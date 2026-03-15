const MARGIN = 5 * 60 * 1000; // refresh 5 min before expiry (matches VS Code)

export type Session = {
  token: string;
  expires: number;
  api: string;
};

const cache = new Map<string, Session>();
const inflight = new Map<string, Promise<Session>>();

function key(oauth: string, domain: string) {
  return `${domain}:${oauth}`;
}

export function invalidate(oauth: string, domain: string) {
  cache.delete(key(oauth, domain));
}

export async function exchange(
  oauth: string,
  domain: string,
  version: string,
): Promise<Session> {
  const k = key(oauth, domain);
  const hit = cache.get(k);
  if (hit && hit.expires - MARGIN > Date.now()) return hit;

  const running = inflight.get(k);
  if (running) return running;

  const job = (async () => {
    try {
      const url = `https://api.${domain}/copilot_internal/v2/token`;
      const res = await fetch(url, {
        headers: {
          Authorization: `token ${oauth}`,
          Accept: "application/json",
          "User-Agent": `opencode/${version}`,
          "X-GitHub-Api-Version": "2025-04-01",
        },
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(
          `Copilot token exchange failed (${res.status}): ${text}`,
        );
      }

      const data = (await res.json()) as {
        token: string;
        expires_at: number;
        endpoints?: Record<string, unknown>;
      };

      if (!data.token)
        throw new Error("Copilot token exchange returned no token");

      const result: Session = {
        token: data.token,
        expires: data.expires_at * 1000,
        api:
          typeof data.endpoints?.api === "string"
            ? data.endpoints.api.replace(/\/+$/, "")
            : domain === "github.com"
              ? "https://api.githubcopilot.com"
              : `https://copilot-api.${domain}`,
      };

      cache.set(k, result);
      return result;
    } finally {
      inflight.delete(k);
    }
  })();

  inflight.set(k, job);
  return job;
}
