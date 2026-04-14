import type { Manifest, RelationEntry } from "./manifest.js";
import type { WikicConfig } from "./config.js";
import { llmCall } from "./llm.js";
import { readText, writeText, ensureDir } from "./files.js";
import { existsSync } from "fs";
import { join } from "path";

const STOPWORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "must", "shall", "can", "need", "dare", "ought",
  "used", "to", "of", "in", "for", "on", "with", "at", "by", "from", "as",
  "into", "through", "during", "before", "after", "above", "below", "between",
  "under", "again", "further", "then", "once", "here", "there", "when", "where",
  "why", "how", "all", "each", "few", "more", "most", "other", "some", "such",
  "no", "nor", "not", "only", "own", "same", "so", "than", "too", "very"
]);

// ── Types ──────────────────────────────────────────────────────────────────────

export interface Claim {
  id: string;
  subject: string;
  predicate: string;
  object: string;
  certainty: "definite" | "probable" | "speculative";
  scope: "universal" | "general" | "specific";
  negated: boolean;
  raw: string;
  excerpt: string;
}

export interface Fact {
  type: "date" | "number" | "definition" | "performance" | "claim";
  value: string;
  raw: string;
  context: string;
}

export interface ClaimContradiction {
  claimA: Claim;
  claimB: Claim;
  explanation: string;
  conflictType: "negation" | "scope_mismatch" | "factual_disagreement" | "definitional" | "other";
  severity: "high" | "medium" | "low";
}

export interface ContradictionResult {
  verified: boolean;
  confidence: number;
  claimsA: Claim[];
  claimsB: Claim[];
  contradictions: ClaimContradiction[];
  explanation: string;
  recommendedAction: "review" | "merge" | "stale" | "warn" | "ignore";
  needsHumanReview: boolean;
}

export interface ContradictionCandidate {
  slugA: string;
  slugB: string;
  sharedSources: string[];
  keywordOverlap?: number;
  hasWikilink?: boolean;
}

export interface CheckedPair {
  slugA: string;
  slugB: string;
  articleHashA: string;
  articleHashB: string;
  lastChecked: string;
  previouslyVerified: boolean;
}

// ── Pure Functions ───────────────────────────────────────────────────────────

export function generateCandidates(
  manifest: Manifest,
  relations: RelationEntry[],
  articleCache: Record<string, string>,
  options?: { minSharedSources?: number; minKeywordOverlap?: number }
): ContradictionCandidate[] {
  const candidates = new Map<string, ContradictionCandidate>();
  // Require 2+ shared sources by default: a concept pair sharing only one source
  // is likely just co-mentioned, not genuinely in tension. Pairs that appear
  // across multiple sources are far more likely to carry conflicting claims.
  const minSharedSources = options?.minSharedSources ?? 2;

  // Phase 1: shared-source pairs (only pairs appearing in 2+ sources together)
  const sourceToConcepts: Record<string, string[]> = {};
  for (const [slug, concept] of Object.entries(manifest.concepts)) {
    for (const src of concept.sources) {
      if (!sourceToConcepts[src]) sourceToConcepts[src] = [];
      sourceToConcepts[src].push(slug);
    }
  }

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

  // Phase 2: explicitly related pairs from the relation graph (wikilinks)
  // These are already identified as related by the LLM, so always worth checking.
  for (const rel of relations) {
    const key = [rel.source, rel.target].sort().join("|");
    if (!candidates.has(key)) {
      candidates.set(key, { slugA: rel.source, slugB: rel.target, sharedSources: [], hasWikilink: true });
    } else {
      candidates.get(key)!.hasWikilink = true;
    }
  }

  // NOTE: The previous O(n²) full-corpus keyword-overlap scan is intentionally
  // removed. For large wikis (100+ concepts) it generates tens of thousands of
  // pairs and produces mostly false positives in domain-specific corpora where
  // every article shares high-frequency domain terms. Contradiction signal comes
  // from structural relationships (shared sources, explicit wikilinks), not
  // keyword co-occurrence alone.

  return Array.from(candidates.values()).filter(c =>
    c.sharedSources.length >= minSharedSources ||
    c.hasWikilink
  );
}

export function simpleExtractFacts(content: string): Fact[] {
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

export function computeKeywordOverlap(contentA: string, contentB: string): number {
  const extractKeywords = (text: string): Set<string> => {
    const normalized = text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter(word => word.length > 2 && !STOPWORDS.has(word));
    const freq: Record<string, number> = {};
    for (const word of normalized) {
      freq[word] = (freq[word] ?? 0) + 1;
    }
    const sorted = Object.entries(freq)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([word]) => word);
    return new Set(sorted);
  };

  const keywordsA = extractKeywords(contentA);
  const keywordsB = extractKeywords(contentB);

  if (keywordsA.size === 0 || keywordsB.size === 0) return 0;

  let intersection = 0;
  for (const kw of keywordsA) {
    if (keywordsB.has(kw)) intersection++;
  }

  const union = keywordsA.size + keywordsB.size - intersection;
  return union > 0 ? intersection / union : 0;
}

export function hashContent(content: string): string {
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    const char = content.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return (hash >>> 0).toString(16);
}

export function loadCheckedPairs(dir: string): CheckedPair[] {
  const filePath = join(dir, "checked_pairs.json");
  try {
    if (existsSync(filePath)) {
      const content = readText(filePath);
      return JSON.parse(content) as CheckedPair[];
    }
  } catch {
    return [];
  }
  return [];
}

