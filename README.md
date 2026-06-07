# opencode-copilot-enhanced

[![npm version](https://img.shields.io/npm/v/opencode-copilot-enhanced.svg)](https://www.npmjs.com/package/opencode-copilot-enhanced)
[![npm downloads](https://img.shields.io/npm/dm/opencode-copilot-enhanced.svg)](https://www.npmjs.com/package/opencode-copilot-enhanced)
[![license](https://img.shields.io/npm/l/opencode-copilot-enhanced.svg)](./LICENSE)

OpenCode plugin for enhanced GitHub Copilot support — richer live model metadata, precise reasoning variants, proper token exchange, and configurable OAuth.

## What it does

- **Enhanced live model sync** — fetches Copilot's `/models` endpoint and preserves richer capabilities such as exact reasoning efforts, context windows, modalities, and internal/custom models
- **Proper token exchange** — exchanges OAuth tokens for Copilot session tokens via `/copilot_internal/v2/token` with caching and refresh-before-expiry (matches VS Code behavior)
- **OpenCode 1.16+ compatibility** — coexists with OpenCode's built-in Copilot support and avoids duplicate `X-GitHub-Api-Version` headers
- **Configurable OAuth** — override the `client_id` and OAuth `scope` via config file
- **Reasoning variants** — exposes exact live reasoning-effort variants and disables unsupported levels so model pickers stay accurate

## Install

```bash
opencode plugin opencode-copilot-enhanced -g
```

This installs the package globally and updates your `opencode.json` automatically.

Or manually:

```bash
npm install -g opencode-copilot-enhanced
```

Then add it to your `opencode.json`:

```json
{
  "plugin": ["opencode-copilot-enhanced"]
}
```

## Configuration

Create `~/.config/opencode/copilot.json` (optional — sensible defaults are used):

```json
{
  "clientId": "01ab8ac9400c4e429b23",
  "scope": "read:user user:email repo workflow"
}
```

| Key        | Default                              | Description                                     |
| ---------- | ------------------------------------ | ----------------------------------------------- |
| `clientId` | `01ab8ac9400c4e429b23`               | OAuth application client ID for the device flow |
| `scope`    | `read:user user:email repo workflow` | OAuth scopes requested during login             |

## How it works

OpenCode includes built-in GitHub Copilot support, including live model discovery. This plugin layers on top of that support for users who want richer Copilot metadata, exact reasoning-effort variants, configurable OAuth details, and compatibility fixes for Copilot-specific request behavior.

This plugin registers `auth` and `provider.models` hooks for the `github-copilot` provider. When loaded alongside the built-in Copilot plugin, it preserves OpenCode's newer request headers and base behavior while enriching the model list with live capability details from Copilot's API.

On each provider load:

1. Exchanges the stored OAuth token for a short-lived Copilot session token
2. Fetches the live model catalog from the Copilot API
3. Merges live model capabilities (context windows, reasoning efforts, modalities) with the static `models.dev` data
4. Applies exact live reasoning variants to each synced model
5. Returns a custom `fetch` that injects the session token, preserves OpenCode's Copilot API version, and fills required Copilot headers

## Note on duplicate login option

Because the built-in Copilot auth plugin always loads, you will see two "Login with GitHub Copilot" options in the provider list. The one labeled **"Login with GitHub Copilot (Enhanced)"** uses your configured `clientId` and `scope`. Both work — pick whichever you prefer.

## Development

```bash
bun install
bun test
bun run build
```
## License

MIT
