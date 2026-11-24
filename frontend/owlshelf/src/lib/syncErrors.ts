/**
 * syncErrors.ts — why sync stopped, in words a user can act on.
 *
 * Sync used to fail silently: the engine retried with backoff, the dev panel
 * behind `?sync=1` was the only place that printed a close code, and everyone
 * else saw a shelf that simply did not update. That is the worst kind of bug —
 * the data is fine, the code is correct, and the product looks broken.
 *
 * So every close path now has a sentence, and the sentence names the code:
 *
 *   - `title`   — one short line for a badge ("Can't reach the relay")
 *   - `detail`  — what actually happened, in plain language
 *   - `retryable` — whether pressing "Try again" can possibly help. A 4401
 *     (origin refused) or a 4404 (rotation) cannot be fixed by retrying, and a
 *     button that does nothing is worse than no button.
 *
 * This module is dependency-free on purpose: `sync.ts` pulls in WebCrypto and
 * the reducer, and a tab that renders a badge must not drag those in.
 */

import { CLOSE } from "./sync";

/** The frames the relay uses to say WHY it closed (its `reason` field). */
export const CLOSE_REASON = {
  ORIGIN: "origin",
  HANDSHAKE_TIMEOUT: "handshake-timeout",
  HELLO_SHAPE: "hello-shape",
  GENERATION: "generation",
  ROOM_CAP: "room-cap",
  DUPLICATE_CONN: "duplicate-conn",
  BYTE_BUDGET: "byte-budget",
  FRAME_CAP: "frame-cap",
  QUEUE_FULL: "queue-full",
  MOVED: "moved",
  IDLE: "idle",
  HEARTBEAT: "heartbeat",
  ROOM_BUDGET: "room-budget",
  GOVERNOR: "governor",
  JOIN_REFUSED: "join-refused",
} as const;

export type SyncTroubleKind =
  | "network" // nothing answered
  | "config" // the deployment disagrees with this client
  | "capacity" // the relay is full or shedding
  | "policy" // this client broke the transport contract
  | "rotation" // the shelf moved on without us: needs a new code
  | "stopped"; // normal, and nothing to do

export interface SyncTrouble {
  /** The WebSocket close code, shown to the user. Support needs it; hiding it
   *  turns every report into "it doesn't work". */
  code: number;
  kind: SyncTroubleKind;
  title: string;
  detail: string;
  /** False when retrying cannot help — the fix is elsewhere. */
  retryable: boolean;
}

function describeReason(reason: string): string | null {
  switch (reason) {
    case CLOSE_REASON.GENERATION:
      return "The shelf's key was rotated and this device is on the old one.";
    case CLOSE_REASON.ROOM_CAP:
      return "This shelf already has as many connected devices as the relay allows.";
    case CLOSE_REASON.BYTE_BUDGET:
      return "This device sent more than the relay's per-connection budget allows, so it was disconnected.";
    case CLOSE_REASON.FRAME_CAP:
      return "A frame was larger than the relay's frame limit.";
    case CLOSE_REASON.QUEUE_FULL:
      return "The relay could not keep up with this device's writes.";
    case CLOSE_REASON.IDLE:
      return "The connection sat idle for too long.";
    case CLOSE_REASON.HEARTBEAT:
      return "The relay stopped hearing from this device (no heartbeat).";
    case CLOSE_REASON.ROOM_BUDGET:
      return "This shelf's outgoing traffic hit the relay's per-room budget.";
    case CLOSE_REASON.GOVERNOR:
      return "The relay is shedding traffic under load.";
    case CLOSE_REASON.DUPLICATE_CONN:
      return "Another connection claimed this device's connection id.";
    case CLOSE_REASON.HELLO_SHAPE:
      return "The relay could not understand this client's opening frame.";
    case CLOSE_REASON.HANDSHAKE_TIMEOUT:
      return "The connection opened but the opening frame never arrived in time.";
    case CLOSE_REASON.MOVED:
      return "The relay has moved to a new address.";
    case CLOSE_REASON.JOIN_REFUSED:
      return "The relay refused to add this shelf to the shared connection.";
    default:
      return null;
  }
}

/**
 * Turn a close into something to show.
 *
 * The fallback is deliberately not "something went wrong": it says the code and
 * that the device will keep trying, because an unexplained number is still more
 * useful to support than a shrug.
 */
