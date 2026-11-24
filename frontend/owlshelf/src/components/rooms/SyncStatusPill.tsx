/**
 * SyncStatusPill.tsx — the badge §6.6 asks for ("badge state"), finally rendered.
 *
 * It exists because sync failed silently. Everything that can go wrong ends in a
 * close code: the relay refuses the origin (4401), the room is full (4403), the
 * key rotated (4404), the socket died (1006), the shelf is not joined yet. None
 * of it reached the user before this component, so "the app is broken" was the
 * only reading available.
 *
 * Three rules it keeps:
 *
 *  1. **The code is never hidden.** It is in the visible label for a failure and
 *     in the tooltip for everything, because a support thread that cannot name a
 *     number cannot name a cause.
 *  2. **`retryable: false` means no retry button.** A 4401 will refuse the
 *     connection the same way forever; offering "Try again" there is a lie the
 *     user pays for twice (once waiting, once concluding the app is broken).
 *  3. **Colour is never the only signal.** The label always says the state in
 *     words, so the badge survives greyscale, colour blindness, and a screen
 *     reader.
 */

import { useState } from "react";
import { AlertTriangle, Check, Loader2, MinusCircle } from "lucide-react";
import { retrySync, useSyncHealth } from "@/lib/hooks";
import type { SyncHealth } from "@/lib/syncErrors";

export interface SyncStatusPillProps {
  health: SyncHealth;
  /** Present when the caller can act on a failure. */
  onRetry?: () => void;
  retrying?: boolean;
  /** Compact form: the dot and a code, for a card corner. */
  compact?: boolean;
}

const ICONS = {
  ok: Check,
  busy: Loader2,
  warn: AlertTriangle,
  error: MinusCircle,
} as const;

export function SyncStatusPill({ health, onRetry, retrying = false, compact = false }: SyncStatusPillProps) {
  const Icon = ICONS[health.tone];
  const code = health.trouble ? health.trouble.code : null;
  const label = compact && code !== null ? String(code) : health.label;
  const actionable = onRetry !== undefined && health.trouble?.retryable === true;

  return (
    <span
      className={`sync-pill sync-pill-${health.tone}${compact ? " sync-pill-compact" : ""}`}
      // The tooltip is the full sentence plus the code: the visible label is a
      // badge, and a badge that lies about scope is worse than no badge.
      title={health.detail}
    >
      <Icon
        size={compact ? 12 : 14}
        strokeWidth={2.4}
        className={health.tone === "busy" ? "sync-pill-spin" : undefined}
        aria-hidden="true"
      />
      <span className="sync-pill-label">{label}</span>
      {actionable && (
        <button
          type="button"
          className="sync-pill-retry"
          onClick={onRetry}
          disabled={retrying}
          title={retrying ? "Retrying…" : "Try again now instead of waiting for the next attempt"}
        >
          {retrying ? "Trying…" : "Try again"}
        </button>
      )}
    </span>
  );
}

export interface RoomSyncPillProps {
  roomId: string;
  /** Dot and code only, for a card corner. */
  compact?: boolean;
}

/**
 * The pill wired to one room's health.
 *
 * A component rather than a hook call at each call site: a card LIST cannot call
 * `useSyncHealth` in a loop, and the retry state belongs with the button that
 * spends it.
 */
export function RoomSyncPill({ roomId, compact = false }: RoomSyncPillProps) {
  const health = useSyncHealth(roomId);
  const [retrying, setRetrying] = useState(false);

  if (health === null) return null;

  const retry = async () => {
    setRetrying(true);
    try {
      await retrySync(roomId);
    } catch {
      // The worker refused the retry (no live engine). The store keeps the last
      // known state, and the next attempt is one click away — surfacing a second
      // error here would replace the relay's code with a transport message.
    } finally {
      setRetrying(false);
    }
  };

  return <SyncStatusPill health={health} onRetry={retry} retrying={retrying} compact={compact} />;
}
