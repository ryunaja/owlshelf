/**
 * pairingErrors.ts — the refusal vocabulary for shared shelves (plan §6.7).
 *
 * Every pairing action is a closed set of named refusals, never a thrown string.
 * That is not tidiness: a dialog that renders `String(error)` for a hostile
 * input is one bug away from showing an attacker's text, and the UI needs
 * distinct copy per reason anyway (`JOIN_REJECT_COPY`'s own doc comment).
 *
 * This module is deliberately DEPENDENCY-FREE. `pairing.ts` pulls in the
 * envelope, the canonical encoder and WebCrypto; `rooms.ts` is worker-only.
 * A tab that needs the copy for a refusal must not drag either of those into
 * the page bundle, so the vocabulary lives here and both sides import it:
 *
 *   pairing.ts  → the fragment parser's reasons (wire-level: bad key, bad gen)
 *                 and the minter's (mint-*: this room cannot be handed out)
 *   rooms.ts    → the storage-level reasons (a room that already has data)
 *
 * `describePairingFailure` is the single place that turns either set into
 * sentence case, so a new reason cannot ship without copy.
 */

/** Why a join fragment was refused. Wire-level: the fragment itself is bad. */
export type JoinReject =
  | "not-a-fragment" // wrong scheme or host
  | "bad-version" // v is not 1
  | "bad-room-id"
  | "bad-relay-url"
  | "bad-key-gen"
  | "bad-room-key"
  | "bad-owner-key"
  | "bad-anchor" // undecodable, or not an epoch-1 shape
  | "duplicate-param" // the same key twice — two parsers, two answers
  | "missing-param";

/** Why an invite could not be MINTED. Local to this device — not wire input. */
export type MintReject =
  | "mint-bad-id" // the stored room id is not a room id
  | "mint-no-relay" // no relay URL, so the joiner would have nowhere to dial
  | "mint-bad-gen" // keyGen is not a positive integer
  | "mint-bad-key" // roomKey is not 32 bytes
  | "mint-no-owner" // no ownerPub: the room has no trust pin at all
  | "mint-bad-owner" // ownerPub will not decode to a public key
  | "mint-not-owner" // pinned to another device, so this device cannot sign for it
  | "mint-no-anchor"; // no signed roster, so there is nothing to hand out

/** Why a room action was refused. Storage-level: the fragment was fine. */
export type RoomReject =
  | "room-exists" // this device already holds data for that room (N10)
  | "anchor-unverified" // the fragment's anchor does not verify against the pin
  | "owner-changed" // a re-pair code naming a different owner
  | "same-generation" // a re-pair code at or below the generation we run
  | "no-room" // re-pair for a room this device does not hold
  | "unknown-room"
  | "not-the-owner"
  | "already-a-member"
  | "not-a-member"
  | "cannot-remove-the-owner";

export const JOIN_REJECT_COPY: Record<JoinReject, string> = {
  "not-a-fragment": "That is not an Owlshelf invite.",
  "bad-version": "That invite is from a newer version of Owlshelf.",
  "bad-room-id": "That invite has a malformed room id.",
  "bad-relay-url": "That invite has a malformed relay URL.",
  "bad-key-gen": "That invite has a malformed generation.",
  "bad-room-key": "That invite's room key is malformed.",
  "bad-owner-key": "That invite has no valid owner key.",
  "bad-anchor": "That invite's roster signature is malformed — ask the owner for a fresh one.",
  "duplicate-param": "That invite is malformed (repeated field).",
  "missing-param": "That invite is incomplete — ask the owner for a fresh one.",
};

export const ROOM_REJECT_COPY: Record<RoomReject, string> = {
  "room-exists":
    "This device already holds data for that shelf. Joining would merge two histories, so it is refused.",
  "anchor-unverified":
    "That invite's owner signature did not check out against the owner this device trusts.",
  "owner-changed": "That code belongs to a different owner than the one this shelf is pinned to.",
  "same-generation":
    "That code is not newer than what this device already runs — ask the owner for a fresh one.",
  "no-room": "This device does not hold that shelf any more.",
  "unknown-room": "That shelf is not on this device.",
  "not-the-owner": "Only the device that owns this shelf can do that.",
  "already-a-member": "That device is already on this shelf.",
  "not-a-member": "That device is not on this shelf.",
  "cannot-remove-the-owner": "The owner cannot be removed from its own shelf.",
};

/**
 * Why the share button cannot produce a code.
 *
 * These are named reasons rather than the sentences an earlier version
 * returned, because a sentence is not a vocabulary: `describePairingFailure`
 * looked the sentence up, missed, and printed "That did not work. Ask for a
 * fresh invite" — hiding the one line that said the shelf had no signed roster.
 * A refusal that cannot be named cannot be shown.
 */
export const MINT_REJECT_COPY: Record<MintReject, string> = {
  "mint-bad-id": "This shelf has no valid id, so it cannot be shared.",
  "mint-no-relay": "Set a relay URL before sharing this shelf — a code with no relay has nowhere to connect.",
  "mint-bad-gen": "This shelf has no valid key generation, so its code would be meaningless.",
  "mint-bad-key": "This shelf's key is not 32 bytes, so a code built from it would not open anything.",
  "mint-no-owner": "This shelf has no owner key yet, so no invite can be trusted.",
  "mint-bad-owner": "This shelf's owner key is corrupt, so an invite would fail to verify.",
  "mint-not-owner": "This shelf's roster was signed by another device, so this device cannot invite anyone to it.",
  "mint-no-anchor": "This shelf has no signed roster, so there is nothing to hand out. Reopen Owlshelf to let it repair the roster, then share again.",
};

/** Anything the caller cannot name is a bug or a newer bundle, not user text. */
const GENERIC = "That did not work. Ask for a fresh invite and try again.";

const KNOWN: Record<string, string> = {
  ...JOIN_REJECT_COPY,
  ...ROOM_REJECT_COPY,
  ...MINT_REJECT_COPY,
  // A worker-side CommandError can surface a code instead of a reason.
  validation: "That invite did not pass validation.",
  internal: "Something went wrong on this device. Nothing was changed.",
};

export function describePairingFailure(reason: string): string {
  return KNOWN[reason] ?? GENERIC;
}
