# Compile Pipeline Cost Reduction + Contradiction-Aware Compilation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal Part 1:** Reduce LLM calls by ~50% by combining write+relate into one prompt per concept, combining summarize+extract into one prompt per source, eliminating the merge LLM call for large sources, and parallelising article writes.

**Goal Part 2:** Make contradiction detection a first-class post-compile step. Every compile run surfaces updated contradiction candidates for human review. High-confidence verified contradictions get written to the graph; pending ones go to a review queue.

**Architecture:** Two new prompt files replace four old ones (`writeAndRelate.ts` replaces `write.ts`+`relate.ts`; `summarizeAndExtract.ts` replaces `summarize.ts`+`extract.ts`+`merge.ts`). Both use a sentinel comment (`<!-- X_JSON ... -->`) to embed JSON inside Markdown output. A new `wikic contradictions` command provides a human-review workflow. Post-compile runs `lint --contradictions` automatically, with incremental checking making it nearly free on unchanged content.

**Tech Stack:** TypeScript ESM (Node16 module resolution), Node 22, `node:test`. Test command: `node --experimental-strip-types --import ./tests/loader.mjs --test 'tests/**/*.test.ts'`. Build: `npm run build` (tsc).

---

## LLM Call Count: Before vs After

| Phase | Before | After | Saving |
|---|---|---|---|
| Small source (<=12 KB) | 1 summarize + 1 extract = **2** | 1 summarize+extract = **1** | -50% |
| Large source (N chunks) | N chunk-summarize + 1 merge + 1 extract = **N+2** | N chunk-summarize+extract = **N** | -2 calls |
| Per concept | 1 write + 1 relate = **2** | 1 write+relate = **1** | -50% |
| **Typical run** (5 sources avg 2 chunks, 10 concepts) | **40** | **20** | **-50%** |
| Post-compile contradiction check | 0 (manual) | candidates + LLM verification (incremental) | depends on pairs |

---

## File Map

**Create:**
- `src/prompts/writeAndRelate.ts` — combined write+relate system prompt, user prompt builder, sentinel parser
- `src/prompts/summarizeAndExtract.ts` — combined summarize+extract system prompt, user prompt builder, sentinel parser
- `src/commands/contradictions.ts` — human review command: `wikic contradictions`, `wikic contradictions --review <pair>`, `wikic contradictions --export`
- `tests/prompts/writeAndRelate.test.ts` — 6 unit tests for the parser
- `tests/prompts/summarizeAndExtract.test.ts` — 6 unit tests for the parser
- `tests/lib/compile.test.ts` — 5 unit tests for `mergeExtractedConcepts`
- `tests/commands/contradictions.test.ts` — integration tests for the contradictions command

**Modify:**
- `src/commands/compile.ts` — rewrite `summarizeSource()`, export `mergeExtractedConcepts`, remove extract phase, replace write+relate loop with parallel `writeAndRelate`, add post-compile contradiction check
- `src/index.ts` — register `contradictionsCommand`
- `src/commands/lint.ts` — expose contradiction functions so `compile` can call them; add `--export-candidates <path>` flag

**Keep (not imported after this plan, left as reference):**
- `src/prompts/summarize.ts`, `src/prompts/extract.ts`, `src/prompts/write.ts`, `src/prompts/relate.ts`, `src/prompts/merge.ts`

**Deleted (replaced):**
- `src/prompts/relate.ts` — replaced by `writeAndRelate.ts`

---

## LLM Call Reduction Tasks (1-6)

### Task 1: Create `writeAndRelate.ts` — combined prompt and parser

**Files:**
- Create: `src/prompts/writeAndRelate.ts`
- Create: `tests/prompts/writeAndRelate.test.ts`

The combined prompt instructs the LLM to write the full article markdown and then append a `<!-- RELATIONS_JSON ... -->` sentinel block containing a JSON array of relations. The parser splits on that sentinel.

- [ ] **Step 1: Write the failing tests**

Create `tests/prompts/writeAndRelate.test.ts`:

