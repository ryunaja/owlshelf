/**
 * protocol.ts — the tab ↔ worker message contract (plan §6.6).
 *
 * §5's split rule: **the worker is the SINGLE WRITER.** Tabs own UI, reads,
 * image capture, and posting *semantic mutation commands*; they never write row
 * tables, never mint ops, never touch the clock. This file is the seam.
 *
 * ── The production list is the plan's, verbatim ───────────────────────────
 *
 * §6.6 formalises six messages and this file implements exactly those:
 *
 *   `cmd` (tab→worker) · `cmd-ack`/`cmd-error` (worker→tab) ·
 *   `visibility` (tab→worker state proxy) · `room-add`/`room-remove` ·
 *   `sync-status` (worker→tab)
 *
 * Two of them do more work than their names suggest, and both were nearly
 * re-invented as new messages before the plan was re-read:
 *
 *  - **`visibility` is also the resume trigger.** §7.1 says a visible tab, an
 *    `online` event and a `pageshow` all "resync all rooms". A tab that reports
 *    `hidden: false` IS that resync — the worker resumes every engine it holds.
 *    There is no separate `resync` message, and there should not be.
 *  - **`room-add`/`room-remove` are reference-counted per port.** One worker
 *    serves every tab, so tab A unmounting must not stop the engine tab B is
 *    still using. The engine stops when the last port that asked for the room
 *    lets go.
 *
 * ── The one addition, already on the record ───────────────────────────────
 *
 * `blob-demand` (tab→worker) and `blob-arrived` (worker→tab). §6.6 says blobs
 * are fetched by `blob-request` but never says who decides to send one; the tab
 * is the only thing that knows a render failed. `owlshelf-code-vs-plan.md` §4
 * records this as a plan gap, so it is an addition to the plan, not a
 * divergence from it.
 *
 * ── The dev block is not the app's protocol ───────────────────────────────
 *
 * `dev-*` exists because Gate G's panel drives a real engine from a tab, and
 * the engine now lives in the worker. It is instrumentation, it is opt-in
 * behind `?sync=1`, and nothing in the app path calls it. Keeping it in a
 * separate, prefixed block is what stops it from being mistaken for the
 * contract — the mistake this file's first draft made.
 *
 * Every request carries an `id` and every reply echoes it, because a port is a
 * single ordered stream shared by every in-flight command in the tab. A reply
 * without an id would be unattributable the moment two dialogs save at once.
 */

import type { Command, CommandAck, MoveResult } from "../cmd";
import type { SyncStatus } from "../sync";
import type { Profile } from "../../types/item";

/** A selection move: one command per item, reported per item (Gate E). */
export interface MoveManyRequest {
  /** Prefix; each item's command id is `${cmdId}:${itemId}`. */
  cmdId: string;
  roomId: string;
  itemIds: readonly string[];
  destination: { roomId: string; locationId: string };
  amount?: number;
}

/** One line in the worker's per-room envelope log (dev panel only). */
export interface SyncLogEntry {
  at: number;
  kind: string;
  from: string | undefined;
  detail: string;
}

/** The engine's live, non-durable state. Everything else is a DB read. */
export interface DevState {
  running: boolean;
  status: SyncStatus;
  connId: string | null;
  members: readonly string[];
  lastClose: { code: number; reason: string } | null;
  log: readonly SyncLogEntry[];
  /** `getDeviceId` persists on first call, so it is a WRITE and cannot be
   *  read from a tab (§5). The panel displays it, so it travels here. */
  deviceId: string | null;
}

/** Gate G's engine operations. Not part of the app's protocol. */
export type DevOp = "catchup" | "audit" | "drain" | "suspend" | "resume" | "blob-request";

/**
 * What a pairing action tells the tab.
 *
 * A refusal is a VALUE, not an error: the outer reply is `ok: true` and the
 * value is `{ok: false, reason}`. Rejecting the request instead would make
 * every caller treat "the user pasted the wrong code" as a transport failure,
 * and would lose the reason the dialog needs. Only a genuine failure (a closed
 * port, a dead worker) rejects.
 *
 * The reason stays a plain string on the wire, not a union: the tab renders copy
 * from `pairingErrors.ts`, and a tab running an older bundle than the worker
 * must print a generic sentence rather than crash on an unknown member. The
 * unions live where the values are minted.
 */
export type PairingReply =
  | {
      ok: true;
      roomId: string;
      keyGen?: number;
      /** Rotation only: whether the signed notice actually reached a socket.
       *  False means no peer was connected, and an offline peer learns nothing
       *  until it re-pairs — the share screen says so instead of implying a
       *  delivery that did not happen. */
      notified?: boolean;
    }
  | { ok: false; reason: string };

export type MintReply = { ok: true; fragment: string } | { ok: false; reason: string };

/** Everything the share screen and the rotation gate need, in one read. */
export interface RoomInfo {
  roomId: string;
  /** `getDeviceId` persists on first call, so only the worker can answer this. */
  deviceId: string | null;
  isOwner: boolean;
  keyGen: number;
  /** Set by a signed `rotate-key` notice: the room moved on without us. */
  rotationPending: number | null;
  /** A verified `rehome` op waiting for the user's consent (§6.7). */
  pendingRelayUrl: string | null;
  status: SyncStatus;
  /** Devices the live engine has seen. Empty when no engine is running. */
  peers: readonly string[];
  /**
   * Why the last connection ended, if it ended badly.
   *
   * This is the field that turns "it stopped syncing" into a code a user can
   * quote and a support thread can act on. It is cleared by a `synced` session,
   * because a failure the room has already recovered from is history.
   */
  lastClose: { code: number; reason: string } | null;
  /** Ops this device holds for the room — a join's "restoring" probe. */
  ops: number;
  running: boolean;
}

