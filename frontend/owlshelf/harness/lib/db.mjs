/**
 * db.mjs — an isolated database per test, built from the SHIPPED class.
 *
 * `OwlshelfDB` is imported from src/lib/db.ts, so the harness opens the same
 * schema declaration (stores.ts), the same v1→v2 upgrade transaction, and the
 * same `populate` gate the app uses. Nothing about the schema is restated
 * here — that is the whole point of audit-4 D5.
 */

import "fake-indexeddb/auto";
import { OwlshelfDB } from "../../src/lib/db.ts";

let counter = 0;

/** A fresh, empty database with the shipped v2 schema. */
export async function freshDb() {
  const name = `owlshelf-harness-${++counter}`;
  const db = new OwlshelfDB(name);
  await db.open();
  return db;
}

/** Close and delete. Safe to call twice. */
export async function disposeDb(db) {
  if (!db) return;
  try {
    await db.delete();
  } catch {
    db.close();
  }
}

/** Run `fn` against a fresh database and always clean up. */
export async function withDb(fn) {
  const db = await freshDb();
  try {
    return await fn(db);
  } finally {
    await disposeDb(db);
  }
}
