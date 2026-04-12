import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getDefaultConfig } from '../../src/lib/config.ts';

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
