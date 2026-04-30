# opencode-copilot-enhanced

[![npm version](https://img.shields.io/npm/v/opencode-copilot-enhanced.svg)](https://www.npmjs.com/package/opencode-copilot-enhanced)
[![npm downloads](https://img.shields.io/npm/dm/opencode-copilot-enhanced.svg)](https://www.npmjs.com/package/opencode-copilot-enhanced)
[![license](https://img.shields.io/npm/l/opencode-copilot-enhanced.svg)](./LICENSE)

OpenCode plugin for enhanced GitHub Copilot support — dynamic model sync, proper token exchange, and configurable OAuth.

## What it does

- **Dynamic model sync** — fetches the live model list from Copilot's `/models` endpoint so new models appear automatically
- **Proper token exchange** — exchanges OAuth tokens for Copilot session tokens via `/copilot_internal/v2/token` with caching and refresh-before-expiry (matches VS Code behavior)
- **Copilot-specific headers** — adds `Copilot-Integration-Id`, `Editor-Version`, `Editor-Plugin-Version`, `X-GitHub-Api-Version` to all requests
- **Configurable OAuth** — override the `client_id` and OAuth `scope` via config file
- **Config sync** — writes the live Copilot model list into `~/.config/opencode/opencode.json` so opencode loads custom/internal models automatically

## Install

```bash
opencode plugin opencode-copilot-enhanced
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

This plugin registers an `auth` hook for the `github-copilot` provider. When loaded alongside the built-in Copilot auth plugin, the deep-merge behavior means this plugin's `fetch` wrapper and model list take precedence.

On each provider load:

1. Exchanges the stored OAuth token for a short-lived Copilot session token
2. Fetches the live model catalog from the Copilot API
3. Merges live model capabilities (context windows, reasoning efforts, modalities) with the static `models.dev` data
4. Writes the merged model list to `~/.config/opencode/opencode.json` under `provider.github-copilot.models`
5. Returns a custom `fetch` that injects the session token and required Copilot headers

## Note on duplicate login option

Because the built-in Copilot auth plugin always loads, you will see two "Login with GitHub Copilot" options in the provider list. The one labeled **"Login with GitHub Copilot (Enhanced)"** uses your configured `clientId` and `scope`. Both work — pick whichever you prefer.

## Development

```bash
bun install
bun test
bun run build
```

## Releasing

Releases are automated via GitHub Actions. To cut a new release:

```bash
npm version patch   # or minor / major
git push --follow-tags
```

The [publish workflow](./.github/workflows/publish.yml) builds, tests, publishes to npm with [provenance](https://docs.npmjs.com/generating-provenance-statements), and creates a GitHub Release with auto-generated notes.

## License

MIT
