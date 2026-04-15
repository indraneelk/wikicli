import { Command } from "commander";
import { join } from "path";
import { existsSync, mkdirSync } from "fs";
import { loadManifest, loadRelations, saveRelations, upsertRelation } from "../lib/manifest.js";
import { loadCheckedPairs, saveCheckedPairs, generateCandidates, extractClaims, verifyContradiction, hashContent } from "../lib/conflicts.js";
import { loadConfig } from "../lib/config.js";
import { readText, writeText } from "../lib/files.js";

const REVIEW_QUEUE_PATH = ".wikic/review_queue.json";

export interface ReviewItem {
  slugA: string;
  slugB: string;
  addedAt: string;
  confidence?: number;
  conflictType?: string;
  contradictions?: unknown[];
  explanation?: string;
  recommendedAction?: string;
  reviewedAt?: string;
  status: "pending" | "confirmed" | "dismissed";
  notes?: string;
}

export interface ReviewQueue {
  pending: ReviewItem[];
  confirmed: ReviewItem[];
  dismissed: ReviewItem[];
}

export function loadReviewQueue(dir: string): ReviewQueue {
  const p = join(dir, REVIEW_QUEUE_PATH);
  if (!existsSync(p)) return { pending: [], confirmed: [], dismissed: [] };
  return JSON.parse(readText(p));
}

export function saveReviewQueue(dir: string, queue: ReviewQueue): void {
  const p = join(dir, REVIEW_QUEUE_PATH);
  const d = join(dir, ".wikic");
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
  writeText(p, JSON.stringify(queue, null, 2));
}

export const contradictionsCommand = new Command("contradictions")
  .description("Manage contradiction candidates and review queue")
  .option("--pending", "Show only pending review")
  .option("--verified", "Show only verified (in graph.json)")
  .option("--all", "Show all contradictions")
  .option("--json", "Output as JSON")
  .option("--export <path>", "Export contradictions to file")
  .action(async (opts) => {
    const dir = process.cwd();

    const manifest = loadManifest(dir);
    const relations = loadRelations(dir);
    const queue = loadReviewQueue(dir);

    const verifiedRelations = relations.filter(r => r.type === "contradicts");

    let pending = queue.pending;
    let verified = verifiedRelations.map(r => ({
      slugA: r.source,
      slugB: r.target,
      evidence: r.evidence,
      confidence: (r as any).confidence,
      conflictType: (r as any).conflictType,
      verifiedAt: r.created_at,
    }));
    let dismissed = queue.dismissed;

    if (opts.pending) {
      pending = pending;
      verified = [];
      dismissed = [];
    } else if (opts.verified) {
      pending = [];
      dismissed = [];
    }

    const output = {
      ok: true,
      pending,
      verified,
      dismissed,
      stats: {
        total_pending: queue.pending.length,
        total_verified: queue.confirmed.length + verifiedRelations.length,
        total_dismissed: queue.dismissed.length,
      },
    };

    if (opts.export) {
      const exportPath = opts.export.startsWith("/") || opts.export.startsWith(dir) 
        ? opts.export 
        : join(dir, opts.export);
      const ext = exportPath.toLowerCase().endsWith(".md") ? "md" : "json";
      if (ext === "md") {
        let md = "# Contradictions Report\n\n";
        md += `## Pending Review (${pending.length})\n\n`;
        for (const p of pending) {
          md += `### ${p.slugA} ↔ ${p.slugB}\n`;
          md += `- Confidence: ${Math.round((p.confidence || 0) * 100)}%\n`;
          md += `- Type: ${p.conflictType || "unknown"}\n`;
          md += `- Added: ${p.addedAt}\n`;
          md += `- Explanation: ${p.explanation || "N/A"}\n\n`;
        }
        md += `## Verified Contradictions (${verified.length})\n\n`;
        for (const v of verified) {
          md += `### ${v.slugA} ↔ ${v.slugB}\n`;
          md += `- Confidence: ${Math.round((v.confidence || 0) * 100)}%\n`;
          md += `- Evidence: ${v.evidence || "N/A"}\n\n`;
        }
        md += `## Dismissed (${dismissed.length})\n\n`;
        for (const dItem of dismissed) {
          md += `- ${dItem.slugA} ↔ ${dItem.slugB} (${dItem.notes || "no notes"})\n`;
        }
        writeText(exportPath, md);
      } else {
        writeText(exportPath, JSON.stringify(output, null, 2));
      }
      console.log(JSON.stringify({ ok: true, exported: opts.export }));
      return;
    }

    console.log(JSON.stringify(output, null, 2));
  });

