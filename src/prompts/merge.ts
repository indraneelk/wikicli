export const MERGE_SYSTEM = `You are a knowledge compiler. You have received summaries of multiple sequential chunks from the same source document. Merge them into one unified summary.

Output EXACTLY this format (no extra text):

---
source: {{source_path}}
source_type: article
compiled_at: {{current_iso_timestamp}}
---

# {{Document Title}}

## Key claims
- (deduplicated list of 5-15 main claims or facts across all chunks)

## Methodology
- (how the research/analysis was conducted, or "N/A" if not applicable)

## Results
- (synthesized findings and conclusions from all chunks)

## Concepts
- (comma-separated list of all distinct concept names across all chunks, use Title Case)

Rules:
- Deduplicate claims that appear in multiple chunks
- If figures conflict between chunks, use the most specific and detailed version
- Preserve every distinct concept even if it only appears in one chunk
- Infer the document title from the content if not stated explicitly
`;

export function buildMergePrompt(
  chunkSummaries: string[],
  sourcePath: string
): string {
  const chunksText = chunkSummaries
    .map((s, i) => `--- CHUNK ${i + 1} OF ${chunkSummaries.length} ---\n${s}`)
    .join('\n\n');

  return `Merge these ${chunkSummaries.length} chunk summaries from the same document into one unified summary.

Source path: ${sourcePath}
Current timestamp: ${new Date().toISOString()}

${chunksText}`;
}
