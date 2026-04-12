# Chunking + Opencode Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add intelligent hybrid chunking for long source files and an opencode-cli provider with switchable free models to wikicli's compile pipeline.

**Architecture:** A new `chunker.ts` splits large files by markdown/Item headers (falling back to paragraph breaks), the compile loop parallel-summarizes chunks and merges them into one summary, and a new `opencode-cli` provider in `llm.ts` calls `opencode run` as a subprocess with stdin explicitly ignored to prevent hangs. A `--model` flag on `compile` overrides the config model at runtime.

**Tech Stack:** TypeScript (Node16 ESM), Commander.js, Node built-in `child_process.spawn`, `node:test` (Node 22 built-in test runner with `--experimental-strip-types`)

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `src/lib/chunker.ts` | Create | `chunkContent()` — hybrid header+paragraph splitter |
| `src/prompts/merge.ts` | Create | `MERGE_SYSTEM`, `buildMergePrompt()` — merge N chunk summaries |
| `src/lib/config.ts` | Modify | Add `chunk_threshold`, `chunk_size`, `min_chunk_size`; fix shallow merge bug |
| `src/lib/llm.ts` | Modify | Add `opencode-cli` provider case + `OPENCODE_FREE_MODELS` constant |
| `src/commands/compile.ts` | Modify | Chunked summarize loop + `--model` flag |
| `tests/lib/chunker.test.ts` | Create | Unit tests for `chunkContent` |
| `tests/lib/llm.test.ts` | Create | Unit tests for opencode output parser |

---

## Task 1: Test Infrastructure

**Files:**
- Modify: `package.json`
- Create: `tests/` directory

- [ ] **Step 1: Add test script to package.json**

Open `package.json` and replace the `"scripts"` block with:

```json
"scripts": {
  "build": "tsc",
  "dev": "tsc --watch",
  "start": "node dist/index.js",
  "test": "node --experimental-strip-types --test 'tests/**/*.test.ts'"
},
```

- [ ] **Step 2: Create tests directory**

```bash
mkdir -p tests/lib
```

- [ ] **Step 3: Verify Node version supports strip-types**

```bash
node --version
```

Expected: `v22.x.x`

- [ ] **Step 4: Commit**

```bash
git add package.json
git commit -m "chore: add test script using node --experimental-strip-types"
```

---

## Task 2: `src/lib/chunker.ts` with TDD

**Files:**
- Create: `src/lib/chunker.ts`
- Create: `tests/lib/chunker.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/lib/chunker.test.ts`:

