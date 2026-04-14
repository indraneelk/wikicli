import type { RelationEntry } from "../lib/manifest.js";

export const QUERY_SYSTEM = `You are a wiki-powered research assistant. Answer the user's question using ONLY the wiki content provided below.

Rules:
- Ground every claim in the wiki content
- Cite sources using [[concept-slug]] wikilinks
- If the wiki doesn't contain enough information to fully answer, say so
- If contradictions are present between articles, acknowledge them and present multiple viewpoints
- Be concise and direct
`;

export function buildQueryPrompt(
  question: string,
  wikiContent: string,
  conflicts?: RelationEntry[]
): string {
  let content = wikiContent;

  if (conflicts && conflicts.length > 0) {
    const conflictNotice = `--- CONFLICT NOTICE ---
The following articles contain contradictory claims. Acknowledge this in your answer.
${conflicts.map(c => `CONFLICT: [[${c.source}]] vs [[${c.target}]] — ${c.evidence || 'contradictory'}`).join('\n')}
---`;
    content = `${conflictNotice}\n\n${content}`;
  }

  return `Question: ${question}

--- WIKI CONTENT ---
${content}
--- END WIKI CONTENT ---`;
}
