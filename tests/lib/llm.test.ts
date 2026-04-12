import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { OPENCODE_FREE_MODELS, extractOpencodeText } from '../../src/lib/llm.ts';

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