export function describeClose(code: number, reason = ""): SyncTrouble {
  const reasonDetail = describeReason(reason);
  const base = { code };

  switch (code) {
    case CLOSE.NORMAL:
      return {
        ...base,
        kind: "stopped",
        title: "Not connected",
        detail: "Sync was switched off for this shelf.",
        retryable: true,
      };
    case CLOSE.GOING_AWAY:
      return {
        ...base,
        kind: "network",
        title: "Reconnecting",
        detail: "The relay closed the connection. This device is dialling again.",
        retryable: true,
      };
    case 1006:
      return {
        ...base,
        kind: "network",
        title: "Can't reach the relay",
        detail:
          "No relay answered. Check that the relay is running, that the address is right, and that this device is online.",
        retryable: true,
      };
    case 1008:
      return {
        ...base,
        kind: "policy",
        title: "Disconnected by the relay",
        detail: reasonDetail ?? "The relay refused this connection as a policy violation.",
        retryable: true,
      };
    case 1011:
      return {
        ...base,
        kind: "network",
        title: "Relay error",
        detail: "The relay hit an internal error while handling this device.",
        retryable: true,
      };
    case CLOSE.TRY_LATER:
      return {
        ...base,
        kind: "capacity",
        title: "Relay is full",
        detail: "The relay is at capacity right now. This device will keep trying.",
        retryable: true,
      };
    case CLOSE.ORIGIN_REFUSED:
      return {
        ...base,
        kind: "config",
        title: "This address isn't allowed",
        detail:
          "The relay refused this page's origin. The fix is server-side: add this site to the relay's ALLOWED_ORIGINS.",
        retryable: false,
      };
    case CLOSE.HANDSHAKE_TIMEOUT:
      return {
        ...base,
        kind: "config",
        title: "Relay didn't answer properly",
        detail: reasonDetail ?? "The connection opened but the opening frame was not accepted.",
        retryable: true,
      };
    case CLOSE.ROOM_CAP:
      return {
        ...base,
        kind: "capacity",
        title: "Shelf is full",
        detail: reasonDetail ?? "This shelf has reached the relay's limit on connected devices.",
        retryable: false,
      };
    case CLOSE.GENERATION_MISMATCH:
      return {
        ...base,
        kind: "rotation",
        title: "Shelf moved to a new key",
        detail:
          reasonDetail ??
          "This device was removed or the owner's key rotated. Ask the owner for a fresh invite.",
        retryable: false,
      };
    default:
      return {
        ...base,
        kind: "network",
        title: "Connection lost",
        detail: reasonDetail ?? "This device will keep trying to reconnect.",
        retryable: true,
      };
  }
}

/** The badge state the app shows. `tone` is what the dot colours. */
export type SyncTone = "ok" | "busy" | "warn" | "error";

export interface SyncHealth {
  tone: SyncTone;
  /** One short line, never a raw code. */
  label: string;
  /** Hover text: the same line plus the code, for support. */
  detail: string;
  /** Present only when something is wrong. */
  trouble: SyncTrouble | null;
}

/** §6.6's badge state, derived. Pure, so it is testable without a worker. */
export function healthOf(
  status: "offline" | "connecting" | "syncing" | "synced" | "attention",
  lastClose: { code: number; reason: string } | null,
  peers: readonly string[],
  running: boolean,
): SyncHealth {
  const trouble = lastClose ? describeClose(lastClose.code, lastClose.reason) : null;
  const code = trouble ? ` (${trouble.code})` : "";

  if (!running) {
    return trouble
      ? { tone: "error", label: trouble.title, detail: trouble.detail + code, trouble }
      : {
          tone: "busy",
          label: "Not connected yet",
          detail: "This device has not opened a connection for this shelf.",
          trouble: null,
        };
  }

  if (status === "attention") {
    return trouble
      ? { tone: "warn", label: trouble.title, detail: trouble.detail + code, trouble }
      : {
          tone: "warn",
          label: "Needs attention",
          detail: "This shelf has a pending notice — open it for details.",
          trouble: null,
        };
  }

  if (status === "synced") {
    return {
      tone: "ok",
      label: peers.length > 0 ? `Up to date · ${peers.length} online` : "Up to date",
      detail: peers.length > 0 ? "Every change on this device has reached its peers." : "Connected.",
      trouble: null,
    };
  }

  if (status === "syncing") {
    return {
      tone: "busy",
      label: "Syncing…",
      detail: "This device is exchanging changes with its peers.",
      trouble: null,
    };
  }

  if (status === "connecting") {
    return {
      tone: "busy",
      label: "Connecting…",
      detail: "Dialling the relay.",
      trouble: null,
    };
  }

  // `offline`, with or without a remembered close.
  return trouble
    ? { tone: "error", label: `Offline · ${trouble.title}`, detail: trouble.detail + code, trouble }
    : {
        tone: "error",
        label: "Offline",
        detail: "Sync is not running for this shelf right now.",
        trouble: null,
      };
}