```typescript
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseWriteAndRelateResponse } from '../../src/prompts/writeAndRelate.ts';

describe('parseWriteAndRelateResponse', () => {
  it('extracts article and relations from well-formed output', () => {
    const text = [
      '---',
      'concept: transformer',
      'aliases: []',
      'sources: ["sources/paper.md"]',
      'confidence: high',
      'tags: ["ml"]',
      'created_at: 2026-01-01T00:00:00.000Z',
      '---',
      '',
      '# Transformer',
      '',
      '## Definition',
      'An attention-based neural network.',
      '',
      '## See Also',
      '[[attention-mechanism]]',
      '',
      '<!-- RELATIONS_JSON',
      '[{"target":"attention-mechanism","type":"implements","evidence":"built on multi-head attention"}]',
      '-->',
    ].join('\n');

    const result = parseWriteAndRelateResponse(text);
    assert.ok(result.article.includes('# Transformer'));
    assert.ok(!result.article.includes('RELATIONS_JSON'));
    assert.equal(result.relations.length, 1);
    assert.equal(result.relations[0].target, 'attention-mechanism');
    assert.equal(result.relations[0].type, 'implements');
    assert.equal(result.relations[0].evidence, 'built on multi-head attention');
  });

  it('returns empty relations when sentinel is absent', () => {
    const text = '---\nconcept: transformer\n---\n\n# Transformer\n\nNo relations block here.';
    const result = parseWriteAndRelateResponse(text);
    assert.ok(result.article.includes('# Transformer'));
    assert.deepEqual(result.relations, []);
  });

  it('returns empty relations when JSON is malformed', () => {
    const text = '# Transformer\n\n<!-- RELATIONS_JSON\nnot valid json\n-->';
    const result = parseWriteAndRelateResponse(text);
    assert.ok(result.article.includes('# Transformer'));
    assert.deepEqual(result.relations, []);
  });

  it('returns empty relations when closing --> is missing', () => {
    const text = '# Transformer\n\n<!-- RELATIONS_JSON\n[{"target":"foo","type":"implements","evidence":"bar"}]';
    const result = parseWriteAndRelateResponse(text);
    assert.deepEqual(result.relations, []);
  });

  it('handles empty relations array', () => {
    const text = '# Transformer\n\n<!-- RELATIONS_JSON\n[]\n-->';
    const result = parseWriteAndRelateResponse(text);
    assert.deepEqual(result.relations, []);
  });

  it('trims whitespace from article portion', () => {
    const text = '  # Transformer  \n\n<!-- RELATIONS_JSON\n[]\n-->';
    const result = parseWriteAndRelateResponse(text);
    assert.equal(result.article, '# Transformer');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
node --experimental-strip-types --import ./tests/loader.mjs --test 'tests/prompts/writeAndRelate.test.ts'
```

Expected: FAIL — `Cannot find module` because `writeAndRelate.ts` does not exist yet.

- [ ] **Step 3: Create `src/prompts/writeAndRelate.ts`**

```typescript
export interface ParsedRelation {
  target: string;
  type: string;
  evidence: string;
}

export interface WriteAndRelateResult {
  article: string;
  relations: ParsedRelation[];
}

const RELATIONS_SENTINEL = '<!-- RELATIONS_JSON';
const RELATIONS_END = '-->';

export const WRITE_AND_RELATE_SYSTEM = `You are a wiki article writer and knowledge graph builder. Given a concept and source material, write a structured wiki article AND extract typed relationships in one response.

Output EXACTLY this format (no extra text before or after):

---
concept: {{slug}}
aliases: {{aliases_json_array}}
sources: {{sources_json_array}}
confidence: {{high_or_medium}}
tags: {{tags_json_array}}
created_at: {{timestamp}}
---

# {{Concept Name}}

## Definition
(Clear, concise explanation of what this concept is)

## How it Works
(Technical or operational details)

## Variants
(Different forms, implementations, or approaches — or "N/A")

## Trade-offs
(Strengths vs weaknesses, costs vs benefits)

## See Also
[[related-concept-1]], [[related-concept-2]]

<!-- RELATIONS_JSON
[{"target":"slug","type":"relation-type","evidence":"why (1-2 sentences from source)"}]
-->

Rules for the article:
- Use [[lowercase-hyphenated-slug]] wikilinks only for concepts in the provided concept list
- Place wikilinks in "See Also" and inline where relevant

Rules for RELATIONS_JSON:
- Relation types: implements, extends, optimizes, contradicts, cites, prerequisite_of, trades_off, derived_from
- target must be a slug (lowercase, hyphenated) matching an existing concept in the list
- evidence: 1-2 sentence excerpt from source material supporting the relationship
- Return [] if no meaningful relations found
- The JSON must be valid — double-check brackets and quotes before outputting
`;

export function buildWriteAndRelatePrompt(
  conceptName: string,
  slug: string,
  aliases: string[],
  sources: string[],
  confidence: string,
  sourceContent: string,
  existingConcepts: string[]
): string {
  return `Write a wiki article and extract relationships for this concept.

Concept: ${conceptName}
Slug: ${slug}
Aliases: ${JSON.stringify(aliases)}
Sources: ${JSON.stringify(sources)}
Confidence: ${confidence}
Timestamp: ${new Date().toISOString()}

Known concepts (for wikilinks): ${existingConcepts.join(', ')}

--- SOURCE MATERIAL ---
${sourceContent}
--- END SOURCE MATERIAL ---`;
}

export function parseWriteAndRelateResponse(text: string): WriteAndRelateResult {
  const sentinelIdx = text.indexOf(RELATIONS_SENTINEL);
  if (sentinelIdx === -1) return { article: text.trim(), relations: [] };

  const article = text.slice(0, sentinelIdx).trim();
  const jsonStart = sentinelIdx + RELATIONS_SENTINEL.length;
  const jsonEnd = text.indexOf(RELATIONS_END, jsonStart);
  if (jsonEnd === -1) return { article, relations: [] };

  try {
    const relations = JSON.parse(text.slice(jsonStart, jsonEnd).trim()) as ParsedRelation[];
    return { article, relations };
  } catch {
    return { article, relations: [] };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
node --experimental-strip-types --import ./tests/loader.mjs --test 'tests/prompts/writeAndRelate.test.ts'
```

Expected: 6 passing, 0 failing.

- [ ] **Step 5: Commit**

```bash
git add src/prompts/writeAndRelate.ts tests/prompts/writeAndRelate.test.ts
git commit -m "feat: add writeAndRelate combined prompt and parser"
```

---

### Task 2: Create `summarizeAndExtract.ts` — combined prompt and parser

**Files:**
- Create: `src/prompts/summarizeAndExtract.ts`
- Create: `tests/prompts/summarizeAndExtract.test.ts`

