/**
 * keys.ts — the per-device Ed25519 identity (plan §6.7, §12.3, §15.8).
 *
 * One keypair per DEVICE, not per room: it signs control ops for every room the
 * device belongs to, so a member's identity is stable across rooms and a room
 * cannot mint itself a fresh identity to escape a revocation.
 *
 * ── Why the private key is stored exportable ──────────────────────────────
 *
 * WebCrypto keys are not persistable. A non-extractable keypair dies with the
 * JS context, which for a `SharedWorker` means every tab close — so a device
 * that could not export its key could never sign anything twice. The private
 * key therefore lives in Dexie in the clear (`meta.deviceKeys`), which is the
 * plan's own shape (§15.8: `{ pub, priv }`).
 *
 * That is a real limitation and it is not hidden: any script running in this
 * origin can read the key, so an XSS is a full identity compromise for every
 * room the device belongs to. The alternative — a passphrase-wrapped key — is a
 * product decision (it needs an unlock flow on every app open), not a protocol
 * one, and it can be added later without changing a single signature byte.
 *
 * ── Why PKCS#8 and not the raw seed ───────────────────────────────────────
 *
 * `exportKey("raw")` on an Ed25519 private key is not universally implemented;
 * PKCS#8 is, in every engine that implements Ed25519 at all, and importing it
 * back is symmetric. The wire form is the RAW public key (32 bytes), because
 * that is what a QR fragment carries.
 */

import type { OwlshelfDB } from "./db";
import { META_KEYS } from "./stores";

export const DEVICE_KEY_ALGORITHM = "Ed25519";
/** A raw Ed25519 public key is exactly 32 bytes. Anything else is refused at
 *  the fragment parser, not at first verify. */
export const PUBLIC_KEY_BYTES = 32;

export interface DeviceKeys {
  /** base64url raw public key (32 bytes). */
  pub: string;
  /** base64url PKCS#8 private key. */
  priv: string;
}

// ─── base64url ─────────────────────────────────────────────────────────────

export function bytesToB64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const normalised = value.replace(/-/g, "+").replace(/_/g, "/");
  const pad = normalised.length % 4 === 0 ? "" : "=".repeat(4 - (normalised.length % 4));
  const binary = atob(normalised + pad);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

// ─── The algorithm identifier ──────────────────────────────────────────────
//
// TypeScript's DOM lib does not list "Ed25519" in `AlgorithmIdentifier`, so the
// constant is used through a narrow cast rather than `as any` at every call.

const ALGORITHM = { name: DEVICE_KEY_ALGORITHM } as unknown as Algorithm;

// ─── Import / export ───────────────────────────────────────────────────────

/** Import a stored private key for signing. Never cached: a key object is
 *  cheap to rebuild and caching it would keep key material reachable from a
 *  long-lived closure. */
export async function importSigningKey(priv: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("pkcs8", b64urlToBytes(priv), ALGORITHM, false, ["sign"]);
}

/** Import a public key for verification. */
export async function importVerifyKey(pub: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", b64urlToBytes(pub), ALGORITHM, false, ["verify"]);
}

/** Sign `bytes`. Signature is 64 bytes, base64url on the wire. */
export async function sign(priv: string, bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const key = await importSigningKey(priv);
  return bytesToB64url(new Uint8Array(await crypto.subtle.sign(ALGORITHM, key, bytes)));
}

/**
 * Verify `signature` over `bytes`.
 *
 * Returns false for EVERY failure — a malformed key, a truncated signature, a
 * wrong length — rather than throwing. A verify path that throws is a verify
 * path whose caller can accidentally catch its way into accepting.
 */
export async function verify(
  pub: string,
  bytes: Uint8Array<ArrayBuffer>,
  signature: string,
): Promise<boolean> {
  let key: CryptoKey;
  try {
    const raw = b64urlToBytes(pub);
    if (raw.length !== PUBLIC_KEY_BYTES) return false;
    key = await importVerifyKey(pub);
  } catch {
    return false;
  }
  try {
    const sig = b64urlToBytes(signature);
    if (sig.length !== 64) return false;
    return await crypto.subtle.verify(ALGORITHM, key, sig, bytes);
  } catch {
    return false;
  }
}

// ─── Persistence ───────────────────────────────────────────────────────────

/**
 * One promise per database, so the worker and every harness db each mint
 * exactly one identity. A module-level singleton would hand the harness's
 * isolated databases the same key, which would make "two devices" a lie.
 */
const keyPromises = new WeakMap<OwlshelfDB, Promise<DeviceKeys>>();

async function mintKeys(): Promise<DeviceKeys> {
  const pair = (await crypto.subtle.generateKey(ALGORITHM, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const pub = bytesToB64url(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)));
  const priv = bytesToB64url(new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey)));
  return { pub, priv };
}

/**
 * Read the device's keypair, minting it on first use.
 *
 * Transactional check-then-put, the same discipline as `getDeviceId`: two tabs
 * racing on a fresh device must not each mint a key and have the loser's
 * signatures rejected by a room that pinned the winner. The re-read inside the
 * transaction is what makes it a check and not a hope.
 *
 * Returns the STORED record, not the minted one, so a loser of the race signs
 * with the key the room actually knows.
 */
export function getDeviceKeys(db: OwlshelfDB): Promise<DeviceKeys> {
  const existing = keyPromises.get(db);
  if (existing) return existing;

  const promise = (async (): Promise<DeviceKeys> => {
    const row = await db.meta.get(META_KEYS.deviceKeys);
    if (isDeviceKeys(row)) return { pub: row.pub, priv: row.priv };

    const minted = await mintKeys();
    return db.transaction("rw", db.meta, async () => {
      const again = await db.meta.get(META_KEYS.deviceKeys);
      if (isDeviceKeys(again)) return { pub: again.pub, priv: again.priv };
      await db.meta.put({ key: META_KEYS.deviceKeys, ...minted });
      return minted;
    });
  })().catch((error: unknown) => {
    // A failed mint must not be cached, or the device is stuck keyless.
    keyPromises.delete(db);
    throw error;
  });

  keyPromises.set(db, promise);
  return promise;
}

function isDeviceKeys(row: unknown): row is { pub: string; priv: string } {
  if (typeof row !== "object" || row === null) return false;
  const record = row as Record<string, unknown>;
  return typeof record.pub === "string" && typeof record.priv === "string";
}

/** Test seam only: forget the cached promise for a database. */
export function resetDeviceKeys(db: OwlshelfDB): void {
  keyPromises.delete(db);
}
