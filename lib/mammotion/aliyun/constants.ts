'use strict';

/**
 * Constants for the legacy Alibaba Cloud IoT Link Platform handshake — the "pre-2025 device"
 * path some Mammotion accounts still use, separate from and unrelated to this app's primary
 * MammotionAuth (Aliyun IoT Link is a different cloud product with its own signed-request
 * scheme). See lib/mammotion/aliyun/README.md for why this exists and what it does and does
 * not do. Values match pymammotion's `pymammotion/const.py` — these are the shared "app"
 * credentials embedded in the Mammotion mobile app itself, not per-user secrets.
 */
export const ALIYUN_APP_KEY = '34231230';
export const ALIYUN_APP_SECRET = '1ba85698bb10e19c6437413b61ba3445';
export const ALIYUN_DOMAIN = 'api.link.aliyun.com';
/** Hardcoded domain for the `connect` step only — not region-routed like the others. */
export const ALIYUN_CONNECT_DOMAIN = 'sdk.openaccount.aliyun.com';
/** Mirrors the Mammotion Android app version string pymammotion pins its requests to. */
export const ALIYUN_APP_VERSION = '2.3.8.19';
export const ALIYUN_SDK_VERSION = '3.4.2';
