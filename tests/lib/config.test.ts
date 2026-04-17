import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { getDefaultConfig, loadConfig, saveConfig } from '../../src/lib/config.ts';

describe('getDefaultConfig', () => {
  it('includes chunk_threshold', () => {
    const cfg = getDefaultConfig();
    assert.equal(typeof cfg.compiler.chunk_threshold, 'number');
    assert.ok(cfg.compiler.chunk_threshold > 0);
  });

  it('includes chunk_size', () => {
    const cfg = getDefaultConfig();
    assert.equal(typeof cfg.compiler.chunk_size, 'number');
    assert.ok(cfg.compiler.chunk_size > 0);
  });

  it('includes min_chunk_size', () => {
    const cfg = getDefaultConfig();
    assert.equal(typeof cfg.compiler.min_chunk_size, 'number');
    assert.ok(cfg.compiler.min_chunk_size > 0);
  });

  it('chunk_threshold is greater than chunk_size', () => {
    const cfg = getDefaultConfig();
    assert.ok(
      cfg.compiler.chunk_threshold > cfg.compiler.chunk_size,
      `chunk_threshold (${cfg.compiler.chunk_threshold}) should be > chunk_size (${cfg.compiler.chunk_size})`
    );
  });

  it('opencode-cli is a valid provider type', () => {
    const cfg = getDefaultConfig();
    // Type check: assign opencode-cli to verify it's in the union
    const provider: typeof cfg.llm.provider = 'opencode-cli';
    assert.ok(provider);
  });
});

describe('saveConfig', () => {
  it('writes config.yaml that can be read back', () => {
    const dir = mkdtempSync(join(os.tmpdir(), 'wikicli-config-test-'));
    try {
      const config = getDefaultConfig();
      config.llm.model = 'opencode/minimax-m2.5-free';
      saveConfig(dir, config);
      const loaded = loadConfig(dir);
      assert.equal(loaded.llm.model, 'opencode/minimax-m2.5-free');
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it('preserves provider, project, and compiler settings after roundtrip', () => {
    const dir = mkdtempSync(join(os.tmpdir(), 'wikicli-config-test-'));
    try {
      const config = getDefaultConfig();
      config.project = 'test-project';
      config.llm.provider = 'opencode-cli';
      config.llm.model = 'opencode/nemotron-3-super-free';
      config.compiler.max_parallel = 5;
      saveConfig(dir, config);
      const loaded = loadConfig(dir);
      assert.equal(loaded.project, 'test-project');
      assert.equal(loaded.llm.provider, 'opencode-cli');
      assert.equal(loaded.llm.model, 'opencode/nemotron-3-super-free');
      assert.equal(loaded.compiler.max_parallel, 5);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it('omits model key when model is undefined', () => {
    const dir = mkdtempSync(join(os.tmpdir(), 'wikicli-config-test-'));
    try {
      const config = getDefaultConfig();
      config.llm.model = undefined;
      saveConfig(dir, config);
      const loaded = loadConfig(dir);
      assert.equal(loaded.llm.model, undefined);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});
