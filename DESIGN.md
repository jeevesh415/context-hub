# Context Hub (chub) - Design Document

## What is Context Hub?

Context Hub bridges the gap between rapidly evolving APIs and LLM knowledge cutoffs. It's a repository of curated, LLM-optimized documentation and skills that AI agents (and humans) can search and retrieve via a CLI.

Content is categorized by **tags**, not rigid types. Common tag conventions:
- `docs` — API/SDK reference documentation (e.g., OpenAI Chat API, Stripe Payments)
- `skill` — Reusable patterns and playbooks, including coding patterns, browser automation, and site-specific knowledge
- Content can have multiple tags including both `docs` and `skill` when it serves both purposes

Each entry also has a **source** field (`official` | `maintainer` | `community`) for trust/quality signaling. Users control which sources agents see via `~/.chub/config.yaml`.

## Architecture

```
GitHub repo (source of truth)
  ↓ CI: build + publish
CDN (serves registry + individual files + optional full bundle)   ← remote source
  ↓ CLI fetches from here
~/.chub/ (local cache)                                            ← cached remote data
  ↓ CLI reads from here
Agent/Human (consumes docs via stdout or -o file)
  ↑ CLI also reads directly from
Local folders (private/internal docs)                             ← local source
```

The CLI supports **multiple sources** — both remote CDNs and local folders. Entries from all sources are merged. See "Multi-source support" below.

## Design Decisions & Rationale

### Why only 4 commands?
We started with 8 commands (search, list, info, get, pull, update, cache, languages) and trimmed to 4. `list` and `info` were merged into `search` (no query = list all, exact id = show detail). `languages` was dropped (search output already shows languages). `pull` (search+get+write) was dropped in favor of unix piping — agents can compose `search --json | jq` with `get -o` for the same result with more control.

### Why no `type` field?
We considered a `type: "docs" | "skills"` field but dropped it. Content can be both a doc and a skill — some API references include step-by-step patterns. Instead, `docs` and `skill` are just tags. Filter with `--tags docs` or `--tags skill`.

### Why `source` field + config-level filtering?
Each entry has `source: "official" | "maintainer" | "community"`. Rather than exposing a `--source` flag to agents, the human controls trust policy via `~/.chub/config.yaml`. This means an enterprise can restrict agents to `source: official,maintainer` without the agent needing to know about quality tiers. Long-term, source filtering will be supplemented by agent usage/complaint reporting data.

### Why no `provider` field?
We considered a top-level `provider` field (e.g., "openai", "stripe") but dropped it. Skills like "JWT auth pattern" don't have a natural provider, leading to filler values. Tags handle vendor filtering just as well (`chub search --tags openai`).

### Why no `active` field?
Soft-delete via `active: false` adds complexity for a rare case. If a doc is deprecated, remove it from the repo. The registry is rebuilt from source on every publish.

### Why tags instead of rigid categories?
Rather than rigid sub-types (`browser-skill`, `coding-skill`), entries use free-form tags: `["skill", "browser", "automation", "playwright"]` vs `["docs", "openai", "chat"]`. This is flexible — new categories emerge without schema changes. Content can have multiple category tags.

### Why hybrid data strategy?
Three approaches were considered:
1. **Full bundle** (download everything) — simple but doesn't scale
2. **Index + on-demand** (fetch individual docs) — lightweight but needs network per doc
3. **Hybrid** (chosen) — registry-only by default, on-demand doc fetching, optional full bundle via `--full`

Hybrid lets agents do `chub update` (fast, small) then `chub get` fetches only what's needed. Power users can `chub update --full` for offline access.

### Why no `chub pull`?
We considered a compound `pull` command (search + get + write in one step). Dropped it because agents can compose the same workflow with unix pipes, with more control over which result to pick. See "Agent piping patterns" below.

### Why `--json` on every command?
Agents parse structured output better than human-formatted text. Every command supports `--json` via a global flag. Default output is human-friendly with colors.

