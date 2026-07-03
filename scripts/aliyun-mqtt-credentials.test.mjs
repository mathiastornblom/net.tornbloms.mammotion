import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

import { deriveAliyunMqttCredentials } from '../.homeybuild/lib/mammotion/aliyun/AliyunMqttTransport.js';

// Locks the Aliyun IoT MQTT credential-derivation algorithm against silent regression and
// checks it matches pymammotion's AliyunMQTTTransport._build_credentials exactly (HMAC-SHA1
// hex digest of "clientId{base}deviceName{name}productKey{key}timestamp{ts}", keyed by the
// account's deviceSecret). Deterministic and self-checkable without a live server — same
// spirit as scripts/aliyun-signing.test.mjs for the CA-signature scheme.

const CONFIG = {
  productKey: 'a1dCWYFLROK',
  deviceName: 'MammotionAccount123',
  deviceSecret: 'super-secret-value',
};

test('deriveAliyunMqttCredentials builds username as {deviceName}&{productKey}', () => {
  const { username } = deriveAliyunMqttCredentials(CONFIG, 1751500000);
  assert.equal(username, 'MammotionAccount123&a1dCWYFLROK');
});

test('deriveAliyunMqttCredentials embeds the timestamp in the clientId suffix', () => {
  const { clientId } = deriveAliyunMqttCredentials(CONFIG, 1751500000);
  assert.equal(
    clientId,
    'a1dCWYFLROK&MammotionAccount123|securemode=2,signmethod=hmacsha1,ext=1,_ss=1,timestamp=1751500000|',
  );
});

test('deriveAliyunMqttCredentials password matches the documented HMAC-SHA1 sign_content', () => {
  const timestamp = 1751500000;
  const { password } = deriveAliyunMqttCredentials(CONFIG, timestamp);

  const clientIdBase = `${CONFIG.productKey}&${CONFIG.deviceName}`;
  const signContent = `clientId${clientIdBase}deviceName${CONFIG.deviceName}productKey${CONFIG.productKey}timestamp${timestamp}`;
  const expected = createHmac('sha1', CONFIG.deviceSecret).update(signContent, 'utf8').digest('hex');

  assert.equal(password, expected);
});

test('deriveAliyunMqttCredentials is deterministic for identical input', () => {
  const a = deriveAliyunMqttCredentials(CONFIG, 1751500000);
  const b = deriveAliyunMqttCredentials(CONFIG, 1751500000);
  assert.deepEqual(a, b);
});

test('deriveAliyunMqttCredentials produces a different password for a different timestamp', () => {
  const a = deriveAliyunMqttCredentials(CONFIG, 1751500000);
  const b = deriveAliyunMqttCredentials(CONFIG, 1751500001);
  assert.notEqual(a.password, b.password);
  assert.notEqual(a.clientId, b.clientId);
});
