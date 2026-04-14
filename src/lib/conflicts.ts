import type { Manifest, RelationEntry } from "./manifest.js";
import type { WikicConfig } from "./config.js";
import { llmCall } from "./llm.js";
import { readText } from "./files.js";
import { join } from "path";

// ── Types ──────────────────────────────────────────────────────────────────────

export interface Fact {
  type: "date" | "number" | "definition" | "performance" | "claim";
  value: string;
  raw: string;
  context: string;
}

export interface ContradictionCandidate {
  slugA: string;
  slugB: string;
  sharedSources: string[];
}

export interface ContradictionConflict {
  factA: string;
  factB: string;
  explanation: string;
  severity: "high" | "medium" | "low";
}

export interface ContradictionResult {
  contradicts: boolean;
  conflicts: ContradictionConflict[];
  recommendedAction: "merge" | "stale" | "warn";
}

// ── Candidate Generation ───────────────────────────────────────────────────────

export function generateCandidates(
  manifest: Manifest,
  relations: RelationEntry[]
): ContradictionCandidate[] {
  const candidates = new Map<string, ContradictionCandidate>();

  // Build source-to-concepts index
  const sourceToConcepts: Record<string, string[]> = {};
  for (const [slug, concept] of Object.entries(manifest.concepts)) {
    for (const src of concept.sources) {
      if (!sourceToConcepts[src]) sourceToConcepts[src] = [];
      sourceToConcepts[src].push(slug);
    }
  }

  // Generate candidates from shared sources
  for (const [source, slugs] of Object.entries(sourceToConcepts)) {
    for (let i = 0; i < slugs.length; i++) {
      for (let j = i + 1; j < slugs.length; j++) {
        const slugA = slugs[i];
        const slugB = slugs[j];
        const key = [slugA, slugB].sort().join("|");
        if (!candidates.has(key)) {
          candidates.set(key, { slugA, slugB, sharedSources: [source] });
        } else {
          candidates.get(key)!.sharedSources.push(source);
        }
      }
    }
  }

  // Add pairs from relation graph
  for (const rel of relations) {
    const key = [rel.source, rel.target].sort().join("|");
    if (!candidates.has(key)) {
      candidates.set(key, { slugA: rel.source, slugB: rel.target, sharedSources: [] });
    }
  }

  return Array.from(candidates.values());
}

// ── Claim Extraction ────────────────────────────────────────────────────────────

export function extractFacts(content: string): Fact[] {
  const facts: Fact[] = [];
  const datePatterns = [
    /\b(19|20)\d{2}\b/g,
    /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]* \d{1,2},? (19|20)\d{2}\b/gi,
  ];
  const numberPatterns = [
    /\d+(?:\.\d+)?\s*%/g,
    /\b\$\d+(?:,\d{3})*(?:\.\d{2})?\b/g,
    /\b\d+(?:\.\d+)?\s*(?:times|x|faster|slower|better|worse)\b/gi,
    /\bO\([^)]+\)\b/g,
  ];
  const defPatterns = [/\b(?:is a type of|is defined as|is an example of|is a form of)\b[^.]+\./gi];
  const perfPatterns = [/\b(?:achieves?|reaches?|attains?)\b[^.]+\b(?:accuracy|precision|recall|F1|score|latency|throughput)\b[^.]+\./gi];
  const claimPatterns = [/\b(?:all|none|always|never)\b[^.]+\./gi];

  for (const pattern of datePatterns) {
    let match;
    while ((match = pattern.exec(content)) !== null) {
      facts.push({
        type: "date",
        value: match[0].toLowerCase().trim(),
        raw: match[0],
        context: extractContext(content, match.index),
      });
    }
  }

  for (const pattern of numberPatterns) {
    let match;
    while ((match = pattern.exec(content)) !== null) {
      facts.push({
        type: "number",
        value: match[0].toLowerCase().trim(),
        raw: match[0],
        context: extractContext(content, match.index),
      });
    }
  }

  for (const pattern of defPatterns) {
    let match;
    while ((match = pattern.exec(content)) !== null) {
      facts.push({
        type: "definition",
        value: match[0].toLowerCase().trim(),
        raw: match[0],
        context: extractContext(content, match.index),
      });
    }
  }

  for (const pattern of perfPatterns) {
    let match;
    while ((match = pattern.exec(content)) !== null) {
      facts.push({
        type: "performance",
        value: match[0].toLowerCase().trim(),
        raw: match[0],
        context: extractContext(content, match.index),
      });
    }
  }

  for (const pattern of claimPatterns) {
    let match;
    while ((match = pattern.exec(content)) !== null) {
      facts.push({
        type: "claim",
        value: match[0].toLowerCase().trim(),
        raw: match[0],
        context: extractContext(content, match.index),
      });
    }
  }

  return facts;
}

function extractContext(content: string, index: number): string {
  const start = Math.max(0, index - 60);
  const end = Math.min(content.length, index + 120);
  return content.slice(start, end).replace(/\n/g, " ").trim();
}

export function normalizeFact(fact: Fact): string {
  return fact.value
    .toLowerCase()
    .replace(/\b(a|an|the)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// ── LLM Verification ──────────────────────────────────────────────────────────

export async function verifyContradiction(
  slugA: string,
  contentA: string,
  sourcesA: string[],
  factsA: Fact[],
  slugB: string,
  contentB: string,
  sourcesB: string[],
  factsB: Fact[],
  config: WikicConfig
): Promise<ContradictionResult> {
  const systemPrompt = `You are a knowledge consistency checker. Analyze whether two wiki articles contain contradictory claims and output only valid JSON.`;

  const factsALines = factsA.map((f) => `- [${f.type}] ${f.raw}`).join("\n");
  const factsBLines = factsB.map((f) => `- [${f.type}] ${f.raw}`).join("\n");

  const userMessage = `Two wiki articles may contain contradictory claims.

Article A — [[${slugA}]] (sources: ${sourcesA.join(", ") || "none"}):
${contentA.slice(0, 3000)}

Extracted facts from Article A:
${factsALines || "(no extractable facts)"}

---

Article B — [[${slugB}]] (sources: ${sourcesB.join(", ") || "none"}):
${contentB.slice(0, 3000)}

Extracted facts from Article B:
${factsBLines || "(no extractable facts)"}

Analyze whether the articles contain contradictory claims.

If YES — output ONLY this JSON (no markdown, no explanation):
{"contradicts":true,"conflicts":[{"factA":"...","factB":"...","explanation":"...","severity":"high|medium|low"}],"recommendedAction":"merge|stale|warn"}

If NO contradiction — output ONLY this JSON:
{"contradicts":false,"conflicts":[],"recommendedAction":"warn"}`;

  const response = await llmCall(systemPrompt, userMessage, config);

  if (!response.ok || !response.text) {
    return {
      contradicts: false,
      conflicts: [],
      recommendedAction: "warn",
    };
  }

  try {
    const cleaned = response.text.replace(/^```json\s*|```\s*$/g, "").trim();
    const parsed = JSON.parse(cleaned) as ContradictionResult;
    return {
      contradicts: parsed.contradicts ?? false,
      conflicts: Array.isArray(parsed.conflicts) ? parsed.conflicts : [],
      recommendedAction: parsed.recommendedAction ?? "warn",
    };
  } catch {
    return {
      contradicts: false,
      conflicts: [],
      recommendedAction: "warn",
    };
  }
}
