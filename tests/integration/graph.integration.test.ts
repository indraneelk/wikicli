import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import os from 'os';
import { spawnSync } from 'child_process';

function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(os.tmpdir(), 'wikicli-graph-integration-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true });
  }
}

function createGraphTestProject(dir: string, options?: {
  concepts?: Array<{slug: string; aliases: string[]; sources: string[]; content?: string}>,
  relations?: Array<{source: string; target: string; type: string; evidence?: string}>,
}): void {
  mkdirSync(join(dir, 'sources'), { recursive: true });
  mkdirSync(join(dir, 'wiki', 'concepts'), { recursive: true });

  writeFileSync(join(dir, 'config.yaml'), `version: 1
project: graph-test
sources_dir: sources
output_dir: wiki
llm:
  provider: claude-cli
compiler:
  max_parallel: 1
`);

  const manifest = { version: 1, sources: {}, concepts: {} };
  for (const c of (options?.concepts || [])) {
    manifest.concepts[c.slug] = {
      article_path: `wiki/concepts/${c.slug}.md`,
      sources: c.sources,
      aliases: c.aliases,
      last_compiled: null,
    };
    if (c.content) {
      writeFileSync(join(dir, `wiki/concepts/${c.slug}.md`), c.content);
    }
  }

  mkdirSync(join(dir, '.wikic'), { recursive: true });
  writeFileSync(join(dir, '.wikic', 'manifest.json'), JSON.stringify(manifest, null, 2));

  const relations = (options?.relations || []).map((r, i) => ({
    id: `${i}`,
    source: r.source,
    target: r.target,
    type: r.type as any,
    created_at: '2024-01-01T00:00:00Z',
    evidence: r.evidence,
  }));
  writeFileSync(join(dir, '.wikic', 'graph.json'), JSON.stringify(relations, null, 2));
}

