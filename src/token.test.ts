import { describe, test, expect, beforeEach, mock } from "bun:test";
import { exchange, invalidate } from "./token.js";

const VERSION = "1.0.0";
const MARGIN = 5 * 60 * 1000;

// Each test uses a unique domain to avoid cross-test cache interference.
let testId = 0;
function uniqueDomain() {
  return `test-${testId++}.example.com`;
}

function mockTokenResponse(
  token: string,
  expiresAt: number,
  api?: string,
): Response {
  const body: Record<string, unknown> = { token, expires_at: expiresAt };
  if (api) body.endpoints = { api };
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

// Save and restore the real fetch around each test.
const realFetch = globalThis.fetch;

function setFetchMock(fetchMock: ReturnType<typeof mock>) {
  globalThis.fetch = fetchMock as unknown as typeof fetch;
}

beforeEach(() => {
  globalThis.fetch = realFetch;
});

// ---------------------------------------------------------------------------

describe("exchange", () => {
  test("returns a session from the exchange endpoint", async () => {
    const domain = uniqueDomain();
    const expiresAt = Math.floor(Date.now() / 1000) + 3600; // 1 hour from now
    const fetchMock = mock(() =>
      Promise.resolve(mockTokenResponse("tok_abc", expiresAt)),
    );
    setFetchMock(fetchMock);

    const session = await exchange("oauth_1", domain, VERSION);

    expect(session.token).toBe("tok_abc");
    expect(session.expires).toBe(expiresAt * 1000);
    expect(session.api).toBe(`https://copilot-api.${domain}`);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("uses the endpoints.api field from the response when present", async () => {
    const domain = uniqueDomain();
    const expiresAt = Math.floor(Date.now() / 1000) + 3600;
    const fetchMock = mock(() =>
      Promise.resolve(
        mockTokenResponse(
          "tok_api",
          expiresAt,
          "https://custom-api.example.com/",
        ),
      ),
    );
    setFetchMock(fetchMock);

    const session = await exchange("oauth_api", domain, VERSION);

    expect(session.api).toBe("https://custom-api.example.com"); // trailing slash stripped
  });

  test("defaults to api.githubcopilot.com for github.com domain", async () => {
    const expiresAt = Math.floor(Date.now() / 1000) + 3600;
    // github.com is a shared domain -- invalidate first to ensure clean state
    invalidate("oauth_ghcom", "github.com");
    const fetchMock = mock(() =>
      Promise.resolve(mockTokenResponse("tok_ghcom", expiresAt)),
    );
    setFetchMock(fetchMock);

    const session = await exchange("oauth_ghcom", "github.com", VERSION);

    expect(session.api).toBe("https://api.githubcopilot.com");
    // Clean up shared domain cache
    invalidate("oauth_ghcom", "github.com");
  });

  test("caches the session on subsequent calls", async () => {
    const domain = uniqueDomain();
    const expiresAt = Math.floor(Date.now() / 1000) + 3600;
    const fetchMock = mock(() =>
      Promise.resolve(mockTokenResponse("tok_cached", expiresAt)),
    );
    setFetchMock(fetchMock);

    const first = await exchange("oauth_2", domain, VERSION);
    const second = await exchange("oauth_2", domain, VERSION);

    expect(first).toBe(second); // same object reference
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("re-fetches when cached session is within the 5-min margin", async () => {
    const domain = uniqueDomain();
    // First call: token that expires 4 minutes from now (inside the 5-min margin)
    const soonExpiry = Math.floor(Date.now() / 1000) + 4 * 60;
    const laterExpiry = Math.floor(Date.now() / 1000) + 3600;

    let callCount = 0;
    const fetchMock = mock(() => {
      callCount++;
      const expiresAt = callCount === 1 ? soonExpiry : laterExpiry;
      return Promise.resolve(
        mockTokenResponse(`tok_margin_${callCount}`, expiresAt),
      );
    });
    setFetchMock(fetchMock);

    const first = await exchange("oauth_3", domain, VERSION);
    expect(first.token).toBe("tok_margin_1");

    // Second call should bypass cache because the session is within the margin
    const second = await exchange("oauth_3", domain, VERSION);
    expect(second.token).toBe("tok_margin_2");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("re-fetches when cached session is already expired", async () => {
    const domain = uniqueDomain();
    // First call: token that is already expired
    const pastExpiry = Math.floor(Date.now() / 1000) - 60;
    const futureExpiry = Math.floor(Date.now() / 1000) + 3600;

    let callCount = 0;
    const fetchMock = mock(() => {
      callCount++;
      const expiresAt = callCount === 1 ? pastExpiry : futureExpiry;
      return Promise.resolve(
        mockTokenResponse(`tok_expired_${callCount}`, expiresAt),
      );
    });
    setFetchMock(fetchMock);

    const first = await exchange("oauth_4", domain, VERSION);
    expect(first.token).toBe("tok_expired_1");

    // Second call should bypass cache because the session is expired
    const second = await exchange("oauth_4", domain, VERSION);
    expect(second.token).toBe("tok_expired_2");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("deduplicates concurrent in-flight requests", async () => {
    const domain = uniqueDomain();
    const expiresAt = Math.floor(Date.now() / 1000) + 3600;
    const fetchMock = mock(
      () =>
        new Promise<Response>((resolve) =>
          // Simulate network latency so all calls overlap
          setTimeout(
            () => resolve(mockTokenResponse("tok_dedup", expiresAt)),
            50,
          ),
        ),
    );
    setFetchMock(fetchMock);

    const [a, b, c] = await Promise.all([
      exchange("oauth_5", domain, VERSION),
      exchange("oauth_5", domain, VERSION),
      exchange("oauth_5", domain, VERSION),
    ]);

    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("throws on non-OK response", async () => {
    const domain = uniqueDomain();
    const fetchMock = mock(() =>
      Promise.resolve(
        new Response("Unauthorized", {
          status: 401,
          statusText: "Unauthorized",
        }),
      ),
    );
    setFetchMock(fetchMock);

    await expect(exchange("oauth_6", domain, VERSION)).rejects.toThrow(
      "Copilot token exchange failed (401)",
    );
  });

  test("throws when response has no token field", async () => {
    const domain = uniqueDomain();
    const fetchMock = mock(() =>
      Promise.resolve(
        new Response(JSON.stringify({ expires_at: 9999999999 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
    setFetchMock(fetchMock);

    await expect(exchange("oauth_7", domain, VERSION)).rejects.toThrow(
      "Copilot token exchange returned no token",
    );
  });
});

// ---------------------------------------------------------------------------

describe("invalidate", () => {
  test("evicts the cached entry so exchange re-fetches", async () => {
    const domain = uniqueDomain();
    const expiresAt = Math.floor(Date.now() / 1000) + 3600;

    let callCount = 0;
    const fetchMock = mock(() => {
      callCount++;
      return Promise.resolve(
        mockTokenResponse(`tok_inv_${callCount}`, expiresAt),
      );
    });
    setFetchMock(fetchMock);

    const first = await exchange("oauth_8", domain, VERSION);
    expect(first.token).toBe("tok_inv_1");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Invalidate and re-exchange
    invalidate("oauth_8", domain);
    const second = await exchange("oauth_8", domain, VERSION);
    expect(second.token).toBe("tok_inv_2");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("is a no-op when no cached entry exists", () => {
    // Should not throw
    invalidate("nonexistent", "nonexistent.example.com");
  });
});
