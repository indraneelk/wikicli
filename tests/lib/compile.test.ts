import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mergeExtractedConcepts } from '../../src/commands/compile.ts';

describe('mergeExtractedConcepts', () => {
  it('deduplicates by normalised name and merges aliases', () => {
    const input = [
      { name: 'Neural Network', aliases: ['NN'], confidence: 'medium' },
      { name: 'Neural Network', aliases: ['neural net'], confidence: 'high' },
    ];
    const result = mergeExtractedConcepts(input);
    assert.equal(result.length, 1);
    assert.deepEqual(result[0].aliases.sort(), ['NN', 'neural net'].sort());
    assert.equal(result[0].confidence, 'high');
  });

  it('keeps distinct concepts separate', () => {
    const input = [
      { name: 'Backpropagation', aliases: [], confidence: 'high' },
      { name: 'Gradient Descent', aliases: ['SGD'], confidence: 'medium' },
    ];
    const result = mergeExtractedConcepts(input);
    assert.equal(result.length, 2);
  });

  it('returns empty array for empty input', () => {
    assert.deepEqual(mergeExtractedConcepts([]), []);
  });

  it('promotes confidence from medium to high when duplicate appears', () => {
    const input = [
      { name: 'Bitcoin', aliases: [], confidence: 'medium' },
      { name: 'Bitcoin', aliases: [], confidence: 'high' },
    ];
    const result = mergeExtractedConcepts(input);
    assert.equal(result[0].confidence, 'high');
  });

  it('normalises names with punctuation to the same key', () => {
    const input = [
      { name: 'U.S. Dollar', aliases: [], confidence: 'high' },
      { name: 'U.S. Dollar', aliases: ['USD'], confidence: 'medium' },
    ];
    const result = mergeExtractedConcepts(input);
    assert.equal(result.length, 1);
    assert.deepEqual(result[0].aliases, ['USD']);
  });
});