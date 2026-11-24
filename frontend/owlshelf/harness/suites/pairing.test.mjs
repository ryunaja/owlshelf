/**
 * pairing.test.mjs — the step-6 UI's command path, executed (§6.7).
 *
 * The screens (share, join, re-pair, remove, leave) do not touch the database.
 * They post worker requests, and those requests are what this suite drives
 * through `createWorkerHost` — the same code the SharedWorker runs, with an
 * isolated database and two device identities.
 *
 * What is worth pinning here, and why each one is a real failure mode:
 *
 *  - **Minting needs the stored room.** A fragment built from a roomId alone
 *    forgets the anchor and the generation; the parser accepts it and the
 *    joiner then trusts a roster nobody signed (N4 / review-2 P0-1/P0-2).
 *  - **Join never rosters the joiner.** Being in the room is possession of the
 *    key, not a roster entry; only an owner-signed epoch admits a device, or
 *    revocation would be undone by the revoked device itself.
 *  - **A re-pair is not a join.** Every surviving member has data after a
 *    rotation, and `joinRoom` refuses a room with data (N10) — so `adopt` is
 *    the only path back in, and it must refuse a stale code, a different
 *    owner, and a re-signed anchor.
 *  - **Revoke rotates, and the engine moves with it.** A rotation changes the
 *    relay hash; an owner whose engine stayed on the old one keeps talking to
 *    a room nobody reads. The rebind is asserted by counting sockets.
 *  - **Leave is the exact purge** (§15.17): the profile row (it IS the room),
 *    the rows, the log, the media — and NOT the signed statement that proves
 *    the leave, which is what lets an offline leave complete.
 *
 * ── Why every refusal is checked as a VALUE ──────────────────────────────
 *
 * The worker replies `{ok: true, value}` even when the value is `{ok: false,
 * reason}`. That is the contract (`protocol.ts`): a wrong invite is a user
 * input problem, not a transport failure, and the dialog needs the reason to
 * pick a sentence. `refusal()` below is the only place that shape is assumed.
 */

import { createWorkerHost } from "../../src/lib/worker/host.ts";
import { JOIN_REJECT_COPY, MINT_REJECT_COPY, parseJoinFragment } from "../../src/lib/pairing.ts";
import { describePairingFailure } from "../../src/lib/pairingErrors.ts";
import { bytesToB64url, getDeviceKeys } from "../../src/lib/keys.ts";
import { mintEpoch, verifyEpoch } from "../../src/lib/roster.ts";
import { readRoom, writeRoom } from "../../src/lib/roomMeta.ts";
import { assert, assertEqual } from "../lib/assert.mjs";
import { withDb } from "../lib/db.mjs";
import { DEVICE_A, DEVICE_B } from "../lib/fixtures.mjs";

/** A host bound to one database and one device identity. */
function makeHost(db, deviceId) {
  return createWorkerHost({
    db,
    getDeviceId: async () => deviceId,
    ensureOpen: async () => {},
  });
}

/** Create a shelf through the command path and return its roomId. */
async function createShelf(host, name = "Home") {
  const reply = await host.handle({
    id: 1,
    kind: "create-profile",
    data: { name, type: "personal", avatarEmoji: "🏠" },
  });
  assertEqual(reply.ok, true, "the shelf was created");
  return reply.value.id;
}

/** The value of a handled request. */
function value(reply) {
  assertEqual(reply.ok, true, "the request was handled");
  return reply.value;
}

/** The reason of a refusal — asserting it was a value, not a rejected request. */
function refusal(reply) {
  const body = value(reply);
  assertEqual(body.ok, false, "refused");
  assert(typeof body.reason === "string" && body.reason.length > 0, "with a named reason");
  return body.reason;
}

/** Add a member by signing the next epoch, the way `admitDevice` does. */
async function addMember(db, roomId, deviceId) {
  const keys = await getDeviceKeys(db);
  const room = await readRoom(db, roomId);
  const epoch = await mintEpoch(roomId, DEVICE_A, keys.priv, (room.rosterEpoch ?? 1) + 1, [
    ...room.roster,
    { deviceId, role: "member", addedAt: 1 },
  ]);
  const staged = await readRoom(db, roomId);
  staged.roster = epoch.members;
  staged.rosterEpoch = epoch.epoch;
  staged.rosterChain = [...(staged.rosterChain ?? []), epoch];
  await writeRoom(db, staged);
  return epoch;
}