```typescript
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chunkContent } from '../../src/lib/chunker.ts';

describe('chunkContent', () => {
  it('returns single-element array when content is at or below maxChars', () => {
    const content = 'Short content under limit.';
    const result = chunkContent(content, 8000, 1500);
    assert.deepEqual(result, ['Short content under limit.']);
  });

  it('returns single-element array when content equals maxChars exactly', () => {
    const content = 'x'.repeat(8000);
    const result = chunkContent(content, 8000, 1500);
    assert.equal(result.length, 1);
  });

  it('splits on markdown headers and keeps each section together', () => {
    const section1 = '# Section One\n\n' + 'word '.repeat(1200); // ~6000 chars
    const section2 = '# Section Two\n\n' + 'word '.repeat(1200);
    const content = section1 + '\n' + section2;
    const result = chunkContent(content, 8000, 1500);
    assert.equal(result.length, 2);
    assert.ok(result[0].includes('# Section One'));
    assert.ok(result[1].includes('# Section Two'));
    assert.ok(!result[0].includes('# Section Two'));
  });

  it('splits on 10-K Item N. patterns', () => {
    const item1 = 'Item 1. Business\n\n' + 'text '.repeat(1200); // ~6000 chars
    const item2 = 'Item 2. Risk Factors\n\n' + 'text '.repeat(1200);
    const content = item1 + '\n' + item2;
    const result = chunkContent(content, 8000, 1500);
    assert.equal(result.length, 2);
    assert.ok(result[0].startsWith('Item 1.'));
    assert.ok(result[1].startsWith('Item 2.'));
  });

  it('splits on PART markers', () => {
    const part1 = 'PART I\n\nSome intro content.\n\n' + 'text '.repeat(1200);
    const part2 = 'PART II\n\nMore content.\n\n' + 'text '.repeat(1200);
    const content = part1 + '\n' + part2;
    const result = chunkContent(content, 8000, 1500);
    assert.equal(result.length, 2);
    assert.ok(result[0].startsWith('PART I'));
    assert.ok(result[1].startsWith('PART II'));
  });

  it('merges accumulated sections when they fit within maxChars', () => {
    const s1 = '# A\n\n' + 'x '.repeat(500); // ~1000 chars
    const s2 = '# B\n\n' + 'x '.repeat(500);
    const s3 = '# C\n\n' + 'x '.repeat(500);
    const content = s1 + '\n' + s2 + '\n' + s3;
    const result = chunkContent(content, 8000, 1500);
    assert.equal(result.length, 1);
  });

  it('merges tiny chunks below minChars into predecessor', () => {
    const toc = 'Item 1. Business 1\nItem 2. Risk 5\n\n'; // ~40 chars
    const section1 = 'Item 1. Business\n\n' + 'content '.repeat(900); // ~7200 chars
    const section2 = 'Item 2. Risk\n\n' + 'content '.repeat(900);
    const content = toc + section1 + '\n' + section2;
    const result = chunkContent(content, 8000, 1500);
    result.forEach(chunk => {
      assert.ok(chunk.length >= 1500, `chunk too small (${chunk.length} chars): ${chunk.slice(0, 80)}`);
    });
  });

  it('falls back to paragraph splitting when no headers present', () => {
    const para = 'This is a paragraph of content that fills space. '.repeat(20) + '\n\n';
    const content = para.repeat(30); // ~30k chars, no headers
    const result = chunkContent(content, 8000, 1500);
    assert.ok(result.length > 1, 'should have split into multiple chunks');
    result.forEach(chunk => {
      assert.ok(chunk.length <= 8000, `chunk too large: ${chunk.length}`);
    });
  });

  it('never produces oversized chunks even with no paragraph breaks', () => {
    const content = 'x'.repeat(50000);
    const result = chunkContent(content, 8000, 1500);
    assert.ok(result.length > 1);
    result.forEach(chunk => {
      assert.ok(chunk.length <= 8000, `chunk too large: ${chunk.length}`);
    });
  });

  it('handles empty string', () => {
    const result = chunkContent('', 8000, 1500);
    assert.deepEqual(result, ['']);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm test
```

Expected: All tests FAIL with `Cannot find module '../../src/lib/chunker.ts'`

- [ ] **Step 3: Implement `src/lib/chunker.ts`**

Create `src/lib/chunker.ts`:

```typescript
const HEADER_RE = /^(#{1,3} |PART [IVX]+\b|Item \d+[A-Z]?\.\s)/;

export function chunkContent(
  content: string,
  maxChars: number,
  minChars: number
): string[] {
  if (content.length <= maxChars) return [content];

  const sections = splitIntoSections(content);

  if (sections.length <= 1) {
    return splitByParagraph(content, maxChars);
  }

  const raw = accumulateSections(sections, maxChars);
  return mergeTiny(raw, minChars);
}

function splitIntoSections(content: string): string[] {
  const lines = content.split('\n');
  const sections: string[] = [];
  let current: string[] = [];

  for (const line of lines) {
    if (current.length > 0 && HEADER_RE.test(line)) {
      sections.push(current.join('\n'));
      current = [line];
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) sections.push(current.join('\n'));
  return sections;
}

function accumulateSections(sections: string[], maxChars: number): string[] {
  const chunks: string[] = [];
  let acc = '';

  for (const section of sections) {
    if (section.length > maxChars) {
      if (acc) { chunks.push(acc); acc = ''; }
      chunks.push(...splitByParagraph(section, maxChars));
      continue;
    }
    const wouldBe = acc ? acc.length + 1 + section.length : section.length;
    if (acc && wouldBe > maxChars) {
      chunks.push(acc);
      acc = section;
    } else {
      acc = acc ? acc + '\n' + section : section;
    }
  }
  if (acc) chunks.push(acc);
  return chunks;
}

function splitByParagraph(content: string, maxChars: number): string[] {
  const chunks: string[] = [];
  let start = 0;

  while (start < content.length) {
    let end = Math.min(start + maxChars, content.length);
    if (end < content.length) {
      const breakAt = content.lastIndexOf('\n\n', end);
      if (breakAt > start) end = breakAt;
    }
    chunks.push(content.slice(start, end));
    start = end;
  }
  return chunks;
}

function mergeTiny(chunks: string[], minChars: number): string[] {
  const result: string[] = [];
  for (const chunk of chunks) {
    if (chunk.length < minChars && result.length > 0) {
      result[result.length - 1] += '\n' + chunk;
    } else {
      result.push(chunk);
    }
  }
  return result;
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm test
```

