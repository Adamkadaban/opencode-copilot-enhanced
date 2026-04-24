import { beforeEach, describe, expect, mock, test } from "bun:test";
import pluginModule, { fetchWithCopilotAuth, plugin } from "./index.js";

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
    const logger = { warn: mock(() => {}) };

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
        logger,
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
    expect(logger.warn).toHaveBeenCalledTimes(1);
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
    const logger = { warn: mock(() => {}) };
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
        logger,
      },
    );

    expect(response.status).toBe(499);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(invalidateSession).not.toHaveBeenCalled();
    expect(sleepImpl).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