/** Read a query parameter out of a fragment without re-implementing the parser. */
function fragmentParam(fragment, key) {
  const url = new URL(fragment.replace("owlshelf://", "https://"));
  return url.searchParams.get(key);
}

/** Replace one parameter, re-encoding the rest through URLSearchParams. */
function withParam(fragment, key, replacement) {
  const url = new URL(fragment.replace("owlshelf://", "https://"));
  url.searchParams.set(key, replacement);
  return `owlshelf://${url.toString().replace("https://", "")}`;
}

/** A structurally valid anchor whose signature is wrong — shape passes, verify fails. */
function forgedAnchorFragment(fragment) {
  const parsed = parseJoinFragment(fragment);
  assertEqual(parsed.ok, true, "the fixture fragment parses");
  const anchor = { epoch: 1, members: parsed.fragment.anchor.members, sig: "AAAA" };
  return withParam(fragment, "s", bytesToB64url(new TextEncoder().encode(JSON.stringify(anchor))));
}

/** A socket that records frames and does nothing on its own. */
function fakeSocket(url) {
  return {
    url,
    sent: [],
    closed: null,
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
    send(data) {
      this.sent.push(JSON.parse(data));
    },
    close(code, reason) {
      this.closed = { code, reason };
    },
    open() {
      this.onopen?.({});
    },
  };
}

/** One macrotask is enough for fake-indexeddb and a floating `engine.start()`. */
const settle = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms));

