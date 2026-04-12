import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chunkContent } from '../../src/lib/chunker.ts';

describe('chunkContent', () => {
  it('returns single-element array when content is at or below maxChars', () => {
    const content = 'Short content under limit.';
    const result = chunkContent(content, 8000, 1500);
    assert.deepEqual(result, ['Short content under limit.']);
  });

  it('returns single-element array when content equals maxChars exactly', () => {
    const content = 'x'.repeat(8000);
    const result = chunkContent(content, 8000, 1500);
    assert.equal(result.length, 1);
  });

  it('splits on markdown headers and keeps each section together', () => {
    const section1 = '# Section One\n\n' + 'word '.repeat(1200); // ~6000 chars
    const section2 = '# Section Two\n\n' + 'word '.repeat(1200);
    const content = section1 + '\n' + section2;
    const result = chunkContent(content, 8000, 1500);
    assert.equal(result.length, 2);
    assert.ok(result[0].includes('# Section One'));
    assert.ok(result[1].includes('# Section Two'));
    assert.ok(!result[0].includes('# Section Two'));
  });

  it('splits on 10-K Item N. patterns', () => {
    const item1 = 'Item 1. Business\n\n' + 'text '.repeat(1200); // ~6000 chars
    const item2 = 'Item 2. Risk Factors\n\n' + 'text '.repeat(1200);
    const content = item1 + '\n' + item2;
    const result = chunkContent(content, 8000, 1500);
    assert.equal(result.length, 2);
    assert.ok(result[0].startsWith('Item 1.'));
    assert.ok(result[1].startsWith('Item 2.'));
  });

  it('splits on PART markers', () => {
    const part1 = 'PART I\n\nSome intro content.\n\n' + 'text '.repeat(1200);
    const part2 = 'PART II\n\nMore content.\n\n' + 'text '.repeat(1200);
    const content = part1 + '\n' + part2;
    const result = chunkContent(content, 8000, 1500);
    assert.equal(result.length, 2);
    assert.ok(result[0].startsWith('PART I'));
    assert.ok(result[1].startsWith('PART II'));
  });

  it('merges accumulated sections when they fit within maxChars', () => {
    const s1 = '# A\n\n' + 'x '.repeat(500); // ~1000 chars
    const s2 = '# B\n\n' + 'x '.repeat(500);
    const s3 = '# C\n\n' + 'x '.repeat(500);
    const content = s1 + '\n' + s2 + '\n' + s3;
    const result = chunkContent(content, 8000, 1500);
    assert.equal(result.length, 1);
  });

  it('merges tiny chunks below minChars into predecessor', () => {
    const toc = 'Item 1. Business 1\nItem 2. Risk 5\n\n'; // ~40 chars
    const section1 = 'Item 1. Business\n\n' + 'content '.repeat(900); // ~7200 chars
    const section2 = 'Item 2. Risk\n\n' + 'content '.repeat(900);
    const content = toc + section1 + '\n' + section2;
    const result = chunkContent(content, 8000, 1500);
    result.forEach(chunk => {
      assert.ok(chunk.length >= 1500, `chunk too small (${chunk.length} chars): ${chunk.slice(0, 80)}`);
    });
  });

  it('falls back to paragraph splitting when no headers present', () => {
    const para = 'This is a paragraph of content that fills space. '.repeat(20) + '\n\n';
    const content = para.repeat(30); // ~30k chars, no headers
    const result = chunkContent(content, 8000, 1500);
    assert.ok(result.length > 1, 'should have split into multiple chunks');
    result.forEach(chunk => {
      assert.ok(chunk.length <= 8000, `chunk too large: ${chunk.length}`);
    });
  });

  it('never produces oversized chunks even with no paragraph breaks', () => {
    const content = 'x'.repeat(50000);
    const result = chunkContent(content, 8000, 1500);
    assert.ok(result.length > 1);
    result.forEach(chunk => {
      assert.ok(chunk.length <= 8000, `chunk too large: ${chunk.length}`);
    });
  });

  it('handles empty string', () => {
    const result = chunkContent('', 8000, 1500);
    assert.deepEqual(result, ['']);
  });
});