const reviewSubCommand = new Command("review")
  .description("Review a specific contradiction pair")
  .argument("<slugA>", "First concept slug")
  .argument("<slugB>", "Second concept slug")
  .option("--notes <text>", "Add reviewer notes")
  .action(async (slugA: string, slugB: string, opts) => {
    const dir = process.cwd();
    const manifest = loadManifest(dir);
    const queue = loadReviewQueue(dir);

    const allItems = [...queue.pending, ...queue.confirmed, ...queue.dismissed];
    const item = allItems.find(
      i => (i.slugA === slugA && i.slugB === slugB) || (i.slugA === slugB && i.slugB === slugA)
    );

    const conceptA = manifest.concepts[slugA];
    const conceptB = manifest.concepts[slugB];

    let contentA = "";
    let contentB = "";

    if (conceptA) {
      try {
        contentA = readText(join(dir, conceptA.article_path));
      } catch {
        contentA = "[Article file not found]";
      }
    }

    if (conceptB) {
      try {
        contentB = readText(join(dir, conceptB.article_path));
      } catch {
        contentB = "[Article file not found]";
      }
    }

    const wikicDir = join(dir, ".wikic");
    const checkedPairs = loadCheckedPairs(wikicDir);
    const pairKey = [slugA, slugB].sort().join("|");
    const checkedPair = checkedPairs.find(p => [p.slugA, p.slugB].sort().join("|") === pairKey);

    const output: Record<string, unknown> = {
      ok: true,
      slugA,
      slugB,
      status: item?.status || "unknown",
    };

    if (item) {
      output.confidence = item.confidence;
      output.conflictType = item.conflictType;
      output.explanation = item.explanation;
      output.recommendedAction = item.recommendedAction;
      output.notes = item.notes;
    }

    output.articleA = contentA.slice(0, 2000);
    output.articleB = contentB.slice(0, 2000);

    if (checkedPair) {
      output.lastChecked = checkedPair.lastChecked;
      output.previouslyVerified = checkedPair.previouslyVerified;
    }

    console.log(JSON.stringify(output, null, 2));
  });

const confirmSubCommand = new Command("confirm")
  .description("Confirm a contradiction — write contradicts edge to graph.json")
  .argument("<slugA>", "First concept slug")
  .argument("<slugB>", "Second concept slug")
  .option("--notes <text>", "Add notes to the review item")
  .action(async (slugA: string, slugB: string, opts) => {
    const dir = process.cwd();
    const manifest = loadManifest(dir);
    const relations = loadRelations(dir);
    const queue = loadReviewQueue(dir);

    const itemIndex = queue.pending.findIndex(
      i => (i.slugA === slugA && i.slugB === slugB) || (i.slugA === slugB && i.slugB === slugA)
    );

    if (itemIndex === -1) {
      console.log(JSON.stringify({ ok: false, error: "Contradiction not found in pending queue" }));
      return;
    }

    const item = queue.pending[itemIndex];
    const evidence = item.explanation || `Confirmed contradiction between ${slugA} and ${slugB}`;

    upsertRelation(manifest, relations, slugA, slugB, "contradicts", evidence);

    const relation = relations.find(r => r.source === slugA && r.target === slugB && r.type === "contradicts");
    if (relation) {
      (relation as any).confidence = item.confidence || 0.7;
      (relation as any).conflictType = item.conflictType || "unknown";
      (relation as any).reviewed = true;
    }

    const confirmedItem: ReviewItem = {
      ...item,
      status: "confirmed",
      reviewedAt: new Date().toISOString(),
      notes: opts.notes || item.notes,
    };

    queue.pending.splice(itemIndex, 1);
    queue.confirmed.push(confirmedItem);

    saveRelations(dir, relations);
    saveReviewQueue(dir, queue);

    console.log(JSON.stringify({ ok: true, action: "confirmed", slugA, slugB }));
  });

