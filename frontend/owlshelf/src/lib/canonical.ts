/**
 * canonical.ts — the ONE encoding rule (plan §15.1, spec-gaps G1).
 *
 * Two correct implementations that sort differently or encode integers
 * differently produce different digests for identical state. The consistency
 * audit then reports divergence on a CONVERGED room, and the repair ladder
 * rebuilds forever. That is the default outcome of an underspecified digest,
 * so every byte below is pinned:
 *
 *   - UTF-8 throughout.
 *   - Strings are length-prefixed: u32 big-endian byte count, then the bytes.
 *   - Integers are fixed-width big-endian (u32/u64 as stated per field).
 *   - Arrays: u32 element count, then elements.
 *   - No whitespace anywhere.
 *   - Fixed field order per structure; where a map is digested, entries are
 *     sorted by key bytes first.
 *
 * The four consumers implemented here are the wire ones. Consumers 5 (control
 * signature) and 6 (export manifest) belong to steps 6 and 7.
 */

import { sha256Hex } from "./hash";
import { parseWinnerKey } from "./reduce";
import { ROW_TABLES, type RowTable } from "./stores";

const encoder = new TextEncoder();

/** The protocol tag that prefixes every signed or sealed structure. */
export const PROTOCOL_TAG = "owlshelf/v1";

// ─── Primitives ────────────────────────────────────────────────────────────

export function utf8(value: string): Uint8Array<ArrayBuffer> {
  return encoder.encode(value);
}

export function u8(value: number): Uint8Array<ArrayBuffer> {
  if (!Number.isInteger(value) || value < 0 || value > 0xff) {
    throw new RangeError(`u8 out of range: ${value}`);
  }
  return Uint8Array.of(value);
}

export function u32be(value: number): Uint8Array<ArrayBuffer> {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new RangeError(`u32 out of range: ${value}`);
  }
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, false);
  return out;
}

export function u64be(value: number | bigint): Uint8Array<ArrayBuffer> {
  const big = typeof value === "bigint" ? value : BigInt(value);
  if (big < 0n || big > 0xffffffffffffffffn) {
    throw new RangeError(`u64 out of range: ${value}`);
  }
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, big, false);
  return out;
}

/** A length-prefixed UTF-8 string: u32 byte count, then the bytes. */
export function lp(value: string): Uint8Array<ArrayBuffer> {
  const bytes = utf8(value);
  return concat(u32be(bytes.length), bytes);
}

export function concat(...parts: Uint8Array<ArrayBuffer>[]): Uint8Array<ArrayBuffer> {
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Byte-order comparison, used wherever the spec says "sorted by key bytes". */
export function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  if (a.length === b.length) return 0;
  return a.length < b.length ? -1 : 1;
}

/**
 * Canonical JSON: UTF-8, keys sorted by code unit, no insignificant
 * whitespace, integers only.
 *
 * Floats are REJECTED rather than rounded. A digest over `1.0` and `1` must
 * not be able to differ, and the only way to guarantee that is to forbid the
 * ambiguous form at the encoder.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isInteger(value)) {
      throw new TypeError(`canonicalJson: floats are not allowed (${value})`);
    }
    return String(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const body = entries
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",");
    return `{${body}}`;
  }
  throw new TypeError(`canonicalJson: unsupported ${typeof value}`);
}

// ─── Consumer 2: AEAD associated data ──────────────────────────────────────

/**
 * `AD = "owlshelf/v1" || 0x00 || roomId || 0x00 || keyGen_be32 || 0x00 || kind`
 *
 * roomId is length-prefixed; kind is the trailing field, so it needs no
 * prefix. This is what makes a cross-room message die at the AEAD tag: the
 * same ciphertext under the same key authenticates differently for a
 * different roomId, keyGen, or kind.
 */
