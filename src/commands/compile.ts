import { Command } from "commander";
import { join } from "path";
import { loadConfig } from "../lib/config.js";
import { loadManifest, saveManifest, upsertConcept, upsertRelation, loadRelations, saveRelations } from "../lib/manifest.js";
import { hashFile } from "../lib/hash.js";
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

async function runContradictionCheck(
  dir: string,
  config: import("../lib/config.js").WikicConfig,
  manifest: import("../lib/manifest.js").Manifest,
  relationsArr: import("../lib/manifest.js").RelationEntry[]
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

  const candidates = generateCandidates(manifest, relationsArr, articleCache);
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
    const dir = process.cwd();
    const baseConfig = loadConfig(dir);
    const config = opts.model
      ? { ...baseConfig, llm: { ...baseConfig.llm, model: opts.model as string } }
      : baseConfig;
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
        const cStats = await runContradictionCheck(dir, config, manifest, relations);
        if (cStats.verified > 0 || cStats.pendingReview > 0) {
          console.error(`  Contradictions: ${cStats.verified} verified, ${cStats.pendingReview} pending review, ${cStats.skipped} skipped (unchanged)`);
        }
        stats.contradiction_stats = cStats;
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