Same sentinel pattern: summary markdown followed by `<!-- CONCEPTS_JSON ... -->`.

- [ ] **Step 1: Write the failing tests**

Create `tests/prompts/summarizeAndExtract.test.ts`:

```typescript
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseSummarizeAndExtractResponse } from '../../src/prompts/summarizeAndExtract.ts';

describe('parseSummarizeAndExtractResponse', () => {
  it('extracts summary and concepts from well-formed output', () => {
    const text = [
      '---',
      'source: sources/paper.md',
      'source_type: article',
      'compiled_at: 2026-01-01T00:00:00.000Z',
      '---',
      '',
      '# Neural Networks',
      '',
      '## Key claims',
      '- Deep learning outperforms shallow methods',
      '',
      '## Concepts',
      '- Neural Network, Backpropagation',
      '',
      '<!-- CONCEPTS_JSON',
      '[{"name":"Neural Network","aliases":["NN","neural net"],"confidence":"high"},{"name":"Backpropagation","aliases":["backprop"],"confidence":"high"}]',
      '-->',
    ].join('\n');

    const result = parseSummarizeAndExtractResponse(text);
    assert.ok(result.summary.includes('# Neural Networks'));
    assert.ok(!result.summary.includes('CONCEPTS_JSON'));
    assert.equal(result.concepts.length, 2);
    assert.equal(result.concepts[0].name, 'Neural Network');
    assert.deepEqual(result.concepts[0].aliases, ['NN', 'neural net']);
    assert.equal(result.concepts[0].confidence, 'high');
    assert.equal(result.concepts[1].name, 'Backpropagation');
  });

  it('returns empty concepts when sentinel is absent', () => {
    const text = '# Neural Networks\n\nSome summary.';
    const result = parseSummarizeAndExtractResponse(text);
    assert.equal(result.summary, '# Neural Networks\n\nSome summary.');
    assert.deepEqual(result.concepts, []);
  });

  it('returns empty concepts when JSON is malformed', () => {
    const text = '# Neural Networks\n\n<!-- CONCEPTS_JSON\nnot json at all\n-->';
    const result = parseSummarizeAndExtractResponse(text);
    assert.ok(result.summary.includes('# Neural Networks'));
    assert.deepEqual(result.concepts, []);
  });

  it('returns empty concepts when closing --> is missing', () => {
    const text = '# Neural Networks\n\n<!-- CONCEPTS_JSON\n[{"name":"Foo","aliases":[],"confidence":"high"}]';
    const result = parseSummarizeAndExtractResponse(text);
    assert.deepEqual(result.concepts, []);
  });

  it('handles empty concepts array', () => {
    const text = '# Summary\n\n<!-- CONCEPTS_JSON\n[]\n-->';
    const result = parseSummarizeAndExtractResponse(text);
    assert.deepEqual(result.concepts, []);
  });

  it('trims whitespace from summary portion', () => {
    const text = '  # Summary  \n\n<!-- CONCEPTS_JSON\n[]\n-->';
    const result = parseSummarizeAndExtractResponse(text);
    assert.equal(result.summary, '# Summary');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
node --experimental-strip-types --import ./tests/loader.mjs --test 'tests/prompts/summarizeAndExtract.test.ts'
```

Expected: FAIL — file does not exist yet.

- [ ] **Step 3: Create `src/prompts/summarizeAndExtract.ts`**

```typescript
export interface ExtractedConcept {
  name: string;
  aliases: string[];
  confidence: string;
}

export interface SummarizeAndExtractResult {
  summary: string;
  concepts: ExtractedConcept[];
}

const CONCEPTS_SENTINEL = '<!-- CONCEPTS_JSON';
const CONCEPTS_END = '-->';

export const SUMMARIZE_AND_EXTRACT_SYSTEM = `You are a knowledge compiler. Summarize a source document and extract key concepts from it in one response.

Output EXACTLY this format (no extra text before or after):

---
source: {{source_path}}
source_type: article
compiled_at: {{current_iso_timestamp}}
---

# {{Document Title}}

## Key claims
- (list 5-10 main claims or facts from the document)

## Methodology
- (how the research/analysis was conducted, or "N/A" if not applicable)

## Results
- (synthesized findings and conclusions)

## Concepts
- (comma-separated list of key concept names, use Title Case)

<!-- CONCEPTS_JSON
[{"name":"Concept Name","aliases":["alt name"],"confidence":"high"},{"name":"Another Concept","aliases":[],"confidence":"medium"}]
-->

Rules for the summary:
- Be factual and concise; preserve key claims, figures, and methodology

Rules for CONCEPTS_JSON:
- Extract 3-10 concepts
- Use Title Case for concept names
- confidence: "high" if explicitly discussed, "medium" if mentioned but not detailed
- aliases: alternative names, acronyms, or shorter forms
- Do NOT extract vague concepts like "Overview" or "Summary"
- The JSON must be valid — double-check brackets and quotes before outputting
`;

export function buildSummarizeAndExtractPrompt(
  sourcePath: string,
  content: string
): string {
  return `Summarize this document and extract concepts from it.

Source path: ${sourcePath}
Current timestamp: ${new Date().toISOString()}