export function associatedData(
  roomId: string,
  keyGen: number,
  kind: string,
): Uint8Array<ArrayBuffer> {
  return concat(
    utf8(PROTOCOL_TAG),
    u8(0),
    lp(roomId),
    u8(0),
    u32be(keyGen),
    u8(0),
    utf8(kind),
  );
}

// ─── Consumer 4: end-marker digest ─────────────────────────────────────────

/**
 * `sha256` over the served opIds in served order, each length-prefixed.
 *
 * Served ORDER, not sorted order: the digest proves the requester received
 * the same sequence the responder sent, so re-sorting would hide a reorder.
 */
export async function endDigest(opIds: readonly string[]): Promise<string> {
  return sha256Hex(concat(...opIds.map((opId) => lp(opId))));
}

// ─── Consumer 3: consistency-audit digest ──────────────────────────────────

export interface AuditRow {
  table: RowTable;
  rowId: string;
  /** The row's `winner` column, or null for a row that never had an op. */
  winner: string | null;
  deletedAt: number | null;
}

const TABLE_ORDER: Record<RowTable, number> = {
  profiles: 0,
  locations: 1,
  items: 2,
};

/**
 * Per room: every visible-or-tombstoned row in table order then rowId byte
 * order, then per-author adopted-op counts sorted by deviceId.
 *
 * Every string is LENGTH-PREFIXED, not NUL-delimited. A `0x00` separator is
 * not injective — a rowId containing a NUL byte would let two different row
 * sets produce the same byte string, which is exactly the ambiguity §15.1
 * exists to prevent. Row ids are UUIDs today, so it was safe, but "safe
 * because of a caller's convention" is not an encoding rule.
 *
 * The counts are not decoration (audit-4 R4-P2-5): a rows-only digest made two
 * devices with different `pending` depths produce identical digests while
 * their derived conflict lists differed. The digest must see the log's shape,
 * not just its rows.
 */
export async function auditDigest(
  rows: readonly AuditRow[],
  counts: Readonly<Record<string, number>>,
): Promise<string> {
  const sorted = [...rows].sort((a, b) => {
    const tableDelta = TABLE_ORDER[a.table] - TABLE_ORDER[b.table];
    if (tableDelta !== 0) return tableDelta;
    return compareBytes(utf8(a.rowId), utf8(b.rowId));
  });

  const parts: Uint8Array<ArrayBuffer>[] = [];
  for (const row of sorted) {
    const order = parseWinnerKey(row.winner);
    if (!order) {
      // A row with no winner cannot be digested: its position in the total
      // order is unknown, so any digest including it would be arbitrary.
      throw new Error(`auditDigest: row ${row.table}/${row.rowId} has no valid winner`);
    }
    parts.push(
      lp(row.table),
      lp(row.rowId),
      u64be(order.ts),
      u32be(order.counter),
      u8(order.rank),
    );
    if (row.deletedAt === null) {
      parts.push(u8(0));
    } else {
      parts.push(u8(1), u64be(row.deletedAt));
    }
  }

  const authors = Object.keys(counts).sort((a, b) =>
    compareBytes(utf8(a), utf8(b)),
  );
  for (const deviceId of authors) {
    parts.push(lp(deviceId), u64be(counts[deviceId]));
  }

  return sha256Hex(concat(...parts));
}

/** The row tables in digest order — exported so callers never re-derive it. */
export const AUDIT_TABLE_ORDER: readonly RowTable[] = ROW_TABLES;

// ─── Consumer 5: control-op signature input (§6.7, step 6) ─────────────────

/**
 * The closed set of control op kinds (plan §6.4).
 *
 * Deliberately THREE. A join request and a leave are not control ops: they
 * carry no authority over the room, so they must not be shaped like something
 * that does. A joiner becomes a member when the OWNER signs an epoch naming it,
 * which is why `roster-epoch` is the only add/remove path there is.
 */
export const CONTROL_KINDS = ["roster-epoch", "rotate-key", "rehome"] as const;
export type ControlKind = (typeof CONTROL_KINDS)[number];

