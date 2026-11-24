/**
 * roomMeta.ts — the `room:<roomId>` meta record (plan §15.8).
 *
 * Instance-scoped on purpose: the worker passes the singleton, the execution
 * harness passes an isolated database, and both run the same code (plan §13).
 * The clock lives INSIDE this record — per room, never a global `clock` row,
 * which would serialize every room's mints on one meta record.
 */

import type { OwlshelfDB } from "./db";
import { META_KEYS, type Room } from "./stores";

export function roomMetaKey(roomId: string): string {
  return `${META_KEYS.roomPrefix}${roomId}`;
}

export async function readRoom(db: OwlshelfDB, roomId: string): Promise<Room | undefined> {
  const row = await db.meta.get(roomMetaKey(roomId));
  return (row as unknown as Room) ?? undefined;
}

export async function writeRoom(db: OwlshelfDB, room: Room): Promise<void> {
  await db.meta.put({ key: roomMetaKey(room.roomId), ...room });
}

/** Every `room:` record on this device, in insertion order. */
export async function listRooms(db: OwlshelfDB): Promise<Room[]> {
  const rows = await db.meta.where("key").startsWith(META_KEYS.roomPrefix).toArray();
  return rows.map((row) => row as unknown as Room);
}

// `newRoom` used to live here and built a room with a key but NO `ownerPub` and
// NO anchor. That is a room nobody can ever pair with, and the only reason it
// survived this long is that nothing called it — `createRoom` (rooms.ts) is the
// one legitimate creator and it signs epoch 1 before persisting. Rooms made by
// the broken create path still exist on real devices; `repairRoom` in rooms.ts
// gives them a roster instead of silently refusing to share them.