--- DOCUMENT START ---
${content}
--- DOCUMENT END ---`;
}

export function parseSummarizeAndExtractResponse(text: string): SummarizeAndExtractResult {
  const sentinelIdx = text.indexOf(CONCEPTS_SENTINEL);
  if (sentinelIdx === -1) return { summary: text.trim(), concepts: [] };

  const summary = text.slice(0, sentinelIdx).trim();
  const jsonStart = sentinelIdx + CONCEPTS_SENTINEL.length;
  const jsonEnd = text.indexOf(CONCEPTS_END, jsonStart);
  if (jsonEnd === -1) return { summary, concepts: [] };

  try {
    const concepts = JSON.parse(text.slice(jsonStart, jsonEnd).trim()) as ExtractedConcept[];
    return { summary, concepts };
  } catch {
    return { summary, concepts: [] };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
node --experimental-strip-types --import ./tests/loader.mjs --test 'tests/prompts/summarizeAndExtract.test.ts'
```

Expected: 6 passing, 0 failing.

- [ ] **Step 5: Commit**

```bash
git add src/prompts/summarizeAndExtract.ts tests/prompts/summarizeAndExtract.test.ts
git commit -m "feat: add summarizeAndExtract combined prompt and parser"
```

---

### Task 3: Export `mergeExtractedConcepts` and rewrite `summarizeSource()`

**Files:**
- Modify: `src/commands/compile.ts`
- Create: `tests/lib/compile.test.ts`

`summarizeSource()` gains a new return field `concepts`. Small sources use the combined prompt (1 call). Large sources run the combined prompt per chunk in parallel, then merge concept lists in code — eliminating the merge LLM call.

- [ ] **Step 1: Write the failing tests**

Create `tests/lib/compile.test.ts`:

```typescript
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mergeExtractedConcepts } from '../../src/commands/compile.ts';

describe('mergeExtractedConcepts', () => {
  it('deduplicates by normalised name and merges aliases', () => {
    const input = [
      { name: 'Neural Network', aliases: ['NN'], confidence: 'medium' },
      { name: 'Neural Network', aliases: ['neural net'], confidence: 'high' },
    ];
    const result = mergeExtractedConcepts(input);
    assert.equal(result.length, 1);
    assert.deepEqual(result[0].aliases.sort(), ['NN', 'neural net'].sort());
    assert.equal(result[0].confidence, 'high');
  });

  it('keeps distinct concepts separate', () => {
    const input = [
      { name: 'Backpropagation', aliases: [], confidence: 'high' },
      { name: 'Gradient Descent', aliases: ['SGD'], confidence: 'medium' },
    ];
    const result = mergeExtractedConcepts(input);
    assert.equal(result.length, 2);
  });

  it('returns empty array for empty input', () => {
    assert.deepEqual(mergeExtractedConcepts([]), []);
  });

  it('promotes confidence from medium to high when duplicate appears', () => {
    const input = [
      { name: 'Bitcoin', aliases: [], confidence: 'medium' },
      { name: 'Bitcoin', aliases: [], confidence: 'high' },
    ];
    const result = mergeExtractedConcepts(input);
    assert.equal(result[0].confidence, 'high');
  });

  it('normalises names with punctuation to the same key', () => {
    const input = [
      { name: 'U.S. Dollar', aliases: [], confidence: 'high' },
      { name: 'U.S. Dollar', aliases: ['USD'], confidence: 'medium' },
    ];
    const result = mergeExtractedConcepts(input);
    assert.equal(result.length, 1);
    assert.deepEqual(result[0].aliases, ['USD']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node --experimental-strip-types --import ./tests/loader.mjs --test 'tests/lib/compile.test.ts'
```

Expected: FAIL — `mergeExtractedConcepts` is not exported from `compile.ts`.

- [ ] **Step 3: Update imports at the top of `src/commands/compile.ts`**

Remove these 5 import lines:

```typescript
import { SUMMARIZE_SYSTEM, buildSummarizePrompt } from "../prompts/summarize.js";
import { EXTRACT_SYSTEM, buildExtractPrompt } from "../prompts/extract.js";
import { WRITE_SYSTEM, buildWritePrompt } from "../prompts/write.js";
import { RELATE_SYSTEM, buildRelatePrompt } from "../prompts/relate.js";
import { MERGE_SYSTEM, buildMergePrompt } from "../prompts/merge.js";
```

Add these 2 in their place:

```typescript
import { SUMMARIZE_AND_EXTRACT_SYSTEM, buildSummarizeAndExtractPrompt, parseSummarizeAndExtractResponse } from "../prompts/summarizeAndExtract.js";
import { WRITE_AND_RELATE_SYSTEM, buildWriteAndRelatePrompt, parseWriteAndRelateResponse } from "../prompts/writeAndRelate.js";
```

- [ ] **Step 4: Add `mergeExtractedConcepts` export just before `summarizeSource`**

Insert this function immediately before the `async function summarizeSource` definition:

```typescript
/**
 * Deduplicate concepts extracted from multiple chunks.
 * Normalises names to a slug-like key, merges aliases, promotes confidence to
 * "high" if any occurrence has it.
 */
export function mergeExtractedConcepts(
  concepts: Array<{ name: string; aliases: string[]; confidence: string }>
): Array<{ name: string; aliases: string[]; confidence: string }> {
  const merged = new Map<string, { name: string; aliases: string[]; confidence: string }>();
  for (const c of concepts) {
    const key = c.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const existing = merged.get(key);
    if (existing) {
      existing.aliases = [...new Set([...existing.aliases, ...c.aliases])];
      if (c.confidence === 'high') existing.confidence = 'high';
    } else {
      merged.set(key, { ...c, aliases: [...c.aliases] });
    }
  }
  return [...merged.values()];
}
```