export default {
  name: "pairing — invite, join, re-pair, remove, leave (§6.7)",
  tests: [
    {
      name: "an invite carries the stored room's generation, key and anchor",
      async run() {
        await withDb(async (db) => {
          const host = makeHost(db, DEVICE_A);
          const roomId = await createShelf(host);
          const minted = value(await host.handle({ id: 2, kind: "pairing-mint", roomId }));
          assertEqual(minted.ok, true, "minted");

          const room = await readRoom(db, roomId);
          const parsed = parseJoinFragment(minted.fragment);
          assertEqual(parsed.ok, true, "the parser accepts what the minter produced");
          assertEqual(parsed.fragment.roomId, roomId, "same room");
          assertEqual(parsed.fragment.keyGen, room.keyGen, "the CURRENT generation travels");
          assertEqual(parsed.fragment.roomKey, room.roomKey, "the key travels");
          assertEqual(parsed.fragment.ownerPub, room.ownerPub, "the pinned owner travels");
          assertEqual(parsed.fragment.anchor.sig, room.rosterAnchor.sig, "the anchor travels");
          assert(
            typeof parsed.fragment.relayUrl === "string" && parsed.fragment.relayUrl.length > 0,
            "the relay URL travels, so a joiner knows where to dial",
          );
        });
      },
    },
    {
      name: "minting refuses a room this device does not hold",
      async run() {
        await withDb(async (db) => {
          const host = makeHost(db, DEVICE_A);
          const reply = await host.handle({ id: 1, kind: "pairing-mint", roomId: "nope" });
          assertEqual(refusal(reply), "unknown-room", "named reason, not a throw");
        });
      },
    },
    {
      name: "a room that predates the anchor is repaired, not refused",
      async run() {
        await withDb(async (db) => {
          const host = makeHost(db, DEVICE_A);
          const roomId = await createShelf(host);
          const created = await readRoom(db, roomId);
          // Exactly what `newRoom`/`createProfile` used to write: a key, an id,
          // and nothing to pin an invite to.
          const bare = { ...created };
          delete bare.ownerPub;
          delete bare.rosterAnchor;
          delete bare.rosterEpoch;
          delete bare.rosterChain;
          await writeRoom(db, bare);

          const minted = value(await host.handle({ id: 2, kind: "pairing-mint", roomId }));
          assertEqual(minted.ok, true, "repaired and minted in one call");

          const repaired = await readRoom(db, roomId);
          assert(repaired.rosterAnchor !== undefined, "the anchor was persisted, so the next open is a no-op");
          assertEqual(repaired.ownerPub, created.ownerPub, "the owner key it already had is kept");
          assertEqual(repaired.keyGen, created.keyGen, "a repair does not rotate the room");
          assertEqual(repaired.roomKey, created.roomKey, "nor change its key");
          assertEqual(repaired.rosterEpoch, 1, "epoch 1, the anchor's epoch");
          assertEqual(repaired.rosterChain.length, 1, "the chain starts at the anchor");
          assertEqual(
            await verifyEpoch(roomId, repaired.ownerPub, DEVICE_A, repaired.rosterAnchor),
            null,
            "the signature verifies against the pinned owner key",
          );

          const parsed = parseJoinFragment(minted.fragment);
          assertEqual(parsed.ok, true, "the code it produced parses");
          assertEqual(parsed.fragment.anchor.sig, repaired.rosterAnchor.sig, "and carries the repair");

          // A roster that lost its owner row must still repair into a VALID
          // anchor: `ownerOf` returns null for an ownerless epoch, so every
          // joiner would refuse the code as `bad-anchor` while the owner sees
          // a perfectly good QR.
          const orphaned = { ...created };
          delete orphaned.ownerPub;
          delete orphaned.rosterAnchor;
          delete orphaned.rosterEpoch;
          delete orphaned.rosterChain;
          await writeRoom(db, { ...orphaned, roster: [] });

          const again = value(await host.handle({ id: 3, kind: "pairing-mint", roomId }));
          assertEqual(again.ok, true, "still repairable");
          const fixed = await readRoom(db, roomId);
          assertEqual(
            fixed.rosterAnchor.members.filter((member) => member.role === "owner").length,
            1,
            "exactly one owner in the signed roster",
          );
          assertEqual(
            await verifyEpoch(roomId, fixed.ownerPub, DEVICE_A, fixed.rosterAnchor),
            null,
            "and the anchor is valid",
          );
        });
      },
    },
    {
      name: "a room pinned to ANOTHER device is refused, never signed in its name",
      async run() {
        await withDb(async (db) => {
          const host = makeHost(db, DEVICE_A);
          const roomId = await createShelf(host);
          const created = await readRoom(db, roomId);

          // A valid public key that is not this device's — i.e. a room imported
          // from a shelf owned elsewhere without its anchor.
          const foreign = await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
            "sign",
            "verify",
          ]);
          const foreignPub = bytesToB64url(
            new Uint8Array(await crypto.subtle.exportKey("raw", foreign.publicKey)),
          );

          await writeRoom(db, {
            ...created,
            ownerPub: foreignPub,
            rosterAnchor: undefined,
            rosterEpoch: undefined,
            rosterChain: undefined,
          });

          const reply = await host.handle({ id: 2, kind: "pairing-mint", roomId });
          assertEqual(refusal(reply), "mint-not-owner", "named refusal, not a silent wrong code");

          const after = await readRoom(db, roomId);
          assertEqual(after.rosterAnchor, undefined, "nothing was signed in the foreign owner's name");
          assertEqual(after.ownerPub, foreignPub, "and the pin was not overwritten");
        });
      },
    },
    {
      name: "every mint refusal has its own sentence, and none falls through to the generic",
      async run() {
        const generic = "That did not work. Ask for a fresh invite and try again.";
        const reasons = Object.keys(MINT_REJECT_COPY);
        assertEqual(reasons.length, 8, "copy for every mint reason");
        for (const reason of reasons) {
          const copy = describePairingFailure(reason);
          assertEqual(copy, MINT_REJECT_COPY[reason], `copy for ${reason}`);
          assert(copy !== generic, `${reason} does not fall through to the generic line`);
        }
        // The defect this pins: `mintJoinFragment` returned SENTENCES, so the
        // lookup missed and the dialog replaced "this shelf has no signed
        // roster" with "That did not work." — the reason existed and was hidden.
        assertEqual(
          describePairingFailure("This room has no signed roster anchor."),
          generic,
          "a sentence is not a reason, so it still falls back rather than being shown",
        );
      },
    },
    {
      name: "joining writes the room and the profile, and does NOT roster the joiner",
      async run() {
        await withDb(async (ownerDb) => {
          const owner = makeHost(ownerDb, DEVICE_A);
          const roomId = await createShelf(owner);
          const minted = value(await owner.handle({ id: 2, kind: "pairing-mint", roomId }));

          await withDb(async (joinerDb) => {
            const joiner = makeHost(joinerDb, DEVICE_B);
            const joined = value(
              await joiner.handle({
                id: 3,
                kind: "pairing-join",
                text: minted.fragment,
                name: "Shared shelf",
              }),
            );
            assertEqual(joined.ok, true, "joined");
            assertEqual(joined.roomId, roomId, "the id is the invite's");

            const room = await readRoom(joinerDb, roomId);
            assertEqual(room?.keyGen, 1, "generation from the invite");
            assertEqual(room?.ownerPub, (await readRoom(ownerDb, roomId)).ownerPub, "owner pinned");
            assertEqual(room?.roster.length, 1, "the roster is the anchor's, not the joiner's");
            assertEqual(
              room?.roster.some((member) => member.deviceId === DEVICE_B),
              false,
              "a device cannot roster itself",
            );
            assertEqual(Object.keys(room?.cursorIn ?? {}).length, 0, "no cursors yet");

            const profile = await joinerDb.profiles.get(roomId);
            assertEqual(profile?.name, "Shared shelf", "the profile row is written");
          });
        });
      },
    },
    {
      name: "joining a room that already has data is refused (room-scoped)",
      async run() {
        await withDb(async (ownerDb) => {
          const owner = makeHost(ownerDb, DEVICE_A);
          const roomId = await createShelf(owner);
          const minted = value(await owner.handle({ id: 2, kind: "pairing-mint", roomId }));

          await withDb(async (joinerDb) => {
            const joiner = makeHost(joinerDb, DEVICE_B);
            await joiner.handle({ id: 3, kind: "pairing-join", text: minted.fragment });
            // One op is enough: "has data" is what makes a merge hazardous.
            await joinerDb.ops.put({
              opId: "op-1",
              roomId,
              deviceId: DEVICE_B,
              authorSeq: 1,
              hlcTs: 1,
              hlcCounter: 0,
              type: "put",
              table: "items",
              rowId: "item-1",
              payload: { name: "Book", locationId: "loc-1" },
            });
            const again = await joiner.handle({
              id: 4,
              kind: "pairing-join",
              text: minted.fragment,
            });
            assertEqual(refusal(again), "room-exists", "and says why");
          });
        });
      },
    },
    {
      name: "a malformed invite is refused with a named reason",
      async run() {
        await withDb(async (db) => {
          const host = makeHost(db, DEVICE_A);
          const reply = await host.handle({ id: 1, kind: "pairing-join", text: "hello" });
          const reason = refusal(reply);
          assert(
            Object.keys(JOIN_REJECT_COPY).includes(reason),
            "the reason is one of the closed set the dialog has copy for",
          );
        });
      },
    },
    {
      name: "re-pair: a stale code, a different owner and a forged anchor are refused",
      async run() {
        await withDb(async (ownerDb) => {
          const owner = makeHost(ownerDb, DEVICE_A);
          const roomId = await createShelf(owner);
          const minted = value(await owner.handle({ id: 2, kind: "pairing-mint", roomId }));
          const fragment = minted.fragment;

          await withDb(async (joinerDb) => {
            const joiner = makeHost(joinerDb, DEVICE_B);
            await joiner.handle({ id: 3, kind: "pairing-join", text: fragment });

            // Same generation: a re-pair code must MOVE the room forward.
            const stale = await joiner.handle({ id: 4, kind: "pairing-adopt", text: fragment });
            assertEqual(refusal(stale), "same-generation", "stale code refused");

            // A different owner key, well-formed enough to parse.
            const otherKey = bytesToB64url(new Uint8Array(32).fill(9));
            const changed = await joiner.handle({
              id: 5,
              kind: "pairing-adopt",
              text: withParam(fragment, "o", otherKey),
            });
            assertEqual(refusal(changed), "owner-changed", "owner swap refused");

            // An anchor whose signature does not verify against the pinned key.
            const forged = await joiner.handle({
              id: 6,
              kind: "pairing-adopt",
              text: forgedAnchorFragment(fragment),
            });
            assertEqual(refusal(forged), "anchor-unverified", "forged anchor refused");

            // A re-pair for a room this device does not hold.
            const missing = await joiner.handle({
              id: 7,
              kind: "pairing-adopt",
              text: withParam(fragment, "r", "some-other-room"),
            });
            assertEqual(refusal(missing), "no-room", "unknown room refused");
          });
        });
      },
    },
    {
      name: "re-pair: a rotation code clears rotationPending and adopts the new key",
      async run() {
        await withDb(async (ownerDb) => {
          const owner = makeHost(ownerDb, DEVICE_A);
          const roomId = await createShelf(owner);
          await addMember(ownerDb, roomId, DEVICE_B);
          const gen1 = value(await owner.handle({ id: 2, kind: "pairing-mint", roomId }));

          await withDb(async (joinerDb) => {
            const joiner = makeHost(joinerDb, DEVICE_B);
            await joiner.handle({ id: 3, kind: "pairing-join", text: gen1.fragment });

            // The notice arrived (the control path is covered elsewhere); what
            // this test needs is the state it leaves behind.
            const pending = await readRoom(joinerDb, roomId);
            pending.rotationPending = 2;
            await writeRoom(joinerDb, pending);

            const removed = value(
              await owner.handle({
                id: 4,
                kind: "pairing-revoke",
                roomId,
                deviceId: DEVICE_B,
              }),
            );
            assertEqual(removed.ok, true, "the owner removed the device");
            assertEqual(removed.keyGen, 2, "and rotated");

            const gen2 = value(await owner.handle({ id: 5, kind: "pairing-mint", roomId }));
            assertEqual(gen2.ok, true, "a new invite exists");
            assertEqual(fragmentParam(gen2.fragment, "g"), "2", "carrying the new generation");
            assert(gen2.fragment !== gen1.fragment, "and it is not the old invite");

            const adopted = value(
              await joiner.handle({ id: 6, kind: "pairing-adopt", text: gen2.fragment }),
            );
            assertEqual(adopted.ok, true, "re-paired");

            const room = await readRoom(joinerDb, roomId);
            assertEqual(room.keyGen, 2, "the joiner runs the new generation");
            assertEqual(room.rotationPending, undefined, "and stops waiting for a code");
            assertEqual(
              room.roomKey,
              (await readRoom(ownerDb, roomId)).roomKey,
              "the joiner adopted the owner's new key, not a stale one",
            );
          });
        });
      },
    },
    {
      name: "removing a device is owner-only, never the owner, and rotates the key",
      async run() {
        await withDb(async (ownerDb) => {
          const owner = makeHost(ownerDb, DEVICE_A);
          const roomId = await createShelf(owner);
          const before = await readRoom(ownerDb, roomId);

          const self = await owner.handle({
            id: 2,
            kind: "pairing-revoke",
            roomId,
            deviceId: before.roster[0].deviceId,
          });
          assertEqual(refusal(self), "cannot-remove-the-owner", "the owner cannot remove itself");

          const stranger = await owner.handle({
            id: 3,
            kind: "pairing-revoke",
            roomId,
            deviceId: "not-a-member",
          });
          assertEqual(refusal(stranger), "not-a-member", "a stranger is not removable");

          await addMember(ownerDb, roomId, DEVICE_B);
          const removed = value(
            await owner.handle({ id: 4, kind: "pairing-revoke", roomId, deviceId: DEVICE_B }),
          );
          assertEqual(removed.ok, true, "removed");
          assertEqual(removed.keyGen, 2, "generation moved");
          assertEqual(removed.notified, false, "no peer was connected, and it says so");

          const after = await readRoom(ownerDb, roomId);
          assert(after.roomKey !== before.roomKey, "the key changed");
          assertEqual(
            after.roster.some((member) => member.deviceId === DEVICE_B),
            false,
            "the roster no longer names it",
          );
          const notice = await ownerDb.meta.get(`notice:${roomId}:1`);
          assert(notice !== undefined, "the old generation is kept to serve the notice");
          assert(notice.expiresAt > Date.now(), "with the 30-day window");
        });
      },
    },
    {
      name: "a rotation re-dials the owner's engine at the new generation",
      async run() {
        await withDb(async (db) => {
          const sockets = [];
          const host = createWorkerHost({
            db,
            getDeviceId: async () => DEVICE_A,
            ensureOpen: async () => {},
            defaultRelayUrl: "ws://relay.test/ws",
            socketFactory: (url) => {
              const socket = fakeSocket(url);
              sockets.push(socket);
              return socket;
            },
          });
          const roomId = await createShelf(host);
          await host.handle({ id: 2, kind: "room-add", roomId });
          await settle();
          assertEqual(sockets.length, 1, "the engine dialled once");

          // A refusal must not re-dial: the room did not change.
          const refused = await host.handle({
            id: 3,
            kind: "pairing-revoke",
            roomId,
            deviceId: "someone-else",
          });
          assertEqual(refusal(refused), "not-a-member", "refused");
          await settle();
          assertEqual(sockets.length, 1, "no re-dial for a refusal");

          await addMember(db, roomId, DEVICE_B);
          const done = value(
            await host.handle({ id: 4, kind: "pairing-revoke", roomId, deviceId: DEVICE_B }),
          );
          assertEqual(done.ok, true, "removed");
          await settle();
          assertEqual(sockets.length, 2, "the engine re-dialled at the new generation");
          assert(sockets[0].closed !== null, "the old socket was closed");
          assertEqual(host.rooms.includes(roomId), true, "and the room is still wanted");
          host.stop();
        });
      },
    },
    {
      name: "leaving purges the room but keeps the signed statement",
      async run() {
        await withDb(async (ownerDb) => {
          const owner = makeHost(ownerDb, DEVICE_A);
          const roomId = await createShelf(owner);
          const minted = value(await owner.handle({ id: 2, kind: "pairing-mint", roomId }));

          await withDb(async (joinerDb) => {
            const joiner = makeHost(joinerDb, DEVICE_B);
            await joiner.handle({ id: 3, kind: "pairing-join", text: minted.fragment });
            await joinerDb.ops.put({
              opId: "op-1",
              roomId,
              deviceId: DEVICE_B,
              authorSeq: 1,
              hlcTs: 1,
              hlcCounter: 0,
              type: "put",
              table: "items",
              rowId: "item-1",
              payload: { name: "Book", locationId: "loc-1" },
            });

            await joiner.handle({ id: 4, kind: "pairing-leave", roomId });

            assertEqual(await readRoom(joinerDb, roomId), undefined, "the room record is gone");
            assertEqual(await joinerDb.profiles.get(roomId), undefined, "the profile row is gone");
            assertEqual(await joinerDb.ops.where("roomId").equals(roomId).count(), 0, "ops gone");
            const statement = await joinerDb.meta.get(`leave:${roomId}`);
            assert(statement !== undefined, "the signed leave statement survives the purge");
            assertEqual(statement.deviceId, DEVICE_B, "and names the leaver");
          });
        });
      },
    },
    {
      name: "the owner cannot leave the shelf it owns",
      async run() {
        await withDb(async (db) => {
          const host = makeHost(db, DEVICE_A);
          const roomId = await createShelf(host);
          const reply = await host.handle({ id: 2, kind: "pairing-leave", roomId });
          assertEqual(reply.ok, false, "refused as a request error");
          assertEqual(reply.error.code, "validation", "a CommandError, not a crash");
          assert((await readRoom(db, roomId)) !== undefined, "and the room is still here");
        });
      },
    },
    {
      name: "room-info reports ownership, generation, rotation and op count",
      async run() {
        await withDb(async (db) => {
          const host = makeHost(db, DEVICE_A);
          const roomId = await createShelf(host);
          const info = value(await host.handle({ id: 2, kind: "room-info", roomId }));
          assertEqual(info.roomId, roomId, "same room");
          assertEqual(info.deviceId, DEVICE_A, "the device id travels (a tab cannot read it)");
          assertEqual(info.isOwner, true, "the creator owns it");
          assertEqual(info.keyGen, 1, "generation");
          assertEqual(info.rotationPending, null, "no rotation");
          assertEqual(info.ops, 0, "no ops yet");
          assertEqual(info.running, false, "no engine until a tab asks for the room");
        });
      },
    },
    {
      name: "a staged relay move is accepted or dismissed, and both are writes",
      async run() {
        await withDb(async (db) => {
          const host = makeHost(db, DEVICE_A);
          const roomId = await createShelf(host);
          const original = (await readRoom(db, roomId)).relayUrl;

          const staged = await readRoom(db, roomId);
          staged.pendingRelayUrl = "ws://elsewhere.test/ws";
          await writeRoom(db, staged);

          await host.handle({ id: 2, kind: "pairing-rehome", roomId, accept: false });
          const dismissed = await readRoom(db, roomId);
          assertEqual(dismissed.pendingRelayUrl, undefined, "dismissing clears the prompt");
          assertEqual(dismissed.relayUrl, original, "and keeps the relay");

          const again = await readRoom(db, roomId);
          again.pendingRelayUrl = "ws://elsewhere.test/ws";
          await writeRoom(db, again);

          await host.handle({ id: 3, kind: "pairing-rehome", roomId, accept: true });
          assertEqual(
            (await readRoom(db, roomId)).relayUrl,
            "ws://elsewhere.test/ws",
            "accepting moves the room",
          );
        });
      },
    },
  ],
};
