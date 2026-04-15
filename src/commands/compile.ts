import { Command } from "commander";
import { join } from "path";
import { loadConfig } from "../lib/config.js";
import type { WikicConfig } from "../lib/config.js";
import { loadManifest, saveManifest, upsertConcept, upsertRelation, loadRelations, saveRelations } from "../lib/manifest.js";
import { hashFile } from "../lib/hash.js";
import { existsSync } from "fs";
import { readText, writeText, ensureDir, listMarkdownFiles } from "../lib/files.js";
import { slugify } from "../lib/slug.js";
import { llmCall, OPENCODE_FREE_MODELS } from "../lib/llm.js";
import { chunkContent } from "../lib/chunker.js";
import { SUMMARIZE_AND_EXTRACT_SYSTEM, buildSummarizeAndExtractPrompt, parseSummarizeAndExtractResponse } from "../prompts/summarizeAndExtract.js";
import { WRITE_AND_RELATE_SYSTEM, buildWriteAndRelatePrompt, parseWriteAndRelateResponse } from "../prompts/writeAndRelate.js";

interface ExtractedConcept {
  name: string;
  aliases: string[];
  confidence: string;
}

interface CompileStats {
  sources_added: number;
  sources_modified: number;
  summarized: number;
  concepts_extracted: number;
  articles_written: number;
  relations_extracted: number;
  errors: string[];
  contradiction_stats?: {
    candidatesChecked: number;
    verified: number;
    pendingReview: number;
    skipped: number;
    errors: number;
  };
}

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

  const combinedSummary = parsed.map((p) => p.summary).join('\n\n---\n\n');
  writeText(join(dir, summaryPath), combinedSummary);

  return { ok: true, summaryPath, concepts };
}

interface ReviewQueueItem {
  slugA: string;
  slugB: string;
  addedAt: string;
  confidence?: number;
  conflictType?: string;
  contradictions?: unknown[];
  explanation?: string;
  recommendedAction?: string;
  status: "pending" | "confirmed" | "dismissed";
  notes?: string;
}

interface ReviewQueue {
  pending: ReviewQueueItem[];
  confirmed: ReviewQueueItem[];
  dismissed: ReviewQueueItem[];
}

const REVIEW_QUEUE_PATH = ".wikic/review_queue.json";

function loadReviewQueue(dir: string): ReviewQueue {
  const p = join(dir, REVIEW_QUEUE_PATH);
  if (!existsSync(p)) return { pending: [], confirmed: [], dismissed: [] };
  return JSON.parse(readText(p));
}

function saveReviewQueue(dir: string, queue: ReviewQueue): void {
  const p = join(dir, REVIEW_QUEUE_PATH);
  writeText(p, JSON.stringify(queue, null, 2));
}

