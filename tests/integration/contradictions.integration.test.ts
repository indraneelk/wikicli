import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

interface TestProject {
  dir: string;
}

function createConfigYaml(dir: string): void {
  const config = `version: 1
project: test-project
description: Test wiki project
sources_dir: sources
output_dir: wiki

llm:
  provider: opencode-cli
  model: opencode/big-pickle

compiler:
  max_parallel: 3
  summary_max_tokens: 2000
  article_max_tokens: 4000
`;
  writeFileSync(join(dir, 'config.yaml'), config);
}

function createManifest(dir: string, manifest: object): void {
  mkdirSync(join(dir, '.wikic'), { recursive: true });
  writeFileSync(join(dir, '.wikic', 'manifest.json'), JSON.stringify(manifest, null, 2));
}

function createGraphJson(dir: string, relations: object[]): void {
  mkdirSync(join(dir, '.wikic'), { recursive: true });
  writeFileSync(join(dir, '.wikic', 'graph.json'), JSON.stringify(relations, null, 2));
}

function createReviewQueue(dir: string, queue: object): void {
  mkdirSync(join(dir, '.wikic'), { recursive: true });
  writeFileSync(join(dir, '.wikic', 'review_queue.json'), JSON.stringify(queue, null, 2));
}

function createConcept(dir: string, slug: string, content: string, frontmatter?: Record<string, unknown>): void {
  const conceptDir = join(dir, 'wiki', 'concepts');
  mkdirSync(conceptDir, { recursive: true });
  let fm = '';
  if (frontmatter) {
    const lines: string[] = [];
    for (const [key, value] of Object.entries(frontmatter)) {
      if (Array.isArray(value)) {
        lines.push(`${key}: [${value.map((v) => `"${v}"`).join(", ")}]`);
      } else if (typeof value === 'string') {
        lines.push(`${key}: "${value}"`);
      } else {
        lines.push(`${key}: ${value}`);
      }
    }
    fm = lines.join('\n');
  }
  writeFileSync(join(conceptDir, `${slug}.md`), fm ? `---\n${fm}\n---\n\n${content}` : content);
}

async function runContradictions(dir: string, args: string[] = []): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    execFile(
      'node',
      [join(process.cwd(), 'dist/index.js'), 'contradictions', ...args],
      { cwd: dir },
      (err, stdout, stderr) => {
        resolve({
          stdout: stdout || '',
          stderr: stderr || '',
          code: err?.code ?? 0,
        });
      }
    );
  });
}

