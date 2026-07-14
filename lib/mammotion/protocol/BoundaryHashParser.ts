/**
 * Parses the two response messages behind the unnamed-zone boundary-discovery fallback
 * (see docs/ZONE_BOUNDARY_FALLBACK_PLAN.md): the raw root hash manifest
 * (`MctlNav.toapp_gethash_ack`, a reply to `LubaCommands.buildGetBoundaryHashListCommand`)
 * and the per-hash type classification (`MctlNav.toapp_get_commondata_ack`, a reply to
 * `buildSynchronizeHashDataCommand`). Both are distinct from `AreaNameParser.ts`'s
 * `toapp_all_hash_name`, which is a naming *overlay* only — an empty named list does not
 * mean the device has no zones (that's the whole premise of this fallback).
 *
 * Hashes stay decimal strings end-to-end here too (see AreaNameParser.ts's doc comment) —
 * the same fixed64/int64 precision-loss risk applies to `dataCouple` and `Hash`.
 */
import type { AreaHashName } from './AreaNameParser.js';

/** One frame of the root hash-list response (`NavGetHashListAck`), pre-filtered to
 *  `subCmd === 0` — the root boundary/obstacle/path list. `subCmd === 3` is an unrelated
 *  "line hash" mechanism (MowPathSaga's cover-path fetch) that must never be mistaken for
 *  this one — see the plan doc's protocol notes. */
export interface RootHashListFrame {
  subCmd: number;
  totalFrame: number;
  currentFrame: number;
  /** Root hashes carried by this frame, as decimal strings (fixed64/int64 on the wire). */
  dataCouple: string[];
}

/** Returns null if the message isn't a `subCmd === 0` root hash-list response. */
export function extractRootHashList(msg: Record<string, unknown>): RootHashListFrame | null {
  const nav = msg.nav as Record<string, unknown> | undefined;
  const ack = nav?.toappGethashAck as Record<string, unknown> | undefined;
  if (!ack) return null;
  const subCmd = typeof ack.subCmd === 'number' ? ack.subCmd : 0;
  // sub_cmd=3 is MowPathSaga's line-hash list (cover-path fetch), a completely different
  // mechanism from the root boundary/obstacle/path manifest — never treat it as the root list.
  if (subCmd !== 0) return null;
  const dataCouple = Array.isArray(ack.dataCouple) ? ack.dataCouple.map((h) => String(h)) : [];
  return {
    subCmd,
    totalFrame: typeof ack.totalFrame === 'number' ? ack.totalFrame : 0,
    currentFrame: typeof ack.currentFrame === 'number' ? ack.currentFrame : 0,
    dataCouple,
  };
}

/** One frame of the per-hash classification response (`NavGetCommDataAck`). `type` is a
 *  `PathType` enum value — only `0` (AREA) is a mowable zone; every other value (obstacle,
 *  path, no-go zone, etc.) must never be fed into a route-generation command. */
export interface CommDataAckFrame {
  /** The classified hash, as a decimal string. NOTE: this response field is capitalized
   *  `Hash` (fixed64) on the wire, unlike the lowercase `hash` (int64) request field. */
  hash: string;
  type: number;
  action: number;
  totalFrame: number;
  currentFrame: number;
}

/** Returns null if the message isn't a per-hash classification response. */
export function extractCommDataAck(msg: Record<string, unknown>): CommDataAckFrame | null {
  const nav = msg.nav as Record<string, unknown> | undefined;
  const ack = nav?.toappGetCommondataAck as Record<string, unknown> | undefined;
  if (!ack) return null;
  return {
    hash: String(ack.Hash ?? '0'),
    type: typeof ack.type === 'number' ? ack.type : -1,
    action: typeof ack.action === 'number' ? ack.action : 0,
    totalFrame: typeof ack.totalFrame === 'number' ? ack.totalFrame : 0,
    currentFrame: typeof ack.currentFrame === 'number' ? ack.currentFrame : 0,
  };
}

/**
 * Synthesizes "Area 1", "Area 2", ... display names for discovered-but-unnamed AREA hashes
 * (LubaDevice.requestBoundaryZoneDiscovery's classification result), matching pymammotion's
 * own `f"area {i + 1}"` fallback naming (`map_saga.py:326`) used whenever the named list came
 * back empty but area hashes were fetched anyway.
 *
 * Sorts numerically via BigInt comparison, not a plain string/lexical sort — fixed64 hashes
 * routinely exceed Number.MAX_SAFE_INTEGER, and a lexical sort would order "10" before "9".
 * Deduplicates exact-duplicate hashes defensively (the root list is not expected to repeat
 * a hash, but a probe re-run after a partial timeout could).
 */
export function synthesizeAreaZoneNames(hashes: string[]): AreaHashName[] {
  const sorted = [...new Set(hashes)].sort((a, b) => {
    const diff = BigInt(a) - BigInt(b);
    if (diff < 0n) return -1;
    if (diff > 0n) return 1;
    return 0;
  });
  return sorted.map((hash, i) => ({ hash, name: `Area ${i + 1}` }));
}
