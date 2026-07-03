'use strict';

/** Response shapes for the legacy Aliyun IoT Link Platform handshake, matching pymammotion's
 *  `pymammotion/aliyun/model/*.py` dataclasses field-for-field (camelCase, as sent on the wire). */

export interface AliyunRegionResponse {
  code: number;
  data: {
    shortRegionId: string;
    oaApiGatewayEndpoint: string;
    regionId: string;
    mqttEndpoint: string;
    pushChannelEndpoint: string;
    regionEnglishName: string;
    apiGatewayEndpoint: string;
  };
}

export interface AliyunConnectResponse {
  data: {
    vid: string;
    code: number;
    data: {
      device: { data: { deviceId: string } };
    };
  };
}

export interface AliyunLoginByOAuthResponse {
  data: {
    code: number;
    message?: string;
    data?: {
      loginSuccessResult: { sid: string };
    };
  };
}

export interface AliyunAepResponse {
  code: number;
  data: { deviceSecret: string; productKey: string; deviceName: string };
}

export interface AliyunSessionByAuthCodeResponse {
  code: number;
  data?: { identityId: string; iotToken: string; iotTokenExpire: number };
}

/** One device from /uc/listBindingByAccount — `owned: 1` for owned, `0` for shared-to-you. */
export interface AliyunAccountDevice {
  deviceName: string;
  productKey: string;
  productName?: string;
  iotId: string;
  owned: number;
  nickName?: string | null;
}

export interface AliyunListingDevAccountResponse {
  code: number;
  data: { total: number; data: AliyunAccountDevice[] } | null;
}

/** One entry from /uc/getShareNoticeList — status 0=accepted, -1=pending, 3=expired. */
export interface AliyunShareNotification {
  deviceName: string;
  productName?: string;
  recordId: string;
  batchId: string;
  isReceiver: number;
  status: number;
}

export interface AliyunShareNoticeListResponse {
  code: number;
  data: { total: number; data: AliyunShareNotification[] } | null;
}
