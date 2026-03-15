import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const DEFAULT_CLIENT_ID = "01ab8ac9400c4e429b23";
const DEFAULT_SCOPE = "read:user user:email repo workflow";

export type PluginConfig = {
  clientId: string;
  scope: string;
};

function dir() {
  return process.env.XDG_CONFIG_HOME
    ? join(process.env.XDG_CONFIG_HOME, "opencode")
    : join(homedir(), ".config", "opencode");
}

export function load(): PluginConfig {
  const file = join(dir(), "copilot.json");
  if (!existsSync(file)) {
    return { clientId: DEFAULT_CLIENT_ID, scope: DEFAULT_SCOPE };
  }
  try {
    const raw = JSON.parse(readFileSync(file, "utf-8"));
    return {
      clientId:
        typeof raw.clientId === "string" ? raw.clientId : DEFAULT_CLIENT_ID,
      scope: typeof raw.scope === "string" ? raw.scope : DEFAULT_SCOPE,
    };
  } catch {
    return { clientId: DEFAULT_CLIENT_ID, scope: DEFAULT_SCOPE };
  }
}
