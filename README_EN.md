# dsh-recall

中文说明：[README.md](./README.md)

A DSH plugin that gives the model a **`recall` tool**: search and read the CALLING AGENT'S OWN session log — the complete durable event history, including events shadowed by compaction.

Compaction never deletes events: it replaces a visible history range with a summary checkpoint, and the replaced events stay in the durable log classified as `shadowed`. `recall` is the official way back to that content — `surfaces: ["shadowed"]` retrieves pre-compaction events verbatim, `seq` reads any exact event.

## Install

Prerequisites: DSH (`dsh web` works), Node.js ≥ 20, pnpm ≥ 10 (needed by the `dsh plugin` command). The plugin is published on npm — one command installs and mounts it:

```sh
dsh plugin --profile web add dsh-recall
```

`dsh plugin add` installs the npm package into the profile directory and — because the package declares `dsh.bundle.patch` — automatically registers it into `dsh.profile.bundles`. It mounts automatically on next start. **No config file edits.**

`recall` is a host-side tool, so one restart is required after mounting:

```sh
# restart dsh web (depends on how you run it)
# e.g. pm2 restart dsh-web, or Ctrl+C then dsh web again
```

### Uninstall

```sh
dsh plugin --profile web remove dsh-recall
```

## Usage

After the restart the model's tool list includes `recall`. Example:

```
recall { query: "Agent/Sub Agent有能力回忆 压缩", max_results: 10 }
```

Arguments:

| arg | meaning |
|---|---|
| `query` | **required**: space-separated keywords; an event must contain every keyword (case-insensitive) |
| `max_results` | optional: max events to return (1-10, default 10, internal cap 10) |
| `surfaces` | optional: only events of these surface classifications (`current` / `shadowed` / `log-only`); all surfaces when omitted |

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

## How it works

- The plugin is a plain npm package declaring `dsh.bundle.patch` (`cordis.patch.yml`) plus a standard plugin row.
- `dsh plugin add` bundle reconciliation (DSH `apps/cli/src/plugin.ts`): after install, packages declaring `dsh.bundle` are appended to the profile's `dsh.profile.bundles`; at boot they merge as a patch layer automatically.
- At runtime `recall` reads the caller's own complete event log via `exec.agent.session.events`; surface classification reuses `buildSessionEventRecords` from `@deepseek-ai/dsh-session-query` — the same vocabulary as the official session-query tools.

## License

MIT