function runWikicGraph(args: string[], cwd: string): { status: number; stdout: string; stderr: string } {
  const result = spawnSync('node', ['/Users/indra/Desktop/indraneelk/Documents/Projects/wikicli/dist/index.js', 'graph', ...args], {
    cwd,
    encoding: 'utf-8',
  });
  return {
    status: result.status ?? 0,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

describe('graph integration', () => {
  it('outputs JSON with nodes and edges', () => {
    withTempDir((dir) => {
      createGraphTestProject(dir, {
        concepts: [
          { slug: 'concept-a', aliases: [], sources: [], content: 'This links to [[concept-b]].' },
          { slug: 'concept-b', aliases: [], sources: [], content: '## Definition\nB' },
        ],
        relations: [],
      });

      const result = runWikicGraph([], dir);
      const output = JSON.parse(result.stdout);

      assert.ok(output.nodes, 'Should have nodes');
      assert.ok(output.edges, 'Should have edges');
      assert.equal(output.nodes.length, 2);
      assert.ok(output.edges.length > 0, 'Should have at least one edge');
    });
  });

  it('--relations filters by type', () => {
    withTempDir((dir) => {
      createGraphTestProject(dir, {
        concepts: [
          { slug: 'concept-a', aliases: [], sources: [], content: '## Definition\nA' },
          { slug: 'concept-b', aliases: [], sources: [], content: '## Definition\nB' },
          { slug: 'concept-c', aliases: [], sources: [], content: '## Definition\nC' },
        ],
        relations: [
          { source: 'concept-a', target: 'concept-b', type: 'contradicts', evidence: 'test' },
          { source: 'concept-a', target: 'concept-c', type: 'extends' },
        ],
      });

      const result = runWikicGraph(['--relations', 'contradicts'], dir);
      const output = JSON.parse(result.stdout);

      assert.equal(output.edges.length, 1);
      assert.equal(output.edges[0].type, 'contradicts');
    });
  });

  it('--relations with non-matching type returns empty edges', () => {
    withTempDir((dir) => {
      createGraphTestProject(dir, {
        concepts: [
          { slug: 'concept-a', aliases: [], sources: [], content: '## Definition\nA' },
          { slug: 'concept-b', aliases: [], sources: [], content: '## Definition\nB' },
        ],
        relations: [
          { source: 'concept-a', target: 'concept-b', type: 'extends' },
        ],
      });

      const result = runWikicGraph(['--relations', 'contradicts'], dir);
      const output = JSON.parse(result.stdout);

      assert.equal(output.edges.length, 0);
    });
  });

  it('--format dot includes edge labels for typed edges', () => {
    withTempDir((dir) => {
      createGraphTestProject(dir, {
        concepts: [
          { slug: 'concept-a', aliases: [], sources: [], content: '## Definition\nA' },
          { slug: 'concept-b', aliases: [], sources: [], content: '## Definition\nB' },
        ],
        relations: [
          { source: 'concept-a', target: 'concept-b', type: 'contradicts' },
        ],
      });

      const result = runWikicGraph(['--format', 'dot'], dir);

      assert.ok(result.stdout.includes('label="contradicts"'), 'Should include edge label');
    });
  });

  it('--format html includes edge colors', () => {
    withTempDir((dir) => {
      createGraphTestProject(dir, {
        concepts: [
          { slug: 'concept-a', aliases: [], sources: [], content: '## Definition\nA' },
          { slug: 'concept-b', aliases: [], sources: [], content: '## Definition\nB' },
        ],
        relations: [
          { source: 'concept-a', target: 'concept-b', type: 'contradicts' },
        ],
      });

      const result = runWikicGraph(['--format', 'html'], dir);

      assert.ok(result.stdout.includes('edgeColors'), 'Should include edgeColors');
      assert.ok(result.stdout.includes('#e74c3c') || result.stdout.includes('e74c3c'), 'Should include contradicts color');
    });
  });

  it('--output writes file and returns ok JSON', () => {
    withTempDir((dir) => {
      createGraphTestProject(dir, {
        concepts: [
          { slug: 'concept-a', aliases: [], sources: [], content: '## Definition\nA' },
        ],
        relations: [],
      });

      const result = runWikicGraph(['--output', 'test-graph.json'], dir);
      const output = JSON.parse(result.stdout);

      assert.equal(output.ok, true);
      assert.equal(output.output, 'test-graph.json');
      assert.ok(existsSync(join(dir, 'test-graph.json')), 'Output file should exist');
    });
  });

  it('dedupes wikilink edges when explicit typed relation exists', () => {
    withTempDir((dir) => {
      createGraphTestProject(dir, {
        concepts: [
          { slug: 'parent-concept', aliases: [], sources: ['src1.md'], content: 'Parent concept links to child concept.' },
          { slug: 'child-concept', aliases: [], sources: ['src2.md'], content: 'Child concept has related content.' },
        ],
        relations: [
          { source: 'parent-concept', target: 'child-concept', type: 'extends', evidence: 'explicit relation' },
        ],
      });

      const result = runWikicGraph([], dir);
      const output = JSON.parse(result.stdout);

      assert.ok(output.nodes.length >= 2, 'Should have nodes');

      const edgesBetween = output.edges.filter((e: any) =>
        (e.from === 'parent-concept' && e.to === 'child-concept') ||
        (e.from === 'child-concept' && e.to === 'parent-concept')
      );

      assert.equal(edgesBetween.length, 1, 'Should have exactly one edge between concepts');
      assert.equal(edgesBetween[0].type, 'extends', 'Typed relation should take precedence');
    });
  });

  it('includes nodes even when no edges', () => {
    withTempDir((dir) => {
      createGraphTestProject(dir, {
        concepts: [
          { slug: 'orphan-concept', aliases: [], sources: ['src1.md'], content: 'This is an orphan concept with no links.' },
        ],
        relations: [],
      });

      const result = runWikicGraph([], dir);
      const output = JSON.parse(result.stdout);

      assert.ok(output.nodes.length > 0, 'Should have nodes');
      assert.equal(output.edges.length, 0, 'Should have no edges');
    });
  });

  it('--relations accepts all RELATION_TYPES values without crash', () => {
    withTempDir((dir) => {
      const relationTypes = ['implements', 'extends', 'optimizes', 'contradicts', 'cites', 'prerequisite_of', 'trades_off', 'derived_from'];

      createGraphTestProject(dir, {
        concepts: [
          { slug: 'concept-a', aliases: [], sources: ['src1.md'], content: 'Content A.' },
          { slug: 'concept-b', aliases: [], sources: ['src2.md'], content: 'Content B.' },
        ],
        relations: [
          { source: 'concept-a', target: 'concept-b', type: 'extends' },
        ],
      });

      for (const type of relationTypes) {
        const result = runWikicGraph(['--relations', type], dir);
        assert.equal(result.status, 0, `Should not crash with --relations ${type}`);
        
        const output = JSON.parse(result.stdout);
        assert.ok(output.nodes, `Should return graph with nodes for type ${type}`);
      }
    });
  });

  it('handles unknown relation type gracefully', () => {
    withTempDir((dir) => {
      createGraphTestProject(dir, {
        concepts: [
          { slug: 'concept-a', aliases: [], sources: ['src1.md'], content: 'Content A.' },
        ],
        relations: [],
      });

      const result = runWikicGraph(['--relations', 'invalid-type'], dir);
      assert.equal(result.status, 0, 'Should not crash with invalid relation type');

      const output = JSON.parse(result.stdout);
      assert.equal(output.edges.length, 0, 'Should return empty edges for unknown type');
    });
  });
});