'use strict';

/**
 * Country code → Aliyun region id, used ONLY as a fallback when the dynamic
 * `/living/account/region/get` lookup can't be reached at all (network-level failure, not
 * a reachable-but-erroring response — see getRegion() in AliyunLegacyProbe.ts). Ported from
 * pymammotion's `pymammotion/aliyun/regions.py` region_mappings table, since that's the same
 * fallback logic pymammotion itself uses for this exact case.
 *
 * pymammotion's table is not exhaustive — this app has Homey users across all 13 supported
 * locales/languages, several of which (the Nordics in particular) were missing from their
 * table entirely and would have silently fallen back to "US" (us-east-1), which is very
 * unlikely to be the account's real Aliyun region. Extended here to cover the rest of the
 * EU/Nordic countries this app ships in, following the same eu-central-1 grouping pymammotion
 * already uses for DE/FR/IT/ES/GB/IE/NL/BE/CH/AT/PL.
 *
 * Countries genuinely missing from this table are NOT silently guessed — getRegion() logs the
 * unmapped code so real diagnostic reports tell us which region to add next, rather than us
 * inventing entries we can't verify.
 */
export const ALIYUN_REGION_MAPPINGS: Record<string, string> = {
  // Asia Pacific
  CN: 'cn-hongkong',
  HK: 'cn-hongkong',
  TW: 'cn-hongkong',
  MO: 'cn-hongkong',
  // Southeast Asia
  SG: 'ap-southeast-1',
  MY: 'ap-southeast-3',
  ID: 'ap-southeast-5',
  TH: 'ap-southeast-1',
  VN: 'ap-southeast-1',
  PH: 'ap-southeast-1',
  BN: 'ap-southeast-1',
  KH: 'ap-southeast-1',
  LA: 'ap-southeast-1',
  MM: 'ap-southeast-1',
  // Australia/Oceania
  AU: 'ap-southeast-2',
  NZ: 'ap-southeast-2',
  FJ: 'ap-southeast-2',
  PG: 'ap-southeast-2',
  // South Asia
  IN: 'ap-south-1',
  LK: 'ap-south-1',
  PK: 'ap-south-1',
  BD: 'ap-south-1',
  NP: 'ap-south-1',
  BT: 'ap-south-1',
  MV: 'ap-south-1',
  // Middle East
  AE: 'me-east-1',
  SA: 'me-east-1',
  QA: 'me-east-1',
  KW: 'me-east-1',
  BH: 'me-east-1',
  OM: 'me-east-1',
  IL: 'me-east-1',
  TR: 'me-east-1',
  // Europe (pymammotion's original entries)
  DE: 'eu-central-1',
  FR: 'eu-central-1',
  IT: 'eu-central-1',
  ES: 'eu-central-1',
  GB: 'eu-central-1',
  IE: 'eu-central-1',
  NL: 'eu-central-1',
  BE: 'eu-central-1',
  CH: 'eu-central-1',
  AT: 'eu-central-1',
  PL: 'eu-central-1',
  // Europe/Nordics — added for this app's supported locales, not in pymammotion's table.
  // Unverified against a real dynamic lookup for these specific countries; logged as
  // "mapped" (not "unmapped/defaulted") so a wrong guess here is still visible in reports.
  SE: 'eu-central-1',
  NO: 'eu-central-1',
  DK: 'eu-central-1',
  FI: 'eu-central-1',
  IS: 'eu-central-1',
  RU: 'eu-central-1',
  // North America
  US: 'us-east-1',
  CA: 'us-east-1',
  MX: 'us-west-1',
  // South America
  BR: 'us-east-1',
  AR: 'us-east-1',
  CL: 'us-east-1',
  CO: 'us-east-1',
  PE: 'us-east-1',
};

/** Default region for a country code with no table entry at all — matches pymammotion's own
 *  `.get(country_code, "US")` default. Genuinely unmapped codes are logged by the caller so
 *  we can add a real entry once we see which country actually needed it. */
export const ALIYUN_DEFAULT_REGION = 'us-east-1';
