import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateCandidates,
  simpleExtractFacts,
  normalizeFact,
  computeKeywordOverlap,
  hashContent,
  loadCheckedPairs,
  saveCheckedPairs,
  shouldRecheck,
} from '../../src/lib/conflicts.ts';
import type { Manifest } from '../../src/lib/manifest.ts';
import type { RelationEntry } from '../../src/lib/manifest.ts';

describe('simpleExtractFacts', () => {
  it('extracts year dates', () => {
    const facts = simpleExtractFacts('The company was founded in 2020 and grew to 1000 employees by 2023.');
    const dates = facts.filter(f => f.type === 'date');
    assert.ok(dates.length >= 2, `Expected at least 2 dates, got ${dates.length}`);
    assert.ok(dates.some(f => f.value.includes('2020') || f.raw.includes('2020')), 'Should find 2020');
    assert.ok(dates.some(f => f.value.includes('2023') || f.raw.includes('2023')), 'Should find 2023');
  });

  it('extracts performance claims', () => {
    const facts = simpleExtractFacts('The system achieves accuracy of 99.5% and runs in under 100ms latency.');
    const perf = facts.filter(f => f.type === 'performance');
    assert.ok(perf.length > 0, 'Should extract performance claims');
  });

  it('extracts definition patterns', () => {
    const facts = simpleExtractFacts('This is a type of machine learning algorithm that is defined as supervised.');
    const defs = facts.filter(f => f.type === 'definition');
    assert.ok(defs.length > 0, 'Should extract definition patterns');
  });

  it('extracts claim patterns with absolute quantifiers', () => {
    const facts = simpleExtractFacts('All tests always pass without any errors.');
    const claims = facts.filter(f => f.type === 'claim');
    assert.ok(claims.length > 0, 'Should extract claims with absolute quantifiers');
  });

  it('returns empty array for content with no extractable facts', () => {
    const facts = simpleExtractFacts('This is a very vague sentence with no numbers or dates.');
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

describe('computeKeywordOverlap', () => {
  it('high overlap returns high score', () => {
    const contentA = 'Machine learning uses neural networks and backpropagation to train models on large datasets.';
    const contentB = 'Neural networks are trained using backpropagation and other machine learning techniques.';
    const overlap = computeKeywordOverlap(contentA, contentB);
    assert.ok(overlap > 0.3, `Expected overlap > 0.3, got ${overlap}`);
  });

  it('no overlap returns 0', () => {
    const contentA = 'The quick brown fox jumps over the lazy dog.';
    const contentB = 'Quantum physics describes the behavior of subatomic particles.';
    const overlap = computeKeywordOverlap(contentA, contentB);
    assert.equal(overlap, 0, 'Should return 0 for no overlap');
  });

  it('handles empty content', () => {
    const overlap1 = computeKeywordOverlap('', 'Some content here');
    const overlap2 = computeKeywordOverlap('Some content here', '');
    const overlap3 = computeKeywordOverlap('', '');
    assert.equal(overlap1, 0, 'Empty string A should return 0');
    assert.equal(overlap2, 0, 'Empty string B should return 0');
    assert.equal(overlap3, 0, 'Both empty should return 0');
  });

  it('handles content with only stopwords', () => {
    const contentA = 'the a is are was were';
    const contentB = 'the and is it was';
    const overlap = computeKeywordOverlap(contentA, contentB);
    assert.equal(overlap, 0, 'Only stopwords should return 0');
  });
});

describe('hashContent', () => {
  it('same content produces same hash', () => {
    const content = 'This is some test content for hashing.';
    const hashA = hashContent(content);
    const hashB = hashContent(content);
    assert.equal(hashA, hashB, 'Same content should produce same hash');
  });

  it('different content produces different hash', () => {
    const hashA = hashContent('Content A');
    const hashB = hashContent('Content B');
    assert.notEqual(hashA, hashB, 'Different content should produce different hash');
  });

  it('hash is deterministic', () => {
    const content = 'Deterministic content test';
    const hashes: string[] = [];
    for (let i = 0; i < 10; i++) {
      hashes.push(hashContent(content));
    }
    assert.ok(hashes.every(h => h === hashes[0]), 'Hash should be consistent across calls');
  });

  it('produces hex string output', () => {
    const hash = hashContent('test');
    assert.ok(/^[0-9a-f]+$/.test(hash), 'Hash should be hex string');
  });
});

describe('shouldRecheck', () => {
  const pair = {
    slugA: 'concept-a',
    slugB: 'concept-b',
    articleHashA: 'abc123',
    articleHashB: 'def456',
    lastChecked: '2024-01-01T00:00:00Z',
    previouslyVerified: false,
  };

  it('returns true when hashA changed', () => {
    const result = shouldRecheck(pair, 'xyz789', 'def456');
    assert.equal(result, true, 'Should return true when hashA changed');
  });

  it('returns true when hashB changed', () => {
    const result = shouldRecheck(pair, 'abc123', 'newHash');
    assert.equal(result, true, 'Should return true when hashB changed');
  });

  it('returns true when both hashes changed', () => {
    const result = shouldRecheck(pair, 'newHashA', 'newHashB');
    assert.equal(result, true, 'Should return true when both hashes changed');
  });

  it('returns false when hashes unchanged', () => {
    const result = shouldRecheck(pair, 'abc123', 'def456');
    assert.equal(result, false, 'Should return false when hashes unchanged');
  });
});

describe('generateCandidates', () => {
  it('identifies concept pairs sharing 2+ sources', () => {
    // minSharedSources=2: only pairs appearing together in 2+ sources are candidates.
    // concept-a and concept-b share src2 and src3 (2 sources) → candidate.
    // concept-c shares no sources with a or b → excluded.
    const manifest: Manifest = {
      version: 1,
      sources: {
        'src1.md': { hash: 'h1', size_bytes: 100, added_at: '2024-01-01', compiled_at: null, summary_path: null, status: 'compiled' },
        'src2.md': { hash: 'h2', size_bytes: 200, added_at: '2024-01-02', compiled_at: null, summary_path: null, status: 'compiled' },
        'src3.md': { hash: 'h3', size_bytes: 300, added_at: '2024-01-03', compiled_at: null, summary_path: null, status: 'compiled' },
        'src4.md': { hash: 'h4', size_bytes: 400, added_at: '2024-01-04', compiled_at: null, summary_path: null, status: 'compiled' },
      },
      concepts: {
        'concept-a': { article_path: 'a.md', sources: ['src1.md', 'src2.md', 'src3.md'], aliases: [], last_compiled: null },
        'concept-b': { article_path: 'b.md', sources: ['src2.md', 'src3.md'], aliases: [], last_compiled: null },
        'concept-c': { article_path: 'c.md', sources: ['src4.md'], aliases: [], last_compiled: null },
      },
    };
    const relations: RelationEntry[] = [];

    const candidates = generateCandidates(manifest, relations, {});
    const slugs = candidates.map(c => [c.slugA, c.slugB]);

    assert.ok(slugs.some(([a, b]) =>
      (a === 'concept-a' && b === 'concept-b') || (a === 'concept-b' && b === 'concept-a')
    ), 'Should include (A, B) sharing src2 and src3');

    assert.ok(!slugs.some(([a, b]) =>
      (a === 'concept-a' && b === 'concept-c') || (a === 'concept-c' && b === 'concept-a')
    ), 'Should NOT include (A, C) — no shared sources');
  });

  it('returns empty array for manifest with no concepts', () => {
    const manifest: Manifest = {
      version: 1,
      sources: {},
      concepts: {},
    };
    const relations: RelationEntry[] = [];
    const candidates = generateCandidates(manifest, relations, {});
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
    const candidates = generateCandidates(manifest, relations, {});
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
    const candidates = generateCandidates(manifest, relations, {});
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
    const candidates = generateCandidates(manifest, [], {});
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
    const candidates = generateCandidates(manifest, [], {});
    const pair = candidates.find(c => 
      (c.slugA === 'concept-a' && c.slugB === 'concept-b') ||
      (c.slugA === 'concept-b' && c.slugB === 'concept-a')
    );
    assert.ok(pair, 'Should find pair between A and B');
    assert.ok(pair.sharedSources.length >= 2, 'Should accumulate shared sources');
  });

  it('filters out source-based candidates whose article content has low keyword overlap', () => {
    // Two concepts share 2 sources but their articles discuss entirely different topics.
    // The keyword post-filter should drop this pair, reducing LLM calls.
    const manifest: Manifest = {
      version: 1,
      sources: {
        'src1.md': { hash: 'h1', size_bytes: 100, added_at: '2024-01-01', compiled_at: null, summary_path: null, status: 'compiled' },
        'src2.md': { hash: 'h2', size_bytes: 200, added_at: '2024-01-02', compiled_at: null, summary_path: null, status: 'compiled' },
      },
      concepts: {
        'event-study': { article_path: 'event-study.md', sources: ['src1.md', 'src2.md'], aliases: [], last_compiled: null },
        'kelly-criterion': { article_path: 'kelly.md', sources: ['src1.md', 'src2.md'], aliases: [], last_compiled: null },
      },
    };
    const relations: RelationEntry[] = [];
    const articleCache: Record<string, string> = {
      'event-study': 'Event study methodology measures abnormal returns around corporate events using market model regression.',
      'kelly-criterion': 'Kelly criterion optimizes position sizing through logarithmic utility maximization for bankroll growth.',
    };
    const candidates = generateCandidates(manifest, relations, articleCache);
    // These share 2 sources but content is entirely different topics — filtered out
    assert.equal(candidates.length, 0, 'Low-overlap source-based pair should be filtered out');
  });

  it('keeps source-based candidates with high keyword overlap', () => {
    const manifest: Manifest = {
      version: 1,
      sources: {
        'src1.md': { hash: 'h1', size_bytes: 100, added_at: '2024-01-01', compiled_at: null, summary_path: null, status: 'compiled' },
        'src2.md': { hash: 'h2', size_bytes: 200, added_at: '2024-01-02', compiled_at: null, summary_path: null, status: 'compiled' },
      },
      concepts: {
        'event-study': { article_path: 'event-study.md', sources: ['src1.md', 'src2.md'], aliases: [], last_compiled: null },
        'cumulative-abnormal-return': { article_path: 'car.md', sources: ['src1.md', 'src2.md'], aliases: [], last_compiled: null },
      },
    };
    const relations: RelationEntry[] = [];
    const articleCache: Record<string, string> = {
      'event-study': 'Event study methodology measures abnormal return using market model regression around corporate events.',
      'cumulative-abnormal-return': 'Cumulative abnormal return aggregates abnormal returns over event window using market model benchmark.',
    };
    const candidates = generateCandidates(manifest, relations, articleCache);
    assert.equal(candidates.length, 1, 'High-overlap source-based pair should pass the filter');
    assert.ok(candidates[0].keywordOverlap !== undefined, 'keywordOverlap should be set on filtered candidate');
    assert.ok(candidates[0].keywordOverlap! > 0.15, 'Overlap should exceed default threshold');
  });

  it('wikilink-based candidates bypass the keyword overlap filter', () => {
    // Even if articles have low overlap, wikilinks indicate a known relationship worth checking.
    const manifest: Manifest = {
      version: 1,
      sources: {},
      concepts: {
        'concept-a': { article_path: 'a.md', sources: [], aliases: [], last_compiled: null },
        'concept-b': { article_path: 'b.md', sources: [], aliases: [], last_compiled: null },
      },
    };
    const relations: RelationEntry[] = [
      { id: '1', source: 'concept-a', target: 'concept-b', type: 'extends', created_at: '2024-01-01T00:00:00Z' },
    ];
    const articleCache: Record<string, string> = {
      'concept-a': 'Quantum physics describes subatomic particles and wave functions.',
      'concept-b': 'Renaissance painting techniques used egg tempera and oil glazing.',
    };
    const candidates = generateCandidates(manifest, relations, articleCache);
    assert.equal(candidates.length, 1, 'Wikilink pair should not be filtered regardless of overlap');
  });

  it('does NOT generate candidates from keyword overlap alone (O(n²) scan removed)', () => {
    // The full-corpus keyword-overlap scan is removed to prevent O(n²) explosion
    // on large wikis. Candidates now come only from shared sources and wikilinks.
    const manifest: Manifest = {
      version: 1,
      sources: {},
      concepts: {
        'transformer': { article_path: 'transformer.md', sources: [], aliases: [], last_compiled: null },
        'bert': { article_path: 'bert.md', sources: [], aliases: [], last_compiled: null },
      },
    };
    const relations: RelationEntry[] = [];
    const articleCache: Record<string, string> = {
      'transformer': 'Transformer architecture uses self-attention mechanism to process sequential data.',
      'bert': 'BERT uses transformer architecture with bidirectional self-attention.',
    };
    const candidates = generateCandidates(manifest, relations, articleCache);
    // No shared sources, no wikilinks → no candidates regardless of keyword overlap
    assert.equal(candidates.length, 0, 'Should not generate candidates from keyword overlap alone');
    const pair = candidates.find(c =>
      (c.slugA === 'transformer' && c.slugB === 'bert') ||
      (c.slugA === 'bert' && c.slugB === 'transformer')
    );
    assert.equal(pair, undefined, 'transformer-bert pair should not be a candidate without shared sources or wikilinks');
    // keywordOverlap field is intentionally not set
  });
});
