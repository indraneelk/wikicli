export interface ExtractedConcept {
  name: string;
  aliases: string[];
  confidence: string;
}

export interface SummarizeAndExtractResult {
  summary: string;
  concepts: ExtractedConcept[];
}

const CONCEPTS_SENTINEL = '<!-- CONCEPTS_JSON';
const CONCEPTS_END = '-->';

export const SUMMARIZE_AND_EXTRACT_SYSTEM = `You are a knowledge compiler. Summarize a source document and extract key concepts from it in one response.

Output EXACTLY this format (no extra text before or after):

---
source: {{source_path}}
source_type: article
compiled_at: {{current_iso_timestamp}}
---

# {{Document Title}}

## Key claims
- (list 5-10 main claims or facts from the document)

## Methodology
- (how the research/analysis was conducted, or "N/A" if not applicable)

## Results
- (synthesized findings and conclusions)

## Concepts
- (comma-separated list of key concept names, use Title Case)

<!-- CONCEPTS_JSON
[{"name":"Concept Name","aliases":["alt name"],"confidence":"high"},{"name":"Another Concept","aliases":[],"confidence":"medium"}]
-->

Rules for the summary:
- Be factual and concise; preserve key claims, figures, and methodology

Rules for CONCEPTS_JSON:
- Extract 3-10 concepts
- Use Title Case for concept names
- confidence: "high" if explicitly discussed, "medium" if mentioned but not detailed
- aliases: alternative names, acronyms, or shorter forms
- Do NOT extract vague concepts like "Overview" or "Summary"
- The JSON must be valid — double-check brackets and quotes before outputting
`;

export function buildSummarizeAndExtractPrompt(
  sourcePath: string,
  content: string
): string {
  return `Summarize this document and extract concepts from it.

Source path: ${sourcePath}
Current timestamp: ${new Date().toISOString()}

--- DOCUMENT START ---
${content}
--- DOCUMENT END ---`;
}

export function parseSummarizeAndExtractResponse(text: string): SummarizeAndExtractResult {
  const sentinelIdx = text.indexOf(CONCEPTS_SENTINEL);
  if (sentinelIdx === -1) return { summary: text.trim(), concepts: [] };

  const summary = text.slice(0, sentinelIdx).trim();
  const jsonStart = sentinelIdx + CONCEPTS_SENTINEL.length;
  const jsonEnd = text.indexOf(CONCEPTS_END, jsonStart);
  if (jsonEnd === -1) return { summary, concepts: [] };

  try {
    const concepts = JSON.parse(text.slice(jsonStart, jsonEnd).trim()) as ExtractedConcept[];
    return { summary, concepts };
  } catch {
    return { summary, concepts: [] };
  }
}
