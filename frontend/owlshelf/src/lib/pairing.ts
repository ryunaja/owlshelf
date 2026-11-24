/**
 * pairing.ts — the QR join fragment (plan §6.7, §15.10, audit-2 N4).
 *
 * ONE minter for create AND re-pair. The fragment carries roomId, relayUrl, the
 * CURRENT keyGen, the room key, and the pinned roster anchor (owner pubkey +
 * owner-signed epoch 1) — everything a joiner needs to join AND to verify
 * ownership, and none of it ever reaches a server.
 *
 * ```
 * owlshelf://join?v=1&r=<roomId>&u=<b64url relayUrl>&g=<keyGen>
 *                &k=<b64url 32B roomKey>&o=<b64url owner Ed25519 pubkey>
 *                &s=<b64url signed epoch-1 roster>
 * ```
 *
 * Three fields are load-bearing and each was a real audit finding:
 *
 *  - **`g` travels WITH the key** (review-2 P0-1). After a rotation the room
 *    runs gen 2+, and a re-pair fragment that omits the generation leaves the
 *    joiner sending gen-1 envelopes the owner drops. The generation is never
 *    hardcoded at the join site.
 *  - **`o` + `s` are the trust anchor** (review-2 P0-2). Without a pinned
 *    epoch-1, the joiner accepted whatever roster epoch it saw first, so any
 *    member holding the room key could claim ownership.
 *  - **`s` is signed over SORTED members** (`roster.ts`), so the anchor's bytes
 *    are identical on every device that stores it.
 *
 * ── Refusals are a closed set, not thrown strings ─────────────────────────
 *
 * `parseJoinFragment` returns a typed refusal reason. A caller that renders
 * `String(error)` for a hostile input is one bug away from showing an attacker's
 * text, and the UI needs distinct copy per reason anyway.
 */

import { canonicalJson } from "./canonical";
import { KEY_BYTES, roomKeyBytes } from "./envelope";
import { PUBLIC_KEY_BYTES, b64urlToBytes, bytesToB64url } from "./keys";
import { sortMembers, type SignedEpoch } from "./roster";
import type { Room, RosterMember } from "./stores";

export const JOIN_SCHEME = "owlshelf:";
export const JOIN_HOST = "join";
export const JOIN_VERSION = 1;
const ROOM_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

// The vocabulary lives in a dependency-free module so a tab can render the copy
// without pulling WebCrypto and the canonical encoder into the page bundle.
import type { JoinReject, MintReject } from "./pairingErrors";
export type { JoinReject } from "./pairingErrors";
export { JOIN_REJECT_COPY, MINT_REJECT_COPY } from "./pairingErrors";

export interface JoinFragment {
  roomId: string;
  relayUrl: string;
  keyGen: number;
  roomKey: string;
  ownerPub: string;
  anchor: SignedEpoch;
}

export type ParseResult =
  | { ok: true; fragment: JoinFragment }
  | { ok: false; reason: JoinReject };

// ─── Mint ──────────────────────────────────────────────────────────────────

export type MintResult = { ok: true; fragment: string } | { ok: false; reason: MintReject };

/**
 * Mint the fragment from a STORED room.
 *
 * Takes the room record, not loose arguments, so a caller cannot pass a roomId
 * and forget the anchor: the pass-4 regression was exactly that — create
 * referencing an unbound room and an undefined anchor, so pairing could not run
 * at all. Every missing piece is a named refusal here.
 */
export function mintJoinFragment(room: Room): MintResult {
  if (!ROOM_ID_PATTERN.test(room.roomId)) return { ok: false, reason: "mint-bad-id" };
  if (typeof room.relayUrl !== "string" || room.relayUrl.trim() === "") {
    return { ok: false, reason: "mint-no-relay" };
  }
  if (!Number.isInteger(room.keyGen) || room.keyGen < 1) {
    return { ok: false, reason: "mint-bad-gen" };
  }
  let keyBytes: Uint8Array<ArrayBuffer>;
  try {
    keyBytes = roomKeyBytes(room.roomKey);
  } catch {
    return { ok: false, reason: "mint-bad-key" };
  }
  if (keyBytes.length !== KEY_BYTES) return { ok: false, reason: "mint-bad-key" };
  if (typeof room.ownerPub !== "string") {
    return { ok: false, reason: "mint-no-owner" };
  }
  let ownerBytes: Uint8Array<ArrayBuffer>;
  try {
    ownerBytes = b64urlToBytes(room.ownerPub);
  } catch {
    return { ok: false, reason: "mint-bad-owner" };
  }
  if (ownerBytes.length !== PUBLIC_KEY_BYTES) {
    return { ok: false, reason: "mint-bad-owner" };
  }
  const anchor = room.rosterAnchor;
  if (!anchor || anchor.epoch !== 1 || anchor.members.length === 0) {
    return { ok: false, reason: "mint-no-anchor" };
  }

  const params = new URLSearchParams();
  params.set("v", String(JOIN_VERSION));
  params.set("r", room.roomId);
  params.set("u", bytesToB64url(new TextEncoder().encode(room.relayUrl.trim())));
  params.set("g", String(room.keyGen));
  params.set("k", room.roomKey);
  params.set("o", room.ownerPub);
  params.set(
    "s",
    bytesToB64url(
      new TextEncoder().encode(
        canonicalJson({ epoch: 1, members: sortMembers(anchor.members), sig: anchor.sig }),
      ),
    ),
  );

  return {
    ok: true,
    fragment: `${JOIN_SCHEME}//${JOIN_HOST}?${params.toString()}`,
  };
}

