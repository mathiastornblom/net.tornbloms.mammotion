/**
 * Flow-card manifest and task-control encoding test. Run after `npm run build`:
 *   node --test scripts/flow-cards.test.mjs
 *
 * Two guards:
 *
 * 1. Every Flow card ships all 13 locales. The app declares 13 languages, and a card
 *    added with only an `en` title still validates and still publishes — it just silently
 *    shows English to everyone else. Nothing else in the build catches that.
 *
 * 2. `resume` encodes as its own task-control opcode. Resume shares one builder with
 *    start/pause/stop/dock, so a wrong or duplicated opcode would send a *different*
 *    real command to a real mower rather than failing — the reason it is worth pinning.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { buildTaskControlCommand } from '../.homeybuild/lib/mammotion/commands/LubaCommands.js';
import { decodeLubaMsg } from '../.homeybuild/lib/mammotion/protocol/Codec.js';

const app = JSON.parse(readFileSync(new URL('../app.json', import.meta.url), 'utf8'));
const LOCALES = ['en', 'nl', 'de', 'fr', 'it', 'sv', 'no', 'es', 'da', 'ru', 'pl', 'ko', 'ar'];

const everyCard = Object.entries(app.flow).flatMap(([group, cards]) =>
  cards.map((card) => ({ group, card })));

test('every Flow card has a title in all 13 locales', () => {
  for (const { group, card } of everyCard) {
    const missing = LOCALES.filter((l) => !card.title?.[l]);
    assert.deepEqual(missing, [], `${group}/${card.id} is missing titles: ${missing.join(', ')}`);
  }
});

test('every Flow card hint, where present, covers all 13 locales', () => {
  // A partial hint is worse than none: Homey falls back to English for the missing
  // languages, so a half-translated hint reads as a bug rather than a default.
  for (const { group, card } of everyCard) {
    if (!card.hint) continue;
    const missing = LOCALES.filter((l) => !card.hint[l]);
    assert.deepEqual(missing, [], `${group}/${card.id} has a partial hint, missing: ${missing.join(', ')}`);
  }
});

test('every Flow card argument title covers all 13 locales', () => {
  for (const { group, card } of everyCard) {
    for (const arg of card.args ?? []) {
      if (!arg.title) continue; // device pickers carry no title
      const missing = LOCALES.filter((l) => !arg.title[l]);
      assert.deepEqual(missing, [], `${group}/${card.id} arg "${arg.name}" is missing titles: ${missing.join(', ')}`);
    }
  }
});

test('resume_mowing is declared as a device-scoped action on the luba driver', () => {
  const card = app.flow.actions.find((c) => c.id === 'resume_mowing');
  assert.ok(card, 'resume_mowing action card must exist');
  const device = card.args.find((a) => a.type === 'device');
  assert.equal(device?.filter, 'driver_id=luba');
});

function opcodeFor(command) {
  const b64 = buildTaskControlCommand(command, '0', 'Luba-TEST', { value: 0 }, 'uY54W5rM8YH');
  return decodeLubaMsg(Buffer.from(b64, 'base64')).nav.todevTaskctrl.action;
}

test('resume encodes a distinct task-control opcode from start, pause and stop', () => {
  const resume = opcodeFor('resume');
  assert.equal(resume, 3, 'resume is action 3 per pymammotion');
  for (const other of ['start', 'pause', 'stop', 'dock']) {
    assert.notEqual(opcodeFor(other), resume, `${other} must not encode the same opcode as resume`);
  }
});
