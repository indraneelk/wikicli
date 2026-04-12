import { Command } from "commander";
import { join } from "path";
import { loadConfig } from "../lib/config.js";
import { loadManifest, saveManifest, upsertConcept } from "../lib/manifest.js";
import { hashFile } from "../lib/hash.js";
import { readText, writeText, ensureDir, listMarkdownFiles } from "../lib/files.js";
import { slugify } from "../lib/slug.js";
import { llmCall } from "../lib/llm.js";
import { SUMMARIZE_SYSTEM, buildSummarizePrompt } from "../prompts/summarize.js";
import { EXTRACT_SYSTEM, buildExtractPrompt } from "../prompts/extract.js";
import { WRITE_SYSTEM, buildWritePrompt } from "../prompts/write.js";
import { chunkContent } from "../lib/chunker.js";
import { MERGE_SYSTEM, buildMergePrompt } from "../prompts/merge.js";

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
  errors: string[];
}

async function runParallel<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;

  async function worker(): Promise<void> {
    // Safe: JS is single-threaded; `next++` is atomic across awaits.
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

async function summarizeSource(
  sourcePath: string,
  content: string,
  config: import("../lib/config.js").WikicConfig,
  dir: string
): Promise<{ ok: true; summaryPath: string } | { ok: false; error?: string }> {
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

export const compileCommand = new Command("compile")
  .description("Compile sources into wiki articles")
  .option("--full", "Force full recompilation")
  .action(async (opts) => {
    const dir = process.cwd();
    const config = loadConfig(dir);
    const manifest = loadManifest(dir);
    const stats: CompileStats = {
      sources_added: 0,
      sources_modified: 0,
      summarized: 0,
      concepts_extracted: 0,
      articles_written: 0,
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

      manifest.sources[sourcePath].summary_path = result.summaryPath ?? null;
      manifest.sources[sourcePath].compiled_at = new Date().toISOString();
      stats.summarized++;
    }

    // Step 3: Extract concepts from summaries
    const allConcepts: Map<string, { concept: ExtractedConcept; sources: string[] }> = new Map();

    for (const sourcePath of toProcess) {
      const entry = manifest.sources[sourcePath];
      if (!entry.summary_path || entry.status === "error") continue;

      const summaryContent = readText(join(dir, entry.summary_path));
      console.error(`  Extracting concepts from ${sourcePath}...`);
      const resp = await llmCall(EXTRACT_SYSTEM, buildExtractPrompt(summaryContent), config);

      if (!resp.ok) {
        stats.errors.push(`Extract failed for ${sourcePath}: ${resp.error}`);
        continue;
      }

      try {
        // Try to parse JSON from the response (handle markdown fences)
        let jsonStr = resp.text.trim();
        if (jsonStr.startsWith("```")) {
          jsonStr = jsonStr.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
        }
        const concepts: ExtractedConcept[] = JSON.parse(jsonStr);

        for (const c of concepts) {
          const slug = slugify(c.name);
          const existing = allConcepts.get(slug);
          if (existing) {
            existing.sources.push(sourcePath);
            existing.concept.aliases = [...new Set([...existing.concept.aliases, ...c.aliases])];
          } else {
            allConcepts.set(slug, { concept: c, sources: [sourcePath] });
          }
          stats.concepts_extracted++;
        }
      } catch {
        stats.errors.push(`Failed to parse concepts from ${sourcePath}: ${resp.text.slice(0, 200)}`);
      }
    }

    // Step 4: Write concept articles
    const conceptsDir = join(dir, config.output_dir, "concepts");
    ensureDir(conceptsDir);
    const allSlugs = [
      ...allConcepts.keys(),
      ...Object.keys(manifest.concepts),
    ];

    for (const [slug, { concept, sources }] of allConcepts) {
      console.error(`  Writing article: ${slug}...`);

      // Gather source material for this concept
      const sourceMaterial: string[] = [];
      for (const sp of sources) {
        const entry = manifest.sources[sp];
        if (entry?.summary_path) {
          sourceMaterial.push(readText(join(dir, entry.summary_path)));
        }
      }

      const articlePath = join(config.output_dir, "concepts", `${slug}.md`);

      const resp = await llmCall(
        WRITE_SYSTEM,
        buildWritePrompt(
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
        continue;
      }

      writeText(join(dir, articlePath), resp.text);
      upsertConcept(manifest, slug, sources[0], articlePath, concept.aliases);
      manifest.concepts[slug].last_compiled = new Date().toISOString();

      // Register all sources for this concept
      for (const sp of sources) {
        upsertConcept(manifest, slug, sp, articlePath);
      }

      manifest.sources[sources[0]].status = "compiled";
      stats.articles_written++;
    }

    // Step 5: Generate index
    generateIndex(dir, config.output_dir, manifest);

    // Step 6: Generate MOC (Map of Content)
    generateMOC(dir, config.output_dir, manifest);

    // Step 7: Update CHANGELOG
    appendChangelog(dir, config.output_dir, stats);

    // Mark all processed sources as compiled
    for (const sp of toProcess) {
      if (manifest.sources[sp].status !== "error") {
        manifest.sources[sp].status = "compiled";
      }
    }

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
  // Read concept articles to extract tags
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
  const changelogPath = join(dir, outputDir, "CHANGELOG.md");
  let existing = "";
  try {
    existing = readText(changelogPath);
  } catch {
    existing = "# CHANGELOG\n\nCompilation history.\n";
  }

  const entry = `
## ${new Date().toISOString()}

- Added: ${stats.sources_added} sources
- Modified: ${stats.sources_modified} sources
- Summarized: ${stats.summarized}
- Concepts extracted: ${stats.concepts_extracted}
- Articles written: ${stats.articles_written}
- Errors: ${stats.errors.length}
${stats.errors.length > 0 ? stats.errors.map((e) => `  - ${e}`).join("\n") : ""}
`;

  writeText(changelogPath, existing + entry);
}
