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
| `max_results` | optional: max matching events (hits) to return (1-10, default 10, internal cap 10) |
| `surfaces` | optional: only events of these surface classifications (`current` / `shadowed` / `log-only`); all surfaces when omitted |

Hits are listed in relevance order: the first line identifies each hit (`#seq type [surface]`), then each hit's text flows after a blank line — text is not line-restricted (it may span lines), bounded only by the per-event character cap; long texts are covered by the match window below.

- **Relevance ranking**: rare (long) terms and higher density rank first, newest wins ties; CJK terms get 2-4 char n-gram fallback matching, so rewritten long Chinese phrases still recall
- **Long-event truncation**: only the content around the first match is kept (centered on the match), with omitted-character markers
- **Matching normalization**: NFKC + lowercase; an NFKC-stable query (no full-width/combining forms) scans with plain lowercase instead (full-width variants in event text, e.g. ＡＢＣ, then no longer match `abc`)
- `query` is limited to 200 characters; longer queries error
- A session that never compacted returns guidance instead of an empty result list (the early content is in the current context)

Design: read-only access to the CALLING agent's OWN session log (no cross-session access); events of the current step are always excluded; a fork inherits its parent's completed-turn log prefix, so it recalls parent history too.

## Configuration

`maxResults` (hit cap per call) and `maxCharsPerEvent` (per-event text cap, default 20000) are required deployment config, adjustable in the mount row's `config`.

## Development

```sh
pnpm install
pnpm build        # tsc types + tsdown lib/
pnpm test         # vitest, incl. a real Loader composition test
npm pack --dry-run
```

## Local testing (before publishing to npm)

`dsh plugin` accepts local paths and installs them as `link:` symlinks (source stays live):

```sh
dsh plugin --profile web add /Users/<you>/<path>/dsh-recall
```

It does both steps automatically: appends the package to the profile's `dsh.profile.bundles` and applies the package's own `cordis.patch.yml` at boot. Afterwards:

1. Remove any old manual mount row for the same `tool-recall` id from the profile's `cordis.patch.yml` to avoid a duplicate insert;
2. Restart the web server; `dsh --profile web --dump-config` should show a `# == dsh-recall` section;
3. After each `src/` change, run `pnpm build` and restart the web server (no need to re-run `plugin add`).

## How it works

- The plugin is a plain npm package declaring `dsh.bundle.patch` (`cordis.patch.yml`) plus a standard plugin row.
- `dsh plugin add` bundle reconciliation (DSH `apps/cli/src/plugin.ts`): after install, packages declaring `dsh.bundle` are appended to the profile's `dsh.profile.bundles`; at boot they merge as a patch layer automatically.
- At runtime `recall` reads the caller's own complete event log via `exec.agent.session.events`; surface classification reuses `buildSessionEventRecords` from `@deepseek-ai/dsh-session-query` — the same vocabulary as the official session-query tools.

## License

MIT