export type WorkerRequest =
  // ── The plan's six (§6.6) ────────────────────────────────────────────────
  | { id: number; kind: "cmd"; cmd: Command }
  | { id: number; kind: "move-many"; request: MoveManyRequest }
  | { id: number; kind: "create-profile"; data: Omit<Profile, "id"> }
  /** §5 detail 1: the worker has no `document`, so tabs proxy visibility.
   *  `hidden: false` is also §7.1's "resync all rooms". */
  | { id: number; kind: "visibility"; hidden: boolean }
  | { id: number; kind: "room-add"; roomId: string }
  | { id: number; kind: "room-remove"; roomId: string }
  // ── Pairing (§6.7) — the step-6 surface ──────────────────────────────────
  //
  // These are worker messages because every one of them WRITES: minting reads
  // the stored room (a tab could do that, but the fragment must come from the
  // room record, never from loose arguments), joining writes a room + profile,
  // revoking rotates the key, leaving purges the room. Two of them also need
  // `getDeviceId`, which is a write on first call (§5).
  /** The QR fragment for a room, at ITS current generation (create + re-pair). */
  | { id: number; kind: "pairing-mint"; roomId: string }
  /** Join a NEW room from a fragment. Refuses a room that already has data. */
  | { id: number; kind: "pairing-join"; text: string; name?: string }
  /** Adopt a rotation code for a room this device already holds (§6.7 step 4). */
  | { id: number; kind: "pairing-adopt"; text: string }
  /** Owner-only: roster-epoch + 1, then rotate the key. */
  | { id: number; kind: "pairing-revoke"; roomId: string; deviceId: string }
  /** Purge this device's copy and keep the signed statement (§15.17). */
  | { id: number; kind: "pairing-leave"; roomId: string }
  /** Consent (or not) to a staged relay move — §6.7's trust prompt. Accepting
   *  is the ONLY path that moves `room.relayUrl`, and it is a write. */
  | { id: number; kind: "pairing-rehome"; roomId: string; accept: boolean }
  /** Roster, role, generation, rotation state, engine status — one read. */
  | { id: number; kind: "room-info"; roomId: string }
  /**
   * "Try again" on a shelf whose sync failed.
   *
   * The engine retries on its own with exponential backoff, so this is not how
   * recovery normally happens — it is the button that makes the failure feel
   * actionable, and it skips the remaining backoff. It is deliberately NOT a
   * dev request: a user who is told "offline, code 1006" needs a lever, and
   * pointing them at `?sync=1` is not a product.
   */
  | { id: number; kind: "sync-retry"; roomId: string }
  // ── The documented plan gap (code-vs-plan §4) ────────────────────────────
  /** §6.6's pull side: a tab saw a missing blob and wants the worker to ask. */
  | { id: number; kind: "blob-demand"; roomId: string; hash: string }
  // ── Dev-only (Gate G instrumentation) ────────────────────────────────────
  | { id: number; kind: "dev-op"; roomId: string; op: DevOp; hash?: string }
  | { id: number; kind: "dev-state"; roomId: string }
  | { id: number; kind: "dev-export-room"; roomId: string }
  | { id: number; kind: "dev-import-room"; text: string }
  | { id: number; kind: "dev-set-relay"; roomId: string; url: string };

/** The error shape a tab can branch on without importing `CommandError`. */
export interface WorkerError {
  code: string;
  message: string;
}

export type WorkerReply =
  | { id: number; ok: true; value: unknown }
  | { id: number; ok: false; error: WorkerError };

/** Unsolicited worker → tab messages. No `id`: they are not replies. */
export type WorkerEvent =
  | { kind: "blob-arrived"; roomId: string; hash: string }
  /**
   * §6.6: "badge state, sole-copy warning, catch-up progress".
   *
   * `lastClose` rides along because a status change and the reason for it are
   * one fact: broadcasting `offline` alone forced every listener to ask a
   * second question, and a tab that did not ask saw a shelf that "just stopped"
   * with no code to show (the silent-failure report).
   */
  | {
      kind: "sync-status";
      roomId: string;
      status: SyncStatus;
      lastClose: { code: number; reason: string } | null;
    };

export type WorkerMessage = WorkerReply | WorkerEvent;

/** Narrow a message to a reply. */
export function isReply(message: WorkerMessage): message is WorkerReply {
  return typeof (message as WorkerReply).id === "number";
}

/** Narrow a message to an event. */
export function isEvent(message: WorkerMessage): message is WorkerEvent {
  return typeof (message as WorkerReply).id !== "number";
}

/** The reply value types, so callers do not cast. */
export interface ReplyValues {
  cmd: CommandAck;
  "move-many": MoveResult[];
  "create-profile": Profile;
  visibility: null;
  "room-add": null;
  "room-remove": null;
  "pairing-mint": MintReply;
  "pairing-join": PairingReply;
  "pairing-adopt": PairingReply;
  "pairing-revoke": PairingReply;
  "pairing-leave": null;
  "pairing-rehome": null;
  "room-info": RoomInfo;
  "sync-retry": null;
  "blob-demand": boolean;
  "dev-op": unknown;
  "dev-state": DevState;
  "dev-export-room": string | null;
  "dev-import-room": null;
  "dev-set-relay": null;
}
