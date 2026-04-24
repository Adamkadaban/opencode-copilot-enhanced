import { exchange } from "./token.js";

export type LiveModel = {
  id: string;
  name?: string;
  version?: string;
  vendor?: string;
  preview?: boolean;
  model_picker_enabled?: boolean;
  policy?: {
    state?: string;
  };
  supported_endpoints?: string[];
  modalities?: {
    input?: string[];
    output?: string[];
  };
  capabilities?: {
    family?: string;
    limits?: {
      context?: number;
      context_window?: number;
      context_window_tokens?: number;
      input?: number;
      max_context_window_tokens?: number;
      max_input_tokens?: number;
      max_output_tokens?: number;
      max_prompt_tokens?: number;
      output?: number;
    };
    supports?: {
      adaptive_thinking?: boolean;
      max_thinking_budget?: number;
      min_thinking_budget?: number;
      reasoning_effort?: string[];
      streaming?: boolean;
      structured_outputs?: boolean;
      tool_calls?: boolean;
      vision?: boolean;
    };
  };
};

// Mirrors the opencode internal Model type that the auth.loader receives
export type Model = {
  id: string;
  providerID: string;
  api: {
    id: string;
    url: string;
    npm: string;
  };
  name: string;
  family?: string;
  capabilities: {
    temperature: boolean;
    reasoning: boolean;
    attachment: boolean;
    toolcall: boolean;
    input: {
      text: boolean;
      audio: boolean;
      image: boolean;
      video: boolean;
      pdf: boolean;
    };
    output: {
      text: boolean;
      audio: boolean;
      image: boolean;
      video: boolean;
      pdf: boolean;
    };
    interleaved: boolean | { field: "reasoning_content" | "reasoning_details" };
  };
  cost: {
    input: number;
    output: number;
    cache: { read: number; write: number };
  };
  limit: {
    context: number;
    input?: number;
    output: number;
  };
  status: "alpha" | "beta" | "deprecated" | "active";
  options: Record<string, unknown>;
  headers: Record<string, string>;
  release_date?: string;
  variants?: Record<string, Record<string, unknown>>;
};

export type Provider = {
  id: string;
  models: Record<string, Model>;
};

// --- helpers ---

function num(...items: Array<number | undefined>) {
  return items.find(
    (v) => typeof v === "number" && Number.isFinite(v) && v > 0,
  );
}

function words(items: unknown) {
  if (!Array.isArray(items)) return [];
  return items.filter((v): v is string => typeof v === "string");
}

