import { Command } from "commander";
import { join } from "path";
import { loadConfig } from "../lib/config.js";
import { loadManifest, loadRelations, saveRelations, upsertRelation } from "../lib/manifest.js";
import { readText, writeText } from "../lib/files.js";
import { listMarkdownFiles } from "../lib/files.js";
import { generateCandidates, extractFacts, verifyContradiction, type Fact, type ContradictionResult, type ContradictionConflict } from "../lib/conflicts.js";
import type { RelationEntry } from "../lib/manifest.js";

interface LintError {
  file: string;
  type: string;
  message: string;
}

interface ContradictionError {
  type: "contradiction";
  fileA: string;
  fileB: string;
  severity: "high" | "medium" | "low";
  conflicts: ContradictionConflict[];
  recommendedAction: "merge" | "stale" | "warn";
}

const lintCmd = new Command("lint")
  .description("Check wiki for broken links, missing fields, orphans, and contradictions")
  .option("--contradictions", "Run contradiction detection pass")
  .option("--fix", "Apply auto-resolution for contradictions (implies --contradictions)")
  .option("--skipLlm", "Skip LLM verification (only candidate generation + fact extraction)")
  .action(async (opts) => {
    const dir = process.cwd();
    const config = loadConfig(dir);
    const manifest = loadManifest(dir);
    const errors: LintError[] = [];
    const contradictionErrors: ContradictionError[] = [];

    const knownSlugs = new Set(Object.keys(manifest.concepts));
    const conceptsDir = join(dir, config.output_dir, "concepts");
    const conceptFiles = listMarkdownFiles(conceptsDir);

    const inboundLinks: Record<string, number> = {};
    for (const slug of knownSlugs) {
      inboundLinks[slug] = 0;
    }

    for (const file of conceptFiles) {
      const content = readText(file);
      const relPath = file.replace(dir + "/", "");

      if (!content.startsWith("---")) {
        errors.push({ file: relPath, type: "missing-frontmatter", message: "No YAML frontmatter found" });
      } else {
        const frontmatter = content.split("---")[1] || "";
        const requiredFields = ["concept", "sources", "confidence"];
        for (const field of requiredFields) {
          if (!frontmatter.includes(`${field}:`)) {
            errors.push({ file: relPath, type: "missing-field", message: `Missing required field: ${field}` });
          }
        }
      }

      const wikilinks = content.match(/\[\[([^\]]+)\]\]/g) || [];
      for (const link of wikilinks) {
        const slug = link.replace(/\[\[|\]\]/g, "").toLowerCase();
        if (!knownSlugs.has(slug)) {
          errors.push({ file: relPath, type: "broken-link", message: `Broken wikilink: ${link}` });
        } else {
          inboundLinks[slug] = (inboundLinks[slug] || 0) + 1;
        }
      }

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

    for (const [slug, count] of Object.entries(inboundLinks)) {
      if (count === 0) {
        errors.push({
          file: manifest.concepts[slug]?.article_path || slug,
          type: "orphan",
          message: `Concept "${slug}" has no inbound wikilinks`,
        });
      }
    }

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

    // Phase 4/5: Contradiction detection
    if (opts.contradictions || opts.fix) {
      const relations = loadRelations(dir);
      const candidates = generateCandidates(manifest, relations);

      const articleCache: Record<string, string> = {};
      for (const [slug, concept] of Object.entries(manifest.concepts)) {
        try {
          articleCache[slug] = readText(join(dir, concept.article_path));
        } catch {
          articleCache[slug] = "";
        }
      }

      for (const candidate of candidates) {
        const contentA = articleCache[candidate.slugA];
        const contentB = articleCache[candidate.slugB];
        if (!contentA || !contentB) continue;

        const factsA = extractFacts(contentA);
        const factsB = extractFacts(contentB);
        const conceptA = manifest.concepts[candidate.slugA];
        const conceptB = manifest.concepts[candidate.slugB];

        if (opts.skipLlm) continue;

        const result = await verifyContradiction(
          candidate.slugA,
          contentA,
          conceptA?.sources || [],
          factsA,
          candidate.slugB,
          contentB,
          conceptB?.sources || [],
          factsB,
          config
        );

        if (result.contradicts && result.conflicts.length > 0) {
          const maxSeverity = result.conflicts.reduce((max, c) => {
            const order = { high: 3, medium: 2, low: 1 };
            return order[c.severity] > order[max] ? c.severity : max;
          }, "low" as "high" | "medium" | "low");

          contradictionErrors.push({
            type: "contradiction",
            fileA: candidate.slugA,
            fileB: candidate.slugB,
            severity: maxSeverity,
            conflicts: result.conflicts,
            recommendedAction: result.recommendedAction,
          });

          // Phase 5: Auto-resolution
          if (opts.fix) {
            upsertRelation(
              manifest,
              relations,
              candidate.slugA,
              candidate.slugB,
              "contradicts",
              result.conflicts.map((c) => `${c.factA} vs ${c.factB}: ${c.explanation}`).join("; ")
            );

            const pathA = join(dir, conceptA?.article_path || "");
            const pathB = join(dir, conceptB?.article_path || "");

            if (result.recommendedAction === "merge") {
              const mergeNoteA = `\n\n## Conflicting Views\n\nThis article may conflict with [[${candidate.slugB}]]. See that article for an alternative perspective.\n`;
              const mergeNoteB = `\n\n## Conflicting Views\n\nThis article may conflict with [[${candidate.slugA}]]. See that article for an alternative perspective.\n`;
              if (pathA && contentA) writeText(pathA, contentA + mergeNoteA);
              if (pathB && contentB) writeText(pathB, contentB + mergeNoteB);
            } else if (result.recommendedAction === "stale") {
              const staleNoteA = `\n\n^[superseded] This article may be stale. See [[${candidate.slugB}]] for an updated perspective.\n`;
              if (pathA && contentA) writeText(pathA, contentA + staleNoteA);
            } else {
              const addConflictField = (content: string, otherSlug: string) => {
                if (!content.includes("conflicts_with:")) {
                  const frontmatterEnd = content.indexOf("---", 3);
                  if (frontmatterEnd > -1) {
                    const frontmatter = content.slice(0, frontmatterEnd + 3);
                    const body = content.slice(frontmatterEnd + 3);
                    const updatedFrontmatter = frontmatter.replace(
                      /---$/,
                      `conflicts_with: [${otherSlug}]\n---`
                    );
                    return updatedFrontmatter + body;
                  }
                }
                return content;
              };
              if (pathA && contentA) writeText(pathA, addConflictField(contentA, candidate.slugB));
              if (pathB && contentB) writeText(pathB, addConflictField(contentB, candidate.slugA));
            }
          }
        }
      }

      if (opts.fix) {
        saveRelations(dir, relations);
      }
    }

    const allErrors = [...errors, ...contradictionErrors];

    console.log(JSON.stringify({
      ok: allErrors.length === 0,
      error_count: allErrors.length,
      errors: allErrors,
      summary: {
        broken_links: errors.filter((e) => e.type === "broken-link").length,
        missing_fields: errors.filter((e) => e.type === "missing-field").length,
        orphans: errors.filter((e) => e.type === "orphan").length,
        empty_sections: errors.filter((e) => e.type === "empty-section").length,
        missing_articles: errors.filter((e) => e.type === "missing-article").length,
        duplicate_aliases: errors.filter((e) => e.type === "duplicate-alias").length,
        contradictions: contradictionErrors.length,
        high_severity: contradictionErrors.filter((e) => e.severity === "high").length,
        medium_severity: contradictionErrors.filter((e) => e.severity === "medium").length,
        low_severity: contradictionErrors.filter((e) => e.severity === "low").length,
        fixes_applied: opts.fix ? contradictionErrors.length : 0,
      },
    }));
  });

export { lintCmd };
export const lintCommand = lintCmd;
