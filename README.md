# ASSet Exporter

Copy a specific set of [Uniform](https://uniform.app) assets from one project to another.

You give the tool a list of **asset ids**. It downloads exactly those assets (binary + metadata) from a *source* project, then uploads them — preserving the original asset id — to a *target* project.

- `pull_assets.mjs` — download assets by id and write a `manifest.json`
- `push_assets.mjs` — read `manifest.json` and upload to the target project

There are no third‑party dependencies; the scripts use only the Node.js standard library and the Uniform REST API.

## Requirements

- Node.js 18+ (uses built‑in `fetch`, `parseArgs`, and `--env-file`)
- A Uniform API key + project id for the **source** project (pull)
- A Uniform API key + project id for the **target** project (push)

## Setup

Copy the example env file and fill in your keys:

```bash
cp .env.example .env.local
```

```bash
# .env.local
UNIFORM_API_KEY=...            # source project key (used by pull)
UNIFORM_PROJECT_ID=...         # source project id

UNIFORM_TARGET_API_KEY=...     # target project key (used by push)
UNIFORM_TARGET_PROJECT_ID=...  # target project id
```

`.env.local` is gitignored. The npm scripts load it automatically via `--env-file=.env.local`.

## How it works

```
PULL (source project)                  PUSH (target project)
─────────────────────                  ────────────────────
asset ids (--ids / --ids-file)         read assets/manifest.json
        │                                      │
        ▼                                      ▼
GET /assets?assetId=<id>               POST /files          (register, get upload URL)
  for each id                                  │
        │                                      ▼
        ▼                              PUT <signed upload URL>  (upload binary)
download fields.url.value                      │
        │                                      ▼
        ▼                              GET /files?id=...    (poll until processed)
save to ./assets/<name>                        │
        │                                      ▼
        ▼                              PUT /assets          (upsert, original _id preserved)
write assets/manifest.json
```

The original asset id is preserved on the target project, so re‑running a push updates the same asset instead of creating a duplicate.

## Pull — download assets by id

Provide ids inline, from a file, or both.

```bash
# inline (comma / space / newline separated)
node --env-file=.env.local pull_assets.mjs --ids id1,id2,id3

# from a file
node --env-file=.env.local pull_assets.mjs --ids-file asset-ids.txt

# preview without downloading or writing the manifest
node --env-file=.env.local pull_assets.mjs --ids-file asset-ids.txt --dry-run
```

Or via the npm script (pass flags after `--`):

```bash
npm run pull -- --ids-file asset-ids.txt
```

### Pull options

| Flag | Default | Description |
|------|---------|-------------|
| `--ids` | — | Asset ids, separated by commas, spaces, or newlines |
| `--ids-file` | — | Path to a file containing ids (see formats below) |
| `--output-dir` | `./assets` | Where downloaded files and `manifest.json` are written |
| `--dry-run` | `false` | Show what would be downloaded; write nothing |

You must supply at least one of `--ids` or `--ids-file` (they can be combined; ids are de‑duplicated).

### Supported `--ids-file` formats

- **Plain text** — one id per line; blank lines ignored; `#` starts a comment
- **JSON array of ids** — `["id1", "id2"]`
- **JSON array of objects with an `id`** — e.g. a previously produced `manifest.json`

Example `asset-ids.txt`:

```text
2ab330da-155b-4d1e-8e98-407e4bd3a6df
c8acaa0b-55e0-4c12-a2ff-a77460e9a9d8   # a comment is fine here
693d2c23-3c95-470b-864c-0dccdef4d072
```

### Output

Files are written to `--output-dir` (default `./assets`). Assets that share a filename are auto‑suffixed (`image.png`, `image__1.png`, …) so nothing is overwritten. A `manifest.json` records the metadata `push_assets.mjs` needs:

```json
[
  {
    "localFile": "simon_ziegler.jpg",
    "id": "00184e13-a50a-44f8-96f2-e136a2380ede",
    "name": "simon_ziegler.jpg",
    "type": "image",
    "modified": "2026-05-27T14:49:23.369+00:00",
    "fields": { "title": { ... }, "mediaType": { ... }, "size": { ... } }
  }
]
```

## Push — upload to the target project

Push reads `manifest.json` from the assets directory and uploads each asset.

```bash
# push everything in the manifest
node --env-file=.env.local push_assets.mjs

# preview without changing the target project
node --env-file=.env.local push_assets.mjs --dry-run

# push only a subset of the manifest
node --env-file=.env.local push_assets.mjs --ids-file asset-ids.txt
```

Or via npm:

```bash
npm run push -- --dry-run
```

### Push options

| Flag | Default | Description |
|------|---------|-------------|
| `--assets-dir` | `./assets` | Directory containing the files and `manifest.json` |
| `--ids` | — | Only push manifest entries whose id is in this list |
| `--ids-file` | — | Same, read from a file (same formats as pull) |
| `--dry-run` | `false` | Log only; no uploads or asset changes |
| `--concurrency` | `3` | Number of assets uploaded in parallel |

If `--ids` / `--ids-file` is given, the manifest is filtered to those ids and any requested id missing from the manifest is reported.

## Typical workflow

```bash
# 1. Pull the assets you want from the source project
node --env-file=.env.local pull_assets.mjs --ids-file asset-ids.txt

# 2. Sanity‑check what would be pushed
node --env-file=.env.local push_assets.mjs --dry-run

# 3. Push to the target project
node --env-file=.env.local push_assets.mjs
```

## Notes

- `assets/` and `.env.local` are gitignored.
- The download URL comes from the asset's `fields.url.value` (the Uniform image/file CDN) and needs no API key.
- Pull fetches one asset per request (`GET /assets?assetId=<id>`); a missing or invalid id is reported and skipped without stopping the run.