// ─── Parse ─────────────────────────────────────────────────────────────────

function refuse(reason: JoinReject): ParseResult {
  return { ok: false, reason };
}

/**
 * Parse and validate a scanned/pasted fragment.
 *
 * Order matters: cheap shape checks before decoding, and every decode is
 * wrapped, so a hostile string can only ever produce a refusal.
 */
export function parseJoinFragment(text: string): ParseResult {
  const trimmed = text.trim();
  if (trimmed === "") return refuse("not-a-fragment");

  // A scanner may hand back `owlshelf:join?...` without the slashes, and
  // `new URL` reads that as pathname `join`. Normalise rather than guess.
  const normalised = trimmed.startsWith(`${JOIN_SCHEME}//`)
    ? trimmed
    : `${JOIN_SCHEME}//${trimmed.slice(JOIN_SCHEME.length).replace(/^\/+/, "")}`;

  let url: URL;
  try {
    url = new URL(normalised);
  } catch {
    return refuse("not-a-fragment");
  }
  if (url.protocol !== JOIN_SCHEME) return refuse("not-a-fragment");
  if (url.host !== JOIN_HOST) return refuse("not-a-fragment");

  // Duplicates are refused, not last-wins: two parsers that pick different
  // occurrences of `k` disagree about which key the room uses, and only one of
  // them is talking to the real room.
  const seen = new Set<string>();
  for (const key of url.searchParams.keys()) {
    if (seen.has(key)) return refuse("duplicate-param");
    seen.add(key);
  }

  const version = url.searchParams.get("v");
  if (version !== String(JOIN_VERSION)) return refuse(version === null ? "missing-param" : "bad-version");

  const roomId = url.searchParams.get("r");
  if (roomId === null) return refuse("missing-param");
  if (!ROOM_ID_PATTERN.test(roomId)) return refuse("bad-room-id");

  const relayRaw = url.searchParams.get("u");
  if (relayRaw === null) return refuse("missing-param");
  let relayUrl: string;
  try {
    relayUrl = new TextDecoder().decode(b64urlToBytes(relayRaw)).trim();
  } catch {
    return refuse("bad-relay-url");
  }
  if (!/^wss?:\/\/\S+$/.test(relayUrl)) return refuse("bad-relay-url");

  const genRaw = url.searchParams.get("g");
  if (genRaw === null) return refuse("missing-param");
  if (!/^[1-9][0-9]{0,8}$/.test(genRaw)) return refuse("bad-key-gen");
  const keyGen = Number(genRaw);

  const key = url.searchParams.get("k");
  if (key === null) return refuse("missing-param");
  try {
    if (roomKeyBytes(key).length !== KEY_BYTES) return refuse("bad-room-key");
  } catch {
    return refuse("bad-room-key");
  }

  const owner = url.searchParams.get("o");
  if (owner === null) return refuse("missing-param");
  try {
    if (b64urlToBytes(owner).length !== PUBLIC_KEY_BYTES) return refuse("bad-owner-key");
  } catch {
    return refuse("bad-owner-key");
  }

  const anchorRaw = url.searchParams.get("s");
  if (anchorRaw === null) return refuse("missing-param");
  let anchorJson: string;
  try {
    anchorJson = new TextDecoder().decode(b64urlToBytes(anchorRaw));
  } catch {
    return refuse("bad-anchor");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(anchorJson);
  } catch {
    return refuse("bad-anchor");
  }
  const anchor = readAnchor(parsed);
  if (anchor === null) return refuse("bad-anchor");

  return {
    ok: true,
    fragment: { roomId, relayUrl, keyGen, roomKey: key, ownerPub: owner, anchor },
  };
}

/** Epoch 1, a non-empty member list, exactly one owner, every field typed. */
function readAnchor(value: unknown): SignedEpoch | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (raw.epoch !== 1) return null;
  if (typeof raw.sig !== "string" || raw.sig === "") return null;
  if (!Array.isArray(raw.members) || raw.members.length === 0) return null;

  const members: RosterMember[] = [];
  for (const item of raw.members) {
    if (typeof item !== "object" || item === null) return null;
    const member = item as Record<string, unknown>;
    if (typeof member.deviceId !== "string" || member.deviceId === "") return null;
    if (member.role !== "owner" && member.role !== "member") return null;
    if (!Number.isInteger(member.addedAt) || (member.addedAt as number) < 0) return null;
    members.push({
      deviceId: member.deviceId,
      role: member.role,
      addedAt: member.addedAt as number,
    });
  }
  if (members.filter((member) => member.role === "owner").length !== 1) return null;
  if (new Set(members.map((member) => member.deviceId)).size !== members.length) return null;

  return { epoch: 1, members: sortMembers(members), sig: raw.sig };
}

/** Human copy for each refusal lives in `pairingErrors.ts` and is re-exported
 *  from here for the callers that already dropped `JoinReject` into their
 *  imports. One table, two entry points — never two tables. */
