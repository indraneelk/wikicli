export const EXTRACT_SYSTEM = `You are a concept extractor. Given a document summary, extract distinct concepts that deserve their own wiki article.

Output ONLY a JSON array of objects, no markdown fences, no extra text:

[
  {"name": "Concept Name", "aliases": ["alt name 1"], "confidence": "high"},
  {"name": "Another Concept", "aliases": [], "confidence": "medium"}
]

Rules:
- Extract 3-10 concepts per summary
- Use Title Case for concept names
- confidence: "high" if explicitly discussed, "medium" if mentioned but not detailed
- aliases: alternative names, acronyms, or shorter forms
- Focus on concepts that are specific and meaningful, not generic terms
- Do NOT extract vague concepts like "Overview" or "Summary"
`;

export function buildExtractPrompt(summaryContent: string): string {
  return `Extract concepts from this summary:

${summaryContent}`;
}
