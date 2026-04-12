const HEADER_RE = /^(#{1,3} |PART [IVX]+\b|Item \d+[A-Z]?\.\s)/;

export function chunkContent(
  content: string,
  maxChars: number,
  minChars: number
): string[] {
  if (content.length <= maxChars) return [content];

  const sections = splitIntoSections(content);

  if (sections.length <= 1) {
    return splitByParagraph(content, maxChars);
  }

  const raw = accumulateSections(sections, maxChars);
  return mergeTiny(raw, minChars);
}

function splitIntoSections(content: string): string[] {
  const lines = content.split('\n');
  const sections: string[] = [];
  let current: string[] = [];

  for (const line of lines) {
    if (current.length > 0 && HEADER_RE.test(line)) {
      sections.push(current.join('\n'));
      current = [line];
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) sections.push(current.join('\n'));
  return sections;
}

function accumulateSections(sections: string[], maxChars: number): string[] {
  const chunks: string[] = [];
  let acc = '';

  for (const section of sections) {
    if (section.length > maxChars) {
      if (acc) { chunks.push(acc); acc = ''; }
      chunks.push(...splitByParagraph(section, maxChars));
      continue;
    }
    const wouldBe = acc ? acc.length + 1 + section.length : section.length;
    if (acc && wouldBe > maxChars) {
      chunks.push(acc);
      acc = section;
    } else {
      acc = acc ? acc + '\n' + section : section;
    }
  }
  if (acc) chunks.push(acc);
  return chunks;
}

function splitByParagraph(content: string, maxChars: number): string[] {
  const chunks: string[] = [];
  let start = 0;

  while (start < content.length) {
    let end = Math.min(start + maxChars, content.length);
    if (end < content.length) {
      const breakAt = content.lastIndexOf('\n\n', end);
      if (breakAt > start) end = breakAt;
    }
    chunks.push(content.slice(start, end));
    start = end;
  }
  return chunks;
}

function mergeTiny(chunks: string[], minChars: number): string[] {
  const result: string[] = [];
  for (const chunk of chunks) {
    if (chunk.length < minChars && result.length > 0) {
      result[result.length - 1] += '\n' + chunk;
    } else {
      result.push(chunk);
    }
  }
  return result;
}