const dismissSubCommand = new Command("dismiss")
  .description("Dismiss a contradiction — remove from pending queue")
  .argument("<slugA>", "First concept slug")
  .argument("<slugB>", "Second concept slug")
  .option("--notes <text>", "Reason for dismissal")
  .action(async (slugA: string, slugB: string, opts) => {
    const dir = process.cwd();
    const queue = loadReviewQueue(dir);

    const itemIndex = queue.pending.findIndex(
      i => (i.slugA === slugA && i.slugB === slugB) || (i.slugA === slugB && i.slugB === slugA)
    );

    if (itemIndex === -1) {
      console.log(JSON.stringify({ ok: false, error: "Contradiction not found in pending queue" }));
      return;
    }

    const item = queue.pending[itemIndex];
    const dismissedItem: ReviewItem = {
      ...item,
      status: "dismissed",
      reviewedAt: new Date().toISOString(),
      notes: opts.notes || item.notes,
    };

    queue.pending.splice(itemIndex, 1);
    queue.dismissed.push(dismissedItem);

    saveReviewQueue(dir, queue);

    console.log(JSON.stringify({ ok: true, action: "dismissed", slugA, slugB }));
  });

// wikic contradictions check <slugA> <slugB>          — direct pair
// wikic contradictions check --source sources/H1.md   — all concepts from that source
// wikic contradictions check --concept event-study     — concept vs its neighbors
const checkSubCommand = new Command("check")
  .description("Run contradiction check on a specific pair, source, or concept")
  .argument("[slugA]", "First concept slug (for direct pair check)")
  .argument("[slugB]", "Second concept slug (for direct pair check)")
  .option("--source <path>", "Check all concepts that came from this source file against each other")
  .option("--concept <slug>", "Check this concept against all concepts it shares sources with")
  .option("--skipLlm", "Only generate candidates, skip LLM verification")
  .action(async (slugA: string | undefined, slugB: string | undefined, opts) => {
    const dir = process.cwd();
    const config = loadConfig(dir);
    const manifest = loadManifest(dir);
    const relations = loadRelations(dir);
    const queue = loadReviewQueue(dir);

    // Build article cache
    const articleCache: Record<string, string> = {};
    for (const [slug, info] of Object.entries(manifest.concepts)) {
      try { articleCache[slug] = readText(join(dir, info.article_path)); } catch { articleCache[slug] = ""; }
    }

    // Determine which pairs to check
    type Pair = { slugA: string; slugB: string };
    let pairs: Pair[] = [];

    if (slugA && slugB) {
      // Direct pair
      if (!manifest.concepts[slugA]) {
        console.log(JSON.stringify({ ok: false, error: `Concept not found: ${slugA}` }));
        return;
      }
      if (!manifest.concepts[slugB]) {
        console.log(JSON.stringify({ ok: false, error: `Concept not found: ${slugB}` }));
        return;
      }
      pairs = [{ slugA, slugB }];
    } else if (opts.source) {
      // All concepts from this source, checked against each other
      const sourcePath = opts.source.startsWith("/") ? opts.source.replace(dir + "/", "") : opts.source;
      const slugs = Object.entries(manifest.concepts)
        .filter(([, info]) => info.sources.includes(sourcePath))
        .map(([slug]) => slug);
      if (slugs.length < 2) {
        console.log(JSON.stringify({ ok: false, error: `Fewer than 2 concepts found for source: ${sourcePath}`, slugs }));
        return;
      }
      for (let i = 0; i < slugs.length; i++) {
        for (let j = i + 1; j < slugs.length; j++) {
          pairs.push({ slugA: slugs[i], slugB: slugs[j] });
        }
      }
    } else if (opts.concept) {
      // This concept vs all concepts it shares sources with (1+ shared source)
      const concept = manifest.concepts[opts.concept];
      if (!concept) {
        console.log(JSON.stringify({ ok: false, error: `Concept not found: ${opts.concept}` }));
        return;
      }
      const sourceSet = new Set(concept.sources);
      const neighbors = new Set<string>();
      for (const [slug, info] of Object.entries(manifest.concepts)) {
        if (slug === opts.concept) continue;
        if (info.sources.some(s => sourceSet.has(s))) neighbors.add(slug);
      }
      pairs = Array.from(neighbors).map(neighbor => ({ slugA: opts.concept, slugB: neighbor }));
    } else {
      console.log(JSON.stringify({ ok: false, error: "Provide two slug arguments, --source, or --concept" }));
      return;
    }

    const results: unknown[] = [];
    let checked = 0;
    let skipped = 0;
    const checkedPairs = loadCheckedPairs(dir);
    const updatedPairs = [...checkedPairs];

    for (const pair of pairs) {
      const contentA = articleCache[pair.slugA] || "";
      const contentB = articleCache[pair.slugB] || "";
      if (!contentA || !contentB) { skipped++; continue; }

      if (opts.skipLlm) {
        results.push({ slugA: pair.slugA, slugB: pair.slugB, status: "candidate_only" });
        checked++;
        continue;
      }

      try {
        const claimsA = await extractClaims(contentA, pair.slugA, config);
        const claimsB = await extractClaims(contentB, pair.slugB, config);
        const result = await verifyContradiction(pair.slugA, claimsA, pair.slugB, claimsB, config);

        checked++;
        const entry: Record<string, unknown> = {
          slugA: pair.slugA,
          slugB: pair.slugB,
          verified: result.verified,
          confidence: result.confidence,
          explanation: result.explanation,
          recommendedAction: result.recommendedAction,
          needsHumanReview: result.needsHumanReview,
          contradictions: result.contradictions,
        };

        // Auto-add high-confidence results to graph + queue
        const key = [pair.slugA, pair.slugB].sort().join("|");
        const alreadyQueued = [...queue.pending, ...queue.confirmed, ...queue.dismissed]
          .some(i => [i.slugA, i.slugB].sort().join("|") === key);

        if (result.verified && result.confidence >= 0.8 && !result.needsHumanReview && !alreadyQueued) {
          upsertRelation(manifest, relations, pair.slugA, pair.slugB, "contradicts",
            result.explanation || `Verified contradiction (confidence: ${Math.round(result.confidence * 100)}%)`);
          entry.action = "added_to_graph";
        } else if ((result.confidence >= 0.5 || result.needsHumanReview) && !alreadyQueued) {
          queue.pending.push({
            slugA: pair.slugA, slugB: pair.slugB,
            addedAt: new Date().toISOString(),
            confidence: result.confidence,
            conflictType: (result.contradictions as Array<{conflictType?: string}>)?.[0]?.conflictType,
            contradictions: result.contradictions as unknown[],
            explanation: result.explanation,
            recommendedAction: result.recommendedAction,
            status: "pending",
          });
          entry.action = "added_to_review_queue";
        }

        updatedPairs.push({
          slugA: pair.slugA, slugB: pair.slugB,
          articleHashA: hashContent(contentA), articleHashB: hashContent(contentB),
          lastChecked: new Date().toISOString(),
          previouslyVerified: result.verified,
        });

        results.push(entry);
      } catch (e) {
        skipped++;
        results.push({ slugA: pair.slugA, slugB: pair.slugB, error: String(e) });
      }
    }

    saveCheckedPairs(dir, updatedPairs);
    saveReviewQueue(dir, queue);
    saveRelations(dir, relations);

    console.log(JSON.stringify({
      ok: true,
      pairs_checked: checked,
      pairs_skipped: skipped,
      results,
    }, null, 2));
  });

contradictionsCommand.addCommand(checkSubCommand);
contradictionsCommand.addCommand(reviewSubCommand);
contradictionsCommand.addCommand(confirmSubCommand);
contradictionsCommand.addCommand(dismissSubCommand);