Expected: All 9 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/chunker.ts tests/lib/chunker.test.ts package.json
git commit -m "feat: add hybrid chunker with header and paragraph splitting"
```

---

## Task 3: `src/prompts/merge.ts`

**Files:**
- Create: `src/prompts/merge.ts`

- [ ] **Step 1: Create `src/prompts/merge.ts`**

```typescript
export const MERGE_SYSTEM = `You are a knowledge compiler. You have received summaries of multiple sequential chunks from the same source document. Merge them into one unified summary.

Output EXACTLY this format (no extra text):

---
source: {{source_path}}
source_type: article
compiled_at: {{current_iso_timestamp}}
---

# {{Document Title}}

## Key claims
- (deduplicated list of 5-15 main claims or facts across all chunks)

## Methodology
- (how the research/analysis was conducted, or "N/A" if not applicable)

## Results
- (synthesized findings and conclusions from all chunks)

## Concepts
- (comma-separated list of all distinct concept names across all chunks, use Title Case)

Rules:
- Deduplicate claims that appear in multiple chunks
- If figures conflict between chunks, use the most specific and detailed version
- Preserve every distinct concept even if it only appears in one chunk
- Infer the document title from the content if not stated explicitly
`;

export function buildMergePrompt(
  chunkSummaries: string[],
  sourcePath: string
): string {
  const chunksText = chunkSummaries
    .map((s, i) => `--- CHUNK ${i + 1} OF ${chunkSummaries.length} ---\n${s}`)
    .join('\n\n');

  return `Merge these ${chunkSummaries.length} chunk summaries from the same document into one unified summary.

Source path: ${sourcePath}
Current timestamp: ${new Date().toISOString()}

${chunksText}`;
}
```

- [ ] **Step 2: Build to check for TypeScript errors**

```bash
npm run build
```

Expected: Exits 0 with no errors.

- [ ] **Step 3: Commit**

```bash
git add src/prompts/merge.ts
git commit -m "feat: add merge prompt for combining chunk summaries"
```

---

## Task 4: Update `src/lib/config.ts`

**Files:**
- Modify: `src/lib/config.ts`
- Create: `tests/lib/config.test.ts`

Two changes: add three new compiler fields; fix the shallow-merge bug that wipes new default fields when config.yaml sets only some compiler keys.

- [ ] **Step 1: Write failing tests**

Create `tests/lib/config.test.ts`:

```typescript
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getDefaultConfig } from '../../src/lib/config.ts';

