import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';

import { getCaSignature, getContentMd5 } from '../.homeybuild/lib/mammotion/aliyun/signing.js';

// These tests lock the algorithm against silent regression and check it matches the
// documented Alibaba Cloud API Gateway "CA signature" scheme (ported from
// alibabacloud-apigateway-util's Python implementation) — they cannot verify correctness
// against Aliyun's real servers, since there is no vendored reference or live test account.
// See lib/mammotion/aliyun/AliyunLegacyProbe.ts for the full context.

test('getContentMd5 matches base64(MD5(body))', () => {
  const body = '{"id":"abc","version":"1.0"}';
  const expected = createHash('md5').update(body, 'utf8').digest('base64');
  assert.equal(getContentMd5(body), expected);
});

test('getContentMd5 returns empty string for an empty body', () => {
  assert.equal(getContentMd5(''), '');
});

test('getCaSignature excludes MOVE_HEADERS from the signed-header block', () => {
  const { signatureHeaders } = getCaSignature({
    method: 'POST',
    pathname: '/uc/listBindingByAccount',
    headers: {
      host: 'example.aliyuncs.com',
      date: 'Fri, 03 Jul 2026 10:00:00 GMT',
      accept: 'application/json',
      'content-type': 'application/octet-stream',
      'content-md5': 'deadbeef==',
      'user-agent': 'test',
      'x-ca-key': '123',
      'x-ca-nonce': 'abc',
    },
    secret: 'shh',
  });
  // Only the non-excluded, sorted header names should appear.
  assert.equal(signatureHeaders, 'x-ca-key,x-ca-nonce');
});

test('getCaSignature builds the documented string-to-sign and HMAC-SHA256s it', () => {
  const headers = {
    host: 'example.aliyuncs.com',
    date: 'Fri, 03 Jul 2026 10:00:00 GMT',
    accept: 'application/json',
    'content-type': 'application/octet-stream',
    'content-md5': 'md5value',
    'x-ca-key': '123',
  };
  const { signature } = getCaSignature({
    method: 'POST', pathname: '/foo', headers, query: { a: '1' }, secret: 'shh',
  });

  const expectedStringToSign = ['POST', 'application/json', 'md5value', 'application/octet-stream',
    'Fri, 03 Jul 2026 10:00:00 GMT', 'x-ca-key:123', '/foo?a=1'].join('\n');
  const expected = createHmac('sha256', 'shh').update(expectedStringToSign, 'utf8').digest('base64');
  assert.equal(signature, expected);
});

test('getCaSignature is deterministic for identical input', () => {
  const opts = {
    method: 'POST', pathname: '/x', headers: { date: 'd', accept: 'a' }, secret: 's',
  };
  assert.equal(getCaSignature(opts).signature, getCaSignature(opts).signature);
});
