/**
 * roster.ts — owner-signed roster epochs (plan §6.7, §6.4, §8.2).
 *
 * The roster is not a synced table and it is not a mutable field. It is an
 * append-only chain of OWNER-SIGNED epochs, pinned to an immutable epoch-1
 * anchor that travels inside the pairing QR. Three consequences, each of which
 * exists to close a specific attack:
 *
 *  1. **A member cannot roster itself.** It holds the room key, so it can read
 *     and write everything — but it cannot produce the owner's signature, so a
 *     `roster-epoch` naming itself fails verification. The dev stopgap it
 *     replaces (`outbox.ts`'s `admitPeerToRoster`) wrote the local roster
 *     directly, which meant a revoked device could re-add itself and defeat
 *     revocation entirely. That function is gone.
 *  2. **The pin is the trust root, not the current roster.** A joiner accepts
 *     the QR's epoch-1 anchor first; every later epoch must verify against the
 *     owner key in that anchor. Trusting "the roster I saw first" would let any
 *     member that got there first claim ownership (review-2 P0-2).
 *  3. **The current members are DERIVED** from the highest epoch, so
 *     `Room.roster` and the chain cannot disagree in the code — only in the
 *     database, which is what `assertConsistent` below is for.
 *
 * ── What the chain is NOT ─────────────────────────────────────────────────
 *
 * It is not the revocation mechanism. Revocation is key rotation: a new key is
 * a new hash is effectively a new room (§6.7). The chain is the ack rule's
 * input and the "who is in this room" display; the security boundary is the
 * key, which is why a revoked device's local roster still listing itself
 * grants it nothing.
 */

import { controlSignatureInput } from "./canonical";
import { sign, verify } from "./keys";
import type { Room, RosterMember } from "./stores";

/** One owner-signed roster epoch. `sig` covers exactly the bytes
 *  `controlSignatureInput("roster-epoch", roomId, ownerDeviceId, {epoch, members})`. */
export interface SignedEpoch {
  epoch: number;
  /** Sorted by deviceId bytes, so two devices storing the same epoch store the
   *  same array — the signature covers sorted order. */
  members: RosterMember[];
  sig: string;
}

export type EpochReject =
  | "no-owner"           // zero or two owner-role members
  | "owner-changed"      // owner deviceId is not the pinned one
  | "bad-sig"            // signature does not verify against the pinned key
  | "stale-epoch"        // epoch <= current — a replay or a rollback
  | "unknown-anchor";    // the room has no pinned anchor to verify against

export type EpochResult = { ok: true; epoch: SignedEpoch } | { ok: false; reason: EpochReject };

/** Sort by deviceId BYTES — the same order the signature covers. */
export function sortMembers(members: readonly RosterMember[]): RosterMember[] {
  return [...members].sort((a, b) => (a.deviceId < b.deviceId ? -1 : a.deviceId > b.deviceId ? 1 : 0));
}

/** Exactly one owner, and it is the pinned one. */
function ownerOf(members: readonly RosterMember[]): RosterMember | null {
  const owners = members.filter((member) => member.role === "owner");
  return owners.length === 1 ? owners[0] : null;
}

/**
 * Mint one epoch with the owner's own key.
 *
 * Throws on a malformed input rather than returning a refusal: this is the
 * MINT side, and a caller that asks for an unsigned epoch has a bug, not a
 * hostile peer.
 */
export async function mintEpoch(
  roomId: string,
  signerDeviceId: string,
  priv: string,
  epoch: number,
  members: readonly RosterMember[],
): Promise<SignedEpoch> {
  const sorted = sortMembers(members);
  if (ownerOf(sorted) === null) {
    throw new Error("mintEpoch: the roster must name exactly one owner");
  }
  const input = controlSignatureInput("roster-epoch", roomId, signerDeviceId, {
    epoch,
    members: sorted,
  });
  return { epoch, members: sorted, sig: await sign(priv, input) };
}

/**
 * Verify one epoch against a pinned owner key.
 *
 * `roomId` and the owner's deviceId are inputs, not lookups: the caller passes
 * the room's own id and the owner id FROM THE ANCHOR, so a candidate epoch that
 * names a different owner cannot even reach the signature check with a
 * consistent input.
 */
export async function verifyEpoch(
  roomId: string,
  ownerPub: string,
  ownerDeviceId: string,
  epoch: SignedEpoch,
): Promise<EpochReject | null> {
  const owner = ownerOf(epoch.members);
  if (owner === null) return "no-owner";
  if (owner.deviceId !== ownerDeviceId) return "owner-changed";
  let input: Uint8Array<ArrayBuffer>;
  try {
    input = controlSignatureInput("roster-epoch", roomId, ownerDeviceId, {
      epoch: epoch.epoch,
      members: epoch.members,
    });
  } catch {
    return "bad-sig";
  }
  return (await verify(ownerPub, input, epoch.sig)) ? null : "bad-sig";
}

