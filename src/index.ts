import type { Hooks, Plugin } from "@opencode-ai/plugin";
import { load } from "./config.js";
import { exchange } from "./token.js";
import { sync, normalize, type Provider } from "./models.js";
import { setTimeout as sleep } from "node:timers/promises";

const VERSION = "1.0.0";
const POLL_MARGIN = 3000; // 3 s safety buffer for OAuth polling

function urls(domain: string) {
  return {
    device: `https://${domain}/login/device/code`,
    token: `https://${domain}/login/oauth/access_token`,
  };
}

export const plugin: Plugin = async (input) => {
  const cfg = load();
  const sdk = input.client;

  return {
    auth: {
      provider: "github-copilot",

      // --- loader: sync models, return custom fetch ---
      async loader(getAuth, provider) {
        const info = await getAuth();
        if (!info || info.type !== "oauth") return {};

        const enterprise = info.enterpriseUrl;
        let baseURL = enterprise
          ? `https://copilot-api.${normalize(enterprise)}`
          : undefined;

        if (provider?.models) {
          await sync(info, provider as unknown as Provider, VERSION)
            .then((api) => {
              baseURL = api;
            })
            .catch(() => {});

          for (const model of Object.values(provider.models)) {
            model.cost = { input: 0, output: 0, cache: { read: 0, write: 0 } };
            model.api.npm = "@ai-sdk/github-copilot";
          }
        }

        return {
          baseURL,
          apiKey: "",
          async fetch(request: RequestInfo | URL, init?: RequestInit) {
            const auth = await getAuth();
            if (auth.type !== "oauth") return fetch(request, init);

            const domain = auth.enterpriseUrl
              ? normalize(auth.enterpriseUrl)
              : "github.com";
            const session = await exchange(auth.refresh, domain, VERSION);

            const url =
              request instanceof URL ? request.href : request.toString();
            const { isVision, isAgent } = detect(url, init);

            const headers: Record<string, string> = {
              "x-initiator": isAgent ? "agent" : "user",
              ...(init?.headers as Record<string, string>),
              "User-Agent": `opencode/${VERSION}`,
              Authorization: `Bearer ${session.token}`,
              "Openai-Intent": "conversation-edits",
              "Copilot-Integration-Id": "vscode-chat",
              "Editor-Version": "vscode/1.100.0",
              "Editor-Plugin-Version": "copilot-chat/0.38.0",
              "X-GitHub-Api-Version": "2025-10-01",
            };

            if (isVision) headers["Copilot-Vision-Request"] = "true";

            delete headers["x-api-key"];
            delete headers["authorization"];

            return fetch(request, { ...init, headers });
          },
        };
      },

      // --- OAuth device flow with configurable clientId ---
      methods: [
        {
          type: "oauth" as const,
          label: "Login with GitHub Copilot (Enhanced)",
          prompts: [
            {
              type: "select" as const,
              key: "deploymentType",
              message: "Select GitHub deployment type",
              options: [
                { label: "GitHub.com", value: "github.com", hint: "Public" },
                {
                  label: "GitHub Enterprise",
                  value: "enterprise",
                  hint: "Data residency or self-hosted",
                },
              ],
            },
            {
              type: "text" as const,
              key: "enterpriseUrl",
              message: "Enter your GitHub Enterprise URL or domain",
              placeholder: "company.ghe.com or https://company.ghe.com",
              condition: (inputs: Record<string, string>) =>
                inputs.deploymentType === "enterprise",
              validate: (value: string) => {
                if (!value) return "URL or domain is required";
                try {
                  const url = value.includes("://")
                    ? new URL(value)
                    : new URL(`https://${value}`);
                  if (!url.hostname)
                    return "Please enter a valid URL or domain";
                  return undefined;
                } catch {
                  return "Please enter a valid URL (e.g., company.ghe.com or https://company.ghe.com)";
                }
              },
            },
          ],
          async authorize(inputs = {}) {
            const type = inputs.deploymentType || "github.com";
            let domain = "github.com";
            let actual = "github-copilot";

            if (type === "enterprise") {
              domain = normalize(inputs.enterpriseUrl!);
              actual = "github-copilot-enterprise";
            }

            const u = urls(domain);
            const res = await fetch(u.device, {
              method: "POST",
              headers: {
                Accept: "application/json",
                "Content-Type": "application/json",
                "User-Agent": `opencode/${VERSION}`,
              },
              body: JSON.stringify({
                client_id: cfg.clientId,
                scope: cfg.scope,
              }),
            });

            if (!res.ok)
              throw new Error("Failed to initiate device authorization");

            const device = (await res.json()) as {
              verification_uri: string;
              user_code: string;
              device_code: string;
              interval: number;
            };

            return {
              url: device.verification_uri,
              instructions: `Enter code: ${device.user_code}`,
              method: "auto" as const,
              async callback() {
                while (true) {
                  const response = await fetch(u.token, {
                    method: "POST",
                    headers: {
                      Accept: "application/json",
                      "Content-Type": "application/json",
                      "User-Agent": `opencode/${VERSION}`,
                    },
                    body: JSON.stringify({
                      client_id: cfg.clientId,
                      device_code: device.device_code,
                      grant_type:
                        "urn:ietf:params:oauth:grant-type:device_code",
                    }),
                  });

                  if (!response.ok) return { type: "failed" as const };

                  const data = (await response.json()) as {
                    access_token?: string;
                    error?: string;
                    interval?: number;
                  };

                  if (data.access_token) {
                    const result: {
                      type: "success";
                      refresh: string;
                      access: string;
                      expires: number;
                      provider?: string;
                      enterpriseUrl?: string;
                    } = {
                      type: "success",
                      refresh: data.access_token,
                      access: data.access_token,
                      expires: 0,
                    };

                    if (actual === "github-copilot-enterprise") {
                      result.provider = "github-copilot-enterprise";
                      result.enterpriseUrl = domain;
                    }

                    return result;
                  }

                  if (data.error === "authorization_pending") {
                    await sleep(device.interval * 1000 + POLL_MARGIN);
                    continue;
                  }

                  if (data.error === "slow_down") {
                    let wait = (device.interval + 5) * 1000;
                    if (
                      typeof data.interval === "number" &&
                      data.interval > 0
                    ) {
                      wait = data.interval * 1000;
                    }
                    await sleep(wait + POLL_MARGIN);
                    continue;
                  }

                  if (data.error) return { type: "failed" as const };

                  await sleep(device.interval * 1000 + POLL_MARGIN);
                }
              },
            };
          },
        },
      ],
    },

    // --- chat.headers: mark subagent & compacted sessions ---
    "chat.headers": async (incoming, output) => {
      if (!incoming.model.providerID.includes("github-copilot")) return;

      if (incoming.model.api.npm === "@ai-sdk/anthropic") {
        output.headers["anthropic-beta"] = "interleaved-thinking-2025-05-14";
      }

      const parts = await sdk.session
        .message({
          path: {
            id: incoming.message.sessionID,
            messageID: incoming.message.id,
          },
          query: { directory: input.directory },
          throwOnError: true,
        })
        .catch(() => undefined);

      if (parts?.data.parts?.some((p) => p.type === "compaction")) {
        output.headers["x-initiator"] = "agent";
        return;
      }

      const session = await sdk.session
        .get({
          path: { id: incoming.sessionID },
          query: { directory: input.directory },
          throwOnError: true,
        })
        .catch(() => undefined);

      if (session?.data.parentID) {
        output.headers["x-initiator"] = "agent";
      }
    },
  } satisfies Hooks;
};

