# dsh-recall

中文说明：[README.md](./README.md)

A DSH plugin that gives the model a **`recall` tool**: search and read the CALLING AGENT'S OWN session log — the complete durable event history, including events shadowed by compaction.

Compaction never deletes events: it replaces a visible history range with a summary checkpoint, and the replaced events stay in the durable log classified as `shadowed`. `recall` is the official way back to that content — `surfaces: ["shadowed"]` retrieves pre-compaction events verbatim, `seq` reads any exact event.

## Install

Prerequisites: DSH (`dsh web` works), Node.js ≥ 20, pnpm ≥ 10 (needed by the `dsh plugin` command).

### Option 1 (recommended): one official CLI command

```sh
dsh plugin --profile web add dsh-recall
```

`dsh plugin add` installs the npm package into the profile directory and — because the package declares `dsh.bundle.patch` — automatically registers it into `dsh.profile.bundles`. It mounts automatically on next start. **No config file edits.**

`recall` is a host-side tool, so one restart is required after mounting:

```sh
# restart dsh web (depends on how you run it)
# e.g. pm2 restart dsh-web, or Ctrl+C then dsh web again
```

### Option 2: manual npm install + mount row

```sh
cd ~/.dsh/profiles/web
npm i dsh-recall
```

Then append to `~/.dsh/profiles/web/cordis.patch.yml`:

```yaml
- insert:
    - id: tool-recall
      name: 'dsh-recall'
      config:
        maxResults: 25
        maxCharsPerEvent: 3000
```

Restart `dsh web`. Use exactly ONE of the two options — both together double-mount.

### From GitHub (without publishing to npm)

```sh
dsh plugin --profile web add github:fengshenx/dsh-recall
# or
cd ~/.dsh/profiles/web && npm i github:fengshenx/dsh-recall
```

The package `prepare` script builds automatically on install.

### Uninstall

```sh
dsh plugin --profile web remove dsh-recall
```

## Usage

After the restart the model's tool list includes `recall`. Example:

```
recall { query: "Agent/Sub Agent有能力回忆", surfaces: ["shadowed"] }
```

Arguments:

| arg | meaning |
|---|---|
| `query` | case-insensitive literal substring over event text (mutually exclusive with `seq`) |
| `seq` | read one exact event by seq; add `window` for neighbors |
| `window` | with `seq`: how many preceding/following events to include |
| `event_types` | filter by event type (e.g. `user/message`, `compaction/summary`) |
| `surfaces` | `current` (model-visible) / `shadowed` (replaced by compaction) / `log-only` (never on the surface) |
| `seq_from` / `seq_to` | seq range filter |
| `limit` | result cap (clamped to the deployment `maxResults`) |

Design: read-only access to the CALLING agent's OWN session log (no cross-session access); events of the current step are always excluded; a fork inherits its parent's completed-turn log prefix, so it recalls parent history too.

## Configuration

`maxResults` (cap on returned events per call) and `maxCharsPerEvent` (cap on characters of each event's text) are required deployment config, adjustable in the mount row's `config`.

## Development

```sh
pnpm install
pnpm build        # tsc types + tsdown lib/
pnpm test         # vitest, incl. a real Loader composition test
npm pack --dry-run
```

## Publishing

```sh
npm publish       # the name dsh-recall is currently available
```

Or just push to GitHub — users install per "From GitHub" above.

## How it works

- The plugin is a plain npm package declaring `dsh.bundle.patch` (`cordis.patch.yml`) plus a standard plugin row.
- `dsh plugin add` bundle reconciliation (DSH `apps/cli/src/plugin.ts`): after install, packages declaring `dsh.bundle` are appended to the profile's `dsh.profile.bundles`; at boot they merge as a patch layer automatically.
- At runtime `recall` reads the caller's own complete event log via `exec.agent.session.events`; surface classification reuses `buildSessionEventRecords` from `@deepseek-ai/dsh-session-query` — the same vocabulary as the official session-query tools.

## License

MIT
