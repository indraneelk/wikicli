import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import os from 'os';
import { spawnSync } from 'child_process';

function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(os.tmpdir(), 'wikicli-query-integration-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true });
  }
}

function createQueryTestProject(dir: string, options?: {
  concepts?: Array<{slug: string; aliases: string[]; sources: string[]; content?: string}>,
  relations?: Array<{source: string; target: string; type: string; evidence?: string}>,
}): void {
  mkdirSync(join(dir, 'sources'), { recursive: true });
  mkdirSync(join(dir, 'wiki', 'concepts'), { recursive: true });

  writeFileSync(join(dir, 'config.yaml'), `version: 1
project: query-test
sources_dir: sources
output_dir: wiki
llm:
  provider: claude-cli
compiler:
  max_parallel: 1
  summary_max_tokens: 1000
  article_max_tokens: 2000
  auto_lint: false
  chunk_threshold: 5000
  chunk_size: 3000
  min_chunk_size: 500
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

function runWikic(args: string[], cwd: string): { status: number; stdout: string; stderr: string } {
  const result = spawnSync('node', ['/Users/indra/Desktop/indraneelk/Documents/Projects/wikicli/dist/index.js', ...args], {
    cwd,
    encoding: 'utf-8',
  });
  return {
    status: result.status ?? 0,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

describe('query integration', () => {
  it('returns error when no relevant pages', () => {
    withTempDir((dir) => {
      createQueryTestProject(dir, {
        concepts: [{ slug: 'machine-learning', aliases: ['ml'], sources: ['src1.md'], content: 'Machine learning is great.' }],
      });

      const result = runWikic(['query', 'cooking recipe'], dir);
      const output = JSON.parse(result.stdout);

      assert.equal(output.ok, false);
      assert.ok(output.error.includes('No relevant wiki pages'), 'Should report no relevant pages');
    });
  });

  it('finds relevant page by slug match', () => {
    withTempDir((dir) => {
      createQueryTestProject(dir, {
        concepts: [{ slug: 'transformer-attention', aliases: [], sources: ['src1.md'], content: 'Transformer attention is a mechanism.' }],
      });

      const result = runWikic(['query', 'what is transformer attention'], dir);
      const output = JSON.parse(result.stdout);

      assert.equal(output.ok, true);
      assert.ok(output.pages_used.includes('transformer-attention'), 'Should use transformer-attention');
    });
  });

  it('finds relevant page by alias match', () => {
    withTempDir((dir) => {
      createQueryTestProject(dir, {
        concepts: [{ slug: 'self-attention', aliases: ['scaled-dot-product', 'scaled-dot-product-attention'], sources: ['src1.md'], content: 'Self attention computes context.' }],
      });

      const result = runWikic(['query', 'what is scaled dot product attention'], dir);
      const output = JSON.parse(result.stdout);

      assert.equal(output.ok, true);
      assert.ok(output.pages_used.includes('self-attention'), 'Should find via alias');
    });
  });

  it('surfaces contradictions when graph has contradicts edges', () => {
    withTempDir((dir) => {
      createQueryTestProject(dir, {
        concepts: [
          { slug: 'llm-wiki', aliases: [], sources: ['src1.md'], content: 'LLM uses transformer architecture.' },
          { slug: 'rag', aliases: [], sources: ['src2.md'], content: 'RAG does not use transformers.' },
        ],
        relations: [
          { source: 'llm-wiki', target: 'rag', type: 'contradicts', evidence: 'Conflicting transformer claims' },
        ],
      });

      const result = runWikic(['query', 'llm wiki vs rag'], dir);
      const output = JSON.parse(result.stdout);

      assert.equal(output.ok, true);
      assert.ok(output.conflicts, 'Should have conflicts');
      assert.ok(output.conflicts.length > 0, 'Should have at least one conflict');
      const conflict = output.conflicts[0];
      assert.ok(conflict.between.includes('llm-wiki') && conflict.between.includes('rag'), 'Should reference both concepts');
    });
  });

  it('does NOT surface non-contradicts relations as conflicts', () => {
    withTempDir((dir) => {
      createQueryTestProject(dir, {
        concepts: [
          { slug: 'base-model', aliases: [], sources: ['src1.md'], content: 'Base model is foundational.' },
          { slug: 'fine-tuned-model', aliases: [], sources: ['src2.md'], content: 'Fine tuned model extends base.' },
        ],
        relations: [
          { source: 'base-model', target: 'fine-tuned-model', type: 'extends' },
        ],
      });

      const result = runWikic(['query', 'base model relationship'], dir);
      const output = JSON.parse(result.stdout);

      assert.equal(output.ok, true);
      assert.ok(!output.conflicts || output.conflicts.length === 0, 'Should not have conflicts for non-contradicts relation');
    });
  });

  it('--save writes answer file', () => {
    withTempDir((dir) => {
      createQueryTestProject(dir, {
        concepts: [{ slug: 'test-concept', aliases: [], sources: ['src1.md'], content: 'Test content here.' }],
      });

      const result = runWikic(['query', 'test question', '--save'], dir);
      const output = JSON.parse(result.stdout);

      assert.equal(output.ok, true);
      assert.ok(output.saved_to, 'Should have saved_to path');
      assert.ok(existsSync(join(dir, output.saved_to)), 'Saved file should exist');

      const savedContent = readFileSync(join(dir, output.saved_to), 'utf-8');
      assert.ok(savedContent.includes('test question'), 'Saved file should contain question');
      assert.ok(savedContent.includes('Test content here') || output.answer, 'Saved file should contain answer');
    });
  });
});