function family(id: string, vendor?: string) {
  const t = `${id} ${vendor ?? ""}`.toLowerCase();
  if (t.includes("claude")) return "claude";
  if (t.includes("codex")) return "gpt-codex";
  if (t.includes("gpt")) return "gpt";
  if (t.includes("gemini")) return "gemini";
  if (t.includes("grok")) return "grok";
  if (t.includes("glm")) return "glm";
  if (t.includes("kimi")) return "kimi";
  return vendor?.toLowerCase() ?? "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toModel(value: unknown): LiveModel | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.id !== "string" || value.id.length === 0) return undefined;

  const capabilities = isRecord(value.capabilities) ? value.capabilities : undefined;
  const limits = capabilities && isRecord(capabilities.limits) ? capabilities.limits : undefined;
  const supports = capabilities && isRecord(capabilities.supports) ? capabilities.supports : undefined;
  const modalities = isRecord(value.modalities) ? value.modalities : undefined;
  const policy = isRecord(value.policy) ? value.policy : undefined;

  return {
    id: value.id,
    name: typeof value.name === "string" ? value.name : undefined,
    version: typeof value.version === "string" ? value.version : undefined,
    vendor: typeof value.vendor === "string" ? value.vendor : undefined,
    preview: typeof value.preview === "boolean" ? value.preview : undefined,
    model_picker_enabled:
      typeof value.model_picker_enabled === "boolean" ? value.model_picker_enabled : undefined,
    supported_endpoints: words(value.supported_endpoints),
    policy: policy
      ? {
          state: typeof policy.state === "string" ? policy.state : undefined,
        }
      : undefined,
    modalities: modalities
      ? {
          input: words(modalities.input),
          output: words(modalities.output),
        }
      : undefined,
    capabilities: capabilities
      ? {
          family: typeof capabilities.family === "string" ? capabilities.family : undefined,
          limits: limits
            ? {
                context: typeof limits.context === "number" ? limits.context : undefined,
                context_window: typeof limits.context_window === "number" ? limits.context_window : undefined,
                context_window_tokens:
                  typeof limits.context_window_tokens === "number" ? limits.context_window_tokens : undefined,
                input: typeof limits.input === "number" ? limits.input : undefined,
                max_context_window_tokens:
                  typeof limits.max_context_window_tokens === "number"
                    ? limits.max_context_window_tokens
                    : undefined,
                max_input_tokens:
                  typeof limits.max_input_tokens === "number" ? limits.max_input_tokens : undefined,
                max_output_tokens:
                  typeof limits.max_output_tokens === "number" ? limits.max_output_tokens : undefined,
                max_prompt_tokens:
                  typeof limits.max_prompt_tokens === "number" ? limits.max_prompt_tokens : undefined,
                output: typeof limits.output === "number" ? limits.output : undefined,
              }
            : undefined,
          supports: supports
            ? {
                adaptive_thinking:
                  typeof supports.adaptive_thinking === "boolean" ? supports.adaptive_thinking : undefined,
                max_thinking_budget:
                  typeof supports.max_thinking_budget === "number" ? supports.max_thinking_budget : undefined,
                min_thinking_budget:
                  typeof supports.min_thinking_budget === "number" ? supports.min_thinking_budget : undefined,
                reasoning_effort: words(supports.reasoning_effort),
                streaming: typeof supports.streaming === "boolean" ? supports.streaming : undefined,
                structured_outputs:
                  typeof supports.structured_outputs === "boolean" ? supports.structured_outputs : undefined,
                tool_calls: typeof supports.tool_calls === "boolean" ? supports.tool_calls : undefined,
                vision: typeof supports.vision === "boolean" ? supports.vision : undefined,
              }
            : undefined,
        }
      : undefined,
  };
}

function limits(input: LiveModel, prev?: Model) {
  const caps = input.capabilities?.limits;
  const output = num(
    caps?.max_output_tokens,
    caps?.output,
    prev?.limit.output,
    8192,
  )!;
  const maxInput = num(
    caps?.max_input_tokens,
    caps?.input,
    caps?.max_prompt_tokens,
    prev?.limit.input,
  );
  const context =
    num(
      caps?.context_window_tokens,
      caps?.context_window,
      caps?.max_context_window_tokens,
      caps?.context,
      prev?.limit.context,
      maxInput ? maxInput + output : undefined,
      output,
    ) ?? output;

  return { context, input: maxInput, output };
}

function efforts(input: LiveModel, prev?: Model) {
  const next = words(input.capabilities?.supports?.reasoning_effort);
  if (next.length > 0) return next;
  return words(prev?.options.reasoningEfforts);
}

function releaseDate(input: LiveModel, prev?: Model) {
  if (prev?.release_date) return prev.release_date;
  if (!input.version) return "";
  const prefix = `${input.id}-`;
  return input.version.startsWith(prefix) ? input.version.slice(prefix.length) : input.version;
}

function supported(input: LiveModel) {
  if (input.model_picker_enabled === false) return false;
  const endpoints = input.supported_endpoints ?? [];
  if (endpoints.length === 0) return true;
  return endpoints.some((e) => e === "/chat/completions" || e === "/responses");
}

