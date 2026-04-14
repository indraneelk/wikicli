# wikic — Wiki Compiler CLI Skill

Use this skill when managing a knowledge base wiki. wikic compiles unstructured documents into structured, interlinked wiki articles with concept extraction, cross-references, and search.

## Setup

A wikic project needs `config.yaml` in the working directory. If it doesn't exist, run:

```bash
wikic init --project <name>
```

This creates: `config.yaml`, `sources/`, `wiki/`, `.wikic/`

## Core Workflow

### 1. Add sources

```bash
wikic add path/to/document.md [more files...]
```

Copies files to `sources/`, tracks them in the manifest. Supports markdown and text files.

### 2. Compile

```bash
wikic compile           # incremental — only changed sources
wikic compile --full    # recompile everything
```

Pipeline: summarize → extract concepts → merge → write articles → generate index + MOC + changelog.

Output goes to `wiki/summaries/`, `wiki/concepts/`, `wiki/index.md`, `wiki/MOC.md`, `wiki/CHANGELOG.md`.

**This command calls the LLM.** Each source generates ~3 LLM calls (summarize, extract, write per concept). Budget time accordingly.

### 3. Check quality

```bash
wikic lint
```

No LLM. Returns JSON with broken wikilinks, missing fields, orphaned concepts, duplicates.

### 4b. Detect contradictions

```bash
wikic lint --contradictions           # detect contradictions between articles
wikic lint --contradictions --skip-llm   # fast check (no LLM, only candidates)
wikic lint --contradictions --fix     # auto-resolve conflicts
```

Uses shared-source analysis + LLM verification to find contradictory claims between wiki articles. Adds typed `contradicts` edges to the knowledge graph.

### 4c. Knowledge graph

```bash
wikic graph                        # JSON: nodes + typed edges
wikic graph --relations contradicts   # filter to contradiction edges only
wikic graph --format html -o graph.html
```

Exports the concept graph with typed relations (implements, extends, contradicts, cites, etc.). Use `--relations <type>` to filter by relation type.

### 5. Auto-fix issues

```bash
wikic heal
```

Uses LLM to fix broken wikilinks, fill missing sections, and resolve issues found by lint.

## Querying the Wiki

### For agents (Mode 2 — no LLM, you synthesize):

```bash
wikic search "keyword"
```

Returns JSON: `{results: [{slug, path, title, snippet, score, aliases, sources}]}`. Read the returned file paths directly and synthesize your own answer.

### For standalone use (Mode 1 — LLM answers):

```bash
wikic query "what is background removal?"
wikic query "what is background removal?" --save    # saves answer as wiki page
```

Uses LLM to answer from wiki content. Returns JSON with `answer` and `pages_used`.

## Other Commands

### Status

```bash
wikic status
```

Returns JSON: source count, concept count, pending/compiled/error states, last compile time.

### Remove a source

```bash
wikic remove sources/filename.md
```

Removes source file, its summary, and any orphaned concepts (concepts that only came from this source).

### Export concept graph

```bash
wikic graph                          # JSON to stdout
wikic graph --format dot -o graph.dot   # Graphviz DOT
wikic graph --format html -o graph.html # Interactive vis.js HTML
wikic graph --relations contradicts     # filter to contradictions
```

## Reading Wiki Content

Wiki articles live in `wiki/concepts/<slug>.md` with this structure:

```yaml
---
concept: <slug>
aliases: ["alt names"]
sources: ["sources/file.md"]
confidence: high|medium
tags: ["tag1", "tag2"]
conflicts_with: ["related-concept-slug"]
---

Sections: Definition, How it Works, Variants, Trade-offs, See Also.

Cross-references use `[[slug]]` wikilinks.

## Tips for Agents

- **Always start with `wikic status`** to understand the current state.
- **Use `wikic search`** (not `wikic query`) when you want to read and reason over content yourself.
- **Use `wikic lint`** after compile to check quality before presenting results.
- **All commands output JSON** to stdout. Parse it directly.
- **Compile is expensive** — check status first to see if sources are already compiled.
- **Read `wiki/index.md`** for a quick overview of all concepts and sources.
