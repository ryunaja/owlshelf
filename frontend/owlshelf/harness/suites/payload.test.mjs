/**
 * payload.test.mjs — plan §15.3, executed.
 *
 * The reducer writes payload fields FLAT onto rows that also carry
 * reducer-owned columns, so the allowlist is a security boundary, not
 * tidiness: an inbound `payload: { winner, deletedAt }` would otherwise make
 * the total order for that row attacker-chosen.
 */

import {
  MAX_PAYLOAD_BYTES,
  normalizePutPayload,
  normalizeResolvePayload,
} from "../../src/lib/payload.ts";
import { assert, assertDeepEqual, assertEqual } from "../lib/assert.mjs";

export default {
  name: "payload — per-table validation (§15.3)",
  tests: [
    {
      name: "items: a full payload round-trips",
      run() {
        const result = normalizePutPayload("items", {
          name: "Dune",
          subtitle: "Frank Herbert",
          description: "SF",
          category: "Fiction",
          itemType: "book",
          stock: 2,
          condition: 4,
          tags: ["sf", "classic"],
          locationId: "loc-1",
          imageUrl: "idb://abc",
        });
        assertEqual(result.ok, true, "accepted");
        assertDeepEqual(
          result.value,
          {
            name: "Dune",
            subtitle: "Frank Herbert",
            description: "SF",
            category: "Fiction",
            itemType: "book",
            stock: 2,
            condition: 4,
            tags: ["sf", "classic"],
            locationId: "loc-1",
            imageUrl: "idb://abc",
          },
          "value",
        );
      },
    },
    {
      name: "items: absent optional fields take the documented defaults",
      run() {
        const result = normalizePutPayload("items", { name: "Dune", locationId: "loc-1" });
        assertEqual(result.ok, true, "accepted");
        assertEqual(result.value.subtitle, "", "subtitle");
        assertEqual(result.value.description, "", "description");
        assertEqual(result.value.category, "Uncategorized", "category");
        assertEqual(result.value.itemType, "other", "itemType");
        assertEqual(result.value.stock, 1, "stock");
        assertEqual(result.value.condition, 3, "condition");
        assertDeepEqual(result.value.tags, [], "tags");
        assertEqual("imageUrl" in result.value, false, "imageUrl stays absent");
      },
    },
    {
      name: "items: an empty name is malformed on receive and 'Untitled' on mint",
      run() {
        assertEqual(normalizePutPayload("items", { name: "", locationId: "l" }).ok, false, "receive rejects");
        assertEqual(normalizePutPayload("items", { locationId: "l" }).ok, false, "absent name rejects");
        const minted = normalizePutPayload("items", { name: "", locationId: "l" }, { side: "mint" });
        assertEqual(minted.ok, true, "mint accepts");
        assertEqual(minted.value.name, "Untitled", "mint default");
      },
    },
    {
      name: "items: unknown fields are dropped, not rejected",
      run() {
        const result = normalizePutPayload("items", {
          name: "Dune",
          locationId: "loc-1",
          somethingFromTheFuture: { nested: true },
        });
        assertEqual(result.ok, true, "accepted");
        assertEqual("somethingFromTheFuture" in result.value, false, "dropped");
      },
    },
    {
      name: "items: winner, deletedAt, id and profileId are never payload-writable",
      run() {
        const result = normalizePutPayload("items", {
          name: "Dune",
          locationId: "loc-1",
          winner: "9999999999:0:0:attacker:op",
          deletedAt: 0,
          id: "hijacked",
          profileId: "other-room",
        });
        assertEqual(result.ok, true, "accepted");
        for (const key of ["winner", "deletedAt", "id", "profileId"]) {
          assertEqual(key in result.value, false, `${key} stripped`);
        }
      },
    },
    {
      name: "items: out-of-range numbers are malformed",
      run() {
        assertEqual(normalizePutPayload("items", { name: "x", locationId: "l", stock: -1 }).ok, false, "stock -1");
        assertEqual(normalizePutPayload("items", { name: "x", locationId: "l", stock: 1_000_001 }).ok, false, "stock too big");
        assertEqual(normalizePutPayload("items", { name: "x", locationId: "l", stock: 1.5 }).ok, false, "fractional stock");
        assertEqual(normalizePutPayload("items", { name: "x", locationId: "l", condition: 0 }).ok, false, "condition 0");
        assertEqual(normalizePutPayload("items", { name: "x", locationId: "l", condition: 6 }).ok, false, "condition 6");
      },
    },
    {
      name: "items: tags are bounded in count and length",
      run() {
        const tooMany = Array.from({ length: 33 }, (_, i) => `t${i}`);
        assertEqual(normalizePutPayload("items", { name: "x", locationId: "l", tags: tooMany }).ok, false, "33 tags");
        assertEqual(normalizePutPayload("items", { name: "x", locationId: "l", tags: ["a".repeat(65)] }).ok, false, "65-char tag");
        assertEqual(normalizePutPayload("items", { name: "x", locationId: "l", tags: ["ok"] }).ok, true, "one tag");
      },
    },
    {
      name: "items: imageUrl must use idb:, data: or https:",
      run() {
        assertEqual(normalizePutPayload("items", { name: "x", locationId: "l", imageUrl: "javascript:alert(1)" }).ok, false, "javascript:");
        assertEqual(normalizePutPayload("items", { name: "x", locationId: "l", imageUrl: "http://x/y.png" }).ok, false, "http:");
        assertEqual(normalizePutPayload("items", { name: "x", locationId: "l", imageUrl: "https://x/y.png" }).ok, true, "https:");
        assertEqual(normalizePutPayload("items", { name: "x", locationId: "l", imageUrl: "data:image/png;base64,AA" }).ok, true, "data:");
      },
    },
    {
      name: "locations: itemCount is dropped (the denormalized counter being removed)",
      run() {
        const result = normalizePutPayload("locations", {
          name: "Shelf",
          icon: "📦",
          description: "",
          itemCount: 42,
        });
        assertEqual(result.ok, true, "accepted");
        assertEqual("itemCount" in result.value, false, "itemCount dropped");
      },
    },
    {
      name: "profiles: type is the one genuine closed union",
      run() {
        assertEqual(normalizePutPayload("profiles", { name: "S", type: "personal" }).ok, true, "personal");
        assertEqual(normalizePutPayload("profiles", { name: "S", type: "business" }).ok, true, "business");
        assertEqual(normalizePutPayload("profiles", { name: "S", type: "shared" }).ok, false, "shared");
        assertEqual(normalizePutPayload("profiles", { name: "", type: "personal" }).ok, false, "empty name");
      },
    },
    {
      name: "resolve: keeping the row REQUIRES content (audit-2 N11)",
      run() {
        assertEqual(normalizeResolvePayload("items", { keep: "row" }).ok, false, "no content");
        assertEqual(normalizeResolvePayload("items", { keep: "row", content: null }).ok, false, "null content");
        assertEqual(normalizeResolvePayload("items", { keep: "row", content: "x" }).ok, false, "string content");
        const ok = normalizeResolvePayload("items", { keep: "row", content: { name: "Dune", locationId: "l" } });
        assertEqual(ok.ok, true, "content accepted");
        assertEqual(ok.keep, "row", "keep");
      },
    },
    {
      name: "resolve: keep tombstone needs no content",
      run() {
        const result = normalizeResolvePayload("items", { keep: "tombstone" });
        assertEqual(result.ok, true, "accepted");
        assertEqual(result.keep, "tombstone", "keep");
        assertEqual(normalizeResolvePayload("items", { keep: "maybe" }).ok, false, "unknown keep");
      },
    },
    {
      name: "a payload over 64 KB is malformed",
      run() {
        const huge = { name: "x", locationId: "l", description: "a".repeat(MAX_PAYLOAD_BYTES) };
        assertEqual(normalizePutPayload("items", huge).ok, false, "over the cap");
      },
    },
  ],
};
