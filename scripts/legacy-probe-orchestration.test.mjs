/**
 * Legacy Aliyun handshake orchestration test. Run after `npm run build`:
 *   node --test scripts/legacy-probe-orchestration.test.mjs
 *
 * The seven-request handshake is injectable (HandshakeSteps), so this drives the real
 * orchestration in AliyunLegacyProbe.ts with fake steps that record when each call *starts*
 * and can fail on demand. It pins three things a real report (USER_REPORTS_INBOX R11) made
 * matter: which steps overlap, that a timed-out step is retried alone rather than the whole
 * handshake being re-run, and that a *logical* rejection in the reordered handshake falls
 * back to the original strict order exactly once — the order confirmed against a live account.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { probeLegacyAliyunDevices, isNetworkLevelError } from '../.homeybuild/lib/mammotion/aliyun/AliyunLegacyProbe.js';

const SESSION = { authorizationCode: 'auth', countryCode: 'SE', userId: 'user-1' };
const REGION = { region: { data: { apiGatewayEndpoint: 'gw', regionId: 'eu', oaApiGatewayEndpoint: 'oa' } }, fallback: undefined };

/** A fake step bundle. `starts` records the order calls *began*; `failOnce` maps a step to an
 *  error thrown on its first call only; `delayMs` lets a step be slow so overlap is observable. */
function fakeSteps({ failOnce = {}, delayMs = {} } = {}) {
  const starts = [];
  const calls = {};
  const step = (name, result) => async (...args) => {
    starts.push(name);
    calls[name] = (calls[name] ?? 0) + 1;
    if (delayMs[name]) await new Promise((r) => setTimeout(r, delayMs[name]));
    if (failOnce[name] && calls[name] === 1) throw failOnce[name];
    return typeof result === 'function' ? result(...args) : result;
  };
  return {
    starts, calls,
    steps: {
      getRegion: step('region', REGION),
      connectDevice: step('connect', { data: { ok: true } }),
      loginByOAuth: step('oauth', { data: { token: 'oa' } }),
      aepHandle: step('aep', { data: { deviceSecret: 's', productKey: 'pk', deviceName: 'dn' } }),
      sessionByAuthCode: step('session', { iotToken: 'iot', iotTokenExpiresAt: 9_999_999_999 }),
      listBindingByAccount: step('binding', { data: { data: [{ iotId: 'x', deviceName: 'Luba-X', productKey: 'pk' }] } }),
      getShareNoticeList: step('notice', { data: { total: 2 } }),
    },
  };
}

const netErr = (msg = 'Aliyun request timed out after 6000ms') => Object.assign(new Error(msg), { code: 'ETIMEDOUT' });
const logicErr = (msg) => new Error(msg); // a reachable server saying no — no `code`

test('parallel mode overlaps region∥connect, oauth∥aep and binding∥notice', async () => {
  // Make the *first* member of each pair slow: if the second only started after the first
  // finished, the pairs were serial. Recording start order (not finish order) is what shows
  // the overlap.
  const f = fakeSteps({ delayMs: { region: 30, oauth: 30, binding: 30 } });
  const r = await probeLegacyAliyunDevices(SESSION, f.steps);
  assert.equal(r.via, 'parallel');
  assert.equal(r.parallelFailure, undefined);
  const idx = (n) => f.starts.indexOf(n);
  assert.ok(idx('connect') < idx('oauth'), 'connect started before stage B — i.e. alongside region, not after it');
  assert.ok(idx('aep') < idx('session'), 'aep started before stage C — i.e. alongside oauth');
  assert.ok(idx('notice') > idx('session'), 'notice started after the token existed');
  assert.deepEqual(f.starts.slice(0, 2).sort(), ['connect', 'region'], 'stage A is exactly region+connect');
  assert.deepEqual(f.starts.slice(2, 4).sort(), ['aep', 'oauth'], 'stage B is exactly oauth+aep');
  assert.equal(f.starts[4], 'session');
  assert.deepEqual(f.starts.slice(5).sort(), ['binding', 'notice'], 'stage D is exactly binding+notice');
  assert.deepEqual(r.boundDevices.map((d) => d.iotId), ['x']);
  assert.equal(r.shareNotifications, 2);
  assert.equal(r.credentials?.productKey, 'pk');
});