- [ ] **Step 5: Replace the entire `summarizeSource` function**

Replace the current `summarizeSource` function with:

```typescript
async function summarizeSource(
  sourcePath: string,
  content: string,
  config: import("../lib/config.js").WikicConfig,
  dir: string
): Promise<
  | { ok: true; summaryPath: string; concepts: Array<{ name: string; aliases: string[]; confidence: string }> }
  | { ok: false; error?: string }
> {
  const summaryFileName =
    sourcePath.replace(/^.*\//, "").replace(/\.md$/, "") + ".md";
  const summaryPath = join(config.output_dir, "summaries", summaryFileName);

  if (content.length <= config.compiler.chunk_threshold) {
    // Small source: one combined summarise+extract call
    const resp = await llmCall(
      SUMMARIZE_AND_EXTRACT_SYSTEM,
      buildSummarizeAndExtractPrompt(sourcePath, content),
      config
    );
    if (!resp.ok) return { ok: false, error: resp.error };
    const { summary, concepts } = parseSummarizeAndExtractResponse(resp.text);
    writeText(join(dir, summaryPath), summary);
    return { ok: true, summaryPath, concepts };
  }

  // Large source: summarise+extract each chunk in parallel, merge concepts in code
  const chunks = chunkContent(
    content,
    config.compiler.chunk_size,
    config.compiler.min_chunk_size
  );
  console.error(`  ${sourcePath}: ${chunks.length} chunks, summarising in parallel...`);

  const chunkResults = await runParallel(
    chunks,
    config.compiler.max_parallel,
    (chunk, i) =>
      llmCall(
        SUMMARIZE_AND_EXTRACT_SYSTEM,
        buildSummarizeAndExtractPrompt(
          `Chunk ${i + 1} of ${chunks.length} from: ${sourcePath}`,
          chunk
        ),
        config
      )
  );

  const failed = chunkResults.find((r) => !r.ok);
  if (failed) return { ok: false, error: failed.error };

  const parsed = chunkResults.map((r) => parseSummarizeAndExtractResponse(r.text));
  const concepts = mergeExtractedConcepts(parsed.flatMap((p) => p.concepts));

  // Store concatenated chunk summaries — no LLM merge call needed
  const combinedSummary = parsed.map((p) => p.summary).join('\n\n---\n\n');
  writeText(join(dir, summaryPath), combinedSummary);

  return { ok: true, summaryPath, concepts };
}
```

- [ ] **Step 6: Run the compile tests**

```bash
node --experimental-strip-types --import ./tests/loader.mjs --test 'tests/lib/compile.test.ts'
```

Expected: 5 passing.

- [ ] **Step 7: Build**

```bash
npm run build
```

Expected: No TypeScript errors.

- [ ] **Step 8: Commit**

```bash
git add src/commands/compile.ts tests/lib/compile.test.ts
git commit -m "refactor: rewrite summarizeSource with combined prompt, export mergeExtractedConcepts, eliminate merge LLM call"
```

---

### Task 4: Remove separate extract phase; populate `allConcepts` from `summarizeSource`

**Files:**
- Modify: `src/commands/compile.ts` (action handler Step 2 and Step 3)

`summarizeSource` now returns `concepts`. The separate extract for-loop is deleted. Concepts are accumulated inside the Step 2 summarise loop.

- [ ] **Step 1: In the `action` handler replace the two-phase block**

Find and delete the "Step 3: Extract concepts from summaries" block. Then replace the "Step 2: Summarize" block with this combined block:

```typescript
// Step 2: Summarise + extract concepts (one LLM call per source, or one per chunk for large sources)
const summariesDir = join(dir, config.output_dir, "summaries");
ensureDir(summariesDir);
const allConcepts: Map<string, { concept: ExtractedConcept; sources: string[] }> = new Map();

for (const sourcePath of toProcess) {
  const content = readText(join(dir, sourcePath));
  console.error(`  Summarizing ${sourcePath}...`);

  const result = await summarizeSource(sourcePath, content, config, dir);

  if (!result.ok) {
    stats.errors.push(`Summarize failed for ${sourcePath}: ${result.error}`);
    manifest.sources[sourcePath].status = "error";
    continue;
  }

  manifest.sources[sourcePath].summary_path = result.summaryPath ?? null;
  manifest.sources[sourcePath].compiled_at = new Date().toISOString();
  stats.summarized++;

  for (const c of result.concepts) {
    const slug = slugify(c.name);
    const existing = allConcepts.get(slug);
    if (existing) {
      existing.sources.push(sourcePath);
      existing.concept.aliases = [...new Set([...existing.concept.aliases, ...c.aliases])];
      if (c.confidence === 'high') existing.concept.confidence = 'high';
    } else {
      allConcepts.set(slug, { concept: c, sources: [sourcePath] });
      stats.concepts_extracted++;
    }
  }
}
```

- [ ] **Step 2: Build**

```bash
npm run build
```

Expected: No TypeScript errors.

- [ ] **Step 3: Run full test suite**

```bash
npm test
```

