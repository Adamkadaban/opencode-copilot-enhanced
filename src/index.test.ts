import { beforeEach, describe, expect, mock, test } from "bun:test";
import pluginModule, {
  applyLiveVariantOverrides,
  fetchWithCopilotAuth,
  plugin,
} from "./index.js";
import { list, sync, type Provider } from "./models.js";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const VERSION = "1.0.0";

const session = {
  token: "tok_1",
  expires: Date.now() + 60_000,
  api: "https://api.githubcopilot.com",
};

const realFetch = globalThis.fetch;
const realCacheDir = process.env.OPENCODE_COPILOT_ENHANCED_CACHE_DIR;

beforeEach(() => {
  globalThis.fetch = realFetch;
  if (realCacheDir === undefined) delete process.env.OPENCODE_COPILOT_ENHANCED_CACHE_DIR;
  else process.env.OPENCODE_COPILOT_ENHANCED_CACHE_DIR = realCacheDir;
});

describe("fetchWithCopilotAuth", () => {
  test("exports a v1 plugin module for current OpenCode", () => {
    expect(pluginModule.id).toBe("opencode-copilot-enhanced");
    expect(pluginModule.server).toBe(plugin);
  });

  test("retries one streamed 499 with a fresh token", async () => {
    let exchangeCount = 0;
    const exchangeSession = mock(async () => ({
      ...session,
      token: `tok_${++exchangeCount}`,
    }));
    const invalidateSession = mock(() => {});
    const sleepImpl = mock(async () => {});

    let fetchCount = 0;
    const fetchImpl = mock(async (_request: RequestInfo | URL, init?: RequestInit) => {
      fetchCount++;
      const headers = init?.headers as Record<string, string>;
      expect(headers.Authorization).toBe(`Bearer tok_${fetchCount}`);

      if (fetchCount === 1) {
        return new Response("", {
          status: 499,
          headers: {
            "content-type": "text/event-stream",
            "x-github-request-id": "gh_123",
            "x-request-id": "req_123",
            "copilot-edits-session": "copilot_123",
          },
        });
      }

      return new Response("ok", { status: 200 });
    });

    const response = await fetchWithCopilotAuth(
      async () => ({
        type: "oauth",
        refresh: "oauth_token",
        enterpriseUrl: "https://enterprise.githubcopilot.com",
      }),
      "https://api.enterprise.githubcopilot.com/chat/completions",
      {
        body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
      },
      VERSION,
      {
        exchangeSession,
        invalidateSession,
        fetchImpl,
        sleepImpl,
      },
    );

    expect(response.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(exchangeSession).toHaveBeenCalledTimes(2);
    expect(invalidateSession).toHaveBeenCalledTimes(1);
    expect(invalidateSession).toHaveBeenCalledWith(
      "oauth_token",
      "enterprise.githubcopilot.com",
    );
    expect(sleepImpl).toHaveBeenCalledTimes(1);
  });

  test("preserves existing 401 retry behavior", async () => {
    const exchangeSession = mock(async () => session);
    const invalidateSession = mock(() => {});
    const sleepImpl = mock(async () => {});

    let fetchCount = 0;
    const fetchImpl = mock(async () => {
      fetchCount++;
      if (fetchCount === 1) {
        return new Response("Unauthorized", { status: 401 });
      }
      return new Response("ok", { status: 200 });
    });

    const response = await fetchWithCopilotAuth(
      async () => ({ type: "oauth", refresh: "oauth_token" }),
      "https://api.githubcopilot.com/chat/completions",
      {
        body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
      },
      VERSION,
      {
        exchangeSession,
        invalidateSession,
        fetchImpl,
        sleepImpl,
      },
    );

    expect(response.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(invalidateSession).toHaveBeenCalledTimes(1);
    expect(sleepImpl).not.toHaveBeenCalled();
  });

  test("does not retry non-streaming 499 responses", async () => {
    const exchangeSession = mock(async () => session);
    const invalidateSession = mock(() => {});
    const sleepImpl = mock(async () => {});
    const fetchImpl = mock(
      async () => new Response("", { status: 499, headers: { "content-type": "application/json" } }),
    );

    const response = await fetchWithCopilotAuth(
      async () => ({ type: "oauth", refresh: "oauth_token" }),
      "https://api.githubcopilot.com/models",
      undefined,
      VERSION,
      {
        exchangeSession,
        invalidateSession,
        fetchImpl,
        sleepImpl,
      },
    );

    expect(response.status).toBe(499);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(invalidateSession).not.toHaveBeenCalled();
    expect(sleepImpl).not.toHaveBeenCalled();
  });

  test("strips service_tier from request body before sending to Copilot", async () => {
    const exchangeSession = mock(async () => session);
    const invalidateSession = mock(() => {});
    const sleepImpl = mock(async () => {});

    let sentBody: string | undefined;
    const fetchImpl = mock(async (_request: RequestInfo | URL, init?: RequestInit) => {
      sentBody = typeof init?.body === "string" ? init.body : undefined;
      return new Response("ok", { status: 200 });
    });

    await fetchWithCopilotAuth(
      async () => ({ type: "oauth", refresh: "oauth_token" }),
      "https://api.githubcopilot.com/chat/completions",
      {
        body: JSON.stringify({
          model: "gpt-5.5",
          messages: [{ role: "user", content: "hi" }],
          service_tier: "priority",
        }),
      },
      VERSION,
      {
        exchangeSession,
        invalidateSession,
        fetchImpl,
        sleepImpl,
      },
    );

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(sentBody!);
    expect(parsed.service_tier).toBeUndefined();
    expect(parsed.model).toBe("gpt-5.5");
    expect(parsed.messages).toHaveLength(1);
  });

  test("preserves an incoming Copilot API version without sending duplicate casing", async () => {
    const exchangeSession = mock(async () => session);
    const invalidateSession = mock(() => {});
    const sleepImpl = mock(async () => {});

    let sentHeaders: Record<string, string> | undefined;
    const fetchImpl = mock(async (_request: RequestInfo | URL, init?: RequestInit) => {
      sentHeaders = init?.headers as Record<string, string>;
      return new Response("ok", { status: 200 });
    });

    await fetchWithCopilotAuth(
      async () => ({ type: "oauth", refresh: "oauth_token" }),
      "https://api.githubcopilot.com/responses",
      {
        headers: {
          "x-github-api-version": "2026-06-01",
        },
        body: JSON.stringify({
          model: "gpt-5.5",
          input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }],
        }),
      },
      VERSION,
      {
        exchangeSession,
        invalidateSession,
        fetchImpl,
        sleepImpl,
      },
    );

    expect(sentHeaders?.["X-GitHub-Api-Version"]).toBe("2026-06-01");
    expect(sentHeaders?.["x-github-api-version"]).toBeUndefined();
  });

});

