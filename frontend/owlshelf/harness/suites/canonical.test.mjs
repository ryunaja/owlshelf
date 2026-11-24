/**
 * canonical.test.mjs — §15.1's encoding rule, byte by byte.
 *
 * The primitives are asserted against HAND-COMPUTED bytes, not against the
 * implementation's own output: a length prefix that is off by one is exactly
 * the bug that makes two correct implementations disagree, and comparing the
 * code to itself cannot see it.
 *
 * The digests are pinned hex, produced by `tools/audit/vectors.py` — a SECOND
 * implementation written from the spec text rather than from `canonical.ts`.
 * That independence is the whole point (spec-gaps G1): a self-consistent
 * digest proves nothing about whether a second implementation agrees, and the
 * consistency audit's failure mode is two devices rebuilding forever on a room
 * that is already converged.
 */

import {
  associatedData,
  auditDigest,
  canonicalJson,
  compareBytes,
  concat,
  endDigest,
  lp,
  u32be,
  u64be,
  u8,
  utf8,
} from "../../src/lib/canonical.ts";
import { assert, assertDeepEqual, assertEqual, assertRejects } from "../lib/assert.mjs";

function bytes(value) {
  return Array.from(value);
}

export default {
  name: "canonical — the one encoding rule (§15.1)",
  tests: [
    {
      name: "u8 / u32be / u64be are fixed-width big-endian",
      async run() {
        assertDeepEqual(bytes(u8(0)), [0], "u8(0)");
        assertDeepEqual(bytes(u8(255)), [255], "u8(255)");
        assertDeepEqual(bytes(u32be(0)), [0, 0, 0, 0], "u32be(0)");
        assertDeepEqual(bytes(u32be(1)), [0, 0, 0, 1], "u32be(1)");
        assertDeepEqual(bytes(u32be(0x01020304)), [1, 2, 3, 4], "u32be(0x01020304)");
        assertDeepEqual(bytes(u64be(1)), [0, 0, 0, 0, 0, 0, 0, 1], "u64be(1)");
        assertDeepEqual(
          bytes(u64be(0x0102030405060708n)),
          [1, 2, 3, 4, 5, 6, 7, 8],
          "u64be(big)",
        );
      },
    },
    {
      name: "an out-of-range integer is rejected, never truncated",
      async run() {
        await assertRejects(async () => u8(256), "u8(256)");
        await assertRejects(async () => u8(-1), "u8(-1)");
        await assertRejects(async () => u32be(2 ** 32), "u32be(2^32)");
        await assertRejects(async () => u32be(1.5), "u32be(1.5)");
        await assertRejects(async () => u64be(-1), "u64be(-1)");
      },
    },
    {
      name: "a string is length-prefixed with its BYTE count, not its length",
      async run() {
        assertDeepEqual(bytes(lp("")), [0, 0, 0, 0], "lp('')");
        assertDeepEqual(bytes(lp("ab")), [0, 0, 0, 2, 0x61, 0x62], "lp('ab')");
        // "é" is 2 UTF-8 bytes but 1 UTF-16 code unit. A length prefix that
        // counted code units would produce a different digest for the same
        // string on a different encoder.
        assertDeepEqual(bytes(lp("é")), [0, 0, 0, 2, 0xc3, 0xa9], "lp('é')");
      },
    },
    {
      name: "concat preserves order and total length",
      async run() {
        assertDeepEqual(bytes(concat(u8(1), u8(2), u8(3))), [1, 2, 3], "three parts");
        assertDeepEqual(bytes(concat()), [], "no parts");
        assertEqual(concat(utf8("ab"), utf8("cd")).length, 4, "length");
      },
    },
    {
      name: "compareBytes orders by byte value, then by length",
      async run() {
        assertEqual(compareBytes(utf8("a"), utf8("b")), -1, "a < b");
        assertEqual(compareBytes(utf8("b"), utf8("a")), 1, "b > a");
        assertEqual(compareBytes(utf8("a"), utf8("a")), 0, "equal");
        assertEqual(compareBytes(utf8("ab"), utf8("a")), 1, "longer wins a prefix tie");
        assertEqual(compareBytes(utf8("a"), utf8("ab")), -1, "shorter loses a prefix tie");
      },
    },
    {
      name: "canonicalJson sorts keys by code unit and emits no whitespace",
      async run() {
        assertEqual(canonicalJson({ b: 1, a: 2 }), '{"a":2,"b":1}', "sorted");
        assertEqual(canonicalJson({ a: [1, 2] }), '{"a":[1,2]}', "array");
        assertEqual(canonicalJson(null), "null", "null");
        assertEqual(canonicalJson(true), "true", "true");
        assertEqual(canonicalJson("x"), '"x"', "string");
        assertEqual(canonicalJson({ a: undefined, b: 1 }), '{"b":1}', "undefined dropped");
      },
    },
    {
      name: "canonicalJson REJECTS a float rather than rounding it",
      async run() {
        // A digest over 1.0 and 1 must not be able to differ, and the only way
        // to guarantee that is to forbid the ambiguous form at the encoder.
        await assertRejects(async () => canonicalJson(1.5), "float");
        await assertRejects(async () => canonicalJson({ a: 0.1 }), "nested float");
      },
    },
    {
      name: "the AEAD associated data is exactly the §15.1 byte string",
      async run() {
        const ad = associatedData("room-a", 1, "op");
        const expected = [
          ...bytes(utf8("owlshelf/v1")),
          0x00,
          ...bytes(lp("room-a")),
          0x00,
          ...bytes(u32be(1)),
          0x00,
          ...bytes(utf8("op")),
        ];
        assertDeepEqual(bytes(ad), expected, "AD bytes");
        assertEqual(ad.length, 30, "AD length");
      },
    },
    {
      name: "the AD binds roomId, keyGen, and kind independently",
      async run() {
        const base = bytes(associatedData("room-a", 1, "op")).join(",");
        assert(base !== bytes(associatedData("room-b", 1, "op")).join(","), "roomId binds");
        assert(base !== bytes(associatedData("room-a", 2, "op")).join(","), "keyGen binds");
        assert(base !== bytes(associatedData("room-a", 1, "audit")).join(","), "kind binds");
      },
    },
    {
      name: "the end digest is over served ORDER, not sorted order",
      async run() {
        const forward = await endDigest(["op-1", "op-2"]);
        const reversed = await endDigest(["op-2", "op-1"]);
        assert(forward !== reversed, "a reorder must change the digest");
        assertEqual(forward.length, 64, "64 hex chars");
        assert(/^[0-9a-f]{64}$/.test(forward), "lowercase hex");
      },
    },
    {
      name: "the end digest of nothing is the digest of the empty string",
      async run() {
        const empty = await endDigest([]);
        assertEqual(empty.length, 64, "64 hex chars");
        // sha256("") — the well-known constant, so this is not self-referential.
        assertEqual(
          empty,
          "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
          "sha256 of the empty byte string",
        );
      },
    },
    {
      name: "known-answer: the AD byte string matches the independent implementation",
      async run() {
        // From tools/audit/vectors.py. A literal, not a re-derivation: the
        // point is that a second implementation produced these bytes.
        assertEqual(
          Buffer.from(associatedData("room-a", 1, "op")).toString("hex"),
          "6f776c7368656c662f76310000000006726f6f6d2d610000000001006f70",
          "AD(room-a, 1, op)",
        );
        assertEqual(
          Buffer.from(associatedData("room-a", 1, "audit")).toString("hex"),
          "6f776c7368656c662f76310000000006726f6f6d2d610000000001006175646974",
          "AD(room-a, 1, audit)",
        );
      },
    },
    {
      name: "known-answer: endDigest matches the independent implementation",
      async run() {
        assertEqual(
          await endDigest(["op-1", "op-2"]),
          "022c8efea661895b022ab1800d4ba8fa25d284c521d46bde1150abfac1458480",
          "served order",
        );
        assertEqual(
          await endDigest(["op-2", "op-1"]),
          "993a3c95bf1b2126070f43550b092bd955af7b82f547a91a1ba12f2588aa1024",
          "reversed",
        );
      },
    },
    {
      name: "known-answer: auditDigest matches the independent implementation",
      async run() {
        const rows = [
          { table: "items", rowId: "item-1", winner: "1000:0:0:dev-a:op-1", deletedAt: null },
          { table: "profiles", rowId: "prof-1", winner: "900:2:1:dev-b:op-2", deletedAt: 1234 },
        ];
        const counts = { "dev-a": 3, "dev-b": 1 };

        assertEqual(
          await auditDigest(rows, counts),
          "eb9bf249f61cc78a0a23452239500e13feb2b56afd20d2e5b4e1f183cd3138f6",
          "rows + counts",
        );
        assertEqual(
          await auditDigest([rows[1], rows[0]], counts),
          "eb9bf249f61cc78a0a23452239500e13feb2b56afd20d2e5b4e1f183cd3138f6",
          "the same digest from the reversed input",
        );
        assertEqual(
          await auditDigest(rows, { "dev-a": 4, "dev-b": 1 }),
          "9e707c2c617cba275917de9b73e59ea25e55d472f265e3ebb6445615464d4883",
          "one more adopted op",
        );
      },
    },
    {
      name: "the audit digest is stable and order-independent over its input",
      async run() {
        const rows = [
          { table: "items", rowId: "i1", winner: "1000:0:0:dev-a:op-1", deletedAt: null },
          { table: "profiles", rowId: "p1", winner: "900:0:0:dev-a:op-0", deletedAt: null },
          { table: "locations", rowId: "l1", winner: "950:0:1:dev-b:op-2", deletedAt: 1200 },
        ];
        const counts = { "dev-b": 2, "dev-a": 1 };

        const forward = await auditDigest(rows, counts);
        const shuffled = await auditDigest([rows[2], rows[0], rows[1]], counts);
        assertEqual(forward, shuffled, "input order must not matter");
        assert(/^[0-9a-f]{64}$/.test(forward), "lowercase hex");
      },
    },
    {
      name: "the audit digest sees the LOG's shape, not just its rows",
      async run() {
        // audit-4 R4-P2-5: a rows-only digest made two devices with different
        // `pending` depths produce identical digests while their derived
        // conflict lists differed.
        const rows = [
          { table: "items", rowId: "i1", winner: "1000:0:0:dev-a:op-1", deletedAt: null },
        ];
        const a = await auditDigest(rows, { "dev-a": 1 });
        const b = await auditDigest(rows, { "dev-a": 2 });
        assert(a !== b, "a different adopted-op count must change the digest");
      },
    },
    {
      name: "a tombstone digests differently from a live row",
      async run() {
        const live = [{ table: "items", rowId: "i1", winner: "1000:0:0:dev-a:op-1", deletedAt: null }];
        const dead = [{ table: "items", rowId: "i1", winner: "1000:0:0:dev-a:op-1", deletedAt: 0 }];
        const a = await auditDigest(live, {});
        const b = await auditDigest(dead, {});
        assert(a !== b, "deletedAt: 0 is a tombstone, not a live row");
      },
    },
    {
      name: "a row with no winner cannot be digested",
      async run() {
        await assertRejects(
          async () => auditDigest([{ table: "items", rowId: "i1", winner: null, deletedAt: null }], {}),
          "a winnerless row has no position in the total order",
        );
      },
    },
  ],
};
