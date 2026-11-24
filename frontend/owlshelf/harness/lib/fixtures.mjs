/**
 * fixtures.mjs — room and op builders.
 *
 * Every fixture is explicit about the fields the reducer reads, so a test
 * that changes one field shows exactly what it changed.
 */

import { bytesToB64url } from "../../src/lib/envelope.ts";
import { writeRoom } from "../../src/lib/roomMeta.ts";

export const ROOM_A = "room-a";
export const ROOM_B = "room-b";
export const DEVICE_A = "dev-a";
export const DEVICE_B = "dev-b";

/** A real 32-byte room key. `roomKeyBytes` rejects anything else, so a
 *  fixture with a short key would make every sealing test throw. */
export const ROOM_KEY = bytesToB64url(new Uint8Array(32).fill(7));

/** ROOM_B's key. A different room MUST have a different key — the hash of the
 *  key is the relay's routing address, so two rooms sharing one key would share
 *  one relay room, and (since §9's multiplexing) one membership too. */
export const ROOM_KEY_B = bytesToB64url(new Uint8Array(32).fill(8));

export function makeRoom(overrides = {}) {
  const roomId = overrides.roomId ?? ROOM_A;
  return {
    roomId,
    profileId: roomId,
    relayUrl: null,
    keyGen: 1,
    roomKey: roomId === ROOM_B ? ROOM_KEY_B : ROOM_KEY,
    roster: [{ deviceId: DEVICE_A, role: "owner", addedAt: 0 }],
    cursorIn: {},
    nextAuthorSeq: 1,
    clock: { ts: 0, counter: 0 },
    migration: "promoted",
    createdAt: 0,
    ...overrides,
  };
}

export async function seedRoom(db, overrides = {}) {
  const room = makeRoom(overrides);
  await writeRoom(db, room);
  return room;
}

let opCounter = 0;

export function makeOp(overrides = {}) {
  opCounter += 1;
  return {
    opId: `op-${opCounter}`,
    roomId: ROOM_A,
    deviceId: DEVICE_A,
    authorSeq: 1,
    hlcTs: 1000,
    hlcCounter: 0,
    type: "put",
    table: "items",
    rowId: "item-1",
    payload: { name: "Book", locationId: "loc-1" },
    ...overrides,
  };
}

/** A put payload that passes §15.3 for the given table. */
export function putPayload(table, overrides = {}) {
  if (table === "profiles") {
    return { name: "Shelf", type: "personal", avatarEmoji: "📚", ...overrides };
  }
  if (table === "locations") {
    return { name: "Shelf A", icon: "📦", description: "", ...overrides };
  }
  return { name: "Book", locationId: "loc-1", ...overrides };
}

/** A fixed, monotonic clock for deterministic mints. */
export function fixedClock(start = 1_000_000, step = 1) {
  let value = start;
  return () => {
    const current = value;
    value += step;
    return current;
  };
}

/** A deterministic uuid seam: `u-1`, `u-2`, … */
export function fixedUuid(prefix = "u") {
  let value = 0;
  return () => `${prefix}-${++value}`;
}
