import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { OPENCODE_FREE_MODELS, extractOpencodeText, extractCodexText } from '../../src/lib/llm.ts';
import { listProviderModels } from '../../src/lib/models.ts';

describe('OPENCODE_FREE_MODELS', () => {
  it('contains exactly 3 entries', () => {
    assert.equal(OPENCODE_FREE_MODELS.length, 3);
  });

  it('all entries start with opencode/', () => {
    for (const m of OPENCODE_FREE_MODELS) {
      assert.ok(m.startsWith('opencode/'), `"${m}" does not start with "opencode/"`);
    }
  });
});

// Actual opencode CLI --format json event format (verified against opencode 1.2.27):
// { "type": "text", "part": { "type": "text", "text": "..." }, ... }
describe('extractOpencodeText', () => {
  it('extracts text from CLI text events', () => {
    const output = [
      '{"type":"step_start","timestamp":1,"sessionID":"s1","part":{"type":"step-start"}}',
      '{"type":"text","timestamp":2,"sessionID":"s1","part":{"id":"p1","type":"text","text":"Hello "}}',
      '{"type":"text","timestamp":3,"sessionID":"s1","part":{"id":"p2","type":"text","text":"world"}}',
      '{"type":"step_finish","timestamp":4,"sessionID":"s1","part":{"type":"step-finish","reason":"stop"}}',
    ].join('\n');
    assert.equal(extractOpencodeText(output), 'Hello world');
  });

  it('ignores non-text event types', () => {
    const output = [
      '{"type":"step_start","part":{"type":"step-start"}}',
      '{"type":"text","part":{"type":"text","text":"Result"}}',
      '{"type":"step_finish","part":{"type":"step-finish"}}',
    ].join('\n');
    assert.equal(extractOpencodeText(output), 'Result');
  });

  it('falls back to raw stdout when no structured events found', () => {
    const output = 'plain text response\nno json here';
    assert.equal(extractOpencodeText(output), 'plain text response\nno json here');
  });

  it('returns empty string for empty output', () => {
    assert.equal(extractOpencodeText(''), '');
  });

  it('handles malformed JSON lines gracefully', () => {
    const output = [
      'not json at all',
      '{"type":"text","part":{"type":"text","text":"OK"}}',
    ].join('\n');
    assert.equal(extractOpencodeText(output), 'OK');
  });
});

// Verified against codex exec --json output format:
// { "type": "item.completed", "item": { "type": "agent_message", "text": "..." } }
describe('extractCodexText', () => {
  it('extracts text from agent_message item.completed events', () => {
    const output = [
      '{"type":"thread.started","thread_id":"abc123"}',
      '{"type":"turn.started"}',
      '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"Hello world"}}',
      '{"type":"turn.completed","usage":{"input_tokens":100,"output_tokens":5}}',
    ].join('\n');
    assert.equal(extractCodexText(output), 'Hello world');
  });

  it('concatenates multiple agent_message events', () => {
    const output = [
      '{"type":"item.completed","item":{"type":"agent_message","text":"Part one. "}}',
      '{"type":"item.completed","item":{"type":"agent_message","text":"Part two."}}',
    ].join('\n');
    assert.equal(extractCodexText(output), 'Part one. Part two.');
  });

  it('ignores non-agent_message item types', () => {
    const output = [
      '{"type":"item.completed","item":{"type":"tool_call","text":"ignored"}}',
      '{"type":"item.completed","item":{"type":"agent_message","text":"kept"}}',
    ].join('\n');
    assert.equal(extractCodexText(output), 'kept');
  });

  it('falls back to raw stdout when no structured events found', () => {
    const output = 'plain text response';
    assert.equal(extractCodexText(output), 'plain text response');
  });

  it('handles malformed JSON lines gracefully', () => {
    const output = [
      'not json',
      '{"type":"item.completed","item":{"type":"agent_message","text":"OK"}}',
    ].join('\n');
    assert.equal(extractCodexText(output), 'OK');
  });
});

describe('listProviderModels', () => {
  it('returns non-empty array for opencode-cli', () => {
    const models = listProviderModels('opencode-cli');
    assert.ok(Array.isArray(models));
    assert.ok(models.length > 0);
  });

  it('opencode-cli models include minimax-m2.5-free', () => {
    const models = listProviderModels('opencode-cli');
    assert.ok(models.includes('opencode/minimax-m2.5-free'));
  });

  it('opencode-cli models match OPENCODE_FREE_MODELS', () => {
    const models = listProviderModels('opencode-cli');
    assert.deepEqual(models, [...OPENCODE_FREE_MODELS]);
  });

  it('returns non-empty array for claude-cli', () => {
    const models = listProviderModels('claude-cli');
    assert.ok(Array.isArray(models));
    assert.ok(models.length > 0);
  });

  it('claude-cli models are strings', () => {
    const models = listProviderModels('claude-cli');
    assert.ok(models.every(m => typeof m === 'string' && m.length > 0));
  });

  it('returns non-empty array for codex-cli', () => {
    const models = listProviderModels('codex-cli');
    assert.ok(Array.isArray(models));
    assert.ok(models.length > 0);
  });

  it('returns empty array for unknown provider', () => {
    const models = listProviderModels('unknown-provider');
    assert.deepEqual(models, []);
  });
});