describe("model syncing", () => {
  test("does not perform eager model sync during config startup", async () => {
    const fetchMock = mock(async () => new Response("unexpected", { status: 500 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const hooks = await plugin({ client: {}, directory: "/tmp" } as any);
    await hooks.config?.({});

    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("applies live reasoning variants as config overrides", () => {
    const config = {};
    const provider: Provider = {
      id: "github-copilot",
      models: {
        "claude-opus-4.7": {
          id: "claude-opus-4.7",
          providerID: "github-copilot",
          api: {
            id: "claude-opus-4.7",
            url: "https://api.enterprise.githubcopilot.com",
            npm: "@ai-sdk/github-copilot",
          },
          name: "Claude Opus 4.7",
          family: "claude",
          capabilities: {
            temperature: false,
            reasoning: true,
            attachment: true,
            toolcall: true,
            input: { text: true, audio: false, image: false, video: false, pdf: false },
            output: { text: true, audio: false, image: false, video: false, pdf: false },
            interleaved: false,
          },
          cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
          limit: { context: 200000, output: 32000 },
          status: "active",
          options: { reasoningEfforts: ["medium"] },
          headers: {},
          release_date: "2026-02-05",
          variants: {},
        },
      },
    };

    applyLiveVariantOverrides(config, provider);

    const variants = (config as any).provider["github-copilot"].models["claude-opus-4.7"].variants;
    expect(variants.medium).toEqual({ reasoningEffort: "medium" });
    expect(variants.high).toEqual({ disabled: true });
    expect(variants.low).toEqual({ disabled: true });
  });

  test("salvages malformed Copilot model rows instead of failing the whole list", async () => {
    const fetchMock = mock(async (request: RequestInfo | URL) => {
      const url = String(request);
      if (url.includes("/copilot_internal/")) {
        return new Response(
          JSON.stringify({
            token: "copilot_token",
            expires_at: Math.floor((Date.now() + 60_000) / 1000),
            refresh_in: 30,
            endpoints: {
              api: "https://api.githubcopilot.com",
            },
          }),
          { status: 200 },
        );
      }

      return new Response(
        JSON.stringify({
          data: [
            {
              id: "healthy-model",
              name: "Healthy Model",
              version: "healthy-model-2025-10-09",
              model_picker_enabled: true,
              capabilities: {
                family: "family-a",
                limits: {
                  max_context_window_tokens: 128000,
                  max_output_tokens: 32000,
                  max_prompt_tokens: 96000,
                },
                supports: {
                  streaming: true,
                  tool_calls: true,
                },
              },
            },
            {
              id: "partial-model",
              name: "Partial Model",
              version: "partial-model-2026-04-01",
              model_picker_enabled: true,
              capabilities: {
                family: "family-b",
                supports: {
                  reasoning_effort: ["low", "medium", "high"],
                },
              },
            },
            {
              id: "disabled-model",
              name: "Disabled",
              version: "disabled-model-2026-04-01",
              model_picker_enabled: true,
              policy: { state: "disabled" },
            },
          ],
        }),
        { status: 200 },
      );
    });

    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await list("oauth_token", "github.com", VERSION, { useCache: false });

    expect(result.data.map((item) => item.id)).toEqual(["healthy-model", "partial-model"]);
  });

  test("uses an abort signal when fetching Copilot models", async () => {
    let modelFetchSignal: AbortSignal | undefined;
    const fetchMock = mock(async (request: RequestInfo | URL, init?: RequestInit) => {
      const url = String(request);
      if (url.includes("/copilot_internal/")) {
        return new Response(
          JSON.stringify({
            token: "copilot_token",
            expires_at: Math.floor((Date.now() + 60_000) / 1000),
            endpoints: { api: "https://api.githubcopilot.com" },
          }),
          { status: 200 },
        );
      }

      modelFetchSignal = init?.signal as AbortSignal | undefined;
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await list("oauth_signal", "signal.example.com", VERSION, { useCache: false });

    expect(modelFetchSignal).toBeInstanceOf(AbortSignal);
  });

  test("sync retains malformed but useful models with safe defaults", async () => {
    const fetchMock = mock(async (request: RequestInfo | URL) => {
      const url = String(request);
      if (url.includes("/copilot_internal/")) {
        return new Response(
          JSON.stringify({
            token: "copilot_token",
            expires_at: Math.floor((Date.now() + 60_000) / 1000),
            refresh_in: 30,
            endpoints: {
              api: "https://api.githubcopilot.com",
            },
          }),
          { status: 200 },
        );
      }

      return new Response(
        JSON.stringify({
          data: [
            {
              id: "partial-model",
              name: "Partial Model",
              version: "partial-model-2026-04-01",
              model_picker_enabled: true,
              capabilities: {
                family: "family-b",
                supports: {
                  adaptive_thinking: true,
                },
              },
            },
          ],
        }),
        { status: 200 },
      );
    });

    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const provider: Provider = {
      id: "github-copilot",
      models: {},
    };

    await sync({ refresh: "oauth_token" }, provider, VERSION, { useCache: false });

    expect(provider.models["partial-model"]).toBeDefined();
    expect(provider.models["partial-model"].limit.context).toBe(8192);
    expect(provider.models["partial-model"].limit.output).toBe(8192);
    expect(provider.models["partial-model"].capabilities.reasoning).toBe(true);
    expect(provider.models["partial-model"].release_date).toBe("2026-04-01");
  });

  test("does not synthesize a partial Copilot auto model", async () => {
    const fetchMock = mock(async (request: RequestInfo | URL) => {
      const url = String(request);
      if (url.includes("/copilot_internal/")) {
        return new Response(
          JSON.stringify({
            token: "copilot_token",
            expires_at: Math.floor((Date.now() + 60_000) / 1000),
            refresh_in: 30,
            endpoints: {
              api: "https://api.githubcopilot.com",
            },
          }),
          { status: 200 },
        );
      }

      return new Response(
        JSON.stringify({
          data: [
            {
              id: "gpt-5.5",
              name: "GPT-5.5",
              model_picker_enabled: true,
              capabilities: {
                limits: {
                  max_context_window_tokens: 1050000,
                  max_output_tokens: 64000,
                },
              },
            },
          ],
        }),
        { status: 200 },
      );
    });

    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const cacheDir = await mkdtemp(path.join(os.tmpdir(), "copilot-model-cache-"));
    try {
      process.env.OPENCODE_COPILOT_ENHANCED_CACHE_DIR = cacheDir;
      const hooks = await plugin({ client: {}, directory: "/tmp" } as any);
      const provider: Provider = {
        id: "github-copilot",
        models: {},
      };

      const models = await (hooks as any).provider.models(provider, {
        auth: { type: "oauth", refresh: "oauth_token" },
      });

      expect(models.auto).toBeUndefined();
      expect(models["gpt-5.5"].limit.context).toBe(1050000);
    } finally {
      await rm(cacheDir, { recursive: true, force: true });
    }
  });

  test("applies live reasoning variants during lazy provider sync", async () => {
    const fetchMock = mock(async (request: RequestInfo | URL) => {
      const url = String(request);
      if (url.includes("/copilot_internal/")) {
        return new Response(
          JSON.stringify({
            token: "copilot_token",
            expires_at: Math.floor((Date.now() + 60_000) / 1000),
            endpoints: { api: "https://api.githubcopilot.com" },
          }),
          { status: 200 },
        );
      }

      return new Response(
        JSON.stringify({
          data: [
            {
              id: "reasoning-model",
              name: "Reasoning Model",
              model_picker_enabled: true,
              capabilities: {
                supports: { reasoning_effort: ["low", "medium"] },
              },
            },
          ],
        }),
        { status: 200 },
      );
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const cacheDir = await mkdtemp(path.join(os.tmpdir(), "copilot-model-cache-"));
    try {
      process.env.OPENCODE_COPILOT_ENHANCED_CACHE_DIR = cacheDir;
      const hooks = await plugin({ client: {}, directory: "/tmp" } as any);
      const provider: Provider = { id: "github-copilot", models: {} };

      const models = await (hooks as any).provider.models(provider, {
        auth: { type: "oauth", refresh: "oauth_reasoning" },
      });

      expect(models["reasoning-model"].variants.low).toEqual({ reasoningEffort: "low" });
      expect(models["reasoning-model"].variants.medium).toEqual({ reasoningEffort: "medium" });
      expect(models["reasoning-model"].variants.high).toEqual({ disabled: true });
    } finally {
      await rm(cacheDir, { recursive: true, force: true });
    }
  });

  test("uses cached model list without network within TTL", async () => {
    const cacheDir = await mkdtemp(path.join(os.tmpdir(), "copilot-model-cache-"));
    try {
      const fetchMock = mock(async (request: RequestInfo | URL) => {
        const url = String(request);
        if (url.includes("/copilot_internal/")) {
          return new Response(
            JSON.stringify({
              token: "copilot_token",
              expires_at: Math.floor((Date.now() + 60_000) / 1000),
              endpoints: { api: "https://api.githubcopilot.com" },
            }),
            { status: 200 },
          );
        }

        return new Response(
          JSON.stringify({
            data: [
              {
                id: "cached-model",
                name: "Cached Model",
                model_picker_enabled: true,
                capabilities: { limits: { max_context_window_tokens: 128000 } },
              },
            ],
          }),
          { status: 200 },
        );
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const first = await list("oauth_cache", "cache.example.com", VERSION, { cacheDir });
      expect(first.data.map((item) => item.id)).toEqual(["cached-model"]);
      expect(fetchMock).toHaveBeenCalledTimes(2);

      const offlineFetch = mock(async () => new Response("offline", { status: 500 }));
      globalThis.fetch = offlineFetch as unknown as typeof fetch;

      const second = await list("oauth_cache", "cache.example.com", VERSION, { cacheDir });
      expect(second.data.map((item) => item.id)).toEqual(["cached-model"]);
      expect(offlineFetch).not.toHaveBeenCalled();
    } finally {
      await rm(cacheDir, { recursive: true, force: true });
    }
  });

  test("returns stale model cache immediately and refreshes in background", async () => {
    const cacheDir = await mkdtemp(path.join(os.tmpdir(), "copilot-model-cache-"));
    try {
      const firstFetch = mock(async (request: RequestInfo | URL) => {
        const url = String(request);
        if (url.includes("/copilot_internal/")) {
          return new Response(
            JSON.stringify({
              token: "copilot_token",
              expires_at: Math.floor((Date.now() + 60_000) / 1000),
              endpoints: { api: "https://api.githubcopilot.com" },
            }),
            { status: 200 },
          );
        }

        return new Response(
          JSON.stringify({ data: [{ id: "stale-model", model_picker_enabled: true }] }),
          { status: 200 },
        );
      });
      globalThis.fetch = firstFetch as unknown as typeof fetch;
      await list("oauth_stale", "stale.example.com", VERSION, { cacheDir });

      let resolveRefresh!: () => void;
      const refreshStarted = new Promise<void>((resolve) => {
        resolveRefresh = resolve;
      });
      const refreshFetch = mock(async (request: RequestInfo | URL) => {
        const url = String(request);
        if (url.includes("/copilot_internal/")) {
          return new Response(
            JSON.stringify({
              token: "copilot_token",
              expires_at: Math.floor((Date.now() + 60_000) / 1000),
              endpoints: { api: "https://api.githubcopilot.com" },
            }),
            { status: 200 },
          );
        }

        resolveRefresh();
        return new Response(
          JSON.stringify({ data: [{ id: "fresh-model", model_picker_enabled: true }] }),
          { status: 200 },
        );
      });
      globalThis.fetch = refreshFetch as unknown as typeof fetch;

      const stale = await list("oauth_stale", "stale.example.com", VERSION, {
        cacheDir,
        cacheTtlMs: 0,
      });
      expect(stale.data.map((item) => item.id)).toEqual(["stale-model"]);

      await refreshStarted;
      expect(refreshFetch).toHaveBeenCalledTimes(2);
    } finally {
      await rm(cacheDir, { recursive: true, force: true });
    }
  });

  test("deduplicates concurrent provider and loader model syncs", async () => {
    let modelFetchCount = 0;
    const fetchMock = mock(async (request: RequestInfo | URL) => {
      const url = String(request);
      if (url.includes("/copilot_internal/")) {
        return new Response(
          JSON.stringify({
            token: "copilot_token",
            expires_at: Math.floor((Date.now() + 60_000) / 1000),
            endpoints: { api: "https://api.githubcopilot.com" },
          }),
          { status: 200 },
        );
      }

      modelFetchCount++;
      await new Promise((resolve) => setTimeout(resolve, 25));
      return new Response(
        JSON.stringify({
          data: [{ id: "deduped-model", model_picker_enabled: true }],
        }),
        { status: 200 },
      );
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const cacheDir = await mkdtemp(path.join(os.tmpdir(), "copilot-model-cache-"));
    try {
      process.env.OPENCODE_COPILOT_ENHANCED_CACHE_DIR = cacheDir;
      const hooks = await plugin({ client: {}, directory: "/tmp" } as any);
      const auth = {
        type: "oauth" as const,
        refresh: `oauth_dedup_${Date.now()}`,
        access: "",
        expires: 0,
      };
      const loaderProvider: Provider = { id: "github-copilot", models: {} };
      const hookProvider: Provider = { id: "github-copilot", models: {} };

      await Promise.all([
        hooks.auth?.loader?.(async () => auth, loaderProvider as any),
        (hooks as any).provider.models(hookProvider, { auth }),
      ]);

      expect(modelFetchCount).toBe(1);
      expect(loaderProvider.models["deduped-model"]).toBeDefined();
      expect(hookProvider.models["deduped-model"]).toBeDefined();
    } finally {
      await rm(cacheDir, { recursive: true, force: true });
    }
  });

});
