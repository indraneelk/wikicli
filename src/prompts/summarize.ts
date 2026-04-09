export const SUMMARIZE_SYSTEM = `You are a knowledge compiler. Your job is to summarize a source document into a structured format.

Output EXACTLY this format (no extra text):

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
- (comma-separated list of key concept names extracted from this document, use Title Case)
`;

export function buildSummarizePrompt(sourcePath: string, content: string): string {
  return `Summarize this document.

Source path: ${sourcePath}
Current timestamp: ${new Date().toISOString()}

--- DOCUMENT START ---
${content}
--- DOCUMENT END ---`;
}
