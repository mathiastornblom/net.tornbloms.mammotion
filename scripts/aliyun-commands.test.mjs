import test from 'node:test';
import assert from 'node:assert/strict';

import { buildInvokeParams, ALIYUN_INVOKE_CODE } from '../.homeybuild/lib/mammotion/aliyun/commands.js';
import { buildSignedGatewayRequest } from '../.homeybuild/lib/mammotion/aliyun/gateway.js';

// These tests lock down the write-path (/thing/service/invoke) request shape against silent
// regression, matching pymammotion's `CloudIOTGateway.send_cloud_command`
// (pymammotion/aliyun/cloud_gateway.py, verified against source 2026-07-03 — see
// docs/ALIYUN_MQTT_TRANSPORT_PLAN.md section 2). They cannot verify correctness against
// Aliyun's real servers, since there is no vendored reference or live test account — the
// signing scheme itself (getCaSignature) is already covered by aliyun-signing.test.mjs and
// is reused unchanged here via buildSignedGatewayRequest.

test('buildInvokeParams base64-encodes the command bytes and uses the fixed identifier', () => {
  const commandBytes = Buffer.from([0x01, 0x02, 0x03, 0xff]);
  const params = buildInvokeParams('BakiVgR9cPgYtfaRuTrv000000', commandBytes);

  assert.equal(params.identifier, 'device_protobuf_sync_service');
  assert.equal(params.iotId, 'BakiVgR9cPgYtfaRuTrv000000');
  assert.deepEqual(params.args, { content: commandBytes.toString('base64') });
});

test('buildInvokeParams round-trips arbitrary bytes through base64', () => {
  const commandBytes = Buffer.from('hello mower', 'utf8');
  const params = buildInvokeParams('iot-123', commandBytes);
  assert.equal(Buffer.from(params.args.content, 'base64').toString('utf8'), 'hello mower');
});

test('sendAliyunCloudCommand request targets /thing/service/invoke with apiVer 1.0.5', () => {
  const commandBytes = Buffer.from([0xaa, 0xbb]);
  const request = buildSignedGatewayRequest({
    domain: 'iot-api.example.aliyuncs.com',
    pathname: '/thing/service/invoke',
    apiVer: '1.0.5',
    params: buildInvokeParams('iot-123', commandBytes),
    iotToken: 'token-abc',
    messageId: 'fixed-message-id',
  });

  assert.equal(request.hostname, 'iot-api.example.aliyuncs.com');
  assert.match(request.path, /^\/thing\/service\/invoke\?x-ca-request-id=/);
  assert.equal(request.method, 'POST');

  const body = JSON.parse(request.body);
  assert.equal(body.id, 'fixed-message-id');
  assert.equal(body.version, '1.0');
  assert.equal(body.request.apiVer, '1.0.5');
  assert.equal(body.request.iotToken, 'token-abc');
  assert.equal(body.params.identifier, 'device_protobuf_sync_service');
  assert.equal(body.params.iotId, 'iot-123');
  assert.equal(body.params.args.content, commandBytes.toString('base64'));
});

test('buildSignedGatewayRequest honors an explicit messageId override', () => {
  const request = buildSignedGatewayRequest({
    domain: 'example.aliyuncs.com',
    pathname: '/thing/service/invoke',
    apiVer: '1.0.5',
    params: {},
    messageId: 'my-fixed-id',
  });
  assert.equal(JSON.parse(request.body).id, 'my-fixed-id');
});

test('ALIYUN_INVOKE_CODE documents the codes pymammotion special-cases', () => {
  assert.equal(ALIYUN_INVOKE_CODE.OK, 200);
  assert.equal(ALIYUN_INVOKE_CODE.DEVICE_OFFLINE, 6205);
  assert.equal(ALIYUN_INVOKE_CODE.DEVICE_UNBOUND, 29004);
  assert.equal(ALIYUN_INVOKE_CODE.IDENTITY_BLANK, 29003);
  assert.equal(ALIYUN_INVOKE_CODE.IOT_TOKEN_EXPIRED, 460);
});
