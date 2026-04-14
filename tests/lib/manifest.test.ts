import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  loadManifest, saveManifest, upsertConcept, removeSource,
  loadRelations, saveRelations, upsertRelation, removeRelation,
  getRelationsByType, getRelationsForConcept, detectCycle,
  RELATION_TYPES, type RelationEntry, type Manifest
} from '../../src/lib/manifest.ts';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import os from 'os';

function withTempDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(os.tmpdir(), 'wikicli-manifest-test-'));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true });
  }
}

describe('loadRelations / saveRelations', () => {
  it('round-trips an empty array', () => {
    withTempDir((dir) => {
      const relations: RelationEntry[] = [];
      saveRelations(dir, relations);
      const loaded = loadRelations(dir);
      assert.deepEqual(loaded, []);
    });
  });

  it('round-trips an array with entries', () => {
    withTempDir((dir) => {
      const relations: RelationEntry[] = [
        { id: '1', source: 'a', target: 'b', type: 'extends', created_at: '2024-01-01T00:00:00Z' },
        { id: '2', source: 'b', target: 'c', type: 'implements', created_at: '2024-01-02T00:00:00Z', evidence: 'see docs' },
      ];
      saveRelations(dir, relations);
      const loaded = loadRelations(dir);
      assert.deepEqual(loaded, relations);
    });
  });

  it('returns empty array when file does not exist', () => {
    withTempDir((dir) => {
      const loaded = loadRelations(dir);
      assert.deepEqual(loaded, []);
    });
  });

  it('throws on invalid JSON', () => {
    withTempDir((dir) => {
      mkdirSync(join(dir, '.wikic'), { recursive: true });
      writeFileSync(join(dir, '.wikic', 'graph.json'), '{ invalid json }');
      assert.throws(() => loadRelations(dir), /JSON|at position/);
    });
  });
});

describe('upsertRelation', () => {
  it('adds a new relation', () => {
    withTempDir((dir) => {
      const manifest = loadManifest(dir);
      const relations: RelationEntry[] = [];
      const result = upsertRelation(manifest, relations, 'concept-a', 'concept-b', 'extends', 'test evidence');
      assert.equal(result.source, 'concept-a');
      assert.equal(result.target, 'concept-b');
      assert.equal(result.type, 'extends');
      assert.equal(result.evidence, 'test evidence');
      assert.equal(relations.length, 1);
    });
  });

  it('deduplicates by (source, target, type)', () => {
    withTempDir((dir) => {
      const manifest = loadManifest(dir);
      const relations: RelationEntry[] = [];
      upsertRelation(manifest, relations, 'a', 'b', 'extends');
      upsertRelation(manifest, relations, 'a', 'b', 'extends');
      assert.equal(relations.length, 1);
    });
  });

  it('updates evidence when same triple exists', () => {
    withTempDir((dir) => {
      const manifest = loadManifest(dir);
      const relations: RelationEntry[] = [];
      upsertRelation(manifest, relations, 'a', 'b', 'extends', 'old evidence');
      upsertRelation(manifest, relations, 'a', 'b', 'extends', 'new evidence');
      assert.equal(relations.length, 1);
      assert.equal(relations[0].evidence, 'new evidence');
    });
  });

  it('accepts valid relation types from RELATION_TYPES', () => {
    withTempDir((dir) => {
      const manifest = loadManifest(dir);
      const relations: RelationEntry[] = [];
      for (const type of RELATION_TYPES) {
        const r = upsertRelation(manifest, relations, `src-${type}`, `tgt-${type}`, type);
        assert.equal(r.type, type);
      }
      assert.equal(relations.length, RELATION_TYPES.length);
    });
  });

  it('generates ids as Date.now() strings', () => {
    withTempDir((dir) => {
      const manifest = loadManifest(dir);
      const relations: RelationEntry[] = [];
      const r1 = upsertRelation(manifest, relations, 'a', 'b', 'extends');
      assert.ok(/^\d+$/.test(r1.id), 'id should be numeric string');
    });
  });
});

describe('removeRelation', () => {
  it('removes by id', () => {
    withTempDir((dir) => {
      const manifest = loadManifest(dir);
      const relations: RelationEntry[] = [
        { id: '1', source: 'a', target: 'b', type: 'extends', created_at: '2024-01-01T00:00:00Z' },
        { id: '2', source: 'c', target: 'd', type: 'implements', created_at: '2024-01-02T00:00:00Z' },
      ];
      removeRelation(manifest, relations, '1');
      assert.equal(relations.length, 1);
      assert.equal(relations[0].id, '2');
    });
  });

  it('no-op if id not found', () => {
    withTempDir((dir) => {
      const manifest = loadManifest(dir);
      const relations: RelationEntry[] = [
        { id: '1', source: 'a', target: 'b', type: 'extends', created_at: '2024-01-01T00:00:00Z' },
      ];
      removeRelation(manifest, relations, 'nonexistent');
      assert.equal(relations.length, 1);
    });
  });
});

