import type { Hooks, Plugin } from "@opencode-ai/plugin";
import { load } from "./config.js";
import { exchange, invalidate } from "./token.js";
import { sync, normalize, type Provider } from "./models.js";
import { setTimeout as sleep } from "node:timers/promises";
import os from "node:os";
import path from "node:path";

const VERSION = "1.0.0";
const POLL_MARGIN = 3000; // 3 s safety buffer for OAuth polling
const RETRY_DELAY = 250;

function urls(domain: string) {
  return {
    device: `https://${domain}/login/device/code`,
    token: `https://${domain}/login/oauth/access_token`,
  };
}

type AuthInfo = {
  type?: string;
  refresh?: string;
  enterpriseUrl?: string;
};

type FetchLike = (
  request: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

type CopilotFetchDeps = {
  exchangeSession?: typeof exchange;
  invalidateSession?: typeof invalidate;
  fetchImpl?: FetchLike;
  sleepImpl?: (ms: number) => Promise<unknown>;
  logger?: Pick<Console, "warn">;
};

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
            .catch((err) => {
              console.error("[opencode-copilot-enhanced] sync failed:", err);
            });

          await writeModels(provider.models as Provider["models"]).catch((err) => {
            console.error(
              "[opencode-copilot-enhanced] config update failed:",
              err,
            );
          });
          for (const model of Object.values(provider.models)) {
            model.cost = { input: 0, output: 0, cache: { read: 0, write: 0 } };
            model.api.npm = "@ai-sdk/github-copilot";
          }
        }

        return {
          baseURL,
          apiKey: "",
          fetch(request: RequestInfo | URL, init?: RequestInit) {
            return fetchWithCopilotAuth(getAuth, request, init, VERSION);
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

function requestURL(request: RequestInfo | URL) {
  if (request instanceof URL) return request.href;
  if (typeof request === "string") return request;
  if (request instanceof Request) return request.url;
  return String(request);
}

function shouldRetry499(url: string, response: Response) {
  if (response.status !== 499) return false;
  const contentType = response.headers.get("content-type") ?? "";
  return url.includes("/chat/completions") || contentType.includes("text/event-stream");
}

function retryLogContext(url: string, response: Response) {
  return {
    status: response.status,
    url,
    contentType: response.headers.get("content-type") ?? undefined,
    githubRequestID: response.headers.get("x-github-request-id") ?? undefined,
    requestID: response.headers.get("x-request-id") ?? undefined,
    copilotSession: response.headers.get("copilot-edits-session") ?? undefined,
  };
}

export async function fetchWithCopilotAuth(
  getAuth: () => Promise<AuthInfo | undefined>,
  request: RequestInfo | URL,
  init: RequestInit | undefined,
  version: string,
  deps: CopilotFetchDeps = {},
) {
  const exchangeSession = deps.exchangeSession ?? exchange;
  const invalidateSession = deps.invalidateSession ?? invalidate;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const sleepImpl = deps.sleepImpl ?? sleep;
  const logger = deps.logger ?? console;

  const auth = await getAuth();
  if (!auth || auth.type !== "oauth" || typeof auth.refresh !== "string") {
    return fetchImpl(request, init);
  }

  const domain = auth.enterpriseUrl ? normalize(auth.enterpriseUrl) : "github.com";
  const url = requestURL(request);

  const doFetch = async () => {
    const session = await exchangeSession(auth.refresh!, domain, version);
    const { isVision, isAgent } = detect(url, init);

    const headers: Record<string, string> = {
      "x-initiator": isAgent ? "agent" : "user",
      ...(init?.headers as Record<string, string>),
      "User-Agent": `opencode/${version}`,
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

    return fetchImpl(request, { ...init, headers });
  };

  const res = await doFetch();
  if (res.status === 401) {
    invalidateSession(auth.refresh, domain);
    return doFetch();
  }

  if (shouldRetry499(url, res)) {
    logger.warn(
      "[opencode-copilot-enhanced] retrying Copilot request after 499",
      retryLogContext(url, res),
    );
    invalidateSession(auth.refresh, domain);
    await sleepImpl(RETRY_DELAY);
    return doFetch();
  }

  return res;
}

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

const pluginModule: { id: string; server: Plugin } = {
  id: "opencode-copilot-enhanced",
  server: plugin,
};

export default pluginModule;

async function writeModels(models: Provider["models"]) {
  const file = path.join(os.homedir(), ".config", "opencode", "opencode.json");
  const item = Bun.file(file);
  const has = await item.exists();
  const cfg = has
    ? await item.json().catch(() => ({}))
    : { $schema: "https://opencode.ai/config.json" };
  const map = cfg.provider ?? {};
  const entry = map["github-copilot"] ?? {};
  const prev = entry.models ?? {};
  const next: Record<string, any> = { ...prev };

  for (const model of Object.values(models)) {
    const status = ["alpha", "beta", "deprecated"].includes(model.status)
      ? { status: model.status }
      : {};
    next[model.id] = {
      id: model.id,
      name: model.name,
      family: model.family,
      ...status,
      reasoning: model.capabilities.reasoning,
      attachment: model.capabilities.attachment,
      tool_call: model.capabilities.toolcall,
      modalities: {
        input: Object.entries(model.capabilities.input)
          .filter(([_, val]) => val)
          .map(([key]) => key),
        output: Object.entries(model.capabilities.output)
          .filter(([_, val]) => val)
          .map(([key]) => key),
      },
      limit: {
        context: model.limit.context,
        input: model.limit.input,
        output: model.limit.output,
      },
      options: model.options,
      headers: model.headers,
      variants: model.variants,
      release_date: model.release_date,
      cost: model.cost,
    };
  }

  map["github-copilot"] = { ...entry, models: next };
  const out = { ...cfg, provider: map };
  await Bun.write(file, JSON.stringify(out, null, 2));
}
