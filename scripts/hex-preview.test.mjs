/**
 * hexPreview test. Run after `npm run build`:
 *   node --test scripts/hex-preview.test.mjs
 *
 * Covers lib/util/hexPreview.ts, the payload renderer attached to every protobuf decode
 * failure log. Multiple users' reports carried decode failures whose messages
 * (`invalid wire type 6 at offset 35`, `index out of range: 41 + 10 > 41`) could not
 * distinguish a truncated frame from a misparsed length prefix, because the bytes were
 * never logged. These tests pin the two properties that make such a log useful: the bytes
 * are readable, and a burst of failures can't flood the report.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { hexPreview } from '../.homeybuild/lib/util/hexPreview.js';

test('renders bytes as space-separated hex with the length', () => {
  assert.equal(hexPreview(Buffer.from([0x00, 0x1f, 0xff, 0xa5])), '00 1f ff a5 (4 bytes)');
});

test('truncates long payloads but still reports the true total length', () => {
  const out = hexPreview(Buffer.alloc(200, 0xab), 4);
  assert.equal(out, 'ab ab ab ab … (200 bytes total)');
});

test('a payload exactly at the cap is not marked as truncated', () => {
  // Boundary: the marker must mean "there is more", otherwise a complete short frame reads
  // as a clipped one and sends the next diagnosis down the wrong path.
  assert.equal(hexPreview(Buffer.from([0x01, 0x02]), 2), '01 02 (2 bytes)');
});

test('renders an empty payload without a leading separator', () => {
  // A zero-length frame is itself a meaningful decode-failure cause, so it has to render —
  // and without the stray leading space the general template would otherwise produce.
  assert.equal(hexPreview(Buffer.alloc(0)), '(0 bytes)');
});
