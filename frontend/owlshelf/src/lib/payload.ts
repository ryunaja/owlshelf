/**
 * payload.ts — per-table payload validation (plan §15.3, spec-gaps G3).
 *
 * The reducer writes payload fields FLAT onto rows that also carry
 * reducer-owned columns. Without an allowlist, an inbound
 * `payload: { winner: [...], deletedAt: 0 }` overwrites them and the total
 * order for that row becomes attacker-chosen. So:
 *
 *  1. Unknown fields are DROPPED, not rejected — rejecting freezes the
 *     author's cursor (R4-P0-1); dropping keeps the op adoptable while the
 *     schema evolves.
 *  2. `winner`, `deletedAt`, `id`, and `profileId` are never payload-writable.
 *  3. Client-side max payload is 64 KB (the relay's 512 KB is a transport
 *     bound, not a data bound).
 *
 * The absent-field defaults are version tolerance, not looseness: the app's
 * own mint path writes every field, so a full payload is the normal case and
 * the defaults only exist so a peer running an older schema converges instead
 * of quarantining. The one thing never normalized is an empty `name` on an
 * inbound put — silence-normalization would sync garbage rows everywhere.
 */

import type { OpType, RowTable } from "./stores";

export const MAX_PAYLOAD_BYTES = 64 * 1024;

export type PayloadReject = "bad-type";

export type NormalizedPayload =
  | { ok: true; type: "put"; value: Record<string, unknown> }
  | { ok: true; type: "delete" }
  | { ok: true; type: "resolve"; keep: "row"; content: Record<string, unknown> }
  | { ok: true; type: "resolve"; keep: "tombstone" }
  | { ok: false; reason: PayloadReject };

export interface NormalizeOptions {
  /** `mint` applies the app's own defaults (an empty item name becomes
   *  "Untitled"); `receive` treats the same input as malformed. */
  side?: "mint" | "receive";
}

/** Reducer-owned columns: never accepted from a payload. */
const RESERVED = new Set(["id", "profileId", "winner", "deletedAt"]);

const ITEM_NAME_MAX = 200;
const TEXT_MAX = 2000;
const CATEGORY_MAX = 100;
const ITEM_TYPE_MAX = 64;
const TAG_MAX = 64;
const TAG_COUNT_MAX = 32;
const STOCK_MAX = 1_000_000;
const PROFILE_NAME_MAX = 100;
const LOCATION_NAME_MAX = 100;
const LOCATION_DESCRIPTION_MAX = 500;
const EMOJI_MAX = 16;
const ID_MAX = 200;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Absent → fallback; wrong type or too long → null (malformed). */
function optionalString(value: unknown, max: number, fallback: string): string | null {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "string" || value.length > max) return null;
  return value;
}

/** Required, non-empty after trimming, bounded. */
function requiredName(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  if (value.trim().length === 0 || value.length > max) return null;
  return value;
}

function optionalInteger(value: unknown, min: number, max: number, fallback: number): number | null {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value)) return null;
  if (value < min || value > max) return null;
  return value;
}

function optionalTags(value: unknown): string[] | null {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > TAG_COUNT_MAX) return null;
  const out: string[] = [];
  for (const tag of value) {
    if (typeof tag !== "string" || tag.length > TAG_MAX) return null;
    out.push(tag);
  }
  return out;
}

function optionalImageUrl(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") return null;
  if (!/^(idb:|data:|https:)/.test(value)) return null;
  return value;
}

function optionalId(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > ID_MAX) return null;
  return value;
}

function normalizeItem(payload: Record<string, unknown>, side: "mint" | "receive"): Record<string, unknown> | null {
  let name = requiredName(payload.name, ITEM_NAME_MAX);
  if (name === null && side === "mint" && (payload.name === undefined || payload.name === null || payload.name === "")) {
    name = "Untitled";
  }
  if (name === null) return null;

  const subtitle = optionalString(payload.subtitle, ITEM_NAME_MAX, "");
  const description = optionalString(payload.description, TEXT_MAX, "");
  const category = optionalString(payload.category, CATEGORY_MAX, "Uncategorized");
  const itemType = optionalString(payload.itemType, ITEM_TYPE_MAX, "other");
  const stock = optionalInteger(payload.stock, 0, STOCK_MAX, 1);
  const condition = optionalInteger(payload.condition, 1, 5, 3);
  const tags = optionalTags(payload.tags);
  const locationId = optionalId(payload.locationId);
  const imageUrl = optionalImageUrl(payload.imageUrl);

  if (
    subtitle === null ||
    description === null ||
    category === null ||
    itemType === null ||
    stock === null ||
    condition === null ||
    tags === null ||
    locationId === null ||
    imageUrl === null
  ) {
    return null;
  }

  const value: Record<string, unknown> = {
    name,
    subtitle,
    description,
    category,
    itemType,
    stock,
    condition,
    tags,
    locationId,
  };
  if (imageUrl !== undefined) value.imageUrl = imageUrl;
  return value;
}