export interface ControlRosterMember {
  deviceId: string;
  role: "owner" | "member";
  addedAt: number;
}

/**
 * The bodies each kind may carry. `rotate-key` carries the GENERATION ONLY —
 * never key material (§6.7 step 2), so a control op can be served from the old
 * room for 30 days without weakening the no-key-grace rule.
 */
export type ControlBody =
  | { kind: "roster-epoch"; epoch: number; members: readonly ControlRosterMember[] }
  | { kind: "rotate-key"; keyGen: number }
  | { kind: "rehome"; relayUrl: string };

/**
 * The exact bytes a control op's signature covers.
 *
 * `"owlshelf/v1" || 0x00 || "control" || 0x00 || lp(kind) || 0x00 ||
 *  lp(roomId) || 0x00 || lp(signerDeviceId) || 0x00 || <kind body>`
 *
 * Four decisions, each of which two implementers would otherwise get wrong:
 *
 *  1. **The signer's deviceId is inside the signed bytes.** The verifier finds
 *     the public key BY that id, so binding it here makes a signature
 *     non-transferable even if a lookup is ever wrong: a signature made by the
 *     owner cannot be presented as made by a member.
 *  2. **The roster is sorted by deviceId BYTES.** A member list is a set; two
 *     implementations that preserve insertion order would produce different
 *     signatures for identical rosters, and one would be rejected as forged.
 *  3. **`epoch` and `keyGen` are u32, not varints.** A varint encoding lets the
 *     same number have two byte forms, which is a signature-malleability bug.
 *  4. **`addedAt` is u64 and REQUIRED.** An optional field would need an
 *     "absent" encoding, and the first implementation to omit it would sign
 *     different bytes than the one that includes it.
 */
export function controlSignatureInput(
  kind: ControlKind,
  roomId: string,
  signerDeviceId: string,
  body: unknown,
): Uint8Array<ArrayBuffer> {
  const head = concat(
    utf8(PROTOCOL_TAG),
    u8(0),
    utf8("control"),
    u8(0),
    lp(kind),
    u8(0),
    lp(roomId),
    u8(0),
    lp(signerDeviceId),
    u8(0),
  );

  if (kind === "rotate-key") {
    const gen = (body as { keyGen?: unknown })?.keyGen;
    if (!Number.isInteger(gen) || (gen as number) < 1) {
      throw new RangeError("controlSignatureInput: rotate-key needs a positive keyGen");
    }
    return concat(head, u32be(gen as number));
  }

  if (kind === "rehome") {
    const url = (body as { relayUrl?: unknown })?.relayUrl;
    if (typeof url !== "string") {
      throw new RangeError("controlSignatureInput: rehome needs a relayUrl");
    }
    return concat(head, lp(url));
  }

  const epoch = (body as { epoch?: unknown })?.epoch;
  if (!Number.isInteger(epoch) || (epoch as number) < 1) {
    throw new RangeError("controlSignatureInput: roster-epoch needs a positive epoch");
  }
  const members = (body as { members?: unknown })?.members;
  if (!Array.isArray(members)) {
    throw new RangeError("controlSignatureInput: roster-epoch needs members");
  }
  const sorted = [...(members as ControlRosterMember[])].sort((a, b) =>
    compareBytes(utf8(a.deviceId), utf8(b.deviceId)),
  );
  const parts: Uint8Array<ArrayBuffer>[] = [head, u32be(epoch as number), u32be(sorted.length)];
  for (const member of sorted) {
    if (member.role !== "owner" && member.role !== "member") {
      throw new RangeError(`controlSignatureInput: bad role ${String(member.role)}`);
    }
    if (!Number.isInteger(member.addedAt) || member.addedAt < 0) {
      throw new RangeError("controlSignatureInput: bad addedAt");
    }
    parts.push(lp(member.deviceId), lp(member.role), u64be(member.addedAt));
  }
  return concat(...parts);
}
