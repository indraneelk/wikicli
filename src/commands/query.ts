import { Command } from "commander";
import { join } from "path";
import { existsSync } from "fs";
import { loadConfig } from "../lib/config.js";
import { loadManifest } from "../lib/manifest.js";
import { readText, writeText, ensureDir } from "../lib/files.js";
import { slugify } from "../lib/slug.js";
import { llmCall } from "../lib/llm.js";
import { QUERY_SYSTEM, buildQueryPrompt } from "../prompts/query.js";

export const queryCommand = new Command("query")
  .description("Ask a question answered from wiki content (uses LLM)")
  .argument("<question>", "The question to answer")
  .option("--save", "Save the answer as a wiki page")
  .option("--limit <n>", "Max pages to load as context", "5")
  .action(async (question: string, opts) => {
    const dir = process.cwd();
    const config = loadConfig(dir);
    const manifest = loadManifest(dir);
    const limit = parseInt(opts.limit, 10);

    // Simple relevance: score each concept by keyword overlap with the question
    const questionWords = question.toLowerCase().split(/\W+/).filter((w) => w.length > 2);
    const scored: { slug: string; score: number }[] = [];

    for (const [slug, concept] of Object.entries(manifest.concepts)) {
      const slugWords = slug.split("-");
      const aliasWords = concept.aliases.flatMap((a) => a.toLowerCase().split(/\W+/));
      const allWords = [...slugWords, ...aliasWords];

      let score = 0;
      for (const qw of questionWords) {
        for (const cw of allWords) {
          if (cw.includes(qw) || qw.includes(cw)) score++;
        }
      }
      if (score > 0) scored.push({ slug, score });
    }

    scored.sort((a, b) => b.score - a.score);
    const topPages = scored.slice(0, limit);

    if (topPages.length === 0) {
      console.log(JSON.stringify({
        ok: false,
        error: "No relevant wiki pages found for this question.",
      }));
      return;
    }

    // Load page content
    const wikiContent: string[] = [];
    for (const { slug } of topPages) {
      const concept = manifest.concepts[slug];
      const articlePath = join(dir, concept.article_path);
      if (existsSync(articlePath)) {
        wikiContent.push(`--- ${slug} ---\n${readText(articlePath)}`);
      }
    }

    const resp = await llmCall(
      QUERY_SYSTEM,
      buildQueryPrompt(question, wikiContent.join("\n\n")),
      config
    );

    if (!resp.ok) {
      console.log(JSON.stringify({ ok: false, error: resp.error }));
      return;
    }

    const result: Record<string, unknown> = {
      ok: true,
      answer: resp.text,
      pages_used: topPages.map((p) => p.slug),
    };

    if (opts.save) {
      const querySlug = slugify(question).slice(0, 60);
      const queryPath = join(config.output_dir, "queries", `${querySlug}.md`);
      const queryContent = `---
question: "${question.replace(/"/g, '\\"')}"
answered_at: ${new Date().toISOString()}
pages_used: ${JSON.stringify(topPages.map((p) => p.slug))}
---

# ${question}

${resp.text}
`;
      ensureDir(join(dir, config.output_dir, "queries"));
      writeText(join(dir, queryPath), queryContent);
      result.saved_to = queryPath;
    }

    console.log(JSON.stringify(result));
  });