/**
 * Adopt an upstream epoch, or explain why it was refused.
 *
 * Monotonic and strictly forward. A replay of the current epoch is a no-op that
 * reports `stale-epoch` rather than an error, because catch-up re-delivers
 * epochs on every resume and a no-op is the correct response to a duplicate.
 *
 * Verification happens FIRST and outside any transaction: `verifyEpoch` calls
 * `crypto.subtle`, whose promise is not backed by an IndexedDB request, so
 * awaiting it inside a Dexie transaction lets the transaction auto-commit
 * ("Transaction committed too early" — found by execution, twice). Callers that
 * are already inside a transaction use `adoptEpoch` below.
 */
export async function applyEpoch(room: Room, incoming: SignedEpoch): Promise<EpochResult> {
  if (!room.ownerPub) return { ok: false, reason: "unknown-anchor" };

  const anchor = room.rosterAnchor;
  if (!anchor) return { ok: false, reason: "unknown-anchor" };
  const anchorOwner = ownerOf(anchor.members);
  if (anchorOwner === null) return { ok: false, reason: "no-owner" };

  if (incoming.epoch <= (room.rosterEpoch ?? 1)) return { ok: false, reason: "stale-epoch" };

  const rejection = await verifyEpoch(room.roomId, room.ownerPub, anchorOwner.deviceId, incoming);
  if (rejection !== null) return { ok: false, reason: rejection };

  return adoptEpoch(room, incoming);
}

/**
 * The mutation half of `applyEpoch`, with NO cryptography — safe to call inside
 * a Dexie transaction.
 *
 * The caller has already verified the signature, which is the only part that
 * needs `crypto.subtle`. This re-checks every STRUCTURAL rule, and the one that
 * can still have moved since verification (staleness). Both are pure functions
 * of the two records, so a caller that skipped them cannot be talked into
 * accepting a chain the owner did not sign.
 */
export function adoptEpoch(room: Room, incoming: SignedEpoch): EpochResult {
  if (!room.ownerPub) return { ok: false, reason: "unknown-anchor" };

  const anchor = room.rosterAnchor;
  if (!anchor) return { ok: false, reason: "unknown-anchor" };
  const anchorOwner = ownerOf(anchor.members);
  if (anchorOwner === null) return { ok: false, reason: "no-owner" };
  const incomingOwner = ownerOf(incoming.members);
  if (incomingOwner === null) return { ok: false, reason: "no-owner" };
  if (incomingOwner.deviceId !== anchorOwner.deviceId) return { ok: false, reason: "owner-changed" };
  if (incoming.epoch <= (room.rosterEpoch ?? 1)) return { ok: false, reason: "stale-epoch" };

  const sorted: SignedEpoch = {
    epoch: incoming.epoch,
    members: sortMembers(incoming.members),
    sig: incoming.sig,
  };

  // The chain keeps every epoch it has seen, sorted, holes allowed: a member
  // that joined at epoch 5 never saw 2..4, and rejecting a gap would mean it
  // could never adopt 6 either. Authority is the owner's signature, not
  // contiguity — §8.2 wants the chain so a post-compaction joiner can walk it,
  // and a hole is visible there rather than fatal.
  const chain = [...(room.rosterChain ?? []), sorted].sort((a, b) => a.epoch - b.epoch);
  room.rosterChain = chain;
  room.rosterEpoch = sorted.epoch;
  room.roster = sorted.members;
  return { ok: true, epoch: sorted };
}

/**
 * The invariant that makes the duplication safe.
 *
 * `Room.roster` is a DERIVED view of the chain's head, kept because every
 * existing consumer (`decideAck`, the profile list) reads it. This returns the
 * list of ways they disagree, so a harness test can assert "none".
 */
export function assertConsistent(room: Room): string[] {
  const problems: string[] = [];
  if (!room.rosterAnchor) return problems;

  const epoch = room.rosterEpoch ?? 1;
  if (epoch === 1) {
    const anchorSig = room.rosterAnchor.sig;
    if (room.rosterChain !== undefined) {
      const head = room.rosterChain.filter((entry) => entry.epoch === 1)[0];
      if (head !== undefined && head.sig !== anchorSig) {
        problems.push("epoch 1 in the chain is not the anchor");
      }
    }
  }

  const head = (room.rosterChain ?? []).reduce<SignedEpoch | null>(
    (best, entry) => (best === null || entry.epoch > best.epoch ? entry : best),
    null,
  );
  if (head === null) {
    if (room.roster.length !== room.rosterAnchor.members.length) {
      problems.push("roster has no chain but differs from the anchor");
    }
    return problems;
  }
  if (head.epoch !== epoch) problems.push(`chain head is epoch ${head.epoch}, room says ${epoch}`);
  if (JSON.stringify(head.members) !== JSON.stringify(sortMembers(room.roster))) {
    problems.push("roster is not the chain head");
  }
  return problems;
}
