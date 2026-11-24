/**
 * RoomGate.tsx — the two blocking prompts a shared shelf can raise (§6.7).
 *
 * 1. **Rotation.** A signed `rotate-key` notice arrived: the owner changed the
 *    key, usually to remove a device. The plan is explicit that this is a
 *    BLOCKING state — the device stops minting (enforced in `cmd.ts` via
 *    `rotationPending`) and tells the user to re-pair, because the alternative
 *    is that they keep editing a copy nobody will ever read. The only way out
 *    is a new code from the owner, so the prompt opens the adopt dialog.
 *
 * 2. **Rehome.** A signed `rehome` op was verified and staged. §6.7 makes
 *    moving a room's relay a TRUST PROMPT, not an instruction: the owner can
 *    point every member at a host it controls, and whoever hosts the relay sees
 *    the metadata even though it cannot read envelopes. Accepting is the only
 *    path that writes `room.relayUrl`.
 *
 * Both prompts read the LIVE room record, so they appear the moment the control
 * op lands and vanish the moment it is resolved — no polling, and no stale
 * "you were removed" banner after a successful re-pair.
 */

import { useState } from "react";
import { KeyRound, Radio } from "lucide-react";
import { pairing, retrySync, useRoomInfo, useSyncHealth } from "@/lib/hooks";
import { JoinRoomDialog } from "./JoinRoomDialog";
import { SyncStatusPill } from "./SyncStatusPill";

export interface RoomGateProps {
  roomId: string;
  roomName: string;
}

export function RoomGate({ roomId, roomName }: RoomGateProps) {
  const { room } = useRoomInfo(roomId);
  const [dismissedRotation, setDismissedRotation] = useState<number | null>(null);
  const [adopting, setAdopting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const health = useSyncHealth(roomId);
  const [retrying, setRetrying] = useState(false);

  if (!room) return null;

  const retry = async () => {
    setRetrying(true);
    try {
      await retrySync(roomId);
    } catch {
      // No live engine: the worker said so, and the badge keeps the code it
      // already has. A second error line here would replace the relay's reason.
    } finally {
      setRetrying(false);
    }
  };

  const rotation = room.rotationPending ?? null;
  if (rotation !== null && rotation !== dismissedRotation) {
    return (
      <>
        <div className="dialog-backdrop" role="presentation">
          <div
            className="dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="rotation-title"
            style={{ maxWidth: 460 }}
          >
            <div className="dialog-header">
              <div>
                <h2 id="rotation-title" className="dialog-title">
                  This shelf moved to a new key
                </h2>
                <p className="dialog-subtitle">
                  “{roomName}” was re-keyed by its owner — usually to remove a device.
                </p>
              </div>
            </div>
            <div className="dialog-divider" />
            <div className="dialog-body">
              <p className="share-warning" role="alert">
                This device can no longer write to the shelf until it is re-paired. Your items
                are still on this device — nothing has been deleted.
              </p>
              <p className="field-hint">
                Ask the owner for a new invite (Share → Copy invite) and paste it here.
              </p>
              {error && (
                <p className="field-error" role="alert">
                  {error}
                </p>
              )}
            </div>
            <div className="dialog-footer">
              <button
                className="btn-ghost"
                type="button"
                onClick={() => setDismissedRotation(rotation)}
              >
                Later
              </button>
              <button className="btn-primary" type="button" onClick={() => setAdopting(true)}>
                Re-pair with a code
              </button>
            </div>
          </div>
        </div>
        <JoinRoomDialog
          open={adopting}
          mode="adopt"
          onClose={() => setAdopting(false)}
          onJoined={() => setAdopting(false)}
        />
      </>
    );
  }

  if (room.pendingRelayUrl) {
    const accept = async () => {
      setBusy(true);
      setError("");
      try {
        await pairing.rehome(roomId, true);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Could not move the shelf.");
      } finally {
        setBusy(false);
      }
    };
    const keep = async () => {
      setBusy(true);
      setError("");
      try {
        await pairing.rehome(roomId, false);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Could not dismiss this.");
      } finally {
        setBusy(false);
      }
    };

    return (
      <div className="dialog-backdrop" role="presentation">
        <div
          className="dialog"
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="rehome-title"
          style={{ maxWidth: 460 }}
        >
          <div className="dialog-header">
            <div>
              <h2 id="rehome-title" className="dialog-title">
                Move this shelf to a new relay?
              </h2>
              <p className="dialog-subtitle">A signed request from the owner of “{roomName}”.</p>
            </div>
          </div>
          <div className="dialog-divider" />
          <div className="dialog-body">
            <p className="share-meta">
              <Radio size={13} strokeWidth={2} /> {room.pendingRelayUrl}
            </p>
            <p className="field-hint">
              Only accept if the owner told you to expect this. The relay forwards encrypted
              envelopes it cannot read, but it does see who syncs and when.
            </p>
            {error && (
              <p className="field-error" role="alert">
                {error}
              </p>
            )}
          </div>
          <div className="dialog-footer">
            <button className="btn-ghost" type="button" onClick={() => void keep()} disabled={busy}>
              Keep current
            </button>
            <button
              className="btn-primary"
              type="button"
              onClick={() => void accept()}
              disabled={busy}
            >
              <KeyRound size={14} strokeWidth={2} />
              {busy ? "Moving…" : "Move shelf"}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // A failed connection is not a dialog: the shelf still works offline, so the
  // card is a banner. It is shown only when the badge has something to say and
  // the rotation prompt is NOT already blocking — two prompts for one incident
  // is what teaches people to dismiss both.
  if (health?.tone === "error" && health.trouble !== null) {
    return (
      <div className="sync-issue" role="status">
        <SyncStatusPill health={health} onRetry={retry} retrying={retrying} />
        <span className="sync-issue-detail">{health.detail}</span>
      </div>
    );
  }

  return null;
}
