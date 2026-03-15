import { exchange } from "./token.js";

export type LiveModel = {
  id: string;
  name?: string;
  vendor?: string;
  preview?: boolean;
  model_picker_enabled?: boolean;
  supported_endpoints?: string[];
  modalities?: {
    input?: string[];
    output?: string[];
  };
  capabilities?: {
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
      reasoning_effort?: string[];
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
  release_date: string;
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
        (list.length > 0 ||
          /(claude|gpt-5|gemini|grok|kimi|glm|o1|o3|o4)/.test(text)),
      attachment:
        prev?.capabilities.attachment ?? inMods.some((m) => m !== "text"),
      toolcall: prev?.capabilities.toolcall ?? true,
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
    release_date: prev?.release_date ?? "",
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

  const body = (await res.json()) as { data?: LiveModel[] } | LiveModel[];
  const data = Array.isArray(body) ? body : body.data;
  return {
    api: session.api,
    data: (data ?? []).filter(supported),
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
