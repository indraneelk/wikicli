import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseWriteAndRelateResponse } from '../../src/prompts/writeAndRelate.ts';

describe('parseWriteAndRelateResponse', () => {
  it('extracts article and relations from well-formed output', () => {
    const text = [
      '---',
      'concept: transformer',
      'aliases: []',
      'sources: ["sources/paper.md"]',
      'confidence: high',
      'tags: ["ml"]',
      'created_at: 2026-01-01T00:00:00.000Z',
      '---',
      '',
      '# Transformer',
      '',
      '## Definition',
      'An attention-based neural network.',
      '',
      '## See Also',
      '[[attention-mechanism]]',
      '',
      '<!-- RELATIONS_JSON',
      '[{"target":"attention-mechanism","type":"implements","evidence":"built on multi-head attention"}]',
      '-->',
    ].join('\n');

    const result = parseWriteAndRelateResponse(text);
    assert.ok(result.article.includes('# Transformer'));
    assert.ok(!result.article.includes('RELATIONS_JSON'));
    assert.equal(result.relations.length, 1);
    assert.equal(result.relations[0].target, 'attention-mechanism');
    assert.equal(result.relations[0].type, 'implements');
    assert.equal(result.relations[0].evidence, 'built on multi-head attention');
  });

  it('returns empty relations when sentinel is absent', () => {
    const text = '---\nconcept: transformer\n---\n\n# Transformer\n\nNo relations block here.';
    const result = parseWriteAndRelateResponse(text);
    assert.ok(result.article.includes('# Transformer'));
    assert.deepEqual(result.relations, []);
  });

  it('returns empty relations when JSON is malformed', () => {
    const text = '# Transformer\n\n<!-- RELATIONS_JSON\nnot valid json\n-->';
    const result = parseWriteAndRelateResponse(text);
    assert.ok(result.article.includes('# Transformer'));
    assert.deepEqual(result.relations, []);
  });

  it('returns empty relations when closing --> is missing', () => {
    const text = '# Transformer\n\n<!-- RELATIONS_JSON\n[{"target":"foo","type":"implements","evidence":"bar"}]';
    const result = parseWriteAndRelateResponse(text);
    assert.deepEqual(result.relations, []);
  });

  it('handles empty relations array', () => {
    const text = '# Transformer\n\n<!-- RELATIONS_JSON\n[]\n-->';
    const result = parseWriteAndRelateResponse(text);
    assert.deepEqual(result.relations, []);
  });

  it('trims whitespace from article portion', () => {
    const text = '  # Transformer  \n\n<!-- RELATIONS_JSON\n[]\n-->';
    const result = parseWriteAndRelateResponse(text);
    assert.equal(result.article, '# Transformer');
  });
});