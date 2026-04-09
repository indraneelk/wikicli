import { Command } from "commander";
import { join } from "path";
import { loadConfig } from "../lib/config.js";
import { loadManifest } from "../lib/manifest.js";
import { readText, listMarkdownFiles } from "../lib/files.js";

interface LintError {
  file: string;
  type: string;
  message: string;
}

export const lintCommand = new Command("lint")
  .description("Check wiki for broken links, missing fields, and orphans")
  .action(() => {
    const dir = process.cwd();
    const config = loadConfig(dir);
    const manifest = loadManifest(dir);
    const errors: LintError[] = [];

    const knownSlugs = new Set(Object.keys(manifest.concepts));
    const conceptsDir = join(dir, config.output_dir, "concepts");
    const conceptFiles = listMarkdownFiles(conceptsDir);

    // Track inbound links for orphan detection
    const inboundLinks: Record<string, number> = {};
    for (const slug of knownSlugs) {
      inboundLinks[slug] = 0;
    }

    for (const file of conceptFiles) {
      const content = readText(file);
      const relPath = file.replace(dir + "/", "");

      // Check frontmatter exists
      if (!content.startsWith("---")) {
        errors.push({ file: relPath, type: "missing-frontmatter", message: "No YAML frontmatter found" });
      } else {
        // Check required fields
        const frontmatter = content.split("---")[1] || "";
        const requiredFields = ["concept", "sources", "confidence"];
        for (const field of requiredFields) {
          if (!frontmatter.includes(`${field}:`)) {
            errors.push({ file: relPath, type: "missing-field", message: `Missing required field: ${field}` });
          }
        }
      }

      // Check wikilinks
      const wikilinks = content.match(/\[\[([^\]]+)\]\]/g) || [];
      for (const link of wikilinks) {
        const slug = link.replace(/\[\[|\]\]/g, "").toLowerCase();
        if (!knownSlugs.has(slug)) {
          errors.push({ file: relPath, type: "broken-link", message: `Broken wikilink: ${link}` });
        } else {
          inboundLinks[slug] = (inboundLinks[slug] || 0) + 1;
        }
      }

      // Check for empty sections
      const sections = ["## Definition", "## How it Works", "## Trade-offs"];
      for (const section of sections) {
        if (content.includes(section)) {
          const idx = content.indexOf(section);
          const nextSection = content.indexOf("\n## ", idx + section.length);
          const sectionContent = nextSection > -1
            ? content.slice(idx + section.length, nextSection).trim()
            : content.slice(idx + section.length).trim();
          if (sectionContent.length < 10) {
            errors.push({ file: relPath, type: "empty-section", message: `Section appears empty: ${section}` });
          }
        }
      }
    }

    // Check for orphaned concepts (no inbound links)
    for (const [slug, count] of Object.entries(inboundLinks)) {
      if (count === 0) {
        errors.push({
          file: manifest.concepts[slug]?.article_path || slug,
          type: "orphan",
          message: `Concept "${slug}" has no inbound wikilinks`,
        });
      }
    }

    // Check for concepts in manifest without article files
    for (const [slug, concept] of Object.entries(manifest.concepts)) {
      try {
        readText(join(dir, concept.article_path));
      } catch {
        errors.push({
          file: concept.article_path,
          type: "missing-article",
          message: `Manifest references article that doesn't exist: ${concept.article_path}`,
        });
      }
    }

    // Check for duplicate concepts (by alias)
    const aliasMap: Record<string, string[]> = {};
    for (const [slug, concept] of Object.entries(manifest.concepts)) {
      for (const alias of concept.aliases) {
        const key = alias.toLowerCase();
        if (!aliasMap[key]) aliasMap[key] = [];
        aliasMap[key].push(slug);
      }
    }
    for (const [alias, slugs] of Object.entries(aliasMap)) {
      if (slugs.length > 1) {
        errors.push({
          file: "manifest",
          type: "duplicate-alias",
          message: `Alias "${alias}" shared by concepts: ${slugs.join(", ")}`,
        });
      }
    }

    console.log(JSON.stringify({
      ok: errors.length === 0,
      error_count: errors.length,
      errors,
      summary: {
        broken_links: errors.filter((e) => e.type === "broken-link").length,
        missing_fields: errors.filter((e) => e.type === "missing-field").length,
        orphans: errors.filter((e) => e.type === "orphan").length,
        empty_sections: errors.filter((e) => e.type === "empty-section").length,
        missing_articles: errors.filter((e) => e.type === "missing-article").length,
        duplicate_aliases: errors.filter((e) => e.type === "duplicate-alias").length,
      },
    }));
  });
