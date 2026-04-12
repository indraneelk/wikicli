# Design: Intelligent Chunking + Opencode Provider

**Date:** 2026-04-11  
**Status:** Approved  

---

## Overview

Two independent enhancements to `wikic compile`:

1. **Intelligent chunking** — long source files are split into semantic chunks before summarization, processed in parallel, then merged into a single unified summary. Prevents token overload and improves LLM output quality on large documents (e.g. 10-K filings, long research papers).
2. **Opencode CLI provider** — adds `opencode-cli` as a provider in `llm.ts`, enabling use of free models via the `opencode` CLI. A `--model` flag on `compile` allows runtime model switching without editing config.

---

## Feature 1: Intelligent Chunking

### Motivation

The current compile pipeline sends entire file content to the LLM for summarization. A typical 10-K filing is ~270k characters — far beyond what produces good summarization output. The existing `summary_max_tokens` and `article_max_tokens` config fields exist but are not enforced anywhere.

### Algorithm (`src/lib/chunker.ts`)

Exported function: `chunkContent(content: string, maxChars: number, minChars: number): string[]`

**Hybrid approach:**

1. If `content.length <= maxChars` → return `[content]` (no chunking, zero overhead for short files).
2. Split on markdown headers (`^#{1,3} `) AND 10-K/SEC-style section markers (`^PART [IVX]+`, `^Item \d+[A-Z]?\.`). Walk sections accumulating character count; when adding the next section would exceed `maxChars`, flush the accumulation as a chunk.
3. If a single section itself exceeds `maxChars`, split it on paragraph boundaries (`\n\n`) rather than mid-sentence. Fixed-size fallback used only when no paragraph break is found.
4. After all chunks are accumulated, merge any chunk smaller than `minChars` into its predecessor. This eliminates TOC fragments and boilerplate stubs (validated on Apple 10-K: produces 2 sub-threshold fragments — TOC header and Sarbanes-Oxley exhibit).

**Validated on Apple 10-K FY2023 (268,422 chars, 8k chunk_size):**
- 48 clean chunks, all within size bounds
- All 4 key sections (Item 1, 1A, 7, 8) start their own chunk — no cross-section blending
- Zero oversized chunks

### Config additions (`config.yaml`)

```yaml
compiler:
  chunk_threshold: 12000   # chars; files at or below this skip chunking entirely
  chunk_size: 8000         # max chars per chunk
  min_chunk_size: 1500     # chunks below this are merged into their predecessor
```

### Summarization pipeline change (`src/commands/compile.ts`)

For each source file in the summarize loop:

1. Call `chunkContent(content, config.compiler.chunk_size, config.compiler.min_chunk_size)`.
2. If single chunk → existing code path, no change.
3. If multiple chunks:
   - Summarize each chunk in **parallel** (up to `config.compiler.max_parallel`), using a modified prompt that labels the chunk (e.g. "Chunk 2 of 4 from: path/to/file.md").
   - If **any** chunk summarization fails → mark source as `error`, skip merge (same error behaviour as today).
   - On success → call merge prompt with all chunk summaries as input.
   - Write merged summary to disk. Everything downstream (extract concepts, write articles) is unchanged — they still see one summary per source file.

### New prompt (`src/prompts/merge.ts`)

Takes N chunk summaries, each labelled with its chunk index. Produces one unified summary in the same frontmatter+sections format as `summarize.ts`. Instructs the model to deduplicate claims, reconcile any conflicting figures, and preserve all distinct concepts.

---

## Feature 2: Opencode CLI Provider + Model Switching

### Provider (`src/lib/llm.ts`)

New case `opencode-cli` in the `llmCall` switch. Invokes:

```
opencode run "<combined_prompt>" --model <modelID> --format json
```

via `execFile` with `stdin: 'ignore'` — stdin explicitly ignored to prevent the known subprocess hang. Response text is accumulated from the JSON event stream by collecting text parts.

The 4 free models are defined as a hardcoded exported constant (used by both the provider and the CLI help text):

```typescript
export const OPENCODE_FREE_MODELS = [
  "opencode/big-pickle",
  "opencode/minimax-m2-5-free",
  "opencode/qwen3-6-plus-free",
  "opencode/nemotron-3-super-free",
] as const;
```

### Config default

```yaml
llm:
  provider: opencode-cli
  model: opencode/big-pickle
```

### `--model` flag on `compile`

```
wikic compile --model opencode/qwen3-6-plus-free
```

Overrides `config.llm.model` for the duration of the run only. No config file is mutated.

The flag's help description lists all 4 free model IDs inline:

```
--model <id>   Override LLM model for this run.
               Free opencode models:
                 opencode/big-pickle (default)
                 opencode/minimax-m2-5-free
                 opencode/qwen3-6-plus-free
                 opencode/nemotron-3-super-free
```

All other commands (`query`, `heal`, `search`) that call `llmCall` inherit the config model as before — no `--model` flag added to them in this iteration.

---

## Files Changed

| File | Change |
|---|---|
| `src/lib/chunker.ts` | **New** — `chunkContent()` hybrid chunker |
| `src/prompts/merge.ts` | **New** — merge N chunk summaries into one |
| `src/lib/llm.ts` | Add `opencode-cli` provider case + `OPENCODE_FREE_MODELS` constant |
| `src/commands/compile.ts` | Chunked summarize loop + `--model` flag |
| `src/lib/config.ts` | Add `chunk_threshold`, `chunk_size`, `min_chunk_size` fields with defaults |

No changes to: `extract.ts`, `write.ts`, `manifest.ts`, `query.ts`, `heal.ts`, `graph.ts`.

---

## What Is Not In Scope

- `--model` flag on `query`, `heal`, or other commands
- Parallel chunk summarization across multiple source files simultaneously (already handled by `max_parallel` at the source level)
- Streaming output from opencode
- Auto-detection of which free model has quota remaining
