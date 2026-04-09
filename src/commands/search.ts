import { Command } from "commander";
import { join } from "path";
import { existsSync } from "fs";
import { loadConfig } from "../lib/config.js";
import { loadManifest } from "../lib/manifest.js";
import { readText } from "../lib/files.js";

interface SearchResult {
  slug: string;
  path: string;
  title: string;
  score: number;
  snippet: string;
  aliases: string[];
  sources: string[];
}

export const searchCommand = new Command("search")
  .description("Search wiki by keyword (no LLM, returns JSON)")
  .argument("<query>", "Search query")
  .option("--limit <n>", "Max results", "10")
  .action((query: string, opts) => {
    const dir = process.cwd();
    const config = loadConfig(dir);
    const manifest = loadManifest(dir);
    const limit = parseInt(opts.limit, 10);

    const queryTerms = query.toLowerCase().split(/\W+/).filter((w) => w.length > 1);
    const results: SearchResult[] = [];

    for (const [slug, concept] of Object.entries(manifest.concepts)) {
      const articlePath = join(dir, concept.article_path);
      if (!existsSync(articlePath)) continue;

      const content = readText(articlePath);
      const contentLower = content.toLowerCase();

      // Score: exact slug match > alias match > content match
      let score = 0;
      for (const term of queryTerms) {
        if (slug.includes(term)) score += 10;
        for (const alias of concept.aliases) {
          if (alias.toLowerCase().includes(term)) score += 5;
        }
        // Count content occurrences
        const regex = new RegExp(term, "gi");
        const matches = contentLower.match(regex);
        if (matches) score += matches.length;
      }

      if (score === 0) continue;

      // Extract snippet: first line after "## Definition" or first non-frontmatter line
      let snippet = "";
      const defIdx = content.indexOf("## Definition");
      if (defIdx > -1) {
        const afterDef = content.slice(defIdx + 14).trim();
        snippet = afterDef.split("\n")[0].slice(0, 200);
      } else {
        const lines = content.split("\n").filter((l) => !l.startsWith("---") && !l.startsWith("#") && l.trim());
        snippet = (lines[0] || "").slice(0, 200);
      }

      // Extract title from first heading
      const titleMatch = content.match(/^#\s+(.+)$/m);
      const title = titleMatch ? titleMatch[1] : slug;

      results.push({
        slug,
        path: concept.article_path,
        title,
        score,
        snippet,
        aliases: concept.aliases,
        sources: concept.sources,
      });
    }

    results.sort((a, b) => b.score - a.score);

    console.log(JSON.stringify({
      ok: true,
      query,
      count: Math.min(results.length, limit),
      results: results.slice(0, limit),
    }));
  });