async function runContradictionCheck(
  dir: string,
  config: import("../lib/config.js").WikicConfig,
  manifest: import("../lib/manifest.js").Manifest,
  relationsArr: import("../lib/manifest.js").RelationEntry[],
  processedSources?: string[]
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

  let candidates = generateCandidates(manifest, relationsArr, articleCache);

  // Scope to concepts from the just-processed sources, if provided.
  // This means compiling 1 source only checks the ~5-10 concepts it produced,
  // not every pair in the entire wiki.
  if (processedSources && processedSources.length > 0) {
    const processedSet = new Set(processedSources);
    const affectedSlugs = new Set(
      Object.entries(manifest.concepts)
        .filter(([, info]) => info.sources.some(s => processedSet.has(s)))
        .map(([slug]) => slug)
    );
    candidates = candidates.filter(c => affectedSlugs.has(c.slugA) || affectedSlugs.has(c.slugB));
  }

  const checkedPairs = loadCheckedPairs(dir);
  const updatedPairs: typeof checkedPairs = [];
  const queue = loadReviewQueue(dir);

  let candidatesChecked = 0;
  let verified = 0;
  let pendingReview = 0;
  let skipped = 0;
  let errors = 0;

  const alreadyInQueue = (slugA: string, slugB: string): boolean => {
    const key = [slugA, slugB].sort().join("|");
    return [...queue.pending, ...queue.confirmed, ...queue.dismissed].some(
      (i) => [i.slugA, i.slugB].sort().join("|") === key
    );
  };

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

      const pairKey = [candidate.slugA, candidate.slugB].sort().join("|");

      if (result.verified && result.confidence >= 0.8 && !result.needsHumanReview) {
        verified++;
        if (!alreadyInQueue(candidate.slugA, candidate.slugB)) {
          upsertRelation(
            manifest,
            relationsArr,
            candidate.slugA,
            candidate.slugB,
            "contradicts",
            result.explanation || `Verified contradiction (confidence: ${Math.round(result.confidence * 100)}%)`
          );
          const rel = relationsArr.find(
            (r) => r.source === candidate.slugA && r.target === candidate.slugB && r.type === "contradicts"
          );
          if (rel) {
            (rel as unknown as Record<string, unknown>).confidence = result.confidence;
            (rel as unknown as Record<string, unknown>).conflictType = result.contradictions?.[0]?.conflictType;
            (rel as unknown as Record<string, unknown>).reviewed = true;
          }
        }
      } else if (result.confidence >= 0.5 || result.needsHumanReview) {
        pendingReview++;
        if (!alreadyInQueue(candidate.slugA, candidate.slugB)) {
          queue.pending.push({
            slugA: candidate.slugA,
            slugB: candidate.slugB,
            addedAt: new Date().toISOString(),
            confidence: result.confidence,
            conflictType: result.contradictions?.[0]?.conflictType,
            contradictions: result.contradictions as unknown as unknown[],
            explanation: result.explanation,
            recommendedAction: result.recommendedAction,
            status: "pending",
          });
        }
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
  saveReviewQueue(dir, queue);

  return { candidatesChecked, verified, pendingReview, skipped, errors };
}

export const compileCommand = new Command("compile")
  .description("Compile sources into wiki articles")
  .option("--full", "Force full recompilation")
  .option("--repair", "Write articles for any concepts missing their article file (no re-summarization)")
  .option(
    "--model <id>",
    "Override LLM model for this run (does not modify config.yaml).\n" +
    "Free opencode models:\n" +
    OPENCODE_FREE_MODELS.map((m) => `  ${m}`).join("\n")
  )
  .option(
    "--provider <name>",
    "Override LLM provider for this run (does not modify config.yaml).\n" +
    "Supported: claude-cli, opencode-cli, codex-cli"
  )
  .action(async (opts) => {
    const dir = process.cwd();
    const baseConfig = loadConfig(dir);
    let config = baseConfig;
    if (opts.provider) {
      config = { ...config, llm: { ...config.llm, provider: opts.provider as WikicConfig["llm"]["provider"] } };
    }
    if (opts.model) {
      config = { ...config, llm: { ...config.llm, model: opts.model as string } };
    }
    const manifest = loadManifest(dir);
    const relations = loadRelations(dir);
    const stats: CompileStats = {
      sources_added: 0,
      sources_modified: 0,
      summarized: 0,
      concepts_extracted: 0,
      articles_written: 0,
      relations_extracted: 0,
      errors: [],
    };

    // Step 1: Detect changed sources
    const toProcess: string[] = [];
    for (const [path, entry] of Object.entries(manifest.sources)) {
      const fullPath = join(dir, path);
      try {
        const currentHash = hashFile(fullPath);
        if (opts.full || entry.status === "pending" || currentHash !== entry.hash) {
          toProcess.push(path);
          if (entry.status === "pending") stats.sources_added++;
          else stats.sources_modified++;
          entry.hash = currentHash;
        }
      } catch {
        stats.errors.push(`Cannot read source: ${path}`);
      }
    }

    if (opts.repair) {
      // Write articles for concepts that exist in manifest but have no article file
      const missingConcepts = Object.entries(manifest.concepts).filter(
        ([, info]) => !existsSync(join(dir, info.article_path))
      );
      if (missingConcepts.length === 0) {
        console.log(JSON.stringify({ ok: true, message: "No missing articles found.", articles_written: 0 }));
        return;
      }
      console.error(`Writing ${missingConcepts.length} missing articles...`);
      const allSlugs = Object.keys(manifest.concepts);
      let repairWritten = 0;
      const repairErrors: string[] = [];
      await runParallel(missingConcepts, config.compiler.max_parallel, async ([slug, info]) => {
        console.error(`  Writing article: ${slug}...`);
        const sourceMaterial: string[] = [];
        for (const sp of info.sources) {
          const entry = manifest.sources[sp];
          if (entry?.summary_path) {
            try { sourceMaterial.push(readText(join(dir, entry.summary_path))); } catch { /* skip */ }
          }
        }
        const conceptName = (info.aliases ?? [])[0] ?? slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
        const resp = await llmCall(
          WRITE_AND_RELATE_SYSTEM,
          buildWriteAndRelatePrompt(
            conceptName,
            slug,
            info.aliases ?? [],
            info.sources,
            "medium",
            sourceMaterial.join("\n\n---\n\n"),
            allSlugs
          ),
          config
        );
        if (!resp.ok) { repairErrors.push(`Write failed for ${slug}: ${resp.error}`); return; }
        const { article, relations: parsedRelations } = parseWriteAndRelateResponse(resp.text);
        writeText(join(dir, info.article_path), article);
        for (const rel of parsedRelations) {
          upsertRelation(manifest, relations, slug, rel.target, rel.type as import("../lib/manifest.js").RelationType, rel.evidence ?? "");
        }
        manifest.concepts[slug].last_compiled = new Date().toISOString();
        repairWritten++;
      });
      saveManifest(dir, manifest);
      saveRelations(dir, relations);
      console.log(JSON.stringify({ ok: true, articles_written: repairWritten, errors: repairErrors }));
      return;
    }

    if (toProcess.length === 0) {
      console.log(JSON.stringify({ ok: true, message: "Nothing to compile — all sources up to date.", ...stats }));
      return;
    }

    console.error(`Compiling ${toProcess.length} source(s)...`);

    // Step 2: Summarise + extract concepts
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

    // Step 3: Write concept articles + extract relations (combined, in parallel)
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

    // Step 4: Generate index
    generateIndex(dir, config.output_dir, manifest);

    // Step 5: Generate MOC (Map of Content)
    generateMOC(dir, config.output_dir, manifest);

    // Step 6: Update CHANGELOG
    appendChangelog(dir, config.output_dir, stats);

    // Step 7: Post-compile contradiction check
    if (config.compiler.auto_lint !== false && toProcess.length > 0) {
      console.error('  Running contradiction check...');
      try {
        const cStats = await runContradictionCheck(dir, config, manifest, relations, toProcess);
        if (cStats.verified > 0 || cStats.pendingReview > 0) {
          console.error(`  Contradictions: ${cStats.verified} verified, ${cStats.pendingReview} pending review, ${cStats.skipped} skipped (unchanged)`);
        }
        stats.contradiction_stats = cStats;
        // Update lint tracking on successfully processed sources
        const lintTimestamp = new Date().toISOString();
        for (const sp of toProcess) {
          if (manifest.sources[sp] && manifest.sources[sp].status !== "error") {
            manifest.sources[sp].lint_at = lintTimestamp;
            manifest.sources[sp].lint_status = cStats.pendingReview > 0 ? "flagged" : "clean";
          }
        }
      } catch (e) {
        console.error(`  Contradiction check failed: ${e}`);
        stats.contradiction_stats = { candidatesChecked: 0, verified: 0, pendingReview: 0, skipped: 0, errors: 1 };
      }
    }

    // Mark all processed sources as compiled
    for (const sp of toProcess) {
      if (manifest.sources[sp].status !== "error") {
        manifest.sources[sp].status = "compiled";
      }
    }

    // Step 8: Generate sources index
    generateSourcesIndex(dir, config.sources_dir, manifest);

    saveRelations(dir, relations);
    saveManifest(dir, manifest);

    console.log(JSON.stringify({ ok: true, ...stats }));
  });

function generateIndex(dir: string, outputDir: string, manifest: import("../lib/manifest.js").Manifest): void {
  const lines = ["# Wiki Index\n"];

  const conceptSlugs = Object.keys(manifest.concepts).sort();
  if (conceptSlugs.length > 0) {
    lines.push("## Concepts\n");
    for (const slug of conceptSlugs) {
      const c = manifest.concepts[slug];
      const sourcesStr = c.sources.map((s) => `\`${s}\``).join(", ");
      lines.push(`- [[${slug}]] — sources: ${sourcesStr}`);
    }
    lines.push("");
  }

  const sourcePaths = Object.keys(manifest.sources).sort();
  if (sourcePaths.length > 0) {
    lines.push("## Sources\n");
    for (const sp of sourcePaths) {
      const entry = manifest.sources[sp];
      const status = entry.status;
      lines.push(`- \`${sp}\` [${status}]${entry.summary_path ? ` → [summary](${entry.summary_path})` : ""}`);
    }
    lines.push("");
  }

  writeText(join(dir, outputDir, "index.md"), lines.join("\n"));
}

function generateMOC(dir: string, outputDir: string, manifest: import("../lib/manifest.js").Manifest): void {
  const tagMap: Record<string, string[]> = {};

  for (const [slug, concept] of Object.entries(manifest.concepts)) {
    try {
      const content = readText(join(dir, concept.article_path));
      const tagMatch = content.match(/^tags:\s*\[([^\]]*)\]/m);
      if (tagMatch) {
        const tags = tagMatch[1].split(",").map((t) => t.trim().replace(/"/g, ""));
        for (const tag of tags) {
          if (tag) {
            if (!tagMap[tag]) tagMap[tag] = [];
            tagMap[tag].push(slug);
          }
        }
      } else {
        if (!tagMap["untagged"]) tagMap["untagged"] = [];
        tagMap["untagged"].push(slug);
      }
    } catch {
      // Skip unreadable articles
    }
  }

  const lines = ["# Map of Content\n"];
  for (const tag of Object.keys(tagMap).sort()) {
    lines.push(`## ${tag}\n`);
    for (const slug of tagMap[tag].sort()) {
      lines.push(`- [[${slug}]]`);
    }
    lines.push("");
  }

  writeText(join(dir, outputDir, "MOC.md"), lines.join("\n"));
}

function appendChangelog(dir: string, outputDir: string, stats: CompileStats): void {
  const changelogPath = join(outputDir, "CHANGELOG.md");
  let existing = "";
  try {
    existing = readText(join(dir, changelogPath));
  } catch {
    existing = "# CHANGELOG\n\nCompilation history.\n";
  }

  const cStats = stats.contradiction_stats;
  const entry = `
## ${new Date().toISOString()}

- Added: ${stats.sources_added} sources
- Modified: ${stats.sources_modified} sources
- Summarized: ${stats.summarized}
- Concepts extracted: ${stats.concepts_extracted}
- Articles written: ${stats.articles_written}
- Relations extracted: ${stats.relations_extracted}
${cStats ? `- Contradiction candidates checked: ${cStats.candidatesChecked}
- Contradictions verified: ${cStats.verified}
- Contradictions pending review: ${cStats.pendingReview}
- Contradictions skipped (unchanged): ${cStats.skipped}` : ''}
- Errors: ${stats.errors.length}
${stats.errors.length > 0 ? stats.errors.map((e) => `  - ${e}`).join("\n") : ""}
`;

  writeText(join(dir, changelogPath), existing + entry);
}

function generateSourcesIndex(dir: string, sourcesDir: string, manifest: import("../lib/manifest.js").Manifest): void {
  const now = new Date().toISOString();
  const entries = Object.entries(manifest.sources).sort(([a], [b]) => a.localeCompare(b));

  const compiled   = entries.filter(([, e]) => e.status === "compiled");
  const pending    = entries.filter(([, e]) => e.status === "pending");
  const errored    = entries.filter(([, e]) => e.status === "error");
  const flagged    = entries.filter(([, e]) => (e.lint_status ?? "unchecked") === "flagged");
  const unchecked  = entries.filter(([, e]) => (e.lint_status ?? "unchecked") === "unchecked");

  const lines: string[] = [
    `# Sources Index`,
    ``,
    `_Auto-generated ${now}_`,
    ``,
    `## Summary`,
    ``,
    `| Metric | Count |`,
    `|--------|-------|`,
    `| Total sources | ${entries.length} |`,
    `| Compiled | ${compiled.length} |`,
    `| Pending | ${pending.length} |`,
    `| Errors | ${errored.length} |`,
    `| Lint: flagged | ${flagged.length} |`,
    `| Lint: unchecked | ${unchecked.length} |`,
    ``,
    `## All Sources`,
    ``,
    `| Source | Status | Compiled At | Lint Status | Lint At | Size |`,
    `|--------|--------|-------------|-------------|---------|------|`,
  ];

  for (const [path, entry] of entries) {
    const status      = entry.status;
    const compiledAt  = entry.compiled_at ? entry.compiled_at.slice(0, 10) : "—";
    const lintStatus  = entry.lint_status ?? "unchecked";
    const lintAt      = entry.lint_at ? entry.lint_at.slice(0, 10) : "—";
    const sizeKb      = (entry.size_bytes / 1024).toFixed(1);
    const statusEmoji = status === "compiled" ? "✅" : status === "error" ? "❌" : "⏳";
    const lintEmoji   = lintStatus === "clean" ? "✅" : lintStatus === "flagged" ? "⚠️" : "—";
    const name        = path.replace(/^sources\//, "");
    lines.push(`| \`${name}\` | ${statusEmoji} ${status} | ${compiledAt} | ${lintEmoji} ${lintStatus} | ${lintAt} | ${sizeKb}KB |`);
  }

  if (errored.length > 0) {
    lines.push(``, `## Errors`, ``);
    for (const [path] of errored) {
      lines.push(`- \`${path}\``);
    }
  }

  if (flagged.length > 0) {
    lines.push(``, `## Flagged for Contradiction Review`, ``);
    for (const [path, entry] of flagged) {
      lines.push(`- \`${path}\` — flagged ${entry.lint_at ?? "unknown"}`);
    }
  }

  lines.push(``);
  writeText(join(dir, sourcesDir, "_index.md"), lines.join("\n"));
}