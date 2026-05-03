import { beforeEach, describe, expect, mock, test } from "bun:test";
import pluginModule, {
  applyLiveVariantOverrides,
  fetchWithCopilotAuth,
  plugin,
} from "./index.js";
import { list, sync, type Provider } from "./models.js";

const VERSION = "1.0.0";

const session = {
  token: "tok_1",
  expires: Date.now() + 60_000,
  api: "https://api.githubcopilot.com",
};

const realFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = realFetch;
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
});

describe("model syncing", () => {
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

    const result = await list("oauth_token", "github.com", VERSION);

    expect(result.data.map((item) => item.id)).toEqual(["healthy-model", "partial-model"]);
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

    await sync({ refresh: "oauth_token" }, provider, VERSION);

    expect(provider.models["partial-model"]).toBeDefined();
    expect(provider.models["partial-model"].limit.context).toBe(8192);
    expect(provider.models["partial-model"].limit.output).toBe(8192);
    expect(provider.models["partial-model"].capabilities.reasoning).toBe(true);
    expect(provider.models["partial-model"].release_date).toBe("2026-04-01");
  });
});