Expected: All tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/commands/compile.ts
git commit -m "refactor: remove separate extract phase — concepts now returned by summarizeSource"
```

---

### Task 5: Replace sequential write+relate loop with parallel `writeAndRelate`

**Files:**
- Modify: `src/commands/compile.ts` (Step 4 of the action handler)

The current for-loop calls write then relate sequentially. Replace it with `runParallel` using `WRITE_AND_RELATE_SYSTEM`. The destructured `relations` from `parseWriteAndRelateResponse` is renamed `parsedRelations` to avoid shadowing the outer `relations` variable (from `loadRelations`).

- [ ] **Step 1: Replace Step 4 in the `action` handler**

Find the current article-writing block (starts with `// Step 4: Write concept articles`). Replace entirely with:

```typescript
// Step 4: Write concept articles + extract relations (combined, in parallel)
const conceptsDir = join(dir, config.output_dir, "concepts");
ensureDir(conceptsDir);
const allSlugs = [
  ...allConcepts.keys(),
  ...Object.keys(manifest.concepts),
];

await runParallel(
  [...allConcepts.entries()],
  config.compiler.max_parallel,
  async ([slug, { concept, sources }]) => {
    console.error(`  Writing article: ${slug}...`);

    const sourceMaterial: string[] = [];
    for (const sp of sources) {
      const entry = manifest.sources[sp];
      if (entry?.summary_path) {
        sourceMaterial.push(readText(join(dir, entry.summary_path)));
      }
    }

    const articlePath = join(config.output_dir, "concepts", `${slug}.md`);

    const resp = await llmCall(
      WRITE_AND_RELATE_SYSTEM,
      buildWriteAndRelatePrompt(
        concept.name,
        slug,
        concept.aliases,
        sources,
        concept.confidence,
        sourceMaterial.join("\n\n---\n\n"),
        allSlugs
      ),
      config
    );

    if (!resp.ok) {
      stats.errors.push(`Write failed for ${slug}: ${resp.error}`);
      return;
    }

    const { article, relations: parsedRelations } = parseWriteAndRelateResponse(resp.text);
    writeText(join(dir, articlePath), article);

    for (const rel of parsedRelations) {
      upsertRelation(
        manifest,
        relations,
        slug,
        rel.target,
        rel.type as import("../lib/manifest.js").RelationType,
        rel.evidence ?? ""
      );
      stats.relations_extracted++;
    }

    upsertConcept(manifest, slug, sources[0], articlePath, concept.aliases);
    manifest.concepts[slug].last_compiled = new Date().toISOString();
    for (const sp of sources) {
      upsertConcept(manifest, slug, sp, articlePath);
    }
    manifest.sources[sources[0]].status = "compiled";
    stats.articles_written++;
  }
);
```

- [ ] **Step 2: Build**

```bash
npm run build
```

Expected: No TypeScript errors.

- [ ] **Step 3: Run full test suite**

```bash
npm test
```

Expected: All tests pass.

- [ ] **Step 4: Smoke test on the model-test project**

```bash
cd /tmp/wikic-model-test
rm -rf wiki && mkdir wiki
node /Users/indra/Desktop/indraneelk/Documents/Projects/wikicli/dist/index.js compile --full 2>&1
```

Expected: Compile completes. JSON output shows `articles_written > 0` and `errors: []`. Spot-check one file in `wiki/concepts/` — it should have proper frontmatter and section headers.

- [ ] **Step 5: Commit**

```bash
git add src/commands/compile.ts
git commit -m "refactor: replace sequential write+relate loop with parallel writeAndRelate, saving 1 LLM call per concept"
```

---

### Task 6: Final build, test run, and push

- [ ] **Step 1: Final clean build**

```bash
npm run build
```

Expected: No errors, no warnings.

- [ ] **Step 2: Full test suite**

```bash
npm test
```

Expected: All tests pass.

- [ ] **Step 3: Verify no dead imports remain**

```bash
grep -n "SUMMARIZE_SYSTEM\|EXTRACT_SYSTEM\|WRITE_SYSTEM\|RELATE_SYSTEM\|MERGE_SYSTEM" src/commands/compile.ts
```

Expected: No output (all old prompt imports are gone).

- [ ] **Step 4: Push**

```bash
git push
```

Expected: Push succeeds.

---

## Contradiction-Aware Tasks (7-9)

### Task 7: Post-compile contradiction check

**Files:**
- Modify: `src/commands/compile.ts` — add post-compile contradiction check
- Modify: `src/commands/lint.ts` — export contradiction functions for reuse

After Steps 1-7 of compile, add a post-compile step that runs the contradiction detection pipeline. This is nearly free due to incremental checking (`checked_pairs.json`) — only changed articles trigger re-verification.

The contradiction check should:
- Run after article writing but before saving manifest
- Only run if `config.compiler.auto_lint !== false` (respect existing config flag)
- Output results to stderr (not stdout — keep JSON stats clean)
- Add `contradiction_stats` to the compile output JSON:
  ```json
  {
    "contradiction_candidates_checked": 12,
    "contradiction_verified": 2,
    "contradiction_pending_review": 1,
    "contradiction_skipped": 9,
    "contradiction_errors": 0
  }
  ```

- [ ] **Step 1: Read `src/lib/conflicts.ts` to understand the exported functions**

Note: `generateCandidates`, `extractClaims`, `verifyContradiction`, `loadCheckedPairs`, `saveCheckedPairs`, `shouldRecheck`, `hashContent` are exported.