describe('getRelationsByType', () => {
  it('filters correctly', () => {
    const relations: RelationEntry[] = [
      { id: '1', source: 'a', target: 'b', type: 'extends', created_at: '2024-01-01T00:00:00Z' },
      { id: '2', source: 'b', target: 'c', type: 'implements', created_at: '2024-01-02T00:00:00Z' },
      { id: '3', source: 'c', target: 'd', type: 'extends', created_at: '2024-01-03T00:00:00Z' },
    ];
    const results = getRelationsByType(relations, 'extends');
    assert.equal(results.length, 2);
    assert.ok(results.every(r => r.type === 'extends'));
  });

  it('returns empty for non-existent type', () => {
    const relations: RelationEntry[] = [
      { id: '1', source: 'a', target: 'b', type: 'extends', created_at: '2024-01-01T00:00:00Z' },
    ];
    const results = getRelationsByType(relations, 'implements');
    assert.deepEqual(results, []);
  });
});

describe('getRelationsForConcept', () => {
  it('returns all relations where concept is source or target', () => {
    const relations: RelationEntry[] = [
      { id: '1', source: 'a', target: 'b', type: 'extends', created_at: '2024-01-01T00:00:00Z' },
      { id: '2', source: 'b', target: 'c', type: 'implements', created_at: '2024-01-02T00:00:00Z' },
      { id: '3', source: 'c', target: 'a', type: 'optimizes', created_at: '2024-01-03T00:00:00Z' },
    ];
    const results = getRelationsForConcept(relations, 'b');
    assert.equal(results.length, 2);
    assert.ok(results.some(r => r.id === '1'));
    assert.ok(results.some(r => r.id === '2'));
  });

  it('returns empty for orphan concept', () => {
    const relations: RelationEntry[] = [
      { id: '1', source: 'a', target: 'b', type: 'extends', created_at: '2024-01-01T00:00:00Z' },
    ];
    const results = getRelationsForConcept(relations, 'orphan');
    assert.deepEqual(results, []);
  });
});

describe('detectCycle', () => {
  it('no cycle on empty array', () => {
    assert.equal(detectCycle([]), false);
  });

  it('no cycle on acyclic graph (A→B, B→C)', () => {
    const relations: RelationEntry[] = [
      { id: '1', source: 'a', target: 'b', type: 'extends', created_at: '2024-01-01T00:00:00Z' },
      { id: '2', source: 'b', target: 'c', type: 'extends', created_at: '2024-01-02T00:00:00Z' },
    ];
    assert.equal(detectCycle(relations), false);
  });

  it('detects cycle (A→B, B→C, C→A)', () => {
    const relations: RelationEntry[] = [
      { id: '1', source: 'a', target: 'b', type: 'extends', created_at: '2024-01-01T00:00:00Z' },
      { id: '2', source: 'b', target: 'c', type: 'extends', created_at: '2024-01-02T00:00:00Z' },
      { id: '3', source: 'c', target: 'a', type: 'extends', created_at: '2024-01-03T00:00:00Z' },
    ];
    assert.equal(detectCycle(relations), true);
  });

  it('detects self-loop (A→A)', () => {
    const relations: RelationEntry[] = [
      { id: '1', source: 'a', target: 'a', type: 'extends', created_at: '2024-01-01T00:00:00Z' },
    ];
    assert.equal(detectCycle(relations), true);
  });

  it('detects cycle in larger graph', () => {
    const relations: RelationEntry[] = [
      { id: '1', source: 'a', target: 'b', type: 'extends', created_at: '2024-01-01T00:00:00Z' },
      { id: '2', source: 'b', target: 'c', type: 'extends', created_at: '2024-01-02T00:00:00Z' },
      { id: '3', source: 'c', target: 'd', type: 'extends', created_at: '2024-01-03T00:00:00Z' },
      { id: '4', source: 'd', target: 'e', type: 'extends', created_at: '2024-01-04T00:00:00Z' },
      { id: '5', source: 'e', target: 'b', type: 'extends', created_at: '2024-01-05T00:00:00Z' },
    ];
    assert.equal(detectCycle(relations), true);
  });
});

describe('saveRelations creates .wikic directory', () => {
  it('creates .wikic directory if missing', () => {
    withTempDir((dir) => {
      saveRelations(dir, []);
      const loaded = loadRelations(dir);
      assert.deepEqual(loaded, []);
    });
  });
});

describe('loadManifest + saveManifest round-trip', () => {
  it('preserves all manifest fields', () => {
    withTempDir((dir) => {
      const manifest = loadManifest(dir);
      manifest.sources['test.md'] = { hash: 'abc', size_bytes: 100, added_at: '2024-01-01', compiled_at: '2024-01-02', summary_path: 'wiki/summaries/test.md', status: 'compiled' };
      manifest.concepts['test-concept'] = { article_path: 'wiki/concepts/test.md', sources: ['test.md'], aliases: ['test'], last_compiled: '2024-01-02' };
      saveManifest(dir, manifest);
      const loaded = loadManifest(dir);
      assert.equal(loaded.sources['test.md'].hash, 'abc');
      assert.equal(loaded.concepts['test-concept'].aliases[0], 'test');
    });
  });
});
