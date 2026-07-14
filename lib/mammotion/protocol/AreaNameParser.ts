/**
 * Parses the zone hash/name enumeration response (MctlNav.toapp_all_hash_name, a reply to
 * LubaCommands.buildGetAreaNameListCommand's read request on the same NavMapNameMsg channel).
 *
 * Confirmed against pymammotion's `get_area_name_list`/`AppGetAllAreaHashName`
 * (mammotion/commands/messages/navigation.py, proto/__init__.py): the device replies with a
 * flat list of `{hash, name}` pairs covering every zone/area it currently has stored — this is
 * how the official app populates its zone picker, and how `async_plan_route` resolves "mow
 * everything" (defaults to every hash in this list) when the user doesn't pick specific zones.
 *
 * Hashes are fixed64 and MUST stay strings end-to-end (see Codec.ts's decodeLubaMsg doc
 * comment) — a zone hash sent back to the device with even one bit of precision lost from
 * JS-number rounding would reference the wrong zone or none at all.
 */
export interface AreaHashName {
  hash: string;
  name: string;
}

/** Returns null if the message isn't a zone-enumeration response. */
export function extractAreaHashNames(msg: Record<string, unknown>): AreaHashName[] | null {
  const nav = msg.nav as Record<string, unknown> | undefined;
  const allHashName = nav?.toappAllHashName as Record<string, unknown> | undefined;
  const hashnames = allHashName?.hashnames;
  if (!Array.isArray(hashnames)) return null;

  return hashnames
    .filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null)
    .map((entry) => ({
      hash: String(entry.hash ?? ''),
      name: typeof entry.name === 'string' ? entry.name : '',
    }))
    .filter((entry) => entry.hash !== '' && entry.hash !== '0');
}
