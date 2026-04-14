export interface ParsedRelation {
  target: string;
  type: string;
  evidence: string;
}

export interface WriteAndRelateResult {
  article: string;
  relations: ParsedRelation[];
}

const RELATIONS_SENTINEL = '<!-- RELATIONS_JSON';
const RELATIONS_END = '-->';

export const WRITE_AND_RELATE_SYSTEM = `You are a wiki article writer and knowledge graph builder. Given a concept and source material, write a structured wiki article AND extract typed relationships in one response.

Output EXACTLY this format (no extra text before or after):

---
concept: {{slug}}
aliases: {{aliases_json_array}}
sources: {{sources_json_array}}
confidence: {{high_or_medium}}
tags: {{tags_json_array}}
created_at: {{timestamp}}
---

# {{Concept Name}}

## Definition
(Clear, concise explanation of what this concept is)

## How it Works
(Technical or operational details)

## Variants
(Different forms, implementations, or approaches — or "N/A")

## Trade-offs
(Strengths vs weaknesses, costs vs benefits)

## See Also
[[related-concept-1]], [[related-concept-2]]

<!-- RELATIONS_JSON
[{"target":"slug","type":"relation-type","evidence":"why (1-2 sentences from source)"}]
-->

Rules for the article:
- Use [[lowercase-hyphenated-slug]] wikilinks only for concepts in the provided concept list
- Place wikilinks in "See Also" and inline where relevant

Rules for RELATIONS_JSON:
- Relation types: implements, extends, optimizes, contradicts, cites, prerequisite_of, trades_off, derived_from
- target must be a slug (lowercase, hyphenated) matching an existing concept in the list
- evidence: 1-2 sentence excerpt from source material supporting the relationship
- Return [] if no meaningful relations found
- The JSON must be valid — double-check brackets and quotes before outputting
`;

export function buildWriteAndRelatePrompt(
  conceptName: string,
  slug: string,
  aliases: string[],
  sources: string[],
  confidence: string,
  sourceContent: string,
  existingConcepts: string[]
): string {
  return `Write a wiki article and extract relationships for this concept.

Concept: ${conceptName}
Slug: ${slug}
Aliases: ${JSON.stringify(aliases)}
Sources: ${JSON.stringify(sources)}
Confidence: ${confidence}
Timestamp: ${new Date().toISOString()}

Known concepts (for wikilinks): ${existingConcepts.join(', ')}

--- SOURCE MATERIAL ---
${sourceContent}
--- END SOURCE MATERIAL ---`;
}

export function parseWriteAndRelateResponse(text: string): WriteAndRelateResult {
  const sentinelIdx = text.indexOf(RELATIONS_SENTINEL);
  if (sentinelIdx === -1) return { article: text.trim(), relations: [] };

  const article = text.slice(0, sentinelIdx).trim();
  const jsonStart = sentinelIdx + RELATIONS_SENTINEL.length;
  const jsonEnd = text.indexOf(RELATIONS_END, jsonStart);
  if (jsonEnd === -1) return { article, relations: [] };

  try {
    const relations = JSON.parse(text.slice(jsonStart, jsonEnd).trim()) as ParsedRelation[];
    return { article, relations };
  } catch {
    return { article, relations: [] };
  }
}