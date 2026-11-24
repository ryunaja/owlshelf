/**
 * envelope.ts — the sealed wire shape (plan §6.6, §15.4, §15.1 consumer 2).
 *
 * Every wire message is one canonical, versioned, room-bound shape, with
 * exactly one exception: the relay-generated `presence` frame, which carries
 * no keyGen and no body because the relay cannot seal anything.
 *
 * ONLY routing fields are plaintext: v, roomId, keyGen, kind, to, from.
 * EVERYTHING else — ops, cursors, digests, blob control — lives inside `body`.
 * The original catch-up shape put `ops` and `cursors` top-level, so the relay
 * would have seen plaintext history, contradicting §10's "ciphertext and
 * routing metadata only" (review-2 P1-4).
 *
 * AEAD is v1 protocol baseline, not a v2 nicety. A tampered, injected, or
 * replayed envelope fails its authentication tag and is dropped WITHOUT
 * touching durable state (P0-7).
 */

import { associatedData, concat, utf8 } from "./canonical";
import { sha256Hex } from "./hash";

export const PROTOCOL_VERSION = 1;
export const NONCE_BYTES = 12;
export const KEY_BYTES = 32;

/** §6.6's CLOSED union. An unlisted kind is dropped at both ends. */
export const ENVELOPE_KINDS = [
  "op",
  "control",
  "catchup-request",
  "catchup-reply",
  "blob-request",
  "file-chunk",
  "audit",
  "audit-bisect",
] as const;

export type EnvelopeKind = (typeof ENVELOPE_KINDS)[number];

const KIND_SET: ReadonlySet<string> = new Set(ENVELOPE_KINDS);

export interface Envelope {
  v: number;
  roomId: string;
  keyGen: number;
  kind: EnvelopeKind;
  /** Optional targeted delivery: a connectionId. */
  to?: string;
  /** Stamped by the RELAY on every forwarded message, never by a client. */
  from?: string;
  /** base64(nonce || ciphertext). */
  body: string;
}

// ─── base64 ────────────────────────────────────────────────────────────────

/** base64url → bytes. The room key's wire form. */
export function b64urlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const normalised = value.replace(/-/g, "+").replace(/_/g, "/");
  const pad = normalised.length % 4 === 0 ? "" : "=".repeat(4 - (normalised.length % 4));
  const binary = atob(normalised + pad);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

/** bytes → base64url, unpadded. */
export function bytesToB64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** bytes → standard base64. The `body` field's wire form. */
export function bytesToB64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** standard base64 → bytes. */
export function b64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

// ─── Room identity ─────────────────────────────────────────────────────────

/**
 * §15.1 consumer 1: `sha256(roomKey)` — 64 lowercase hex of the ASCII hex
 * string. The client computes it ONCE and sends it; the relay never hashes.
 */
export async function roomHash(roomKeyB64: string): Promise<string> {
  return sha256Hex(roomKeyBytes(roomKeyB64));
}

/** The raw 32-byte room key. Throws on a wrong-length key rather than
 *  silently deriving a different one. */
export function roomKeyBytes(roomKeyB64: string): Uint8Array<ArrayBuffer> {
  const bytes = b64urlToBytes(roomKeyB64);
  if (bytes.length !== KEY_BYTES) {
    throw new Error(`room key must be ${KEY_BYTES} bytes, got ${bytes.length}`);
  }
  return bytes;
}

// ─── Key cache ─────────────────────────────────────────────────────────────

// Importing a CryptoKey is not free and the same room key is used for every
// frame on a socket. Keyed by the b64 form so a rotation is a new entry, never
// a stale hit.
const keyCache = new Map<string, Promise<CryptoKey>>();

function importRoomKey(roomKeyB64: string): Promise<CryptoKey> {
  let cached = keyCache.get(roomKeyB64);
  if (!cached) {
    cached = crypto.subtle.importKey(
      "raw",
      roomKeyBytes(roomKeyB64),
      "AES-GCM",
      false,
      ["encrypt", "decrypt"],
    );
    keyCache.set(roomKeyB64, cached);
  }
  return cached;
}

