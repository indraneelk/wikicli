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
  auto_lint: true
  chunk_threshold: 12000
  chunk_size: 8000
  min_chunk_size: 1500
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

async function runLint(dir: string, args: string[] = []): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    execFile(
      'node',
      [join(process.cwd(), 'dist/index.js'), 'lint', ...args],
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

describe('lint integration', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'wikicli-lint-test-'));
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  describe('basic lint', () => {
    it('runs on empty project with no errors', async () => {
      createConfigYaml(testDir);
      createManifest(testDir, { version: 1, sources: {}, concepts: {} });
      createGraphJson(testDir, []);
      mkdirSync(join(testDir, 'wiki', 'concepts'), { recursive: true });

      const result = await runLint(testDir);
      const output = JSON.parse(result.stdout);

      assert.equal(output.ok, true);
      assert.equal(output.error_count, 0);
    });

    it('detects broken wikilinks', async () => {
      createConfigYaml(testDir);
      createManifest(testDir, {
        version: 1,
        sources: {},
        concepts: {
          'existing-concept': { article_path: 'wiki/concepts/existing-concept.md', sources: [], aliases: [], last_compiled: null },
        },
      });
      createGraphJson(testDir, []);

      createConcept(testDir, 'existing-concept', 'This links to [[nonexistent-concept]].', {
        concept: 'existing-concept',
        sources: [],
        confidence: 1,
      });

      const result = await runLint(testDir);
      const output = JSON.parse(result.stdout);

      assert.equal(output.ok, false);
      assert.ok(output.error_count >= 1);
      const brokenLinkError = output.errors.find((e: any) => e.type === 'broken-link');
      assert.ok(brokenLinkError, 'Should find broken link error');
      assert.ok(brokenLinkError.message.includes('nonexistent-concept'));
    });

    it('detects orphan concepts with no inbound links', async () => {
      createConfigYaml(testDir);
      createManifest(testDir, {
        version: 1,
        sources: {},
        concepts: {
          'orphan-concept': { article_path: 'wiki/concepts/orphan-concept.md', sources: [], aliases: [], last_compiled: null },
        },
      });
      createGraphJson(testDir, []);

      createConcept(testDir, 'orphan-concept', '## Definition\nTest content.', {
        concept: 'orphan-concept',
        sources: [],
        confidence: 1,
      });

      const result = await runLint(testDir);
      const output = JSON.parse(result.stdout);

      assert.equal(output.ok, false);
      const orphanError = output.errors.find((e: any) => e.type === 'orphan');
      assert.ok(orphanError, 'Should find orphan error');
    });

    it('returns proper summary counts', async () => {
      createConfigYaml(testDir);
      createManifest(testDir, {
        version: 1,
        sources: {},
        concepts: {
          'concept-a': { article_path: 'wiki/concepts/concept-a.md', sources: [], aliases: [], last_compiled: null },
        },
      });
      createGraphJson(testDir, []);

      createConcept(testDir, 'concept-a', '## Definition\nTest.', {
        concept: 'concept-a',
        sources: [],
        confidence: 1,
      });

      const result = await runLint(testDir);
      const output = JSON.parse(result.stdout);

      assert.ok(output.summary, 'Should have summary');
      assert.ok(typeof output.summary.broken_links === 'number');
      assert.ok(typeof output.summary.orphans === 'number');
      assert.ok(typeof output.summary.missing_fields === 'number');
    });
  });

  describe('lint --contradictions --skipLlm', () => {
    it('runs candidate generation without LLM', async () => {
      createConfigYaml(testDir);
      createManifest(testDir, {
        version: 1,
        sources: {
          'src1.md': { hash: 'h1', size_bytes: 100, added_at: '2024-01-01', compiled_at: null, summary_path: null, status: 'compiled' },
        },
        concepts: {
          'concept-a': { article_path: 'wiki/concepts/concept-a.md', sources: ['src1.md'], aliases: [], last_compiled: null },
          'concept-b': { article_path: 'wiki/concepts/concept-b.md', sources: ['src1.md'], aliases: [], last_compiled: null },
        },
      });
      createGraphJson(testDir, []);

      createConcept(testDir, 'concept-a', '## Definition\nTest content A.\n\nSee also [[concept-b]].', {
        concept: 'concept-a',
        sources: ['src1.md'],
        confidence: 1,
      });
      createConcept(testDir, 'concept-b', '## Definition\nTest content B.\n\nSee also [[concept-a]].', {
        concept: 'concept-b',
        sources: ['src1.md'],
        confidence: 1,
      });

      const result = await runLint(testDir, ['--contradictions', '--skipLlm']);
      const output = JSON.parse(result.stdout);

      assert.equal(output.ok, true);
      assert.ok(output.summary.contradictions >= 0);
    });
  });

  describe('lint --contradictions --fix', () => {
    it('writes to graph.json when fixing', async () => {
      createConfigYaml(testDir);
      createManifest(testDir, {
        version: 1,
        sources: {
          'src1.md': { hash: 'h1', size_bytes: 100, added_at: '2024-01-01', compiled_at: null, summary_path: null, status: 'compiled' },
        },
        concepts: {
          'concept-a': { article_path: 'wiki/concepts/concept-a.md', sources: ['src1.md'], aliases: [], last_compiled: null },
          'concept-b': { article_path: 'wiki/concepts/concept-b.md', sources: ['src1.md'], aliases: [], last_compiled: null },
        },
      });
      createGraphJson(testDir, []);

      createConcept(testDir, 'concept-a', '## Definition\nTest content A.\n\nSee also [[concept-b]].', {
        concept: 'concept-a',
        sources: ['src1.md'],
        confidence: 1,
      });
      createConcept(testDir, 'concept-b', '## Definition\nTest content B.\n\nSee also [[concept-a]].', {
        concept: 'concept-b',
        sources: ['src1.md'],
        confidence: 1,
      });

      const result = await runLint(testDir, ['--contradictions', '--fix', '--skipLlm']);
      const output = JSON.parse(result.stdout);

      assert.equal(output.ok, true);

      const graphPath = join(testDir, '.wikic', 'graph.json');
      const graphContent = readFileSync(graphPath, 'utf-8');
      assert.doesNotThrow(() => JSON.parse(graphContent), 'graph.json should be valid JSON');
    });

    it('outputs new contradiction format with summary', async () => {
      createConfigYaml(testDir);
      createManifest(testDir, {
        version: 1,
        sources: {
          'src1.md': { hash: 'h1', size_bytes: 100, added_at: '2024-01-01', compiled_at: null, summary_path: null, status: 'compiled' },
        },
        concepts: {
          'concept-a': { article_path: 'wiki/concepts/concept-a.md', sources: ['src1.md'], aliases: [], last_compiled: null },
          'concept-b': { article_path: 'wiki/concepts/concept-b.md', sources: ['src1.md'], aliases: [], last_compiled: null },
        },
      });
      createGraphJson(testDir, []);

      createConcept(testDir, 'concept-a', '## Definition\nTest content A with machine learning concepts.', {
        concept: 'concept-a',
        sources: ['src1.md'],
        confidence: 1,
      });
      createConcept(testDir, 'concept-b', '## Definition\nTest content B with neural network training.', {
        concept: 'concept-b',
        sources: ['src1.md'],
        confidence: 1,
      });

      const result = await runLint(testDir, ['--contradictions', '--skipLlm']);
      const output = JSON.parse(result.stdout);

      assert.ok(output.contradiction_summary, 'Should have contradiction_summary');
      assert.ok(typeof output.contradiction_summary.candidates_checked === 'number', 'Should have candidates_checked');
      assert.ok(typeof output.contradiction_summary.verified_contradictions === 'number', 'Should have verified_contradictions');
      assert.ok(typeof output.contradiction_summary.pending_review === 'number', 'Should have pending_review');
      assert.ok(typeof output.contradiction_summary.skipped_unchanged === 'number', 'Should have skipped_unchanged');
      assert.ok(Array.isArray(output.verified_contradictions), 'Should have verified_contradictions array');
      assert.ok(Array.isArray(output.pending_review), 'Should have pending_review array');
    });
  });

  describe('lint incremental checking', () => {
    it('skips unchanged pairs on second run', async () => {
      createConfigYaml(testDir);
      // Both concepts must share 2+ sources to be candidates (minSharedSources=2)
      createManifest(testDir, {
        version: 1,
        sources: {
          'src1.md': { hash: 'h1', size_bytes: 100, added_at: '2024-01-01', compiled_at: null, summary_path: null, status: 'compiled' },
          'src2.md': { hash: 'h2', size_bytes: 100, added_at: '2024-01-01', compiled_at: null, summary_path: null, status: 'compiled' },
        },
        concepts: {
          'concept-a': { article_path: 'wiki/concepts/concept-a.md', sources: ['src1.md', 'src2.md'], aliases: [], last_compiled: null },
          'concept-b': { article_path: 'wiki/concepts/concept-b.md', sources: ['src1.md', 'src2.md'], aliases: [], last_compiled: null },
        },
      });
      createGraphJson(testDir, []);

      createConcept(testDir, 'concept-a', '## Definition\nTest content A.', {
        concept: 'concept-a',
        sources: ['src1.md'],
        confidence: 1,
      });
      createConcept(testDir, 'concept-b', '## Definition\nTest content B.', {
        concept: 'concept-b',
        sources: ['src1.md'],
        confidence: 1,
      });

      const result1 = await runLint(testDir, ['--contradictions', '--skipLlm']);
      const output1 = JSON.parse(result1.stdout);
      const firstChecked = output1.contradiction_summary?.candidates_checked || 0;

      const result2 = await runLint(testDir, ['--contradictions', '--skipLlm']);
      const output2 = JSON.parse(result2.stdout);
      const secondChecked = output2.contradiction_summary?.candidates_checked || 0;

      assert.ok(firstChecked > 0, 'First run should check some candidates');
      assert.ok(secondChecked < firstChecked, 'Second run should skip unchanged pairs');
    });
  });

  describe('lint with missing article files', () => {
    it('detects missing articles referenced in manifest', async () => {
      createConfigYaml(testDir);
      createManifest(testDir, {
        version: 1,
        sources: {},
        concepts: {
          'concept-a': { article_path: 'wiki/concepts/missing.md', sources: [], aliases: [], last_compiled: null },
        },
      });
      createGraphJson(testDir, []);
      mkdirSync(join(testDir, 'wiki', 'concepts'), { recursive: true });

      const result = await runLint(testDir);
      const output = JSON.parse(result.stdout);

      assert.equal(output.ok, false);
      const missingError = output.errors.find((e: any) => e.type === 'missing-article');
      assert.ok(missingError, 'Should find missing article error');
    });
  });

  describe('lint with duplicate aliases', () => {
    it('detects duplicate aliases across concepts', async () => {
      createConfigYaml(testDir);
      createManifest(testDir, {
        version: 1,
        sources: {},
        concepts: {
          'concept-a': { article_path: 'wiki/concepts/concept-a.md', sources: [], aliases: ['alias-x'], last_compiled: null },
          'concept-b': { article_path: 'wiki/concepts/concept-b.md', sources: [], aliases: ['alias-x'], last_compiled: null },
        },
      });
      createGraphJson(testDir, []);

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

      const result = await runLint(testDir);
      const output = JSON.parse(result.stdout);

      assert.equal(output.ok, false);
      const dupError = output.errors.find((e: any) => e.type === 'duplicate-alias');
      assert.ok(dupError, 'Should find duplicate alias error');
    });
  });
});