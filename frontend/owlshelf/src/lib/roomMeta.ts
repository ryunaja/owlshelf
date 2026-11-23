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

/** A fresh room record. `roomId` IS the profile id (§6.7): a remap that
 *  breaks that orphans the room from its profile. */
export function newRoom(roomId: string, deviceId: string, roomKeyB64: string, now: number): Room {
  return {
    roomId,
    profileId: roomId,
    relayUrl: null,
    keyGen: 1,
    roomKey: roomKeyB64,
    roster: [{ deviceId, role: "owner", addedAt: now }],
    cursorIn: {},
    nextAuthorSeq: 1,
    clock: { ts: 0, counter: 0 },
    migration: "promoted",
    createdAt: now,
  };
}