### Why `~/.chub/config.yaml`?
Env vars work but aren't persistent. A config file at `~/.chub/config.yaml` stores defaults. Enterprise users can set `cdn_url` to point to an internal CDN with proprietary docs. Priority: env var > config.yaml > hardcoded defaults.

### Why multi-source?
Teams often have internal/proprietary docs alongside the public community registry. Rather than requiring everything be published to one CDN, the CLI supports multiple sources — remote CDNs and local folders. Each source has its own `registry.json`. Entries are merged, and IDs are namespaced only when there's a collision (e.g., `community/openai-chat` vs `internal/openai-chat`). Local sources read directly from the filesystem — no caching needed.

### Why namespace only on collision?
Most IDs are unique across sources, so forcing `source/id` everywhere would add noise. Namespacing kicks in only when two sources define the same ID. Users can always use the explicit `source/id` form. On collision, `chub get bare-id` errors with a suggestion to use the namespaced form.

---

## CLI Interface

### Commands

| Command | Purpose | Key Options |
|---|---|---|
| `chub search [query]` | Search (no query = list all, exact id = detail) | `--tags`, `--lang`, `--limit`, `--json` |
| `chub get <id> [language]` | Fetch a specific doc/skill | `--version`, `-o <path>`, `--json` |
| `chub update` | Refresh cached registry | `--force`, `--full` |
| `chub cache status\|clear` | Manage local cache | |

### How `search` works
- `chub search` — lists all entries (replaces `list`)
- `chub search openai-chat` — exact id match shows full detail (replaces `info`)
- `chub search "stripe"` — fuzzy search across id, name, description, tags
- `chub search --tags skill,browser` — filtered listing

### Output modes
- **Default**: Human-friendly, colored terminal output
- **`--json`**: Structured JSON to stdout (no color escapes)
- **`-o <path>`**: Write content to file, print short confirmation to stderr

### Agent piping patterns
Instead of a dedicated `pull` command, agents compose standard unix tools:

```bash
# Get the top search result's id
chub search "stripe payments" --json | jq -r '.results[0].id'

# Get top 3 ids
chub search "stripe payments" --json | jq -r '.results[:3][].id'

# Full pipeline: search → pick best → fetch → write to file
ID=$(chub search "stripe payments" --json | jq -r '.results[0].id')
chub get "$ID" js -o .context/stripe.md

# Fetch multiple results
for ID in $(chub search "authentication" --json | jq -r '.results[:3][].id'); do
  chub get "$ID" -o ".context/${ID}.md"
done
```

### Human workflow example
```bash
chub search "authentication"          # Browse what's available
chub search jwt-auth-pattern          # Exact id → full detail
chub get jwt-auth-pattern typescript  # Read in terminal
chub get jwt-auth-pattern ts -o .context/jwt.md  # Save to file
```

---

## Data Strategy

### What the CDN serves
```
cdn.contexthub.dev/v1/
├── registry.json                                    # ~100KB index
├── bundle.tar.gz                                    # Full bundle (optional)
├── docs/openai/chat/python/1.52.0/CONTEXT.md       # Individual files
└── skills/browser/playwright-login/.../CONTEXT.md   # Individual files
```

### How the CLI uses it
1. `chub update` → fetches `registry.json` only (~100KB), caches locally
2. `chub search` → searches local registry (no network)
3. `chub get <id>` → checks local cache first, fetches individual file from CDN if missing
4. `chub update --full` → downloads entire `bundle.tar.gz` for offline use

### Local cache layout
```
~/.chub/
├── config.yaml              # User config (optional, created manually)
└── sources/                 # Per-source cache (remote sources only)
    ├── community/
    │   ├── registry.json    # Cached index for this source
    │   ├── meta.json        # { lastUpdated, registryHash }
    │   └── data/            # Cached content (on-demand or full bundle)
    │       └── docs/openai/chat/python/1.52.0/CONTEXT.md
    └── another-remote/
        ├── registry.json
        ├── meta.json
        └── data/...
```

