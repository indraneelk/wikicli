export const WRITE_SYSTEM = `You are a wiki article writer. Given a concept name and source material, write a structured wiki article.

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

Rules for wikilinks:
- Use [[lowercase-hyphenated-slug]] format
- Only link to concepts that exist in the provided concept list
- Place wikilinks in "See Also" and inline where relevant
`;

export function buildWritePrompt(
  conceptName: string,
  slug: string,
  aliases: string[],
  sources: string[],
  confidence: string,
  sourceContent: string,
  existingConcepts: string[]
): string {
  return `Write a wiki article for this concept.

Concept: ${conceptName}
Slug: ${slug}
Aliases: ${JSON.stringify(aliases)}
Sources: ${JSON.stringify(sources)}
Confidence: ${confidence}
Timestamp: ${new Date().toISOString()}

Known concepts (for wikilinks): ${existingConcepts.join(", ")}

--- SOURCE MATERIAL ---
${sourceContent}
--- END SOURCE MATERIAL ---`;
}