- [ ] **Step 2: Create a `runContradictionCheck` helper function in `compile.ts`**

Add this near the top of `src/commands/compile.ts` (or in a new `src/lib/contradiction.ts`):

```typescript
async function runContradictionCheck(
  dir: string,
  config: import("../lib/config.js").WikicConfig,
  manifest: import("../lib/manifest.js").Manifest,
  relations: import("../lib/manifest.js").RelationEntry[]
): Promise<{
  candidatesChecked: number;
  verified: number;
  pendingReview: number;
  skipped: number;
  errors: number;
}> {
  const { generateCandidates, extractClaims, verifyContradiction, loadCheckedPairs, saveCheckedPairs, shouldRecheck, hashContent } = await import("../lib/conflicts.js");

  const articleCache: Record<string, string> = {};
  for (const [slug, concept] of Object.entries(manifest.concepts)) {
    try {
      articleCache[slug] = readText(join(dir, concept.article_path));
    } catch {
      articleCache[slug] = "";
    }
  }

  const candidates = generateCandidates(manifest, relations, articleCache);
  const checkedPairs = loadCheckedPairs(dir);
  const updatedPairs: typeof checkedPairs = [];
  
  let candidatesChecked = 0;
  let verified = 0;
  let pendingReview = 0;
  let skipped = 0;
  let errors = 0;

  for (const candidate of candidates) {
    const contentA = articleCache[candidate.slugA];
    const contentB = articleCache[candidate.slugB];
    if (!contentA || !contentB) continue;

    const currentHashA = hashContent(contentA);
    const currentHashB = hashContent(contentB);

    const existing = checkedPairs.find(
      (p) => p.slugA === candidate.slugA && p.slugB === candidate.slugB
    );

    if (existing && !shouldRecheck(existing, currentHashA, currentHashB)) {
      skipped++;
      updatedPairs.push(existing);
      continue;
    }

    candidatesChecked++;

    try {
      const claimsA = await extractClaims(contentA, candidate.slugA, config);
      const claimsB = await extractClaims(contentB, candidate.slugB, config);
      const result = await verifyContradiction(
        candidate.slugA, claimsA,
        candidate.slugB, claimsB,
        config
      );

      if (result.verified) {
        verified++;
        // upsertRelation will be called by the caller after this function
      } else if (result.needsHumanReview) {
        pendingReview++;
      }

      updatedPairs.push({
        slugA: candidate.slugA,
        slugB: candidate.slugB,
        articleHashA: currentHashA,
        articleHashB: currentHashB,
        lastChecked: new Date().toISOString(),
        previouslyVerified: result.verified,
      });
    } catch {
      errors++;
      updatedPairs.push({
        slugA: candidate.slugA,
        slugB: candidate.slugB,
        articleHashA: currentHashA,
        articleHashB: currentHashB,
        lastChecked: new Date().toISOString(),
        previouslyVerified: false,
      });
    }
  }

  saveCheckedPairs(dir, updatedPairs);

  return { candidatesChecked, verified, pendingReview, skipped, errors };
}
```

- [ ] **Step 3: Add post-compile step in compile.ts action handler**

Add after Step 7 (update CHANGELOG) and before saveManifest:

```typescript
// Step 8: Post-compile contradiction check
let contradictionStats = { candidatesChecked: 0, verified: 0, pendingReview: 0, skipped: 0, errors: 0 };
if (config.compiler.auto_lint !== false && toProcess.length > 0) {
  console.error('  Running contradiction check...');
  try {
    contradictionStats = await runContradictionCheck(dir, config, manifest, relations);
    if (contradictionStats.verified > 0 || contradictionStats.pendingReview > 0) {
      console.error(`  Contradictions: ${contradictionStats.verified} verified, ${contradictionStats.pendingReview} pending review, ${contradictionStats.skipped} skipped (unchanged)`);
    }
  } catch (e) {
    console.error(`  Contradiction check failed: ${e}`);
    contradictionStats.errors = 1;
  }
}
```

- [ ] **Step 4: Update the compile output JSON to include contradiction stats**

Find the final `console.log(JSON.stringify({ ok: true, ...stats }))` and add `contradiction_stats`:

```typescript
console.log(JSON.stringify({
  ok: true,
  ...stats,
  contradiction_stats: contradictionStats,
}));
```

- [ ] **Step 5: Add `contradiction_stats` to `CompileStats` interface**

```typescript
interface CompileStats {
  // ... existing fields ...
  contradiction_stats?: {
    candidatesChecked: number;
    verified: number;
    pendingReview: number;
    skipped: number;
    errors: number;
  };
}
```

- [ ] **Step 6: Build and run tests**

```bash
npm run build && npm test
```

