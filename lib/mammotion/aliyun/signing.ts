'use strict';

import { createHash, createHmac } from 'crypto';

/**
 * Alibaba Cloud API Gateway "CA signature" scheme — ported line-for-line from the
 * `alibabacloud-apigateway-util` Python package (the same one pymammotion depends on for
 * its Aliyun IoT Link Platform calls). This is NOT the OAuth/HMAC scheme MammotionAuth.ts
 * uses for Mammotion's own cloud — it's a separate, older Alibaba Cloud product's signing
 * convention. Do not "clean up" the header-canonicalization order below; every byte of it
 * is dictated by what the Aliyun server recomputes and compares against.
 */

/** Headers excluded from the canonical signed-header block (handled positionally instead). */
const MOVE_HEADERS = new Set([
  'x-ca-signature', 'x-ca-signature-headers', 'accept', 'content-md5',
  'content-type', 'date', 'host', 'token', 'user-agent',
]);

/** Base64(MD5(body)) — empty string for a bodyless request. Matches `get_content_md5`. */
export function getContentMd5(body: string): string {
  if (!body) return '';
  return createHash('md5').update(body, 'utf8').digest('base64');
}

/**
 * Computes the `x-ca-signature` header value and, as a side effect, the
 * `x-ca-signature-headers` value the caller must also send. Mutates nothing — returns both
 * so the caller applies them explicitly (mirrors the Python original returning just the
 * signature and mutating request.headers directly; the header-list value is deterministic
 * from the same input so callers can present it however they want).
 */
export function getCaSignature(opts: {
  method: string;
  pathname: string;
  /** All headers that will be sent, EXCLUDING x-ca-signature/x-ca-signature-headers. */
  headers: Record<string, string>;
  /** Query params to append to pathname, in insertion order (Aliyun does not sort these). */
  query?: Record<string, string>;
  secret: string;
}): { signature: string; signatureHeaders: string } {
  const {
    method, pathname, headers, query, secret,
  } = opts;

  const accept = headers.accept ?? '';
  const contentMd5 = headers['content-md5'] ?? '';
  const contentType = headers['content-type'] ?? '';
  const date = headers.date ?? '';

  const signedKeys = Object.keys(headers)
    .filter((k) => !MOVE_HEADERS.has(k.toLowerCase()))
    .sort();
  const signatureHeaders = signedKeys.join(',');
  const headerBlock = signedKeys.map((k) => `${k}:${headers[k] ?? ''}`).join('\n');

  let url = pathname;
  if (query && Object.keys(query).length > 0) {
    const qs = Object.entries(query).map(([k, v]) => `${k}=${v}`).join('&');
    url += `?${qs}`;
  }

  const stringToSign = `${method}\n${accept}\n${contentMd5}\n${contentType}\n${date}\n${headerBlock}\n${url}`;
  const signature = createHmac('sha256', secret).update(stringToSign, 'utf8').digest('base64');
  return { signature, signatureHeaders };
}

/** RFC 1123 date string (e.g. "Fri, 03 Jul 2026 10:00:00 GMT"), matching Python's
 *  `UtilClient.get_date_utcstring()` — JS's own toUTCString() already produces this format. */
export function getDateUtcString(): string {
  return new Date().toUTCString();
}

/** A short random nonce, matching the shape (not cryptographic strength requirements) of
 *  Python's `UtilClient.get_nonce()` — Aliyun only requires request-scoped uniqueness. */
export function getNonce(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