test('a timed-out step is retried alone — the steps that already succeeded are not re-run', async () => {
  // R11's shape: earlier steps succeed, one step times out. Before, the whole handshake was
  // re-run from the top; now only the failed request is repeated.
  const f = fakeSteps({ failOnce: { session: netErr() } });
  const r = await probeLegacyAliyunDevices(SESSION, f.steps);
  assert.equal(r.via, 'parallel', 'a network failure never triggers the sequential fallback');
  assert.equal(f.calls.session, 2, 'the timed-out step ran twice');
  for (const n of ['region', 'connect', 'oauth', 'aep', 'binding', 'notice']) assert.equal(f.calls[n], 1, `${n} ran once`);
});

test('a logical rejection in the reordered handshake falls back to the strict original order exactly once', async () => {
  // If Aliyun ever objects to aepHandle running before loginByOAuth has completed, this is
  // the path that saves the pairing: the original, live-confirmed order, run once.
  const f = fakeSteps({ failOnce: { aep: logicErr('aep rejected: 4xx') } });
  const r = await probeLegacyAliyunDevices(SESSION, f.steps);
  assert.equal(r.via, 'sequential');
  assert.match(r.parallelFailure, /oauth\|aep/, 'the failing stage is named');
  assert.match(r.parallelFailure, /aep rejected/, 'and the server\'s own message is kept');
  assert.equal(f.calls.aep, 2, 'aep: failed once in parallel, succeeded once in sequential');
  // The sequential rerun is strictly ordered: after the fallback begins, every step starts
  // only after the previous one finished.
  const rerun = f.starts.slice(f.starts.lastIndexOf('region'));
  assert.deepEqual(rerun, ['region', 'connect', 'oauth', 'aep', 'session', 'binding', 'notice']);
});

test('a logical rejection is not retried within a stage, and a persistent one still fails', async () => {
  // A reachable server saying no would say no again; only the *shape* of the handshake
  // changes on fallback, not the number of tries per step within it.
  const always = new Error('bound listing forbidden');
  const f = fakeSteps();
  f.steps.listBindingByAccount = async () => { f.starts.push('binding'); throw always; };
  await assert.rejects(() => probeLegacyAliyunDevices(SESSION, f.steps), /bound listing forbidden/);
  assert.equal(f.starts.filter((n) => n === 'binding').length, 2, 'once in parallel, once in the sequential fallback — never a third time');
});

test('a persistent network failure surfaces as the network error, without a sequential fallback', async () => {
  // The sequential order would hit the same dead network; per-step retry already gave the
  // step its second chance.
  const f = fakeSteps();
  f.steps.connectDevice = async () => { f.starts.push('connect'); throw netErr('ECONNRESET'); };
  await assert.rejects(() => probeLegacyAliyunDevices(SESSION, f.steps), (err) => err.code === 'ETIMEDOUT' && /ECONNRESET/.test(err.message));
  assert.equal(f.starts.filter((n) => n === 'connect').length, 2, 'the per-step retry, and nothing more');
});

test('the gateway timeout error now counts as network-level', () => {
  // gateway.ts used to throw a bare Error for its own inactivity timeout, which
  // isNetworkLevelError() classed as a *logical* failure — so neither getRegion\'s static
  // fallback nor the per-step retry would have engaged for exactly R11\'s failure.
  assert.equal(isNetworkLevelError(netErr()), true);
  assert.equal(isNetworkLevelError(logicErr('code=500')), false);
  assert.equal(isNetworkLevelError(new AggregateError([netErr()], 'many')), true);
});

test('a session without an authorization code is rejected before any request is made', async () => {
  const f = fakeSteps();
  await assert.rejects(() => probeLegacyAliyunDevices({ ...SESSION, authorizationCode: '' }, f.steps), /authorizationCode/);
  assert.deepEqual(f.starts, []);
});