Local path sources are **not cached** — the CLI reads directly from the configured `path`.

---

## Schemas

### Registry (`registry.json`)
```json
{
  "version": "1.0.0",
  "base_url": "https://cdn.contexthub.dev/v1",
  "generated": "2026-02-01T00:00:00.000Z",
  "entries": [
    {
      "id": "openai-chat",
      "name": "OpenAI Chat API",
      "description": "Chat completions with GPT models",
      "source": "maintainer",
      "tags": ["docs", "openai", "chat", "llm"],
      "languages": [
        {
          "language": "python",
          "versions": [
            {
              "version": "1.52.0",
              "path": "docs/openai/chat/python/1.52.0/CONTEXT.md",
              "hash": "sha256:abc123...",
              "size": 45200,
              "lastUpdated": "2026-01-15"
            }
          ],
          "recommendedVersion": "1.52.0"
        }
      ]
    }
  ]
}
```

**Field notes:**
- `source` — `official` (library author), `maintainer` (context-hub team), `community`. Filtered by config, not by agent.
- `path` — relative to `base_url`, used for on-demand fetching
- `hash` — content hash, skip re-download if local cache matches
- `size` — bytes, useful for progress indication and token estimation
- `tags` — used for all filtering (vendor, category, content type like `docs`/`skill`)

### Config (`~/.chub/config.yaml`)
```yaml
# Multi-source (recommended)
sources:
  - name: community
    url: https://cdn.contexthub.dev/v1       # Remote CDN
  - name: internal
    path: /Users/rohit/my-company-docs       # Local folder

# Trust policy: which entry sources to show (applies across ALL sources)
source: "official,maintainer,community"

# Optional
output_dir: "./context"                       # Default -o directory
refresh_interval: 86400                       # Cache TTL in seconds (24h)
output_format: "human"                        # Default output: "human" or "json"
```

**Backward compat:** If no `sources` array, falls back to single `cdn_url` field (or `CHUB_BUNDLE_URL` env var) as a source named "default".

**Priority for single-source mode:** `CHUB_BUNDLE_URL` env var > `config.yaml cdn_url` > hardcoded default

**Local source folder structure:** Must contain `registry.json` at root with the same schema as the CDN registry. Doc files are read directly from the folder.

---

## Project Structure

```
chub-first-draft/
├── cli/
│   ├── package.json              # npm package with bin entry
│   ├── bin/chub                  # #!/usr/bin/env node entry point
│   ├── src/
│   │   ├── index.js              # Commander setup, global --json, preAction cache hook
│   │   ├── commands/
│   │   │   ├── search.js         # search / list / info (all in one)
│   │   │   ├── get.js            # fetch content
│   │   │   ├── update.js         # refresh registry / full bundle
│   │   │   └── cache.js          # cache status / clear
│   │   └── lib/
│   │       ├── config.js         # Load config.yaml, merge env vars, defaults
│   │       ├── cache.js          # Registry fetch, on-demand doc fetch, bundle extract
│   │       ├── registry.js       # Load registry, search/filter/query
│   │       ├── output.js         # Dual-mode output (human with chalk / JSON)
│   │       └── normalize.js      # Language aliases (js→javascript, py→python)
├── .gitignore
├── package.json                  # Root workspace
```

## Dependencies

- `commander` ^12 — CLI framework
- `chalk` ^5 — Terminal colors
- `yaml` ^2 — Config parsing
- `tar` ^7 — Bundle extraction (for `--full` mode)
- Node.js >= 18 (built-in `fetch`, no `node-fetch` needed)

## Reference

- Existing implementation (for patterns, not to copy): see `rp15-chub/context-hub/cli/`
- Existing content (193+ API docs): see `rp15-chub/context-hub/libraries/`
