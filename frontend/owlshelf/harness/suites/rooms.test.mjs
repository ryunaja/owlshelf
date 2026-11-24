/**
 * rooms.test.mjs — pairing, the signed roster, and revocation (§6.7, Gate D).
 *
 * The tests that matter are the refusals, because the whole point of §6.7 is
 * that a member holding the room key still cannot do these things:
 *
 *   - cannot name itself in a roster epoch (no owner signature),
 *   - cannot replay or roll back an epoch,
 *   - cannot point a room at its own relay,
 *   - cannot keep minting after a rotation.
 *
 * Each refusal is asserted to leave ZERO materialized change, which is Gate D's
 * wording. A refusal that also half-wrote is the failure mode that matters.
 */

import { executeCommand } from "../../src/lib/cmd.ts";
import { controlSignatureInput } from "../../src/lib/canonical.ts";
import {
  applyControlOp,
  confirmRehome,
  mintRehome,
  mintRosterEpoch,
  mintRotateKey,
  readControlOp,
} from "../../src/lib/control.ts";
import { getDeviceKeys, sign, verify } from "../../src/lib/keys.ts";
import { JOIN_REJECT_COPY, mintJoinFragment, parseJoinFragment } from "../../src/lib/pairing.ts";
import { applyEpoch, assertConsistent, mintEpoch, verifyEpoch } from "../../src/lib/roster.ts";
import { readRoom } from "../../src/lib/roomMeta.ts";
import {
  admitDevice,
  createRoom,
  joinRoom,
  leaveKey,
  leaveRoom,
  revokeDevice,
} from "../../src/lib/rooms.ts";
import { assert, assertDeepEqual, assertEqual, assertRejects } from "../lib/assert.mjs";
import { disposeDb, freshDb, withDb } from "../lib/db.mjs";
import { DEVICE_A, DEVICE_B, ROOM_A, ROOM_KEY, makeRoom, seedRoom } from "../lib/fixtures.mjs";

const WALL = 1_700_000_000_000;
const RELAY = "ws://relay.test/ws";

/** Deterministic randomness, seeded so two calls with different seeds mint
 *  different ids and keys (an unseeded counter would make two rooms collide). */
function seqRandom(seed) {
  return (bytes) => {
    const out = new Uint8Array(bytes);
    for (let i = 0; i < bytes; i += 1) out[i] = (seed + i * 7 + 13) % 256;
    return out;
  };
}

function deps(db, deviceId, seed = 1) {
  return {
    db,
    getDeviceId: async () => deviceId,
    now: () => WALL,
    random: seqRandom(seed),
  };
}

/** An owner room on device A, created through the real path. */
async function ownerRoom(db, seed = 1) {
  const { room } = await createRoom(
    { relayUrl: RELAY, name: "Mine", type: "personal", avatarEmoji: "🦉" },
    deps(db, DEVICE_A, seed),
  );
  return room;
}

/** A joined room on device B from device A's fragment. */
async function joinedRoom(ownerDb, joinerDb) {
  const owner = await ownerRoom(ownerDb);
  const minted = mintJoinFragment(owner);
  assert(minted.ok, `the owner room must be pairable: ${minted.reason ?? ""}`);
  const result = await joinRoom(minted.fragment, deps(joinerDb, DEVICE_B));
  assert(result.ok, `join should succeed, got ${result.reason ?? ""}`);
  return { ownerRoom: owner, joinerRoom: result.room, fragment: minted.fragment };
}

/** A room record pinned to this db's key, for tests that start from a fixture. */
async function anchoredRoom(db, overrides = {}) {
  const keys = await getDeviceKeys(db);
  const anchor = await mintEpoch("room-a", DEVICE_A, keys.priv, 1, [
    { deviceId: DEVICE_A, role: "owner", addedAt: 0 },
  ]);
  return makeRoom({
    ownerPub: keys.pub,
    rosterAnchor: anchor,
    rosterEpoch: 1,
    roster: anchor.members,
    rosterChain: [anchor],
    ...overrides,
  });
}

