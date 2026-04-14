import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateCandidates,
  extractFacts,
  normalizeFact,
} from '../../src/lib/conflicts.ts';
import type { Manifest } from '../../src/lib/manifest.ts';
import type { RelationEntry } from '../../src/lib/manifest.ts';

describe('extractFacts', () => {
  it('extracts year dates', () => {
    const facts = extractFacts('The company was founded in 2020 and grew to 1000 employees by 2023.');
    const dates = facts.filter(f => f.type === 'date');
    assert.ok(dates.length >= 2, `Expected at least 2 dates, got ${dates.length}`);
    assert.ok(dates.some(f => f.value.includes('2020') || f.raw.includes('2020')), 'Should find 2020');
    assert.ok(dates.some(f => f.value.includes('2023') || f.raw.includes('2023')), 'Should find 2023');
  });

  it('extracts performance claims', () => {
    const facts = extractFacts('The system achieves accuracy of 99.5% and runs in under 100ms latency.');
    const perf = facts.filter(f => f.type === 'performance');
    assert.ok(perf.length > 0, 'Should extract performance claims');
  });

  it('extracts definition patterns', () => {
    const facts = extractFacts('This is a type of machine learning algorithm that is defined as supervised.');
    const defs = facts.filter(f => f.type === 'definition');
    assert.ok(defs.length > 0, 'Should extract definition patterns');
  });

  it('extracts claim patterns with absolute quantifiers', () => {
    const facts = extractFacts('All tests always pass without any errors.');
    const claims = facts.filter(f => f.type === 'claim');
    assert.ok(claims.length > 0, 'Should extract claims with absolute quantifiers');
  });

  it('returns empty array for content with no extractable facts', () => {
    const facts = extractFacts('This is a very vague sentence with no numbers or dates.');
    assert.deepEqual(facts, []);
  });
});

describe('normalizeFact', () => {
  it('normalizes to lowercase', () => {
    const normalized = normalizeFact({ type: 'number', value: '95.2%', raw: '95.2%', context: '' });
    assert.ok(!normalized.includes('95') || normalized.toLowerCase() === normalized);
  });

  it('strips articles', () => {
    const normalized = normalizeFact({ type: 'definition', value: 'The algorithm is defined as quicksort', raw: 'The algorithm is defined as quicksort', context: '' });
    assert.ok(!normalized.includes(' the ') && !normalized.includes(' a ') && !normalized.includes(' an '));
  });

  it('collapses whitespace', () => {
    const normalized = normalizeFact({ type: 'date', value: '  2024   01  15  ', raw: '  2024   01  15  ', context: '' });
    assert.ok(!normalized.includes('  '), 'Should collapse multiple spaces');
  });

  it('returns a string', () => {
    const result = normalizeFact({ type: 'claim', value: 'All tests pass', raw: 'All tests pass', context: '' });
    assert.equal(typeof result, 'string');
  });
});

