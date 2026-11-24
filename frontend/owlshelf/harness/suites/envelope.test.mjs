/**
 * envelope.test.mjs — the sealed wire shape (§6.6, §15.4, §15.1 consumer 2).
 *
 * The AEAD tag is the ONLY cryptographic gate in the whole protocol: the relay
 * cannot check it, so a cross-room, tampered, or replayed frame must die here
 * or not at all. Every test below is a way that gate could be bypassed.
 */

import {
  ENVELOPE_KINDS,
  NONCE_BYTES,
  b64ToBytes,
  b64urlToBytes,
  bytesToB64,
  bytesToB64url,
  clearKeyCache,
  isEnvelope,
  matchesRoom,
  open,
  roomHash,
  roomKeyBytes,
  seal,
} from "../../src/lib/envelope.ts";
import { assert, assertDeepEqual, assertEqual, assertRejects } from "../lib/assert.mjs";

const KEY = bytesToB64url(new Uint8Array(32).fill(1));
const OTHER_KEY = bytesToB64url(new Uint8Array(32).fill(2));
const ROOM = "room-a";

function flipByte(b64) {
  const bytes = b64ToBytes(b64);
  bytes[bytes.length - 1] ^= 0xff;
  return bytesToB64(bytes);
}

export default {
  name: "envelope — AEAD seal/open and the three gates (§6.6)",
  tests: [
    {
      name: "base64 and base64url round-trip",
      async run() {
        const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
        assertDeepEqual(Array.from(b64ToBytes(bytesToB64(bytes))), Array.from(bytes), "base64");
        assertDeepEqual(
          Array.from(b64urlToBytes(bytesToB64url(bytes))),
          Array.from(bytes),
          "base64url",
        );
        assert(!bytesToB64url(bytes).includes("="), "base64url is unpadded");
      },
    },
    {
      name: "the room key must be exactly 32 bytes",
      async run() {
        assertEqual(roomKeyBytes(KEY).length, 32, "32 bytes");
        await assertRejects(
          async () => roomKeyBytes(bytesToB64url(new Uint8Array(16).fill(1))),
          "a 16-byte key must be refused, not stretched",
        );
      },
    },
    {
      name: "the room hash is sha256 of the key bytes, 64 lowercase hex",
      async run() {
        const hash = await roomHash(KEY);
        assertEqual(hash.length, 64, "64 chars");
        assert(/^[0-9a-f]{64}$/.test(hash), "lowercase hex");
        // Deterministic and key-dependent.
        assertEqual(await roomHash(KEY), hash, "stable");
        assert((await roomHash(OTHER_KEY)) !== hash, "a different key is a different room");
      },
    },
    {
      name: "seal then open round-trips the body",
      async run() {
        const body = { requestId: "r1", cursors: { "dev-a": 3 } };
        const envelope = await seal(KEY, ROOM, 1, "catchup-request", body);
        assertEqual(envelope.v, 1, "version");
        assertEqual(envelope.roomId, ROOM, "roomId");
        assertEqual(envelope.keyGen, 1, "keyGen");
        assertEqual(envelope.kind, "catchup-request", "kind");
        assertDeepEqual(await open(KEY, envelope), body, "body");
      },
    },
    {
      name: "the body is base64(nonce || ciphertext), nonce first",
      async run() {
        const envelope = await seal(KEY, ROOM, 1, "op", { a: 1 });
        const raw = b64ToBytes(envelope.body);
        // 12-byte nonce + ciphertext + 16-byte GCM tag.
        assert(raw.length > NONCE_BYTES + 16, "longer than nonce + tag");
        const nonce = raw.subarray(0, NONCE_BYTES);
        assertEqual(nonce.length, 12, "96-bit nonce");
      },
    },
    {
      name: "every seal uses a FRESH nonce",
      async run() {
        // Reusing a nonce under one key breaks GCM completely, so two seals of
        // the same body must never produce the same bytes.
        const a = await seal(KEY, ROOM, 1, "op", { a: 1 });
        const b = await seal(KEY, ROOM, 1, "op", { a: 1 });
        assert(a.body !== b.body, "identical bodies must seal differently");
      },
    },
    {
      name: "a tampered ciphertext fails the tag",
      async run() {
        const envelope = await seal(KEY, ROOM, 1, "op", { a: 1 });
        const tampered = { ...envelope, body: flipByte(envelope.body) };
        assertEqual(await open(KEY, tampered), null, "tampered body");
      },
    },
    {
      name: "a cross-room envelope fails the tag — gate three",
      async run() {
        // The relay's string check and the client's socket-room check are the
        // first two gates; this is the one an attacker cannot forge past.
        const envelope = await seal(KEY, ROOM, 1, "op", { a: 1 });
        const relabelled = { ...envelope, roomId: "room-b" };
        assertEqual(await open(KEY, relabelled), null, "roomId is bound into the AD");
      },
    },
    {
      name: "a stale keyGen fails the tag",
      async run() {
        const envelope = await seal(KEY, ROOM, 1, "op", { a: 1 });
        assertEqual(await open(KEY, { ...envelope, keyGen: 2 }), null, "keyGen is bound");
      },
    },
    {
      name: "a relabelled kind fails the tag",
      async run() {
        // Without this, an `op` could be replayed as an `audit` and poison the
        // high-water marks the ack rule trusts.
        const envelope = await seal(KEY, ROOM, 1, "op", { a: 1 });
        assertEqual(await open(KEY, { ...envelope, kind: "audit" }), null, "kind is bound");
      },
    },
    {
      name: "the wrong room key fails the tag",
      async run() {
        const envelope = await seal(KEY, ROOM, 1, "op", { a: 1 });
        assertEqual(await open(OTHER_KEY, envelope), null, "wrong key");
      },
    },
    {
      name: "a truncated body is refused, not decrypted",
      async run() {
        const envelope = await seal(KEY, ROOM, 1, "op", { a: 1 });
        const raw = b64ToBytes(envelope.body);
        const short = bytesToB64(raw.subarray(0, NONCE_BYTES));
        assertEqual(await open(KEY, { ...envelope, body: short }), null, "nonce only");
        assertEqual(await open(KEY, { ...envelope, body: "" }), null, "empty");
        assertEqual(await open(KEY, { ...envelope, body: "!!not base64!!" }), null, "garbage");
      },
    },
    {
      name: "isEnvelope accepts every kind in the closed union",
      async run() {
        for (const kind of ENVELOPE_KINDS) {
          const envelope = await seal(KEY, ROOM, 1, kind, {});
          assert(isEnvelope(envelope), `kind ${kind}`);
        }
      },
    },
    {
      name: "isEnvelope rejects a kind outside the union",
      async run() {
        const envelope = await seal(KEY, ROOM, 1, "op", {});
        assert(!isEnvelope({ ...envelope, kind: "nope" }), "unknown kind");
        assert(!isEnvelope({ ...envelope, kind: "presence" }), "the relay's own frame kind");
        assert(!isEnvelope({ ...envelope, v: 2 }), "unknown version");
        assert(!isEnvelope({ ...envelope, body: "" }), "empty body");
        assert(!isEnvelope({ ...envelope, to: 123 }), "non-string to");
        assert(!isEnvelope(null), "null");
        assert(!isEnvelope([]), "array");
      },
    },
    {
      name: "matchesRoom is the client's socket-room check",
      async run() {
        const envelope = await seal(KEY, ROOM, 1, "op", {});
        assert(matchesRoom(envelope, ROOM, 1), "same room");
        assert(!matchesRoom(envelope, "room-b", 1), "different room");
        assert(!matchesRoom(envelope, ROOM, 2), "different generation");
      },
    },
    {
      name: "a `to` target survives the round trip",
      async run() {
        const envelope = await seal(KEY, ROOM, 1, "catchup-reply", { a: 1 }, { to: "conn-1" });
        assertEqual(envelope.to, "conn-1", "to");
        assertDeepEqual(await open(KEY, envelope), { a: 1 }, "body");
      },
    },
    {
      name: "a fixed nonce is honoured, and a wrong-length one is refused",
      async run() {
        const nonce = new Uint8Array(NONCE_BYTES).fill(7);
        const a = await seal(KEY, ROOM, 1, "op", { a: 1 }, { nonce });
        const b = await seal(KEY, ROOM, 1, "op", { a: 1 }, { nonce });
        assertEqual(a.body, b.body, "a fixed nonce is deterministic");
        await assertRejects(
          async () => seal(KEY, ROOM, 1, "op", {}, { nonce: new Uint8Array(8) }),
          "an 8-byte nonce must be refused",
        );
      },
    },
    {
      name: "the key cache does not leak across a rotation",
      async run() {
        const before = await seal(KEY, ROOM, 1, "op", { a: 1 });
        clearKeyCache();
        const after = await seal(KEY, ROOM, 1, "op", { a: 1 });
        assertDeepEqual(await open(KEY, before), { a: 1 }, "pre-rotation still opens");
        assertDeepEqual(await open(KEY, after), { a: 1 }, "post-rotation opens");
      },
    },
  ],
};
