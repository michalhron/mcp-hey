# Next steps and the personal-index overhaul

Notes from the 2026-10-09 test-and-fix session. They cover mcp-hey and its companion [new-outlook-mcp](https://github.com/michalhron/new-outlook-mcp), which imports the `.eml` archive mcp-hey writes. The same notes live in new-outlook-mcp's `docs/`; keep the two copies in sync. Nothing here is built yet unless it says so.

## Where things stand (2026-10-09)

**Pieces**

| Piece | What it does | State |
|---|---|---|
| mcp-hey (`~/mcp-hey`) | Live HEY account: read, search, reply, screen, move. Saves every message you *open* as `.eml` to `HEY_ARCHIVE_DIR` (`~/Mail/hey-archive`). | Works. PR michalhron/mcp-hey#6 (docs) open. |
| new-outlook-mcp (`~/new-outlook-mcp`) | Reads Outlook's local caches (legacy archive + New Outlook HxStore), ICS feeds and `.eml` folders into one SQLite archive (`archive.db`) with FTS, embeddings, a reranker, realms (work/private) and calendar. Read-only MCP server over it. | Works. PR #16 (fixes) and #17 (reranker, stacked on #16) open. Installed from the local clone via pipx. |
| mega-outlook-mcp (`outlook-local`) | AppleScript bridge to Outlook. | Dead since New Outlook (no AppleScript). Can be removed. |

**Fixed today** (PRs #16, #17): schema migrations; merged mail belongs to both realms; footers/banners and punctuation-only lines left out of embeddings; function words dropped from hybrid keyword search; pypdf warnings quieted; cross-encoder reranker over the top 50 results.

**Measured today** (12 descriptive queries with a known answer, a real archive of about 9,000 messages, hybrid mode). Keep this set as a regression benchmark (see below for where the queries live).

| | right email #1 | top 5 | top 10 | s/search |
|---|---|---|---|---|
| hybrid, no reranker | 3/12 | 4/12 | 5/12 | 0.98 |
| hybrid + reranker | 5/12 | 5/12 | 6/12 | 1.28 |

- new-outlook-mcp's ROADMAP.md Phase 5 "done when" (right message in the top 5 for queries phrased from memory) is **not met yet**: 5/12.
- 4 of 12 targets never reach the candidate list: a first-stage recall problem the reranker cannot fix.
- multilingual-e5-base instead of e5-small: median rank 253 → 171, top 10 unchanged, 3× slower to embed. Not adopted (model deleted).
- e5-small scores almost everything between 0.79 and 0.87, so pure vector search cannot separate short transactional mail (invoices, receipts) from the rest.

The 12 benchmark queries (English and Dutch, each describing a known email without using its words: invoices, a refund, an order confirmation, a conference registration, a procedure email) refer to real mail, so they are kept outside the repo in `~/Library/Application Support/new-outlook-mcp/benchmark-queries.md` (mode 600).

---

## Part 1: small next steps (current architecture)

Roughly in order of value.

1. **Merge PRs.** #16 first, then retarget #17 to `main` and merge; then mcp-hey#6. Reinstall with `pipx install --force ~/new-outlook-mcp[watch,semantic]` (or from GitHub once merged; `--force` alone did not upgrade a git install before, uninstall + install did).
2. **HEY backfill.** Today only messages opened through mcp-hey reach the index (19). Add a command to mcp-hey (CLI or tool, e.g. `hey_archive_backfill`) that walks chosen boxes (Imbox, Set Aside, Reply Later; optionally Feed/Paper Trail) and saves each message's `.eml`, rate-limited, resumable, skipping files that exist. Then `new-outlook sync --source eml` picks them up. This is the biggest gap in the current setup.
3. **Install the watcher** (`new-outlook launchd` / `watch`) so new Outlook and HEY mail is synced and embedded without manual `sync`.
4. **First-stage recall** (the 4/12 that never become candidates). Ideas, cheapest first:
   - add a short "header passage" per message (sender name + domain + subject + date + amounts) so transactional mail has a dense, descriptive chunk;
   - query expansion: run the vector search for the query and for a few rewrites (e.g. translated to English/Dutch), union the candidates;
   - larger candidate pool from the vector side only, reranker over the union;
   - try BAAI/bge-m3 (≈2.3 GB, slower) on the benchmark before any full rebuild.
5. **One reranker regression** ("refund for an AI programming tool": #1 → #8). Consider fusing reranker score with the first-stage rank instead of replacing it.
6. **Benchmark as a command**: `new-outlook bench` reading a small YAML/TOML of (query → subject or message-id) pairs, printing the table above. Run it before and after any search change.
7. **Housekeeping**
   - `new-outlook status` groups merged mail under the first account only; show all accounts per message.
   - 827 HxStore source rows have no account (merged into legacy copies); `sync --source hxstore --full` would fill them. Harmless today.
   - Pre-existing lint debt (~190 ruff findings) in the repo.
   - Remove the dead `outlook-local` (mega-outlook-mcp) server from Claude configs.
   - Never run `embed --reembed` twice: it wipes the index first. `embed --status` says when a rebuild is needed.

---

## Part 2: the architectural overhaul: a general personal index

### The idea

Semantic search should not live *inside* an Outlook tool. It should be its own system that takes in content from many sources (mail accounts first, later notes, folders of documents, calendar, task lists, transcripts) and offers one search over all of it, with the same quality machinery (chunking, boilerplate removal, embeddings, reranking, realms) applied to everything.

Today's code is already halfway there: `archive.db` is source-agnostic, importers live in `importers/`, and search never asks where a message came from. What ties it to mail is the data model (a `messages` table with mail columns) and the name.

### Target shape

```
          ┌──────────── live account servers (act on things) ────────────┐
          │ mcp-hey (HEY)   Outlook: none possible   Things   Notes…     │
          └──────────────────────────────────────────────────────────────┘

sources ─► connectors ─► normalized documents ─► pipeline ─► index ─► search MCP
 Outlook cache        Outlook (legacy, HxStore)      chunk           SQLite:     search
 HEY .eml / backfill  eml                            boilerplate     documents,  semantic_search
 Notes, Obsidian      notes                          embed           chunks,     find_similar
 folders (PDF, docx)  files                          (rerank at      vectors,    get_document
 calendar (ICS)       ics                             query time)    FTS         + per-type tools
 transcripts, Things  …
```

**Live servers act; the index finds.** mcp-hey stays a live HEY client. The index server stays read-only.

### Core concepts

- **Document**: the unit of search and of results. Fields every source fills: `id`, `source` (outlook, hey, notes, files…), `source_key` (stable id inside the source), `kind` (email, note, file, event, task, transcript), `title`, `body_text`, `created`/`modified`, `people` (from/to/authors), `container` (folder, notebook, directory), `realm` (work/private, generalised to *scopes*), `url_or_path` to open the original, and `extra` (JSON for kind-specific fields: mail headers, attendees, file type…).
- **Relations**: thread membership, attachments (document → child documents), duplicates across sources (today's dedup by Message-ID generalises to "same content seen in two places"; the merged-realm rule from today becomes "a document belongs to every scope of every place it was seen").
- **Chunk**: passage of a document's text plus position; what gets embedded. Today's chunker becomes per-kind (mail strips quotes and signatures; notes split by heading; PDFs by page/paragraph; transcripts by speaker turn).
- **Boilerplate**: today's "line seen in ≥10 messages" rule generalises per source/kind (repeated note templates, document headers/footers, slide masters).
- **Scopes** (today's realms): work, private, and later finer ones (a project, a client). Fences at the server level as today.
- **Privacy rules**: today's exclusion rules (accounts, folders, senders, subjects) generalise to per-source rules evaluated at import *and* at query time.

### Connectors (contract)

Each connector is a small module that:
1. lists what changed since its last run (cursor/mtime/watch events),
2. yields normalized documents (+ attachments as child documents),
3. reports deletions,
4. is read-only toward the source.

Candidates, roughly by value: Outlook caches (exists), HEY `.eml` + backfill (exists in part), Apple Notes or Obsidian/Markdown folders, document folders (PDF/docx/xlsx/pptx: extraction code already exists for attachments), calendar (exists, ICS + legacy), Things to-dos, meeting transcripts (whisper models are already on this Mac), Zotero/literature PDFs.

### Search

- Keyword FTS + vector search, fused with RRF (exists), plus cross-encoder rerank (exists).
- Filters common to all kinds: source, kind, scope, date range, people, container.
- Results always say kind and source and how to open the original.
- Kind-specific tools stay thin wrappers (get_thread for mail, get_event for calendar…).
- Evaluation: the benchmark set (Part 1, step 6) grows per source; no search change without a before/after table.

### Migration path (no big bang)

1. **Rename and reframe** new-outlook-mcp as the index (working names: `mail-archive-mcp` → better something kind-neutral, e.g. `localindex`, `personal-index-mcp`). Keep `new-outlook` / `new-outlook-mcp` commands as aliases. Docs: Outlook is "a source".
2. **Introduce `documents`** next to `messages` via a schema migration (the migration mechanism from PR #16 exists for exactly this): either a view over `messages` first, then a real table that mail rows move into. Chunks and vectors key on document id.
3. **Move mail-specific code** (quote stripping, threading, realms by account) behind the `email` kind.
4. **Add the first non-mail connector** (a Markdown/notes folder is the easiest) and prove search across kinds.
5. **Then** consider splitting repos: index core + connectors as optional extras (`[outlook]`, `[notes]`, `[files]`). Splitting earlier would force an `.eml`-like interchange format and lose fields (folder, read state, cached attachments) that the in-process `MessageRecord` keeps.

### Open decisions (for the user)

- Name of the index project.
- Which non-mail source comes first (notes app? which one? document folders? transcripts?).
- Whether HEY's Feed/Paper Trail should be indexed at all (newsletters/receipts: useful for "when did I pay X", noisy otherwise).
- Scopes beyond work/private?
- Embedding model choice once the benchmark is broader (stay with e5-small + reranker vs. bge-m3).

### Lessons from today worth keeping

- Short repeated footers dominate vector search; drop repeated lines before embedding.
- Small multilingual embedders compress scores; a reranker is the cheap fix, recall is the hard part.
- Write test queries from what the document *says*, not from what you know about it (one test email was assumed to be about physiotherapy; its text never says so).
- Version the schema and the chunking rules separately; status should tell the user when a rebuild is worth it.
- Read-only opens must fail with a clear "run X to upgrade" message, not a SQL error.