function normalizeProfile(payload: Record<string, unknown>): Record<string, unknown> | null {
  const name = requiredName(payload.name, PROFILE_NAME_MAX);
  const type = payload.type;
  const avatarEmoji = optionalString(payload.avatarEmoji, EMOJI_MAX, "");
  if (name === null || avatarEmoji === null) return null;
  if (type !== "personal" && type !== "business") return null;
  return { name, type, avatarEmoji };
}

function normalizeLocation(payload: Record<string, unknown>): Record<string, unknown> | null {
  const name = requiredName(payload.name, LOCATION_NAME_MAX);
  const icon = optionalString(payload.icon, EMOJI_MAX, "");
  const description = optionalString(payload.description, LOCATION_DESCRIPTION_MAX, "");
  if (name === null || icon === null || description === null) return null;
  // `itemCount` is deliberately absent: it is the denormalized counter being
  // removed (§6.5 delta 4). A payload carrying it has the field dropped.
  return { name, icon, description };
}

function normalizeRow(table: RowTable, payload: unknown, side: "mint" | "receive"): Record<string, unknown> | null {
  if (!isPlainObject(payload)) return null;
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (RESERVED.has(key)) continue;
    clean[key] = value;
  }
  if (table === "items") return normalizeItem(clean, side);
  if (table === "profiles") return normalizeProfile(clean);
  return normalizeLocation(clean);
}

function withinByteCap(value: Record<string, unknown>): boolean {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).length <= MAX_PAYLOAD_BYTES;
  } catch {
    return false;
  }
}

/**
 * Validate and normalize one op payload.
 *
 * A `resolve` keeping the row REQUIRES replacement content — a resolve
 * without content once wiped the row (audit-2 N11, executed) — so it is
 * rejected here, before any write.
 */
export function normalizePayload(
  table: RowTable,
  type: OpType,
  payload: unknown,
  options: NormalizeOptions = {},
): NormalizedPayload {
  const side = options.side ?? "receive";

  if (type === "delete") return { ok: true, type: "delete" };

  if (type === "resolve") {
    if (!isPlainObject(payload)) return { ok: false, reason: "bad-type" };
    const keep = payload.keep;
    if (keep === "tombstone") return { ok: true, type: "resolve", keep: "tombstone" };
    if (keep !== "row") return { ok: false, reason: "bad-type" };
    const content = normalizeRow(table, payload.content, side);
    if (content === null || !withinByteCap(content)) return { ok: false, reason: "bad-type" };
    return { ok: true, type: "resolve", keep: "row", content };
  }

  const value = normalizeRow(table, payload, side);
  if (value === null || !withinByteCap(value)) return { ok: false, reason: "bad-type" };
  return { ok: true, type: "put", value };
}

// ─── Narrowed entry points ─────────────────────────────────────────────────

// `normalizePayload` takes a dynamic op type (the reducer's case), so its
// result is the full union. Call sites that KNOW the type use these instead
// and get a precise result without a cast.

export type PutPayload =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; reason: PayloadReject };

export type ResolvePayload =
  | { ok: true; keep: "row"; content: Record<string, unknown> }
  | { ok: true; keep: "tombstone" }
  | { ok: false; reason: PayloadReject };

/** The rejection branch is a distinct shape, and saying so explicitly keeps
 *  these entry points independent of how a given checker narrows a negated
 *  boolean discriminant — `if (!result.ok) return result` is correct, but it
 *  reads as "return the whole union" to some language servers. */
function isRejected(result: NormalizedPayload): result is { ok: false; reason: PayloadReject } {
  return result.ok === false;
}

export function normalizePutPayload(
  table: RowTable,
  payload: unknown,
  options: NormalizeOptions = {},
): PutPayload {
  const result = normalizePayload(table, "put", payload, options);
  if (isRejected(result)) return { ok: false, reason: result.reason };
  if (result.type !== "put") return { ok: false, reason: "bad-type" };
  return { ok: true, value: result.value };
}

export function normalizeResolvePayload(
  table: RowTable,
  payload: unknown,
  options: NormalizeOptions = {},
): ResolvePayload {
  const result = normalizePayload(table, "resolve", payload, options);
  if (isRejected(result)) return { ok: false, reason: result.reason };
  if (result.type !== "resolve") return { ok: false, reason: "bad-type" };
  return result.keep === "row"
    ? { ok: true, keep: "row", content: result.content }
    : { ok: true, keep: "tombstone" };
}