// --- request body inspection for vision / agent detection ---

function detect(url: string, init?: RequestInit) {
  try {
    const body =
      typeof init?.body === "string" ? JSON.parse(init.body) : init?.body;

    // Completions API
    if (body?.messages && url.includes("completions")) {
      const last = body.messages[body.messages.length - 1];
      return {
        isVision: body.messages.some(
          (msg: any) =>
            Array.isArray(msg.content) &&
            msg.content.some((p: any) => p.type === "image_url"),
        ),
        isAgent: last?.role !== "user",
      };
    }

    // Responses API
    if (body?.input) {
      const last = body.input[body.input.length - 1];
      return {
        isVision: body.input.some(
          (item: any) =>
            Array.isArray(item?.content) &&
            item.content.some((p: any) => p.type === "input_image"),
        ),
        isAgent: last?.role !== "user",
      };
    }

    // Messages API (Anthropic)
    if (body?.messages) {
      const last = body.messages[body.messages.length - 1];
      const hasNonTool =
        Array.isArray(last?.content) &&
        last.content.some((p: any) => p?.type !== "tool_result");
      return {
        isVision: body.messages.some(
          (item: any) =>
            Array.isArray(item?.content) &&
            item.content.some(
              (p: any) =>
                p?.type === "image" ||
                (p?.type === "tool_result" &&
                  Array.isArray(p?.content) &&
                  p.content.some((n: any) => n?.type === "image")),
            ),
        ),
        isAgent: !(last?.role === "user" && hasNonTool),
      };
    }
  } catch {}

  return { isVision: false, isAgent: false };
}

export default plugin;
