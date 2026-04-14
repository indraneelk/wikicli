import { Command } from "commander";
import { join } from "path";
import { loadConfig } from "../lib/config.js";
import { loadManifest, loadRelations, saveRelations, upsertRelation } from "../lib/manifest.js";
import { readText, writeText } from "../lib/files.js";
import { listMarkdownFiles } from "../lib/files.js";
import {
  generateCandidates,
  simpleExtractFacts,
  extractClaims,
  verifyContradiction,
  hashContent,
  loadCheckedPairs,
  saveCheckedPairs,
  shouldRecheck,
  type ClaimContradiction,
} from "../lib/conflicts.js";

interface LintError {
  file: string;
  type: string;
  message: string;
}

interface VerifiedContradiction {
  fileA: string;
  fileB: string;
  confidence: number;
  severity: "high" | "medium" | "low";
  conflictType: string;
  conflicts: ClaimContradiction[];
  recommendedAction: string;
}

interface PendingReviewItem {
  fileA: string;
  fileB: string;
  confidence: number;
  reason: string;
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

    if (opts.contradictions || opts.fix) {
      const relations = loadRelations(dir);
      const wikicDir = join(dir, ".wikic");

      const checkedPairs = loadCheckedPairs(wikicDir);
      const checkedPairsMap = new Map(checkedPairs.map(p => [`${p.slugA}|${p.slugB}`, p]));

      const articleCache: Record<string, string> = {};
      for (const [slug, concept] of Object.entries(manifest.concepts)) {
        try {
          articleCache[slug] = readText(join(dir, concept.article_path));
        } catch {
          articleCache[slug] = "";
        }
      }

      const candidates = generateCandidates(manifest, relations, articleCache, {
        minSharedSources: 1,
        minKeywordOverlap: 0.15,
      });

      const verifiedContradictions: VerifiedContradiction[] = [];
      const pendingReview: PendingReviewItem[] = [];
      const skippedPairs: string[] = [];
      const allCandidates: string[] = [];

      let checkedCount = 0;
      let verifiedCount = 0;
      let pendingCount = 0;
      let skippedCount = 0;

      const FIX_CONFIDENCE_THRESHOLD = 0.8;
      const VERIFIED_CONFIDENCE_THRESHOLD = 0.7;

      for (const candidate of candidates) {
        const key = [candidate.slugA, candidate.slugB].sort().join("|");
        allCandidates.push(key);

        const contentA = articleCache[candidate.slugA];
        const contentB = articleCache[candidate.slugB];
        if (!contentA || !contentB) {
          skippedCount++;
          skippedPairs.push(key);
          continue;
        }

        const hashA = hashContent(contentA);
        const hashB = hashContent(contentB);

        const existing = checkedPairsMap.get(key);
        if (existing && !shouldRecheck(existing, hashA, hashB)) {
          skippedCount++;
          skippedPairs.push(key);
          continue;
        }

        checkedCount++;
        process.stderr.write(`[${checkedCount}/${candidates.length}] Checking ${candidate.slugA} vs ${candidate.slugB}...\n`);

        let claimsA: any[] = [];
        let claimsB: any[] = [];

        if (!opts.skipLlm) {
          try {
            claimsA = await extractClaims(contentA, candidate.slugA, config);
          } catch (e) {
            process.stderr.write(`  Warning: Failed to extract claims for ${candidate.slugA}, using fallback\n`);
          }

          try {
            claimsB = await extractClaims(contentB, candidate.slugB, config);
          } catch (e) {
            process.stderr.write(`  Warning: Failed to extract claims for ${candidate.slugB}, using fallback\n`);
          }
        }

        if (claimsA.length === 0) {
          claimsA = simpleExtractFacts(contentA).map(f => ({ raw: f.raw, certainty: "definite" as const, scope: "specific" as const, negated: false }));
        }
        if (claimsB.length === 0) {
          claimsB = simpleExtractFacts(contentB).map(f => ({ raw: f.raw, certainty: "definite" as const, scope: "specific" as const, negated: false }));
        }

        if (opts.skipLlm) {
          skippedCount++;
          skippedPairs.push(key);
          checkedPairsMap.set(key, {
            slugA: candidate.slugA,
            slugB: candidate.slugB,
            articleHashA: hashA,
            articleHashB: hashB,
            lastChecked: new Date().toISOString(),
            previouslyVerified: false,
          });
          continue;
        }

        const result = await verifyContradiction(
          candidate.slugA,
          claimsA,
          candidate.slugB,
          claimsB,
          config
        );

        if (result.verified && result.confidence >= VERIFIED_CONFIDENCE_THRESHOLD) {
          verifiedCount++;
          const maxSeverity = result.contradictions.reduce((max, c) => {
            const order = { high: 3, medium: 2, low: 1 };
            return order[c.severity] > order[max] ? c.severity : max;
          }, "low" as "high" | "medium" | "low");

          const conflictTypes = [...new Set(result.contradictions.map(c => c.conflictType))];

          verifiedContradictions.push({
            fileA: candidate.slugA,
            fileB: candidate.slugB,
            confidence: result.confidence,
            severity: maxSeverity,
            conflictType: conflictTypes.join(", "),
            conflicts: result.contradictions,
            recommendedAction: result.recommendedAction,
          });

          if (!result.needsHumanReview && opts.fix && result.confidence >= FIX_CONFIDENCE_THRESHOLD) {
            upsertRelation(
              manifest,
              relations,
              candidate.slugA,
              candidate.slugB,
              "contradicts",
              result.contradictions.map(c => c.explanation).join("; ")
            );
            const relation = relations.find(r => r.source === candidate.slugA && r.target === candidate.slugB && r.type === "contradicts");
            if (relation) {
              (relation as any).confidence = result.confidence;
              (relation as any).conflictType = conflictTypes[0];
              (relation as any).reviewed = true;
            }
          } else if (result.needsHumanReview) {
            pendingCount++;
            pendingReview.push({
              fileA: candidate.slugA,
              fileB: candidate.slugB,
              confidence: result.confidence,
              reason: result.explanation || "Low confidence — requires human domain knowledge",
            });

            if (opts.fix) {
              const pathA = join(dir, manifest.concepts[candidate.slugA]?.article_path || "");
              const pathB = join(dir, manifest.concepts[candidate.slugB]?.article_path || "");
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
        } else if (result.confidence > 0 && result.confidence < VERIFIED_CONFIDENCE_THRESHOLD) {
          pendingCount++;
          pendingReview.push({
            fileA: candidate.slugA,
            fileB: candidate.slugB,
            confidence: result.confidence,
            reason: result.explanation || "Medium confidence — requires human domain knowledge",
          });
        }

        checkedPairsMap.set(key, {
          slugA: candidate.slugA,
          slugB: candidate.slugB,
          articleHashA: hashA,
          articleHashB: hashB,
          lastChecked: new Date().toISOString(),
          previouslyVerified: result.verified,
        });
      }

      const newCheckedPairs = Array.from(checkedPairsMap.values());
      saveCheckedPairs(wikicDir, newCheckedPairs);

      if (opts.fix) {
        saveRelations(dir, relations);
      }

      const highConfidence = verifiedContradictions.filter(v => v.confidence >= 0.9).length;
      const mediumConfidence = verifiedContradictions.filter(v => v.confidence >= 0.7 && v.confidence < 0.9).length;
      const lowConfidence = verifiedContradictions.filter(v => v.confidence < 0.7).length;
      const avgConfidence = verifiedContradictions.length > 0
        ? verifiedContradictions.reduce((sum, v) => sum + v.confidence, 0) / verifiedContradictions.length
        : 0;

      console.log(JSON.stringify({
        ok: errors.length === 0,
        error_count: errors.length,
        errors: errors,
        contradiction_summary: {
          candidates_checked: checkedCount,
          verified_contradictions: verifiedCount,
          pending_review: pendingCount,
          skipped_unchanged: skippedCount,
          avg_confidence: Math.round(avgConfidence * 100) / 100,
          high_confidence: highConfidence,
          medium_confidence: mediumConfidence,
          low_confidence: lowConfidence,
        },
        verified_contradictions: verifiedContradictions,
        pending_review: pendingReview,
        summary: {
          broken_links: errors.filter((e) => e.type === "broken-link").length,
          missing_fields: errors.filter((e) => e.type === "missing-field").length,
          orphans: errors.filter((e) => e.type === "orphan").length,
          empty_sections: errors.filter((e) => e.type === "empty-section").length,
          missing_articles: errors.filter((e) => e.type === "missing-article").length,
          duplicate_aliases: errors.filter((e) => e.type === "duplicate-alias").length,
          contradictions: verifiedContradictions.length,
          high_severity: verifiedContradictions.filter((e) => e.severity === "high").length,
          medium_severity: verifiedContradictions.filter((e) => e.severity === "medium").length,
          low_severity: verifiedContradictions.filter((e) => e.severity === "low").length,
          fixes_applied: opts.fix ? verifiedContradictions.filter(v => !v.recommendedAction?.includes("review")).length : 0,
        },
      }));
      return;
    }

    console.log(JSON.stringify({
      ok: errors.length === 0,
      error_count: errors.length,
      errors: errors,
      summary: {
        broken_links: errors.filter((e) => e.type === "broken-link").length,
        missing_fields: errors.filter((e) => e.type === "missing-field").length,
        orphans: errors.filter((e) => e.type === "orphan").length,
        empty_sections: errors.filter((e) => e.type === "empty-section").length,
        missing_articles: errors.filter((e) => e.type === "missing-article").length,
        duplicate_aliases: errors.filter((e) => e.type === "duplicate-alias").length,
        contradictions: 0,
        high_severity: 0,
        medium_severity: 0,
        low_severity: 0,
        fixes_applied: 0,
      },
    }));
  });

export { lintCmd };
export const lintCommand = lintCmd;