export default {
  name: "rooms — pairing, signed roster, revocation (§6.7)",
  tests: [
    // ── keys ──────────────────────────────────────────────────────────────
    {
      name: "the device keypair is minted once and reused",
      async run() {
        await withDb(async (db) => {
          const first = await getDeviceKeys(db);
          const second = await getDeviceKeys(db);
          assertEqual(first.pub, second.pub, "the same public key");
          assertEqual(first.priv, second.priv, "the same private key");
          const stored = await db.meta.get("deviceKeys");
          assertEqual(stored.pub, first.pub, "and it is persisted under meta.deviceKeys");
        });
      },
    },
    {
      name: "two databases are two devices, with different keys",
      async run() {
        const a = await freshDb();
        const b = await freshDb();
        try {
          const keysA = await getDeviceKeys(a);
          const keysB = await getDeviceKeys(b);
          assert(keysA.pub !== keysB.pub, "different public keys");
        } finally {
          await disposeDb(a);
          await disposeDb(b);
        }
      },
    },
    {
      name: "a signing round-trip verifies, and nothing malformed throws",
      async run() {
        await withDb(async (db) => {
          const keys = await getDeviceKeys(db);
          const bytes = new TextEncoder().encode("hello");
          const sig = await sign(keys.priv, bytes);
          assertEqual(await verify(keys.pub, bytes, sig), true, "round-trip");
          assertEqual(await verify(keys.pub, new TextEncoder().encode("hellp"), sig), false, "tampered");
          assertEqual(await verify("not-a-key", bytes, sig), false, "a junk key is false, not a throw");
          assertEqual(await verify(keys.pub, bytes, "junk"), false, "a junk signature is false");
          assertEqual(await verify("", bytes, ""), false, "and so is empty everything");
        });
      },
    },
    // ── canonical consumer 5 ──────────────────────────────────────────────
    {
      name: "the control signature input ignores member order but not content",
      async run() {
        const a = { deviceId: "dev-a", role: "owner", addedAt: 1 };
        const b = { deviceId: "dev-b", role: "member", addedAt: 2 };
        const base = { epoch: 2, members: [a, b] };
        const forward = controlSignatureInput("roster-epoch", "room-1", "dev-a", base);
        const reverse = controlSignatureInput("roster-epoch", "room-1", "dev-a", {
          epoch: 2,
          members: [b, a],
        });
        assertDeepEqual([...forward], [...reverse], "member order does not change the bytes");

        const changed = [
          controlSignatureInput("roster-epoch", "room-1", "dev-a", { ...base, epoch: 3 }),
          controlSignatureInput("roster-epoch", "room-2", "dev-a", base),
          controlSignatureInput("roster-epoch", "room-1", "dev-b", base),
          controlSignatureInput("roster-epoch", "room-1", "dev-a", {
            epoch: 2,
            members: [a, { ...b, addedAt: 3 }],
          }),
        ];
        for (const [index, bytes] of changed.entries()) {
          assert(
            forward.join(",") !== bytes.join(","),
            `variant ${index} must produce different bytes`,
          );
        }
      },
    },
    {
      name: "each control kind has its own encoding and refuses a bad body",
      async run() {
        const rotate = controlSignatureInput("rotate-key", "r", "d", { keyGen: 2 });
        const rehome = controlSignatureInput("rehome", "r", "d", { relayUrl: RELAY });
        const roster = controlSignatureInput("roster-epoch", "r", "d", {
          epoch: 2,
          members: [{ deviceId: "d", role: "owner", addedAt: 0 }],
        });
        const seen = new Set([rotate.join(","), rehome.join(","), roster.join(",")]);
        assertEqual(seen.size, 3, "three distinct encodings");

        for (const bad of [{}, { keyGen: 0 }, { keyGen: 1.5 }, { keyGen: -1 }]) {
          let threw = false;
          try {
            controlSignatureInput("rotate-key", "r", "d", bad);
          } catch {
            threw = true;
          }
          assert(threw, `rotate-key refuses ${JSON.stringify(bad)}`);
        }
      },
    },
    // ── roster ────────────────────────────────────────────────────────────
    {
      name: "an owner-signed epoch verifies against the pinned key",
      async run() {
        await withDb(async (db) => {
          const keys = await getDeviceKeys(db);
          const epoch = await mintEpoch("room-1", DEVICE_A, keys.priv, 1, [
            { deviceId: DEVICE_A, role: "owner", addedAt: 0 },
          ]);
          assertEqual(await verifyEpoch("room-1", keys.pub, DEVICE_A, epoch), null, "verifies");
          assertEqual(
            await verifyEpoch("room-1", keys.pub, DEVICE_B, epoch),
            "owner-changed",
            "a different owner id is refused before the signature check",
          );
          assertEqual(
            await verifyEpoch("room-2", keys.pub, DEVICE_A, epoch),
            "bad-sig",
            "the same epoch bytes under another roomId do not verify",
          );
        });
      },
    },
    {
      name: "a forged epoch fails its signature and changes nothing",
      async run() {
        await withDb(async (db) => {
          const room = await anchoredRoom(db);
          const forged = {
            epoch: 2,
            members: [
              { deviceId: DEVICE_A, role: "owner", addedAt: 0 },
              { deviceId: DEVICE_B, role: "member", addedAt: 0 },
            ],
            sig: "AAAA",
          };
          const result = await applyEpoch(room, forged);
          assertEqual(result.ok, false, "refused");
          assertEqual(result.reason, "bad-sig", "for a bad signature");
          assertEqual(room.rosterEpoch, 1, "the epoch did not move");
          assertEqual(room.roster.length, 1, "and neither did the roster");
        });
      },
    },
    {
      name: "an epoch naming a different owner is refused",
      async run() {
        await withDb(async (db) => {
          const keys = await getDeviceKeys(db);
          const room = await anchoredRoom(db);
          // Signed by the real owner key, but claiming a DIFFERENT owner id.
          const swapped = await mintEpoch("room-a", DEVICE_B, keys.priv, 2, [
            { deviceId: DEVICE_B, role: "owner", addedAt: 0 },
          ]);
          const result = await applyEpoch(room, swapped);
          assertEqual(result.ok, false, "refused");
          assertEqual(result.reason, "owner-changed", "because the owner id moved");
          assertEqual(room.rosterEpoch, 1, "no materialized change");
        });
      },
    },
    {
      name: "an epoch with zero or two owners is refused",
      async run() {
        await withDb(async (db) => {
          const room = await anchoredRoom(db);
          const twoOwners = {
            epoch: 2,
            members: [
              { deviceId: DEVICE_A, role: "owner", addedAt: 0 },
              { deviceId: DEVICE_B, role: "owner", addedAt: 0 },
            ],
            sig: "AAAA",
          };
          assertEqual((await applyEpoch(room, twoOwners)).reason, "no-owner", "two owners is not one");
          const noOwner = {
            epoch: 2,
            members: [{ deviceId: DEVICE_B, role: "member", addedAt: 0 }],
            sig: "AAAA",
          };
          assertEqual((await applyEpoch(room, noOwner)).reason, "no-owner", "and neither is zero");
          assertEqual(room.rosterEpoch, 1, "nothing moved");
        });
      },
    },
    {
      name: "a valid epoch is adopted, and a replay or rollback is refused",
      async run() {
        await withDb(async (db) => {
          const keys = await getDeviceKeys(db);
          const room = await anchoredRoom(db);
          const anchor = room.rosterAnchor;

          const two = await mintEpoch("room-a", DEVICE_A, keys.priv, 2, [
            { deviceId: DEVICE_A, role: "owner", addedAt: 0 },
            { deviceId: DEVICE_B, role: "member", addedAt: 1 },
          ]);
          const adopted = await applyEpoch(room, two);
          assertEqual(adopted.ok, true, "epoch 2 adopted");
          assertEqual(room.rosterEpoch, 2, "the epoch moved");
          assertEqual(room.roster.length, 2, "the roster grew");
          assertDeepEqual(assertConsistent(room), [], "chain and roster agree");

          const replay = await applyEpoch(room, two);
          assertEqual(replay.reason, "stale-epoch", "a replay is stale, not an error");
          const rollback = await applyEpoch(room, anchor);
          assertEqual(rollback.reason, "stale-epoch", "a rollback is stale too");
          assertEqual(room.rosterEpoch, 2, "and nothing moved");
        });
      },
    },
    {
      name: "an epoch is adopted across a gap (a joiner never saw the middle)",
      async run() {
        await withDb(async (db) => {
          const keys = await getDeviceKeys(db);
          const room = await anchoredRoom(db);
          const five = await mintEpoch("room-a", DEVICE_A, keys.priv, 5, [
            { deviceId: DEVICE_A, role: "owner", addedAt: 0 },
            { deviceId: "dev-e", role: "member", addedAt: 4 },
          ]);
          assertEqual((await applyEpoch(room, five)).ok, true, "epoch 5 without 2..4");
          assertEqual(room.rosterEpoch, 5, "the head is 5");
          assertDeepEqual(assertConsistent(room), [], "and it is consistent");
        });
      },
    },
    {
      name: "assertConsistent detects a roster that is not the chain head",
      async run() {
        await withDb(async (db) => {
          const room = await anchoredRoom(db, {
            roster: [
              { deviceId: DEVICE_A, role: "owner", addedAt: 0 },
              { deviceId: "squatter", role: "member", addedAt: 0 },
            ],
          });
          const problems = assertConsistent(room);
          assertEqual(problems.length, 1, "one problem");
          assert(problems[0].includes("roster"), `mentions the roster: ${problems[0]}`);
        });
      },
    },
    // ── pairing ───────────────────────────────────────────────────────────
    {
      name: "the QR fragment round-trips, anchor included",
      async run() {
        await withDb(async (db) => {
          const room = await ownerRoom(db);
          const minted = mintJoinFragment(room);
          assert(minted.ok, "minted");
          assert(minted.fragment.startsWith("owlshelf://join?"), "the documented scheme");

          const parsed = parseJoinFragment(minted.fragment);
          assert(parsed.ok, `parsed: ${parsed.reason ?? ""}`);
          assertEqual(parsed.fragment.roomId, room.roomId, "roomId");
          assertEqual(parsed.fragment.relayUrl, RELAY, "relayUrl");
          assertEqual(parsed.fragment.keyGen, 1, "keyGen");
          assertEqual(parsed.fragment.roomKey, room.roomKey, "roomKey");
          assertEqual(parsed.fragment.ownerPub, room.ownerPub, "owner key");
          assertEqual(parsed.fragment.anchor.sig, room.rosterAnchor.sig, "anchor signature");

          // The property that makes the fragment a trust anchor: the anchor's
          // signature verifies against the owner key it travelled with.
          assertEqual(
            await verifyEpoch(room.roomId, room.ownerPub, DEVICE_A, parsed.fragment.anchor),
            null,
            "the anchor verifies against the owner key in the same fragment",
          );
        });
      },
    },
    {
      name: "the fragment carries the CURRENT generation, not 1",
      async run() {
        await withDb(async (db) => {
          const room = { ...(await ownerRoom(db)), keyGen: 3 };
          const minted = mintJoinFragment(room);
          assert(minted.ok, "minted");
          const parsed = parseJoinFragment(minted.fragment);
          assert(parsed.ok, "parsed");
          assertEqual(parsed.fragment.keyGen, 3, "generation 3 travels with the key");
        });
      },
    },
    {
      name: "a room that cannot be paired is refused by the minter, not the joiner",
      async run() {
        await withDb(async (db) => {
          const room = await ownerRoom(db);
          for (const [label, broken] of [
            ["no relay URL", { ...room, relayUrl: null }],
            ["no owner key", { ...room, ownerPub: undefined }],
            ["no anchor", { ...room, rosterAnchor: undefined }],
            ["short key", { ...room, roomKey: "AAAA" }],
            ["zero generation", { ...room, keyGen: 0 }],
            ["anchor at epoch 2", { ...room, rosterAnchor: { ...room.rosterAnchor, epoch: 2 } }],
          ]) {
            const minted = mintJoinFragment(broken);
            assertEqual(minted.ok, false, `refused: ${label}`);
          }
        });
      },
    },
    {
      name: "every malformed fragment is refused with a named reason",
      async run() {
        await withDb(async (db) => {
          const good = mintJoinFragment(await ownerRoom(db));
          assert(good.ok, "minted");

          const cases = [
            ["", "not-a-fragment"],
            ["https://example.com/?v=1", "not-a-fragment"],
            ["owlshelf://other?v=1", "not-a-fragment"],
            [good.fragment.replace("v=1", "v=2"), "bad-version"],
            [good.fragment.replace(/r=[^&]+/, "r=..%2F.."), "bad-room-id"],
            [good.fragment.replace(/g=[^&]+/, "g=0"), "bad-key-gen"],
            [good.fragment.replace(/k=[^&]+/, "k=AAAA"), "bad-room-key"],
            [good.fragment.replace(/o=[^&]+/, "o=AAAA"), "bad-owner-key"],
            [good.fragment.replace(/s=[^&]+/, "s=AAAA"), "bad-anchor"],
            [`${good.fragment}&r=x`, "duplicate-param"],
          ];
          for (const [text, reason] of cases) {
            const parsed = parseJoinFragment(text);
            assertEqual(parsed.ok, false, `refused as ${reason}`);
            assertEqual(parsed.reason, reason, `reason for ${reason}`);
          }
          assertEqual(Object.keys(JOIN_REJECT_COPY).length, 10, "copy for every reason");
          for (const [reason, copy] of Object.entries(JOIN_REJECT_COPY)) {
            assert(typeof copy === "string" && copy.length > 0, `copy for ${reason}`);
          }
        });
      },
    },
    {
      name: "an anchor that is not exactly one epoch-1 owner is refused",
      async run() {
        await withDb(async (db) => {
          const good = mintJoinFragment(await ownerRoom(db));
          assert(good.ok, "minted");
          const encode = (value) =>
            btoa(JSON.stringify(value))
              .replace(/\+/g, "-")
              .replace(/\//g, "_")
              .replace(/=+$/, "");
          const withAnchor = (value) => good.fragment.replace(/s=[^&]+/, `s=${encode(value)}`);

          assertEqual(
            parseJoinFragment(
              withAnchor({
                epoch: 1,
                members: [
                  { deviceId: DEVICE_A, role: "owner", addedAt: 0 },
                  { deviceId: DEVICE_B, role: "owner", addedAt: 0 },
                ],
                sig: "AAAA",
              }),
            ).reason,
            "bad-anchor",
            "two owners",
          );
          assertEqual(
            parseJoinFragment(
              withAnchor({
                epoch: 1,
                members: [
                  { deviceId: DEVICE_A, role: "owner", addedAt: 0 },
                  { deviceId: DEVICE_A, role: "member", addedAt: 0 },
                ],
                sig: "AAAA",
              }),
            ).reason,
            "bad-anchor",
            "the same device twice",
          );
          assertEqual(
            parseJoinFragment(
              withAnchor({
                epoch: 2,
                members: [{ deviceId: DEVICE_A, role: "owner", addedAt: 0 }],
                sig: "AAAA",
              }),
            ).reason,
            "bad-anchor",
            "the anchor must be epoch 1",
          );
        });
      },
    },
    // ── control ───────────────────────────────────────────────────────────
    {
      name: "readControlOp admits the three kinds and refuses everything else",
      async run() {
        const members = [{ deviceId: DEVICE_A, role: "owner", addedAt: 0 }];
        assert(
          readControlOp({ kind: "roster-epoch", roomId: "r", signer: "s", epoch: 2, members, sig: "x" }),
          "roster-epoch",
        );
        assert(readControlOp({ kind: "rotate-key", roomId: "r", signer: "s", keyGen: 2, sig: "x" }), "rotate-key");
        assert(readControlOp({ kind: "rehome", roomId: "r", signer: "s", relayUrl: RELAY, sig: "x" }), "rehome");

        for (const bad of [
          null,
          {},
          "roster-epoch",
          { kind: "put", roomId: "r", signer: "s", sig: "x" },
          { kind: "rotate-key", roomId: "r", signer: "s", keyGen: 0, sig: "x" },
          { kind: "rotate-key", roomId: "r", signer: "s", keyGen: 2 },
          { kind: "rehome", roomId: "r", signer: "s", relayUrl: "not-a-url", sig: "x" },
          { kind: "roster-epoch", roomId: "r", signer: "s", epoch: 2, members: [], sig: "x" },
          {
            kind: "roster-epoch",
            roomId: "r",
            signer: "s",
            epoch: 2,
            members: [
              { deviceId: DEVICE_A, role: "owner", addedAt: 0 },
              { deviceId: DEVICE_B, role: "owner", addedAt: 0 },
            ],
            sig: "x",
          },
        ]) {
          assertEqual(readControlOp(bad), null, `refused ${JSON.stringify(bad)}`);
        }
      },
    },
    {
      name: "a valid roster-epoch op is applied and a forged one changes nothing",
      async run() {
        await withDb(async (db) => {
          const room = await ownerRoom(db);
          const keys = await getDeviceKeys(db);

          const good = await mintRosterEpoch(room, keys, DEVICE_A, [
            ...room.roster,
            { deviceId: DEVICE_B, role: "member", addedAt: WALL },
          ]);
          assertEqual(good.epoch, 2, "epoch 2");
          assertEqual((await applyControlOp(db, room.roomId, good)).ok, true, "applied");
          const after = await readRoom(db, room.roomId);
          assertEqual(after.roster.length, 2, "the peer joined the roster");
          assertDeepEqual(assertConsistent(after), [], "chain and roster agree");

          const forged = { ...good, epoch: 3, sig: "AAAA" };
          const refused = await applyControlOp(db, room.roomId, forged);
          assertEqual(refused.ok, false, "refused");
          assertEqual(refused.reason, "not-the-owner", "for being unsigned");
          const still = await readRoom(db, room.roomId);
          assertEqual(still.rosterEpoch, 2, "no materialized change");
          assertEqual(still.roster.length, 2, "and neither did the roster");
        });
      },
    },
    {
      name: "a control op for another room is refused before any write",
      async run() {
        await withDb(async (db) => {
          const room = await ownerRoom(db);
          const keys = await getDeviceKeys(db);
          const op = await mintRosterEpoch(room, keys, DEVICE_A, [
            ...room.roster,
            { deviceId: DEVICE_B, role: "member", addedAt: WALL },
          ]);
          assertEqual((await applyControlOp(db, ROOM_A, op)).reason, "wrong-room", "cannot cross rooms");
          assertEqual((await readRoom(db, room.roomId)).rosterEpoch, 1, "and nothing moved");
        });
      },
    },
    {
      name: "minting a control op requires being the owner WITH the pinned key",
      async run() {
        await withDb(async (db) => {
          const room = await ownerRoom(db);
          const keys = await getDeviceKeys(db);
          await assertRejects(
            () => mintRosterEpoch(room, keys, DEVICE_B, room.roster),
            "a device id that is not the owner cannot mint",
          );
          const other = await freshDb();
          try {
            const otherKeys = await getDeviceKeys(other);
            await assertRejects(
              () => mintRosterEpoch(room, otherKeys, DEVICE_A, room.roster),
              "a key that is not the pinned one cannot mint",
            );
          } finally {
            await disposeDb(other);
          }
        });
      },
    },
    {
      name: "rotate-key records the generation and never the key",
      async run() {
        await withDb(async (db) => {
          const room = await ownerRoom(db);
          const keys = await getDeviceKeys(db);
          const before = (await readRoom(db, room.roomId)).roomKey;

          const op = await mintRotateKey(room, keys, DEVICE_A, 2);
          assertEqual(op.keyGen, 2, "generation only");
          assertEqual("roomKey" in op, false, "the op carries no key material");

          assertEqual((await applyControlOp(db, room.roomId, op)).ok, true, "applied");
          const after = await readRoom(db, room.roomId);
          assertEqual(after.rotationPending, 2, "rotation is pending");
          assertEqual(after.roomKey, before, "and the key did NOT change");

          assertEqual((await applyControlOp(db, room.roomId, op)).reason, "stale", "a replay is stale");

          await assertRejects(
            () =>
              executeCommand(
                db,
                { cmdId: "c1", roomId: room.roomId, kind: "putItem", locationId: "loc-1", item: { name: "Dune" } },
                { deviceId: DEVICE_A, now: () => WALL },
              ),
            "and minting is refused while the room is rotated",
          );
          assertEqual(await db.ops.count(), 0, "with nothing minted");
        });
      },
    },
    {
      name: "rehome is staged for a trust prompt, then committed",
      async run() {
        await withDb(async (db) => {
          const room = await ownerRoom(db);
          const keys = await getDeviceKeys(db);
          const target = "wss://other.test/ws";

          const op = await mintRehome(room, keys, DEVICE_A, target);
          assertEqual((await applyControlOp(db, room.roomId, op)).ok, true, "applied");
          const staged = await readRoom(db, room.roomId);
          assertEqual(staged.pendingRelayUrl, target, "staged, not applied");
          assertEqual(staged.relayUrl, RELAY, "the live URL did not move");

          assertEqual(await confirmRehome(db, room.roomId), true, "committed");
          const applied = await readRoom(db, room.roomId);
          assertEqual(applied.relayUrl, target, "the URL moved");
          assertEqual(applied.pendingRelayUrl, undefined, "and the staging cleared");
          assertEqual(await confirmRehome(db, room.roomId), false, "nothing left to confirm");
        });
      },
    },
    // ── create / join ─────────────────────────────────────────────────────
    {
      name: "createRoom persists a complete, pairable room and its profile",
      async run() {
        await withDb(async (db) => {
          const { room, profile } = await createRoom(
            { relayUrl: RELAY, name: "Mine", type: "personal", avatarEmoji: "🦉" },
            deps(db, DEVICE_A),
          );
          const stored = await readRoom(db, room.roomId);
          assert(stored !== undefined, "the room is durable");
          assertEqual(stored.profileId, stored.roomId, "profile id IS the room id");
          assertEqual(stored.ownerPub, (await getDeviceKeys(db)).pub, "the owner key is pinned");
          assertEqual(stored.rosterEpoch, 1, "epoch 1");
          assertEqual(stored.roster.filter((m) => m.role === "owner").length, 1, "one owner");
          assertEqual(profile.id, room.roomId, "the profile is keyed by the room");
          assert((await db.profiles.get(room.roomId)) !== undefined, "and it is written in the same tx");
          assertDeepEqual(assertConsistent(stored), [], "chain and roster agree");

          const minted = mintJoinFragment(stored);
          assert(minted.ok, "pairable immediately, with nothing else needed");
        });
      },
    },
    {
      name: "joinRoom adopts the QR's key and generation and does not roster itself",
      async run() {
        const ownerDb = await freshDb();
        const joinerDb = await freshDb();
        try {
          const { joinerRoom } = await joinedRoom(ownerDb, joinerDb);
          const stored = await readRoom(joinerDb, joinerRoom.roomId);
          assertEqual(stored.keyGen, 1, "the generation came from the QR");
          assertEqual(stored.ownerPub, (await getDeviceKeys(ownerDb)).pub, "the owner key is pinned");
          assertEqual(stored.roster.length, 1, "the roster is the anchor's members");
          assertEqual(stored.roster[0].role, "owner", "which is the owner alone");
          assertEqual(
            stored.roster.some((m) => m.role === "owner" && m.deviceId === DEVICE_B),
            false,
            "the joiner did NOT write itself in",
          );
          assertEqual(stored.nextAuthorSeq, 1, "a fresh authorSeq space");
          assert((await joinerDb.profiles.get(joinerRoom.roomId)) !== undefined, "profile written");
        } finally {
          await disposeDb(ownerDb);
          await disposeDb(joinerDb);
        }
      },
    },
    {
      name: "a data-carrying re-join is refused, but a second room still joins",
      async run() {
        const ownerDb = await freshDb();
        const joinerDb = await freshDb();
        const otherDb = await freshDb();
        try {
          const { fragment, joinerRoom } = await joinedRoom(ownerDb, joinerDb);

          // A re-pair with NO data is allowed — that is how a rotation re-joins.
          assertEqual((await joinRoom(fragment, deps(joinerDb, DEVICE_B))).ok, true, "empty re-join");
          // With data it is refused, and the refusal is ROOM-scoped.
          await executeCommand(
            joinerDb,
            { cmdId: "c1", roomId: joinerRoom.roomId, kind: "putItem", locationId: "loc-1", item: { name: "Dune" } },
            { deviceId: DEVICE_B, now: () => WALL },
          );
          const again = await joinRoom(fragment, deps(joinerDb, DEVICE_B));
          assertEqual(again.ok, false, "refused");
          assertEqual(again.reason, "room-exists", "room-scoped, not device-scoped");

          // A DIFFERENT room on the same device must still join (audit-2 N10).
          const second = await ownerRoom(otherDb, 9);
          const secondQr = mintJoinFragment(second);
          assert(secondQr.ok, "pairable");
          assert(secondQr.fragment !== fragment, "and it is a different room");
          const joined = await joinRoom(secondQr.fragment, deps(joinerDb, DEVICE_B));
          assertEqual(joined.ok, true, "a multi-room device is not a merge hazard");
        } finally {
          await disposeDb(ownerDb);
          await disposeDb(joinerDb);
          await disposeDb(otherDb);
        }
      },
    },
    // ── admit ─────────────────────────────────────────────────────────────
    {
      name: "the owner admits a peer by signing an epoch; the peer adopts it",
      async run() {
        const ownerDb = await freshDb();
        const joinerDb = await freshDb();
        try {
          const { ownerRoom: owner, joinerRoom: joiner } = await joinedRoom(ownerDb, joinerDb);

          const admitted = await admitDevice(owner.roomId, DEVICE_B, deps(ownerDb, DEVICE_A));
          assert(admitted.ok === true, `admitted: ${admitted.reason ?? ""}`);
          assertEqual(admitted.op.kind, "roster-epoch", "a roster-epoch op");
          assertEqual(admitted.op.epoch, 2, "epoch 2");
          assertEqual(admitted.room.roster.length, 2, "the owner's roster grew");

          assertEqual((await applyControlOp(joinerDb, joiner.roomId, admitted.op)).ok, true, "the peer adopts it");
          const peerRoom = await readRoom(joinerDb, joiner.roomId);
          assertEqual(peerRoom.roster.length, 2, "and now sees itself as a member");
          assertDeepEqual(assertConsistent(peerRoom), [], "chain and roster agree");

          const twice = await admitDevice(owner.roomId, DEVICE_B, deps(ownerDb, DEVICE_A));
          assertEqual(twice.reason, "already-a-member", "idempotent");
        } finally {
          await disposeDb(ownerDb);
          await disposeDb(joinerDb);
        }
      },
    },
    {
      name: "a non-owner cannot admit anyone",
      async run() {
        const ownerDb = await freshDb();
        const joinerDb = await freshDb();
        try {
          const { joinerRoom } = await joinedRoom(ownerDb, joinerDb);
          const attempt = await admitDevice(joinerRoom.roomId, "someone", deps(joinerDb, DEVICE_B));
          assertEqual(attempt.ok, false, "refused");
          assertEqual(attempt.reason, "not-the-owner", "because only the owner signs epochs");
          assertEqual((await readRoom(joinerDb, joinerRoom.roomId)).roster.length, 1, "nothing changed");
        } finally {
          await disposeDb(ownerDb);
          await disposeDb(joinerDb);
        }
      },
    },
    // ── revoke → rotate → re-pair ─────────────────────────────────────────
    {
      name: "revocation removes the member, rotates the key, and notifies the old room",
      async run() {
        const ownerDb = await freshDb();
        const joinerDb = await freshDb();
        try {
          const { ownerRoom: owner, joinerRoom: joiner } = await joinedRoom(ownerDb, joinerDb);
          await admitDevice(owner.roomId, DEVICE_B, deps(ownerDb, DEVICE_A));
          const before = (await readRoom(ownerDb, owner.roomId)).roomKey;

          const revoked = await revokeDevice(owner.roomId, DEVICE_B, deps(ownerDb, DEVICE_A, 5));
          assert("notice" in revoked, `revoked: ${revoked.reason ?? ""}`);
          assertEqual(revoked.room.roster.length, 1, "the member is gone");
          assertEqual(revoked.room.keyGen, 2, "the generation moved");
          assert(revoked.room.roomKey !== before, "and the key is new");
          assertEqual(revoked.notice.kind, "rotate-key", "the notice is a rotate-key op");
          assertEqual("roomKey" in revoked.notice, false, "carrying no key material");

          const notice = await ownerDb.meta.get(`notice:${owner.roomId}:1`);
          assert(notice !== undefined, "the old generation is kept to serve the notice");
          assert(notice.expiresAt > WALL, "for the notice window");
          assertEqual(notice.roomKey, before, "and it holds the OLD key");

          // The stale member receives the notice and stops minting.
          assertEqual((await applyControlOp(joinerDb, joiner.roomId, revoked.notice)).ok, true, "accepted");
          const stale = await readRoom(joinerDb, joiner.roomId);
          assertEqual(stale.rotationPending, 2, "and knows it must re-pair");
          assertEqual(stale.roomKey, before, "its old key did not magically change");
          await assertRejects(
            () =>
              executeCommand(
                joinerDb,
                { cmdId: "c1", roomId: joiner.roomId, kind: "putItem", locationId: "loc-1", item: { name: "late" } },
                { deviceId: DEVICE_B, now: () => WALL },
              ),
            "a stale member can no longer mint into the old room",
          );
        } finally {
          await disposeDb(ownerDb);
          await disposeDb(joinerDb);
        }
      },
    },
    {
      name: "a non-member cannot be revoked and the owner cannot revoke itself",
      async run() {
        await withDb(async (db) => {
          const room = await ownerRoom(db);
          assertEqual(
            (await revokeDevice(room.roomId, DEVICE_B, deps(db, DEVICE_A))).reason,
            "not-a-member",
            "a stranger",
          );
          assertEqual(
            (await revokeDevice(room.roomId, DEVICE_A, deps(db, DEVICE_A))).reason,
            "cannot-remove-the-owner",
            "the owner",
          );
          const after = await readRoom(db, room.roomId);
          assertEqual(after.keyGen, 1, "and no rotation happened");
          assertEqual(after.roomKey, room.roomKey, "the key is untouched");
        });
      },
    },
    // ── leave ─────────────────────────────────────────────────────────────
    {
      name: "leaving purges the exact set and keeps the signed statement",
      async run() {
        const ownerDb = await freshDb();
        const joinerDb = await freshDb();
        try {
          const { joinerRoom: joiner } = await joinedRoom(ownerDb, joinerDb);
          const roomId = joiner.roomId;

          await executeCommand(
            joinerDb,
            { cmdId: "c1", roomId, kind: "putItem", locationId: "loc-1", item: { name: "Dune" } },
            { deviceId: DEVICE_B, now: () => WALL },
          );
          await joinerDb.files.put({
            roomId,
            hash: "hash-1",
            bytes: new Uint8Array([1, 2, 3]),
            size: 3,
            contentType: "image/png",
            createdAt: WALL,
          });
          await joinerDb.snapshots.put({ roomId, at: WALL });
          assert((await joinerDb.ops.count()) > 0, "there is a log to purge");

          await leaveRoom(roomId, deps(joinerDb, DEVICE_B));

          assertEqual(await joinerDb.profiles.get(roomId), undefined, "profile gone");
          assertEqual(await joinerDb.items.count(), 0, "items gone");
          assertEqual(await joinerDb.ops.count(), 0, "ops gone");
          assertEqual(await joinerDb.outbox.count(), 0, "outbox gone");
          assertEqual(await joinerDb.files.count(), 0, "files gone");
          assertEqual(await joinerDb.snapshots.count(), 0, "snapshots gone");
          assertEqual(await readRoom(joinerDb, roomId), undefined, "room meta gone");

          const statement = await joinerDb.meta.get(leaveKey(roomId));
          assert(statement !== undefined, "the leave statement survived the purge");
          assertEqual(typeof statement.sig, "string", "and it is signed");
          assertEqual(statement.deviceId, DEVICE_B, "by the leaving device");
        } finally {
          await disposeDb(ownerDb);
          await disposeDb(joinerDb);
        }
      },
    },
    {
      name: "the owner cannot leave its own room",
      async run() {
        await withDb(async (db) => {
          const room = await ownerRoom(db);
          await assertRejects(() => leaveRoom(room.roomId, deps(db, DEVICE_A)), "the owner cannot leave");
          assert((await readRoom(db, room.roomId)) !== undefined, "and nothing was purged");
        });
      },
    },
    // ── the deleted stopgap ───────────────────────────────────────────────
    {
      name: "contact no longer touches the roster (admitPeerToRoster is gone)",
      async run() {
        await withDb(async (db) => {
          await seedRoom(db);
          const { recordPeerCursors, touchPeer } = await import("../../src/lib/outbox.ts");
          await recordPeerCursors(db, ROOM_A, "stranger", { [DEVICE_A]: 5 }, WALL);
          await touchPeer(db, ROOM_A, "another-stranger", WALL);
          const room = await readRoom(db, ROOM_A);
          assertEqual(room.roster.length, 1, "the roster did not grow");
          assertEqual(room.lastSeen.stranger, WALL, "but contact was recorded");
          assertEqual(room.peerCursors.stranger[DEVICE_A], 5, "and so were the cursors");
          assertEqual(room.roomKey, ROOM_KEY, "and the room is unchanged otherwise");
        });
      },
    },
  ],
};