/** Test seam: drop cached keys so a rotation test starts clean. */
export function clearKeyCache(): void {
  keyCache.clear();
}

// ─── Shape ─────────────────────────────────────────────────────────────────

export function isEnvelope(value: unknown): value is Envelope {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Partial<Envelope>;
  if (candidate.v !== PROTOCOL_VERSION) return false;
  if (typeof candidate.roomId !== "string" || candidate.roomId.length === 0) return false;
  if (!Number.isInteger(candidate.keyGen)) return false;
  if (typeof candidate.kind !== "string" || !KIND_SET.has(candidate.kind)) return false;
  if (typeof candidate.body !== "string" || candidate.body.length === 0) return false;
  if (candidate.to !== undefined && typeof candidate.to !== "string") return false;
  return true;
}

/**
 * The client's socket-room check — gate two of three.
 *
 * Cheap and total, and it runs BEFORE the AEAD open so a cross-room frame
 * never reaches the decrypt path. The AEAD tag is the real binding; this is
 * the one that costs nothing.
 */
export function matchesRoom(envelope: Envelope, roomId: string, keyGen: number): boolean {
  return envelope.roomId === roomId && envelope.keyGen === keyGen;
}

// ─── Seal / open ───────────────────────────────────────────────────────────

export interface SealOptions {
  to?: string;
  /** Test seam: a fixed nonce. Production always uses a fresh random one. */
  nonce?: Uint8Array<ArrayBuffer>;
}

/**
 * Seal one body into an envelope.
 *
 * The nonce is 12 random bytes per frame. Reusing a nonce under one key
 * breaks GCM completely, so there is no counter and no derivation — a fresh
 * `getRandomValues` per seal is the only safe default.
 */
export async function seal(
  roomKeyB64: string,
  roomId: string,
  keyGen: number,
  kind: EnvelopeKind,
  body: unknown,
  options: SealOptions = {},
): Promise<Envelope> {
  const key = await importRoomKey(roomKeyB64);
  const nonce = options.nonce ?? crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  if (nonce.length !== NONCE_BYTES) {
    throw new Error(`nonce must be ${NONCE_BYTES} bytes, got ${nonce.length}`);
  }

  const plaintext = utf8(JSON.stringify(body));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce, additionalData: associatedData(roomId, keyGen, kind) },
      key,
      plaintext,
    ),
  );

  const envelope: Envelope = {
    v: PROTOCOL_VERSION,
    roomId,
    keyGen,
    kind,
    body: bytesToB64(concat(nonce, ciphertext)),
  };
  if (options.to !== undefined) envelope.to = options.to;
  return envelope;
}

/**
 * Open one envelope. Returns null on ANY failure — a bad tag, a truncated
 * body, a wrong room, or unparseable plaintext.
 *
 * Null rather than a throw is deliberate: a forged or replayed frame is an
 * expected event, not an exception, and the caller's only correct response is
 * to drop it without touching durable state (P0-7).
 */
export async function open(
  roomKeyB64: string,
  envelope: Envelope,
): Promise<unknown | null> {
  if (!isEnvelope(envelope)) return null;

  let raw: Uint8Array<ArrayBuffer>;
  try {
    raw = b64ToBytes(envelope.body);
  } catch {
    return null;
  }
  if (raw.length <= NONCE_BYTES) return null;

  const nonce = raw.subarray(0, NONCE_BYTES);
  const ciphertext = raw.subarray(NONCE_BYTES);

  try {
    const key = await importRoomKey(roomKeyB64);
    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: nonce,
        additionalData: associatedData(envelope.roomId, envelope.keyGen, envelope.kind),
      },
      key,
      ciphertext,
    );
    return JSON.parse(new TextDecoder().decode(plaintext));
  } catch {
    return null;
  }
}
