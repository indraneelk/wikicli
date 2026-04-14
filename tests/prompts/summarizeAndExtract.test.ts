import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseSummarizeAndExtractResponse } from '../../src/prompts/summarizeAndExtract.ts';

describe('parseSummarizeAndExtractResponse', () => {
  it('extracts summary and concepts from well-formed output', () => {
    const text = [
      '---',
      'source: sources/paper.md',
      'source_type: article',
      'compiled_at: 2026-01-01T00:00:00.000Z',
      '---',
      '',
      '# Neural Networks',
      '',
      '## Key claims',
      '- Deep learning outperforms shallow methods',
      '',
      '## Concepts',
      '- Neural Network, Backpropagation',
      '',
      '<!-- CONCEPTS_JSON',
      '[{"name":"Neural Network","aliases":["NN","neural net"],"confidence":"high"},{"name":"Backpropagation","aliases":["backprop"],"confidence":"high"}]',
      '-->',
    ].join('\n');

    const result = parseSummarizeAndExtractResponse(text);
    assert.ok(result.summary.includes('# Neural Networks'));
    assert.ok(!result.summary.includes('CONCEPTS_JSON'));
    assert.equal(result.concepts.length, 2);
    assert.equal(result.concepts[0].name, 'Neural Network');
    assert.deepEqual(result.concepts[0].aliases, ['NN', 'neural net']);
    assert.equal(result.concepts[0].confidence, 'high');
    assert.equal(result.concepts[1].name, 'Backpropagation');
  });

  it('returns empty concepts when sentinel is absent', () => {
    const text = '# Neural Networks\n\nSome summary.';
    const result = parseSummarizeAndExtractResponse(text);
    assert.equal(result.summary, '# Neural Networks\n\nSome summary.');
    assert.deepEqual(result.concepts, []);
  });

  it('returns empty concepts when JSON is malformed', () => {
    const text = '# Neural Networks\n\n<!-- CONCEPTS_JSON\nnot json at all\n-->';
    const result = parseSummarizeAndExtractResponse(text);
    assert.ok(result.summary.includes('# Neural Networks'));
    assert.deepEqual(result.concepts, []);
  });

  it('returns empty concepts when closing --> is missing', () => {
    const text = '# Neural Networks\n\n<!-- CONCEPTS_JSON\n[{"name":"Foo","aliases":[],"confidence":"high"}]';
    const result = parseSummarizeAndExtractResponse(text);
    assert.deepEqual(result.concepts, []);
  });

  it('handles empty concepts array', () => {
    const text = '# Summary\n\n<!-- CONCEPTS_JSON\n[]\n-->';
    const result = parseSummarizeAndExtractResponse(text);
    assert.deepEqual(result.concepts, []);
  });

  it('trims whitespace from summary portion', () => {
    const text = '  # Summary  \n\n<!-- CONCEPTS_JSON\n[]\n-->';
    const result = parseSummarizeAndExtractResponse(text);
    assert.equal(result.summary, '# Summary');
  });
});