describe('contradictions integration', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'wikicli-contradictions-test-'));
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  describe('wikic contradictions', () => {
    it('lists empty queue on new project', async () => {
      createConfigYaml(testDir);
      createManifest(testDir, { version: 1, sources: {}, concepts: {} });
      createGraphJson(testDir, []);
      mkdirSync(join(testDir, 'wiki', 'concepts'), { recursive: true });

      const result = await runContradictions(testDir);
      const output = JSON.parse(result.stdout);

      assert.equal(output.ok, true);
      assert.ok(Array.isArray(output.pending));
      assert.ok(Array.isArray(output.verified));
      assert.ok(Array.isArray(output.dismissed));
      assert.equal(output.stats.total_pending, 0);
    });

    it('shows pending contradictions when present', async () => {
      createConfigYaml(testDir);
      createManifest(testDir, {
        version: 1,
        sources: {},
        concepts: {
          'concept-a': { article_path: 'wiki/concepts/concept-a.md', sources: [], aliases: [], last_compiled: null },
          'concept-b': { article_path: 'wiki/concepts/concept-b.md', sources: [], aliases: [], last_compiled: null },
        },
      });
      createGraphJson(testDir, []);
      createReviewQueue(testDir, {
        pending: [
          {
            slugA: 'concept-a',
            slugB: 'concept-b',
            addedAt: '2024-01-01T00:00:00Z',
            confidence: 0.75,
            conflictType: 'negation',
            status: 'pending',
          },
        ],
        confirmed: [],
        dismissed: [],
      });

      createConcept(testDir, 'concept-a', '## Definition\nContent A.', {
        concept: 'concept-a',
        sources: [],
        confidence: 1,
      });
      createConcept(testDir, 'concept-b', '## Definition\nContent B.', {
        concept: 'concept-b',
        sources: [],
        confidence: 1,
      });

      const result = await runContradictions(testDir);
      const output = JSON.parse(result.stdout);

      assert.equal(output.ok, true);
      assert.equal(output.pending.length, 1);
      assert.equal(output.pending[0].slugA, 'concept-a');
      assert.equal(output.pending[0].slugB, 'concept-b');
    });

    it('filters with --pending flag', async () => {
      createConfigYaml(testDir);
      createManifest(testDir, { version: 1, sources: {}, concepts: {} });
      createGraphJson(testDir, []);
      createReviewQueue(testDir, {
        pending: [{ slugA: 'a', slugB: 'b', addedAt: '2024-01-01', status: 'pending' }],
        confirmed: [],
        dismissed: [{ slugA: 'x', slugB: 'y', addedAt: '2024-01-01', status: 'dismissed', notes: 'not contradictory' }],
      });
      mkdirSync(join(testDir, 'wiki', 'concepts'), { recursive: true });

      const result = await runContradictions(testDir, ['--pending']);
      const output = JSON.parse(result.stdout);

      assert.equal(output.pending.length, 1);
      assert.equal(output.verified.length, 0);
      assert.equal(output.dismissed.length, 0);
    });

    it('exports to JSON file', async () => {
      createConfigYaml(testDir);
      createManifest(testDir, { version: 1, sources: {}, concepts: {} });
      createGraphJson(testDir, []);
      createReviewQueue(testDir, {
        pending: [{ slugA: 'a', slugB: 'b', addedAt: '2024-01-01', status: 'pending', confidence: 0.8 }],
        confirmed: [],
        dismissed: [],
      });
      mkdirSync(join(testDir, 'wiki', 'concepts'), { recursive: true });

      const exportPath = join(testDir, 'export.json');
      const result = await runContradictions(testDir, ['--export', exportPath]);

      assert.ok(readFileSync(exportPath, 'utf-8').length > 0);
    });

    it('exports to Markdown file', async () => {
      createConfigYaml(testDir);
      createManifest(testDir, { version: 1, sources: {}, concepts: {} });
      createGraphJson(testDir, []);
      createReviewQueue(testDir, {
        pending: [{ slugA: 'a', slugB: 'b', addedAt: '2024-01-01', status: 'pending', confidence: 0.8 }],
        confirmed: [],
        dismissed: [],
      });
      mkdirSync(join(testDir, 'wiki', 'concepts'), { recursive: true });

      const exportPath = join(testDir, 'export.md');
      const result = await runContradictions(testDir, ['--export', exportPath]);

      const content = readFileSync(exportPath, 'utf-8');
      assert.ok(content.includes('# Contradictions Report'));
      assert.ok(content.includes('Pending Review'));
    });
  });

  describe('wikic contradictions review', () => {
    it('outputs review format for a pair', async () => {
      createConfigYaml(testDir);
      createManifest(testDir, {
        version: 1,
        sources: {},
        concepts: {
          'concept-a': { article_path: 'wiki/concepts/concept-a.md', sources: [], aliases: [], last_compiled: null },
          'concept-b': { article_path: 'wiki/concepts/concept-b.md', sources: [], aliases: [], last_compiled: null },
        },
      });
      createGraphJson(testDir, []);
      createReviewQueue(testDir, {
        pending: [
          {
            slugA: 'concept-a',
            slugB: 'concept-b',
            addedAt: '2024-01-01T00:00:00Z',
            confidence: 0.75,
            conflictType: 'negation',
            explanation: 'One claims X is true, other claims X is false',
            status: 'pending',
          },
        ],
        confirmed: [],
        dismissed: [],
      });

      createConcept(testDir, 'concept-a', '## Definition\nContent A says X is true.', {
        concept: 'concept-a',
        sources: [],
        confidence: 1,
      });
      createConcept(testDir, 'concept-b', '## Definition\nContent B says X is false.', {
        concept: 'concept-b',
        sources: [],
        confidence: 1,
      });

      const result = await runContradictions(testDir, ['review', 'concept-a', 'concept-b']);
      const output = JSON.parse(result.stdout);

      assert.equal(output.ok, true);
      assert.equal(output.slugA, 'concept-a');
      assert.equal(output.slugB, 'concept-b');
      assert.equal(output.status, 'pending');
      assert.equal(output.confidence, 0.75);
      assert.ok(output.articleA.includes('Content A'));
    });
  });

  describe('wikic contradictions confirm', () => {
    it('adds contradicts edge to graph.json', async () => {
      createConfigYaml(testDir);
      createManifest(testDir, {
        version: 1,
        sources: {},
        concepts: {
          'concept-a': { article_path: 'wiki/concepts/concept-a.md', sources: [], aliases: [], last_compiled: null },
          'concept-b': { article_path: 'wiki/concepts/concept-b.md', sources: [], aliases: [], last_compiled: null },
        },
      });
      createGraphJson(testDir, []);
      createReviewQueue(testDir, {
        pending: [
          {
            slugA: 'concept-a',
            slugB: 'concept-b',
            addedAt: '2024-01-01T00:00:00Z',
            confidence: 0.8,
            conflictType: 'negation',
            explanation: 'Verified contradiction',
            status: 'pending',
          },
        ],
        confirmed: [],
        dismissed: [],
      });

      createConcept(testDir, 'concept-a', '## Definition\nContent A.', {
        concept: 'concept-a',
        sources: [],
        confidence: 1,
      });
      createConcept(testDir, 'concept-b', '## Definition\nContent B.', {
        concept: 'concept-b',
        sources: [],
        confidence: 1,
      });

      const result = await runContradictions(testDir, ['confirm', 'concept-a', 'concept-b']);
      const output = JSON.parse(result.stdout);

      assert.equal(output.ok, true);
      assert.equal(output.action, 'confirmed');

      const graphContent = readFileSync(join(testDir, '.wikic', 'graph.json'), 'utf-8');
      const graph = JSON.parse(graphContent);
      const contradictsEdge = graph.find((e: any) => e.type === 'contradicts');
      assert.ok(contradictsEdge, 'Should have contradicts edge');
      assert.equal(contradictsEdge.source, 'concept-a');
      assert.equal(contradictsEdge.target, 'concept-b');

      const queueContent = readFileSync(join(testDir, '.wikic', 'review_queue.json'), 'utf-8');
      const queue = JSON.parse(queueContent);
      assert.equal(queue.pending.length, 0);
      assert.equal(queue.confirmed.length, 1);
      assert.equal(queue.confirmed[0].status, 'confirmed');
    });

    it('fails when contradiction not in pending queue', async () => {
      createConfigYaml(testDir);
      createManifest(testDir, { version: 1, sources: {}, concepts: {} });
      createGraphJson(testDir, []);
      createReviewQueue(testDir, { pending: [], confirmed: [], dismissed: [] });
      mkdirSync(join(testDir, 'wiki', 'concepts'), { recursive: true });

      const result = await runContradictions(testDir, ['confirm', 'a', 'b']);
      const output = JSON.parse(result.stdout);

      assert.equal(output.ok, false);
      assert.ok(output.error.includes('not found'));
    });
  });

  describe('wikic contradictions dismiss', () => {
    it('moves item to dismissed in review_queue.json', async () => {
      createConfigYaml(testDir);
      createManifest(testDir, {
        version: 1,
        sources: {},
        concepts: {
          'concept-a': { article_path: 'wiki/concepts/concept-a.md', sources: [], aliases: [], last_compiled: null },
          'concept-b': { article_path: 'wiki/concepts/concept-b.md', sources: [], aliases: [], last_compiled: null },
        },
      });
      createGraphJson(testDir, []);
      createReviewQueue(testDir, {
        pending: [
          {
            slugA: 'concept-a',
            slugB: 'concept-b',
            addedAt: '2024-01-01T00:00:00Z',
            confidence: 0.6,
            status: 'pending',
          },
        ],
        confirmed: [],
        dismissed: [],
      });

      createConcept(testDir, 'concept-a', '## Definition\nContent A.', {
        concept: 'concept-a',
        sources: [],
        confidence: 1,
      });
      createConcept(testDir, 'concept-b', '## Definition\nContent B.', {
        concept: 'concept-b',
        sources: [],
        confidence: 1,
      });

      const result = await runContradictions(testDir, ['dismiss', 'concept-a', 'concept-b', '--notes', 'Not actually contradictory']);
      const output = JSON.parse(result.stdout);

      assert.equal(output.ok, true);
      assert.equal(output.action, 'dismissed');

      const queueContent = readFileSync(join(testDir, '.wikic', 'review_queue.json'), 'utf-8');
      const queue = JSON.parse(queueContent);
      assert.equal(queue.pending.length, 0);
      assert.equal(queue.dismissed.length, 1);
      assert.equal(queue.dismissed[0].status, 'dismissed');
      assert.equal(queue.dismissed[0].notes, 'Not actually contradictory');
    });

    it('fails when contradiction not in pending queue', async () => {
      createConfigYaml(testDir);
      createManifest(testDir, { version: 1, sources: {}, concepts: {} });
      createGraphJson(testDir, []);
      createReviewQueue(testDir, { pending: [], confirmed: [], dismissed: [] });
      mkdirSync(join(testDir, 'wiki', 'concepts'), { recursive: true });

      const result = await runContradictions(testDir, ['dismiss', 'a', 'b']);
      const output = JSON.parse(result.stdout);

      assert.equal(output.ok, false);
      assert.ok(output.error.includes('not found'));
    });
  });

  describe('verified contradictions', () => {
    it('shows contradicts edges from graph.json as verified', async () => {
      createConfigYaml(testDir);
      createManifest(testDir, {
        version: 1,
        sources: {},
        concepts: {
          'concept-a': { article_path: 'wiki/concepts/concept-a.md', sources: [], aliases: [], last_compiled: null },
          'concept-b': { article_path: 'wiki/concepts/concept-b.md', sources: [], aliases: [], last_compiled: null },
        },
      });
      createGraphJson(testDir, [
        {
          id: '1',
          source: 'concept-a',
          target: 'concept-b',
          type: 'contradicts',
          created_at: '2024-01-01T00:00:00Z',
          evidence: 'Verified contradiction',
          confidence: 0.85,
          conflictType: 'negation',
        },
      ]);
      createReviewQueue(testDir, { pending: [], confirmed: [], dismissed: [] });

      createConcept(testDir, 'concept-a', '## Definition\nContent A.', {
        concept: 'concept-a',
        sources: [],
        confidence: 1,
      });
      createConcept(testDir, 'concept-b', '## Definition\nContent B.', {
        concept: 'concept-b',
        sources: [],
        confidence: 1,
      });

      const result = await runContradictions(testDir, ['--verified']);
      const output = JSON.parse(result.stdout);

      assert.equal(output.verified.length, 1);
      assert.equal(output.verified[0].slugA, 'concept-a');
      assert.equal(output.verified[0].slugB, 'concept-b');
    });
  });
});