function build(
  input: LiveModel,
  providerID: string,
  url: string,
  prev?: Model,
): Model {
  const inMods = words(input.modalities?.input);
  const outMods = words(input.modalities?.output);
  const text = input.id.toLowerCase();
  const list = efforts(input, prev);

  return {
    id: input.id,
    providerID,
    api: {
      id: input.id,
      url: prev?.api.url ?? url,
      npm: "@ai-sdk/github-copilot",
    },
    name: input.name ?? prev?.name ?? input.id,
    family: prev?.family ?? family(input.id, input.vendor),
    capabilities: {
      temperature: prev?.capabilities.temperature ?? false,
      reasoning:
        prev?.capabilities.reasoning ??
        (input.capabilities?.supports?.adaptive_thinking === true ||
          typeof input.capabilities?.supports?.max_thinking_budget === "number" ||
          typeof input.capabilities?.supports?.min_thinking_budget === "number" ||
          list.length > 0),
      attachment:
        prev?.capabilities.attachment ??
        (input.capabilities?.supports?.vision === true || inMods.some((m) => m !== "text")),
      toolcall: prev?.capabilities.toolcall ?? input.capabilities?.supports?.tool_calls ?? true,
      input: {
        text: true,
        audio: prev?.capabilities.input.audio ?? inMods.includes("audio"),
        image: prev?.capabilities.input.image ?? inMods.includes("image"),
        video: prev?.capabilities.input.video ?? inMods.includes("video"),
        pdf: prev?.capabilities.input.pdf ?? inMods.includes("pdf"),
      },
      output: {
        text: true,
        audio: prev?.capabilities.output.audio ?? outMods.includes("audio"),
        image: prev?.capabilities.output.image ?? outMods.includes("image"),
        video: prev?.capabilities.output.video ?? outMods.includes("video"),
        pdf: prev?.capabilities.output.pdf ?? outMods.includes("pdf"),
      },
      interleaved: prev?.capabilities.interleaved ?? false,
    },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: limits(input, prev),
    status: prev?.status ?? "active",
    options: {
      ...prev?.options,
      ...(list.length > 0 ? { reasoningEfforts: list } : {}),
    },
    headers: prev?.headers ?? {},
    release_date: releaseDate(input, prev),
    variants: prev?.variants ?? {},
  };
}

// --- public API ---

export function normalize(url: string) {
  return url.replace(/^https?:\/\//, "").replace(/\/$/, "");
}

export async function list(oauth: string, domain: string, version: string) {
  const session = await exchange(oauth, domain, version);
  const res = await fetch(`${session.api}/models`, {
    headers: {
      Authorization: `Bearer ${session.token}`,
      "Copilot-Integration-Id": "vscode-chat",
      "Editor-Version": "vscode/1.100.0",
      "Editor-Plugin-Version": "copilot-chat/0.38.0",
      "User-Agent": `opencode/${version}`,
      "X-GitHub-Api-Version": "2025-10-01",
    },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Copilot model listing failed (${res.status}): ${text}`);
  }

  const body = (await res.json()) as { data?: unknown[] } | unknown[];
  const raw = Array.isArray(body) ? body : body.data;
  const data = (raw ?? []).map(toModel).filter((item): item is LiveModel => Boolean(item));
  return {
    api: session.api,
    data: data.filter((item) => item.policy?.state !== "disabled").filter(supported),
  };
}

export async function sync(
  info: { refresh: string; enterpriseUrl?: string },
  provider: Provider,
  version: string,
) {
  const domain = info.enterpriseUrl
    ? normalize(info.enterpriseUrl)
    : "github.com";
  const result = await list(info.refresh, domain, version);
  const url =
    result.api ||
    Object.values(provider.models)[0]?.api.url ||
    "https://api.githubcopilot.com";
  const ids = new Set(result.data.map((m) => m.id));

  const next = Object.fromEntries(
    Object.entries(provider.models).filter(
      ([k, v]) => k !== v.api.id || ids.has(v.api.id),
    ),
  );

  for (const item of result.data) {
    next[item.id] = build(
      item,
      provider.id,
      url,
      next[item.id] ?? provider.models[item.id],
    );
  }

  provider.models = next;
  return result.api;
}
