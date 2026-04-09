export const HEAL_SYSTEM = `You are a wiki healer. Given a wiki article and a list of lint errors, fix the article.

Return the COMPLETE fixed article (including frontmatter). Do not explain your changes — just output the corrected article.

Common fixes:
- Broken [[wikilinks]]: replace with the closest matching concept from the provided list, or remove if no match
- Missing frontmatter fields: add them with sensible defaults
- Missing sections: add them with brief placeholder content
- Duplicate aliases: deduplicate
`;

export function buildHealPrompt(
  article: string,
  errors: string[],
  knownConcepts: string[]
): string {
  return `Fix this wiki article.

Errors found:
${errors.map((e) => `- ${e}`).join("\n")}

Known concepts (for wikilink resolution): ${knownConcepts.join(", ")}

--- ARTICLE ---
${article}
--- END ARTICLE ---`;
}
