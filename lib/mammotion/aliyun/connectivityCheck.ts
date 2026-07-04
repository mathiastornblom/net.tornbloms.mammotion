'use strict';

import { connect as tlsConnect } from 'tls';

/**
 * Raw TLS reachability check against the legacy Aliyun handshake's fixed entry point,
 * independent of the full 6-step OAuth handshake in AliyunLegacyProbe.ts. Diagnostic-only:
 * a real user's Homey hub repeatedly failed that handshake with ETIMEDOUT/ENETUNREACH while
 * the same account reached it fine from a different network — this isolates whether it's a
 * genuine network-path problem (and how long it takes to fail: a silent multi-second OS
 * timeout points at a dropped-packet block, a near-instant failure points at an active
 * reset/reject) from anything handshake-logic-specific.
 */
export const ALIYUN_CONNECTIVITY_CHECK_TIMEOUT_MS = 5000;

export async function checkAliyunConnectivity(
  host: string,
  port = 443,
  timeoutMs = ALIYUN_CONNECTIVITY_CHECK_TIMEOUT_MS,
): Promise<string> {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    const socket = tlsConnect({
      host, port, timeout: timeoutMs, servername: host,
    });
    const finish = (result: string) => {
      socket.destroy();
      resolve(`${result} after ${Date.now() - startedAt}ms`);
    };
    socket.once('secureConnect', () => finish('OK'));
    socket.once('timeout', () => finish('TIMEOUT'));
    socket.once('error', (err: Error & { code?: string }) => finish(`FAILED (${err.code ?? err.message})`));
  });
}