describe('getDefaultConfig', () => {
  it('includes chunk_threshold', () => {
    const cfg = getDefaultConfig();
    assert.equal(typeof cfg.compiler.chunk_threshold, 'number');
    assert.ok(cfg.compiler.chunk_threshold > 0);
  });

  it('includes chunk_size', () => {
    const cfg = getDefaultConfig();
    assert.equal(typeof cfg.compiler.chunk_size, 'number');
    assert.ok(cfg.compiler.chunk_size > 0);
  });

  it('includes min_chunk_size', () => {
    const cfg = getDefaultConfig();
    assert.equal(typeof cfg.compiler.min_chunk_size, 'number');
    assert.ok(cfg.compiler.min_chunk_size > 0);
  });

  it('chunk_threshold is greater than chunk_size', () => {
    const cfg = getDefaultConfig();
    assert.ok(
      cfg.compiler.chunk_threshold > cfg.compiler.chunk_size,
      `chunk_threshold (${cfg.compiler.chunk_threshold}) should be > chunk_size (${cfg.compiler.chunk_size})`
    );
  });

  it('opencode-cli is a valid provider type', () => {
    const cfg = getDefaultConfig();
    // Type check: assign opencode-cli to verify it's in the union
    const provider: typeof cfg.llm.provider = 'opencode-cli';
    assert.ok(provider);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm test
```

Expected: Config tests FAIL with property `chunk_threshold` being undefined.

- [ ] **Step 3: Replace `src/lib/config.ts` with updated version**

```typescript
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { parse as parseYaml } from "yaml";

export interface WikicConfig {
  version: number;
  project: string;
  description: string;
  sources_dir: string;
  output_dir: string;
  llm: {
    provider: "claude-cli" | "anthropic" | "openai" | "ollama" | "opencode-cli";
    model?: string;
  };
  compiler: {
    max_parallel: number;
    summary_max_tokens: number;
    article_max_tokens: number;
    auto_lint: boolean;
    chunk_threshold: number;
    chunk_size: number;
    min_chunk_size: number;
  };
}

const DEFAULT_CONFIG: WikicConfig = {
  version: 1,
  project: "my-wiki",
  description: "A wikic project",
  sources_dir: "sources",
  output_dir: "wiki",
  llm: {
    provider: "claude-cli",
  },
  compiler: {
    max_parallel: 3,
    summary_max_tokens: 2000,
    article_max_tokens: 4000,
    auto_lint: true,
    chunk_threshold: 12000,
    chunk_size: 8000,
    min_chunk_size: 1500,
  },
};

export function getDefaultConfig(): WikicConfig {
  return {
    ...DEFAULT_CONFIG,
    llm: { ...DEFAULT_CONFIG.llm },
    compiler: { ...DEFAULT_CONFIG.compiler },
  };
}

export function loadConfig(dir: string = process.cwd()): WikicConfig {
  const configPath = join(dir, "config.yaml");
  if (!existsSync(configPath)) {
    throw new Error(
      `No config.yaml found in ${dir}. Run 'wikic init' first.`
    );
  }
  const raw = readFileSync(configPath, "utf-8");
  const parsed = parseYaml(raw);
  return {
    ...DEFAULT_CONFIG,
    ...parsed,
    llm: { ...DEFAULT_CONFIG.llm, ...parsed?.llm },
    compiler: { ...DEFAULT_CONFIG.compiler, ...parsed?.compiler },
  };
}

export function configToYaml(config: WikicConfig): string {
  const lines = [
    `version: ${config.version}`,
    `project: ${config.project}`,
    `description: "${config.description}"`,
    `sources_dir: ${config.sources_dir}`,
    `output_dir: ${config.output_dir}`,
    ``,
    `llm:`,
    `  provider: ${config.llm.provider}`,
    ...(config.llm.model ? [`  model: ${config.llm.model}`] : []),
    ``,
    `compiler:`,
    `  max_parallel: ${config.compiler.max_parallel}`,
    `  summary_max_tokens: ${config.compiler.summary_max_tokens}`,
    `  article_max_tokens: ${config.compiler.article_max_tokens}`,
    `  auto_lint: ${config.compiler.auto_lint}`,
    `  chunk_threshold: ${config.compiler.chunk_threshold}`,
    `  chunk_size: ${config.compiler.chunk_size}`,
    `  min_chunk_size: ${config.compiler.min_chunk_size}`,
  ];
  return lines.join("\n") + "\n";
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm test
```

Expected: All tests PASS (config + chunker).

- [ ] **Step 5: Commit**

```bash
git add src/lib/config.ts tests/lib/config.test.ts
git commit -m "feat: add chunk config fields and fix shallow-merge in loadConfig"
```

---

## Task 5: Add `opencode-cli` Provider to `src/lib/llm.ts`

**Files:**
- Modify: `src/lib/llm.ts`
- Create: `tests/lib/llm.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/lib/llm.test.ts`:

```typescript
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { OPENCODE_FREE_MODELS, extractOpencodeText } from '../../src/lib/llm.ts';

describe('OPENCODE_FREE_MODELS', () => {
  it('contains exactly 4 entries', () => {
    assert.equal(OPENCODE_FREE_MODELS.length, 4);
  });

  it('all entries start with opencode/', () => {
    for (const m of OPENCODE_FREE_MODELS) {
      assert.ok(m.startsWith('opencode/'), `"${m}" does not start with "opencode/"`);
    }
  });
});

describe('extractOpencodeText', () => {
  it('extracts text from message.part.updated events', () => {
    const output = [
      '{"type":"session.created","properties":{"id":"s1"}}',
      '{"type":"message.part.updated","properties":{"part":{"type":"text","text":"Hello "}}}',
      '{"type":"message.part.updated","properties":{"part":{"type":"text","text":"world"}}}',
      '{"type":"session.idle","properties":{"sessionID":"s1"}}',
    ].join('\n');
    assert.equal(extractOpencodeText(output), 'Hello world');
  });

  it('ignores non-text part types', () => {
    const output = [
      '{"type":"message.part.updated","properties":{"part":{"type":"tool-invocation","toolName":"read"}}}',
      '{"type":"message.part.updated","properties":{"part":{"type":"text","text":"Result"}}}',
    ].join('\n');
    assert.equal(extractOpencodeText(output), 'Result');
  });

  it('falls back to raw stdout when no structured events found', () => {
    const output = 'plain text response\nno json here';
    assert.equal(extractOpencodeText(output), 'plain text response\nno json here');
  });

  it('returns empty string for empty output', () => {
    assert.equal(extractOpencodeText(''), '');
  });

  it('handles malformed JSON lines gracefully', () => {
    const output = [
      'not json at all',
      '{"type":"message.part.updated","properties":{"part":{"type":"text","text":"OK"}}}',
    ].join('\n');
    assert.equal(extractOpencodeText(output), 'OK');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm test
```

Expected: FAIL — `OPENCODE_FREE_MODELS` and `extractOpencodeText` not exported.

- [ ] **Step 3: Replace `src/lib/llm.ts` with updated version**

```typescript
import { execFile, spawn } from "child_process";
import { loadConfig, WikicConfig } from "./config.js";

export interface LLMResponse {
  text: string;
  ok: boolean;
  error?: string;
}

export const OPENCODE_FREE_MODELS = [
  "opencode/big-pickle",
  "opencode/minimax-m2-5-free",
  "opencode/qwen3-6-plus-free",
  "opencode/nemotron-3-super-free",
] as const;

/**
 * Call an LLM with a system prompt and user message.
 * Supports claude-cli and opencode-cli providers.
 */
export async function llmCall(
  systemPrompt: string,
  userMessage: string,
  config?: WikicConfig
): Promise<LLMResponse> {
  const cfg = config ?? loadConfig();
  const provider = cfg.llm.provider;

  switch (provider) {
    case "claude-cli":
      return claudeCliCall(systemPrompt, userMessage, cfg.llm.model);
    case "opencode-cli":
      return opencodeCliCall(
        systemPrompt,
        userMessage,
        cfg.llm.model ?? OPENCODE_FREE_MODELS[0]
      );
    default:
      return {
        text: "",
        ok: false,
        error: `Provider "${provider}" not yet implemented. Use "claude-cli" or "opencode-cli".`,
      };
  }
}

async function claudeCliCall(
  systemPrompt: string,
  userMessage: string,
  model?: string
): Promise<LLMResponse> {
  const combinedPrompt = `${systemPrompt}\n\n---\n\n${userMessage}`;
  const args = ["-p", combinedPrompt, "--output-format", "text"];
  if (model) args.push("--model", model);

  return new Promise((resolve) => {
    execFile(
      "claude",
      args,
      { maxBuffer: 1024 * 1024 * 10 },
      (err, stdout, stderr) => {
        if (err) {
          resolve({
            text: "",
            ok: false,
            error: `claude CLI error: ${err.message}\n${stderr}`,
          });
        } else {
          resolve({ text: stdout.trim(), ok: true });
        }
      }
    );
  });
}

async function opencodeCliCall(
  systemPrompt: string,
  userMessage: string,
  model: string
): Promise<LLMResponse> {
  const combinedPrompt = `${systemPrompt}\n\n---\n\n${userMessage}`;
  const args = ["run", combinedPrompt, "--model", model, "--format", "json"];

  return new Promise((resolve) => {
    const child = spawn("opencode", args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });

    child.on("close", (code) => {
      if (code !== 0) {
        resolve({
          text: "",
          ok: false,
          error: `opencode error (exit ${code}): ${stderr.slice(0, 500)}`,
        });
        return;
      }
      resolve({ text: extractOpencodeText(stdout).trim(), ok: true });
    });

    child.on("error", (err) => {
      resolve({
        text: "",
        ok: false,
        error: `opencode spawn error: ${err.message}`,
      });
    });
  });
}

/**
 * Extracts assistant text from opencode --format json event stream.
 * Each line is a JSON event; accumulates text from message.part.updated events.
 * Falls back to raw stdout if no structured events are found.
 */
export function extractOpencodeText(output: string): string {
  const lines = output.split('\n').filter(l => l.trim());
  const parts: string[] = [];

  for (const line of lines) {
    try {
      const event = JSON.parse(line);
      if (
        event.type === 'message.part.updated' &&
        event.properties?.part?.type === 'text' &&
        typeof event.properties.part.text === 'string'
      ) {
        parts.push(event.properties.part.text);
      }
    } catch {
      // non-JSON line — skip
    }
  }

  if (parts.length > 0) return parts.join('');
  return output; // fallback: return raw stdout
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm test
```

Expected: All tests PASS (llm + chunker + config)

- [ ] **Step 5: Commit**

```bash
git add src/lib/llm.ts tests/lib/llm.test.ts
git commit -m "feat: add opencode-cli provider with free model list and json output parser"
```

---

## Task 6: Chunked Summarize Loop in `src/commands/compile.ts`

**Files:**
- Modify: `src/commands/compile.ts`

Replaces the summarize loop with a chunk-aware version. All other sections (concept extraction, article writing, index generation) are unchanged.

- [ ] **Step 1: Add new imports at the top of `src/commands/compile.ts`**

After line 11 (`import { WRITE_SYSTEM, buildWritePrompt } from "../prompts/write.js";`), add:

```typescript
import { chunkContent } from "../lib/chunker.js";
import { MERGE_SYSTEM, buildMergePrompt } from "../prompts/merge.js";
```

- [ ] **Step 2: Add `runParallel` helper before the `compileCommand` export**

Insert before `export const compileCommand`:

```typescript
async function runParallel<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;

  async function worker(): Promise<void> {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    () => worker()
  );
  await Promise.all(workers);
  return results;
}
```

- [ ] **Step 3: Add `summarizeSource` helper before the `compileCommand` export**

Insert after `runParallel`, still before `export const compileCommand`:

```typescript
async function summarizeSource(
  sourcePath: string,
  content: string,
  config: import("../lib/config.js").WikicConfig,
  dir: string
): Promise<{ ok: boolean; summaryPath?: string; error?: string }> {
  const summaryFileName =
    sourcePath.replace(/^.*\//, "").replace(/\.md$/, "") + ".md";
  const summaryPath = join(config.output_dir, "summaries", summaryFileName);

  if (content.length <= config.compiler.chunk_threshold) {
    const resp = await llmCall(
      SUMMARIZE_SYSTEM,
      buildSummarizePrompt(sourcePath, content),
      config
    );
    if (!resp.ok) return { ok: false, error: resp.error };
    writeText(join(dir, summaryPath), resp.text);
    return { ok: true, summaryPath };
  }

  const chunks = chunkContent(
    content,
    config.compiler.chunk_size,
    config.compiler.min_chunk_size
  );
  console.error(`  ${sourcePath}: ${chunks.length} chunks, summarizing in parallel...`);

  const chunkResults = await runParallel(
    chunks,
    config.compiler.max_parallel,
    (chunk, i) =>
      llmCall(
        SUMMARIZE_SYSTEM,
        buildSummarizePrompt(
          `Chunk ${i + 1} of ${chunks.length} from: ${sourcePath}`,
          chunk
        ),
        config
      )
  );

  const failed = chunkResults.find((r) => !r.ok);
  if (failed) return { ok: false, error: failed.error };

  const mergeResp = await llmCall(
    MERGE_SYSTEM,
    buildMergePrompt(chunkResults.map((r) => r.text), sourcePath),
    config
  );
  if (!mergeResp.ok) return { ok: false, error: mergeResp.error };

  writeText(join(dir, summaryPath), mergeResp.text);
  return { ok: true, summaryPath };
}
```

- [ ] **Step 4: Replace the summarize loop in the compile action**

Find this block (lines ~72–93):

```typescript
    // Step 2: Summarize
    const summariesDir = join(dir, config.output_dir, "summaries");
    ensureDir(summariesDir);

    for (const sourcePath of toProcess) {
      const content = readText(join(dir, sourcePath));
      console.error(`  Summarizing ${sourcePath}...`);
      const resp = await llmCall(
        SUMMARIZE_SYSTEM,
        buildSummarizePrompt(sourcePath, content),
        config
      );

      if (!resp.ok) {
        stats.errors.push(`Summarize failed for ${sourcePath}: ${resp.error}`);
        manifest.sources[sourcePath].status = "error";
        continue;
      }

      const summaryFileName = sourcePath.replace(/^.*\//, "").replace(/\.md$/, "") + ".md";
      const summaryPath = join(config.output_dir, "summaries", summaryFileName);
      writeText(join(dir, summaryPath), resp.text);
      manifest.sources[sourcePath].summary_path = summaryPath;
      manifest.sources[sourcePath].compiled_at = new Date().toISOString();
      stats.summarized++;
    }
```

Replace with:

```typescript
    // Step 2: Summarize (with chunking for large files)
    const summariesDir = join(dir, config.output_dir, "summaries");
    ensureDir(summariesDir);

    for (const sourcePath of toProcess) {
      const content = readText(join(dir, sourcePath));
      console.error(`  Summarizing ${sourcePath}...`);

      const result = await summarizeSource(sourcePath, content, config, dir);

      if (!result.ok) {
        stats.errors.push(`Summarize failed for ${sourcePath}: ${result.error}`);
        manifest.sources[sourcePath].status = "error";
        continue;
      }

      manifest.sources[sourcePath].summary_path = result.summaryPath;
      manifest.sources[sourcePath].compiled_at = new Date().toISOString();
      stats.summarized++;
    }
```

- [ ] **Step 5: Build to check for TypeScript errors**

```bash
npm run build
```

Expected: Exits 0 with no errors.

- [ ] **Step 6: Commit**

```bash
git add src/commands/compile.ts
git commit -m "feat: chunked summarize loop with parallel processing and merge step"
```

---

## Task 7: `--model` Flag on `compile`

**Files:**
- Modify: `src/commands/compile.ts`

- [ ] **Step 1: Add `OPENCODE_FREE_MODELS` import**

At the top of `src/commands/compile.ts`, add to the existing llm import line:

```typescript
import { llmCall, OPENCODE_FREE_MODELS } from "../lib/llm.js";
```

(Replace the existing `import { llmCall } from "../lib/llm.js";`)

- [ ] **Step 2: Add `--model` option to `compileCommand` definition**

Find:

```typescript
export const compileCommand = new Command("compile")
  .description("Compile sources into wiki articles")
  .option("--full", "Force full recompilation")
  .action(async (opts) => {
```

Replace with:

```typescript
export const compileCommand = new Command("compile")
  .description("Compile sources into wiki articles")
  .option("--full", "Force full recompilation")
  .option(
    "--model <id>",
    "Override LLM model for this run (does not modify config.yaml).\n" +
    "Free opencode models:\n" +
    OPENCODE_FREE_MODELS.map((m) => `  ${m}`).join("\n")
  )
  .action(async (opts) => {
```

- [ ] **Step 3: Apply model override at the top of the action body**

Find the first two lines of the action body:

```typescript
    const dir = process.cwd();
    const config = loadConfig(dir);
```

Replace with:

```typescript
    const dir = process.cwd();
    const baseConfig = loadConfig(dir);
    const config = opts.model
      ? { ...baseConfig, llm: { ...baseConfig.llm, model: opts.model as string } }
      : baseConfig;
```

- [ ] **Step 4: Build and verify help text**

```bash
npm run build && node dist/index.js compile --help
```

Expected output includes a `--model` option listing all 4 free models.

- [ ] **Step 5: Run full test suite**

```bash
npm test
```

Expected: All tests PASS.

- [ ] **Step 6: Final commit**

```bash
git add src/commands/compile.ts
git commit -m "feat: add --model flag to compile command with free opencode model list in help"
```

---

## Spec Coverage

| Requirement | Task |
|---|---|
| Hybrid chunker: headers first, paragraph fallback | Task 2 |
| `min_chunk_size` merge for tiny fragments | Task 2 |
| `chunk_threshold`, `chunk_size`, `min_chunk_size` config fields | Task 4 |
| Fix shallow-merge in `loadConfig` | Task 4 |
| Parallel chunk summarization up to `max_parallel` | Task 6 |
| Merge prompt for N chunk summaries | Task 3 + 6 |
| Error if any chunk fails — mark source as error | Task 6 |
| Downstream pipeline unchanged (extract, write) | Task 6 |
| `opencode-cli` provider in `llm.ts` | Task 5 |
| `OPENCODE_FREE_MODELS` exported constant | Task 5 |
| `stdin: ignore` to prevent subprocess hang | Task 5 |
| JSON event stream parsing with raw fallback | Task 5 |
| `--model` flag overrides config at runtime | Task 7 |
| Help text lists all 4 free model IDs | Task 7 |
| `configToYaml` outputs new fields (for `wikic init`) | Task 4 |
