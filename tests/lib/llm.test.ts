import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { OPENCODE_FREE_MODELS, extractOpencodeText } from '../../src/lib/llm.ts';

describe('OPENCODE_FREE_MODELS', () => {
  it('contains exactly 4 entries', () => {
    assert.equal(OPENCODE_FREE_MODELS.length, 4);
  });

  it('all entries start with opencode/', () => {
    for (const m of OPENCODE_FREE_MODELS) {
      assert.ok(m.startsWith('opencode/'), `"${m}" does not start with "opencode/"`);
    }
  });
});

describe('extractOpencodeText', () => {
  it('extracts text from message.part.updated events', () => {
    const output = [
      '{"type":"session.created","properties":{"id":"s1"}}',
      '{"type":"message.part.updated","properties":{"part":{"type":"text","text":"Hello "}}}',
      '{"type":"message.part.updated","properties":{"part":{"type":"text","text":"world"}}}',
      '{"type":"session.idle","properties":{"sessionID":"s1"}}',
    ].join('\n');
    assert.equal(extractOpencodeText(output), 'Hello world');
  });

  it('ignores non-text part types', () => {
    const output = [
      '{"type":"message.part.updated","properties":{"part":{"type":"tool-invocation","toolName":"read"}}}',
      '{"type":"message.part.updated","properties":{"part":{"type":"text","text":"Result"}}}',
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
      '{"type":"message.part.updated","properties":{"part":{"type":"text","text":"OK"}}}',
    ].join('\n');
    assert.equal(extractOpencodeText(output), 'OK');
  });
});
