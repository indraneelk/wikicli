export const RELATE_SYSTEM = `You are a knowledge graph builder. Given a concept and source material, extract typed relationships to other concepts in the wiki.

Output ONLY JSON (no markdown fences, no extra text):
[
  {"target": "slug", "type": "implements|extends|optimizes|contradicts|cites|prerequisite_of|trades_off|derived_from", "evidence": "why this relation exists (1-2 sentences from source)"},
  ...
]

Rules:
- Only use relation types from: implements, extends, optimizes, contradicts, cites, prerequisite_of, trades_off, derived_from
- target must be a slug (lowercase, hyphenated) matching an existing concept
- evidence: brief excerpt from source material explaining the relationship
- Only include relations that are clearly supported by the source material
- contradictions are high-value: look for claims that disagree with common understanding
- Return empty array [] if no meaningful relations are found
`;

export function buildRelatePrompt(
  conceptName: string,
  slug: string,
  sourceContent: string,
  existingConcepts: string[]
): string {
  return `Extract typed relationships from this concept article's source material.

Concept: ${conceptName}
Slug: ${slug}
Existing concepts in wiki: ${existingConcepts.join(", ")}

--- SOURCE MATERIAL ---
${sourceContent}
--- END SOURCE MATERIAL ---`;
}