export function saveCheckedPairs(dir: string, pairs: CheckedPair[]): void {
  const filePath = join(dir, "checked_pairs.json");
  try {
    ensureDir(dir);
    writeText(filePath, JSON.stringify(pairs, null, 2));
  } catch (e) {
    console.error("Failed to save checked pairs:", e);
  }
}

export function shouldRecheck(
  pair: CheckedPair,
  currentHashA: string,
  currentHashB: string
): boolean {
  return pair.articleHashA !== currentHashA || pair.articleHashB !== currentHashB;
}

// ── LLM-based Functions ───────────────────────────────────────────────────────

export async function extractClaims(
  content: string,
  slug: string,
  config: WikicConfig
): Promise<Claim[]> {
  const systemPrompt = `You are a knowledge claim extractor. Given a wiki article, extract all significant factual claims it makes.

Output ONLY JSON array:
[
  {"id": "c1", "subject": "...", "predicate": "...", "object": "...", "certainty": "definite|probable|speculative", "scope": "universal|general|specific", "negated": false, "raw": "...", "excerpt": "..."},
  ...
]

Rules:
- subject: the entity making or receiving the claim (e.g., "transformer", "BERT", "this approach")
- predicate: the verb or relation (e.g., "achieves", "is a type of", "cannot scale to")
- object: what is claimed (e.g., "95% accuracy", "a neural architecture", "models with 1B+ parameters")
- certainty: definite (explicitly stated), probable (likely/probably qualifiers), speculative (may/might/suggests)
- scope: universal (all/always/none), general (typically/usually), specific (some/rarely/occasionally)
- negated: true if the claim contains negation words (not, never, cannot, no, without, doesn't, isn't)
- raw: the exact sentence or phrase containing the claim
- excerpt: 1-2 sentences of context around the claim
- Extract 3-15 claims from the article. Focus on claims that could potentially conflict with claims in other articles.
- Ignore purely definitional claims that are widely accepted facts.
- Include performance claims, comparative claims, and scope claims.`;

  const truncated = content.slice(0, 4000);
  const userMessage = `Extract claims from this wiki article:\n\n${truncated}`;

  const response = await llmCall(systemPrompt, userMessage, config);

  if (!response.ok || !response.text) {
    return [];
  }

  try {
    const cleaned = response.text.replace(/^```json\s*|```\s*$/g, "").trim();
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed)) {
      return parsed as Claim[];
    }
  } catch {
    return [];
  }
  return [];
}

export async function verifyContradiction(
  slugA: string,
  claimsA: Claim[],
  slugB: string,
  claimsB: Claim[],
  config: WikicConfig
): Promise<ContradictionResult> {
  const systemPrompt = `You are a knowledge conflict analyst. Two wiki articles have claims. Determine if they contain contradictory claims.

Analyze each claim pair and identify conflicts.

Output ONLY JSON:
{
  "verified": true/false,
  "confidence": 0.0-1.0,
  "contradictions": [
    {
      "claimA_id": "c1",
      "claimB_id": "c3",
      "explanation": "Article A claims X while Article B claims not-X",
      "conflictType": "negation|scope_mismatch|factual_disagreement|definitional|other",
      "severity": "high|medium|low"
    }
  ],
  "explanation": "Summary of the conflict analysis...",
  "recommendedAction": "review|merge|stale|warn|ignore",
  "needsHumanReview": true/false
}

Rules:
- verified: true only if you found specific contradictory claim pairs
- confidence: how certain are you? Higher for clear negation mismatches, lower for subtle scope disagreements
- needsHumanReview: true if confidence < 0.8 OR if conflicts are definitional (require domain knowledge)
- severity: high (clear factual disagreement), medium (scope or certainty mismatch), low (minor disagreement)
- recommendedAction: review (flag for human), merge (conflicting views exist), stale (one is outdated), warn (minor), ignore (no real conflict)`;

  const claimsAJson = JSON.stringify(claimsA, null, 2);
  const claimsBJson = JSON.stringify(claimsB, null, 2);

  const userMessage = `Article A — [[${slugA}]] claims:
${claimsAJson}

Article B — [[${slugB}]] claims:
${claimsBJson}`;

  const response = await llmCall(systemPrompt, userMessage, config);

  if (!response.ok || !response.text) {
    return {
      verified: false,
      confidence: 0,
      claimsA: [],
      claimsB: [],
      contradictions: [],
      explanation: "LLM call failed",
      recommendedAction: "ignore",
      needsHumanReview: true,
    };
  }

  try {
    const cleaned = response.text.replace(/^```json\s*|```\s*$/g, "").trim();
    const parsed = JSON.parse(cleaned);
    
    const contradictions: ClaimContradiction[] = [];
    for (const c of parsed.contradictions ?? []) {
      const claimA = claimsA.find(ca => ca.id === c.claimA_id);
      const claimB = claimsB.find(cb => cb.id === c.claimB_id);
      if (claimA && claimB) {
        contradictions.push({
          claimA,
          claimB,
          explanation: c.explanation,
          conflictType: c.conflictType,
          severity: c.severity,
        });
      }
    }

    return {
      verified: parsed.verified ?? false,
      confidence: parsed.confidence ?? 0,
      claimsA,
      claimsB,
      contradictions,
      explanation: parsed.explanation ?? "",
      recommendedAction: parsed.recommendedAction ?? "ignore",
      needsHumanReview: parsed.needsHumanReview ?? parsed.confidence < 0.8,
    };
  } catch {
    return {
      verified: false,
      confidence: 0,
      claimsA: [],
      claimsB: [],
      contradictions: [],
      explanation: "Failed to parse LLM response",
      recommendedAction: "ignore",
      needsHumanReview: true,
    };
  }
}