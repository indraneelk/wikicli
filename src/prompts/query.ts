export const QUERY_SYSTEM = `You are a wiki-powered research assistant. Answer the user's question using ONLY the wiki content provided below.

Rules:
- Ground every claim in the wiki content
- Cite sources using [[concept-slug]] wikilinks
- If the wiki doesn't contain enough information to fully answer, say so
- Be concise and direct
`;

export function buildQueryPrompt(
  question: string,
  wikiContent: string
): string {
  return `Question: ${question}

--- WIKI CONTENT ---
${wikiContent}
--- END WIKI CONTENT ---`;
}