Expected: All tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/commands/compile.ts
git commit -m "feat: add post-compile contradiction check, runs automatically unless auto_lint is disabled"
```

---

### Task 8: Create `wikic contradictions` — human review command

**Files:**
- Create: `src/commands/contradictions.ts`
- Create: `tests/commands/contradictions.test.ts`
- Modify: `src/index.ts` — register `contradictionsCommand`

The contradictions command provides a structured human review workflow. It surfaces pending candidates, lets humans confirm/reject, and manages the review queue.

**Commands:**

```bash
wikic contradictions              # list all contradictions (verified + pending)
wikic contradictions --pending    # list only pending review
wikic contradictions --verified  # list only verified
wikic contradictions --review <slugA> <slugB>  # review a specific pair
wikic contradictions --confirm <slugA> <slugB>  # confirm: write contradicts edge
wikic contradictions --dismiss <slugA> <slugB>  # dismiss: remove from candidates
wikic contradictions --export    # export all contradictions as JSON
wikic contradictions --export-candidates  # export only pending candidates
```

**Data structures:**

```typescript
// .wikic/review_queue.json
export interface ReviewQueue {
  pending: ReviewItem[];
  confirmed: ReviewItem[];
  dismissed: ReviewItem[];
}

export interface ReviewItem {
  slugA: string;
  slugB: string;
  addedAt: string;
  reviewedAt?: string;
  confidence?: number;
  conflicts?: ClaimContradiction[];
  notes?: string;  // human reviewer's notes
}
```

**Implementation notes:**
- Use `loadRelations` to read/write `graph.json` for verified contradictions
- Use a new `review_queue.json` file in `.wikic/` for the queue
- `--review` should load both article files and display their content in context of the candidate conflicts
- `--confirm` should call `upsertRelation` with the `contradicts` type and move the item to `confirmed`
- `--dismiss` should remove from `pending` and add to `dismissed`
- Export formats: JSON (machine-readable), Markdown (human-readable)

- [ ] **Step 1: Write the command skeleton**

Create `src/commands/contradictions.ts`:

```typescript
import { Command } from "commander";
import { loadConfig } from "../lib/config.js";
import { loadManifest, loadRelations, saveRelations, upsertRelation, type RelationEntry, type RelationType } from "../lib/manifest.js";
import { readText } from "../lib/files.js";
import { join } from "path";
import { generateCandidates, loadCheckedPairs, extractClaims, verifyContradiction } from "../lib/conflicts.js";
```

Implement the subcommands as described above.

- [ ] **Step 2: Write integration tests**

Create `tests/commands/contradictions.test.ts` with tests for all subcommands. Use the same temp project setup pattern as `lint.integration.test.ts`.

- [ ] **Step 3: Register in `src/index.ts`**

```typescript
import { contradictionsCommand } from "./commands/contradictions.js";
// ... after graphCommand ...
program.addCommand(contradictionsCommand);
```

- [ ] **Step 4: Build and test**

```bash
npm run build && npm test
```

Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/commands/contradictions.ts tests/commands/contradictions.test.ts src/index.ts
git commit -m "feat: add wikic contradictions command for human review workflow"
```

---

### Task 9: Final integration, test run, and push

- [ ] **Step 1: Clean build**

```bash
npm run build
```

Expected: No TypeScript errors.

- [ ] **Step 2: Full test suite**

```bash
npm test
```

Expected: All tests pass.

- [ ] **Step 3: End-to-end smoke test**

```bash
cd /tmp/wikic-model-test
rm -rf wiki .wikic
wikic init --project model-test
wikic add /path/to/some/research.md
wikic compile --full
# Should show:
# - articles_written > 0
# - relations_extracted > 0
# - contradiction_candidates_checked > 0

wikic contradictions --pending
# Should list pending contradictions

wikic contradictions --export
# Should export JSON

wikic contradictions --review <slugA> <slugB>
# Should display review interface
```

- [ ] **Step 4: Verify all old prompt files are still referenced nowhere**

```bash
grep -rn "from.*prompts/summarize\|from.*prompts/extract\|from.*prompts/write\|from.*prompts/relate\|from.*prompts/merge" src/
```

Expected: No output (all old prompts are reference-only).

- [ ] **Step 5: Push**

```bash
git push
```

---

## Summary of All Changes

### LLM Call Reduction

| File | Action | Why |
|---|---|---|
| `src/prompts/writeAndRelate.ts` | Create | Combined write+relate prompt and sentinel parser |
| `src/prompts/summarizeAndExtract.ts` | Create | Combined summarize+extract prompt and sentinel parser |
| `src/commands/compile.ts` | Modify | New imports, `mergeExtractedConcepts` export, rewritten `summarizeSource`, collapsed Steps 2+3, parallelised Step 4, post-compile contradiction check |
| `tests/prompts/writeAndRelate.test.ts` | Create | 6 parser unit tests |
| `tests/prompts/summarizeAndExtract.test.ts` | Create | 6 parser unit tests |
| `tests/lib/compile.test.ts` | Create | 5 `mergeExtractedConcepts` unit tests |

### Contradiction-Aware Compilation

| File | Action | Why |
|---|---|---|
| `src/commands/contradictions.ts` | Create | Human review workflow: list, review, confirm, dismiss |
| `tests/commands/contradictions.test.ts` | Create | Integration tests for review workflow |
| `src/commands/compile.ts` | Modify | Post-compile contradiction check (Step 8) |
| `src/commands/lint.ts` | Modify | Functions already exported for reuse |
| `src/index.ts` | Modify | Register contradictionsCommand |
| `src/prompts/summarize.ts` | Untouched | Kept as reference |
| `src/prompts/extract.ts` | Untouched | Kept as reference |
| `src/prompts/write.ts` | Untouched | Kept as reference |
| `src/prompts/relate.ts` | Untouched | Kept as reference (replaced by writeAndRelate) |
| `src/prompts/merge.ts` | Untouched | Kept as reference |