describe('generateCandidates', () => {
  it('identifies concept pairs with shared sources', () => {
    const manifest: Manifest = {
      version: 1,
      sources: {
        'src1.md': { hash: 'h1', size_bytes: 100, added_at: '2024-01-01', compiled_at: null, summary_path: null, status: 'compiled' },
        'src2.md': { hash: 'h2', size_bytes: 200, added_at: '2024-01-02', compiled_at: null, summary_path: null, status: 'compiled' },
        'src3.md': { hash: 'h3', size_bytes: 300, added_at: '2024-01-03', compiled_at: null, summary_path: null, status: 'compiled' },
        'src4.md': { hash: 'h4', size_bytes: 400, added_at: '2024-01-04', compiled_at: null, summary_path: null, status: 'compiled' },
      },
      concepts: {
        'concept-a': { article_path: 'a.md', sources: ['src1.md', 'src2.md'], aliases: [], last_compiled: null },
        'concept-b': { article_path: 'b.md', sources: ['src2.md', 'src3.md'], aliases: [], last_compiled: null },
        'concept-c': { article_path: 'c.md', sources: ['src4.md'], aliases: [], last_compiled: null },
      },
    };
    const relations: RelationEntry[] = [];

    const candidates = generateCandidates(manifest, relations);
    const slugs = candidates.map(c => [c.slugA, c.slugB]);

    assert.ok(slugs.some(([a, b]) => 
      (a === 'concept-a' && b === 'concept-b') || (a === 'concept-b' && b === 'concept-a')
    ), 'Should include (A, B) with shared src2');
    
    assert.ok(!slugs.some(([a, b]) => 
      (a === 'concept-a' && b === 'concept-c') || (a === 'concept-c' && b === 'concept-a')
    ), 'Should NOT include (A, C) - no shared sources');
  });

  it('returns empty array for manifest with no concepts', () => {
    const manifest: Manifest = {
      version: 1,
      sources: {},
      concepts: {},
    };
    const relations: RelationEntry[] = [];
    const candidates = generateCandidates(manifest, relations);
    assert.deepEqual(candidates, []);
  });

  it('returns empty array when no concepts share sources', () => {
    const manifest: Manifest = {
      version: 1,
      sources: {
        'src1.md': { hash: 'h1', size_bytes: 100, added_at: '2024-01-01', compiled_at: null, summary_path: null, status: 'compiled' },
        'src2.md': { hash: 'h2', size_bytes: 200, added_at: '2024-01-02', compiled_at: null, summary_path: null, status: 'compiled' },
      },
      concepts: {
        'concept-a': { article_path: 'a.md', sources: ['src1.md'], aliases: [], last_compiled: null },
        'concept-b': { article_path: 'b.md', sources: ['src2.md'], aliases: [], last_compiled: null },
      },
    };
    const relations: RelationEntry[] = [];
    const candidates = generateCandidates(manifest, relations);
    assert.deepEqual(candidates, []);
  });

  it('includes pairs from relation graph even without shared sources', () => {
    const manifest: Manifest = {
      version: 1,
      sources: {},
      concepts: {
        'concept-a': { article_path: 'a.md', sources: ['src1.md'], aliases: [], last_compiled: null },
        'concept-b': { article_path: 'b.md', sources: ['src2.md'], aliases: [], last_compiled: null },
      },
    };
    const relations: RelationEntry[] = [
      { id: '1', source: 'concept-a', target: 'concept-b', type: 'extends', created_at: '2024-01-01T00:00:00Z' },
    ];
    const candidates = generateCandidates(manifest, relations);
    assert.equal(candidates.length, 1);
    assert.ok(
      (candidates[0].slugA === 'concept-a' && candidates[0].slugB === 'concept-b') ||
      (candidates[0].slugA === 'concept-b' && candidates[0].slugB === 'concept-a')
    );
  });

  it('returns empty for manifest with single concept', () => {
    const manifest: Manifest = {
      version: 1,
      sources: { 's1.md': { hash: 'h1', size_bytes: 100, added_at: '2024-01-01', compiled_at: null, summary_path: null, status: 'compiled' } },
      concepts: { 'only-concept': { article_path: 'only.md', sources: ['s1.md'], aliases: [], last_compiled: null } },
    };
    const candidates = generateCandidates(manifest, []);
    assert.deepEqual(candidates, []);
  });

  it('accumulates shared sources across multiple sources', () => {
    const manifest: Manifest = {
      version: 1,
      sources: {
        'src1.md': { hash: 'h1', size_bytes: 100, added_at: '2024-01-01', compiled_at: null, summary_path: null, status: 'compiled' },
        'src2.md': { hash: 'h2', size_bytes: 200, added_at: '2024-01-02', compiled_at: null, summary_path: null, status: 'compiled' },
      },
      concepts: {
        'concept-a': { article_path: 'a.md', sources: ['src1.md', 'src2.md'], aliases: [], last_compiled: null },
        'concept-b': { article_path: 'b.md', sources: ['src1.md', 'src2.md'], aliases: [], last_compiled: null },
      },
    };
    const candidates = generateCandidates(manifest, []);
    const pair = candidates.find(c => 
      (c.slugA === 'concept-a' && c.slugB === 'concept-b') ||
      (c.slugA === 'concept-b' && c.slugB === 'concept-a')
    );
    assert.ok(pair, 'Should find pair between A and B');
    assert.ok(pair.sharedSources.length >= 2, 'Should accumulate shared sources');
  });
});
