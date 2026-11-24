/**
 * ShareRoomDialog.tsx — the owner's half of §6.7, and the member's leave path.
 *
 * What §6.7 asks this screen to say, and why each line exists:
 *
 *  - **The invite is the key.** "Anyone with this code can read and edit this
 *    shelf" is not boilerplate: the fragment carries the 32-byte room key, and
 *    a screenshot in a group chat is a full grant.
 *  - **Removing a device is a rotation.** §6.7's v1 choice is revoke → rotate →
 *    ALL members re-pair, so the confirm step says so instead of implying a
 *    single device is dropped and everyone else sails on.
 *  - **A removed device keeps its copy.** Leaving or being removed is not an
 *    erase (the purge set is local, §15.17); disclosing it here is one of the
 *    two custody events the plan names.
 *  - **The notice is a pointer, not a credential.** If no peer was connected at
 *    rotation time the signed notice was not delivered, and the dialog says
 *    that plainly rather than claiming a delivery that did not happen. Control
 *    ops are not in the op log yet, so an offline member learns nothing from a
 *    later catch-up (`owlshelf-code-vs-plan.md` §5.6).
 *
 * The QR is minted by the WORKER from the STORED room (`pairing-mint`), never
 * assembled here: the fragment has to carry the current `keyGen` and the pinned
 * anchor, and a tab that built it from a roomId would forget both (N4).
 */

import { useEffect, useState } from "react";
import { Check, Copy, ShieldAlert, Users, X } from "lucide-react";
import { pairing, useRoomInfo, useSyncHealth } from "@/lib/hooks";
import { describePairingFailure } from "@/lib/pairingErrors";
import { copyText } from "@/lib/clipboard";
import { ShareQr } from "./ShareQr";
import { RoomSyncPill } from "./SyncStatusPill";

export interface ShareRoomDialogProps {
  open: boolean;
  roomId: string;
  roomName: string;
  onClose: () => void;
}

export function ShareRoomDialog({ open, roomId, roomName, onClose }: ShareRoomDialogProps) {
  if (!open) return null;
  return <ShareRoomBody roomId={roomId} roomName={roomName} onClose={onClose} />;
}

interface MintState {
  keyGen: number;
  fragment?: string;
  error?: string;
}

interface ShareRoomBodyProps {
  roomId: string;
  roomName: string;
  onClose: () => void;
}

function ShareRoomBody({ roomId, roomName, onClose }: ShareRoomBodyProps) {
  // The live half (roster, key generation, rotation flags) comes from IndexedDB;
  // the worker half (deviceId, ownership, engine status) is polled while the
  // dialog is open. 1.5 s is a presence indicator, not a progress bar.
  const { room, info } = useRoomInfo(roomId, 1_500);
  // The badge's own state: pushed by the worker's `sync-status` events, so it
  // also reflects a failure that happened before this dialog opened.
  const health = useSyncHealth(roomId);

  const [mint, setMint] = useState<MintState | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  const [busyDevice, setBusyDevice] = useState<string | null>(null);
  const [confirmDevice, setConfirmDevice] = useState<string | null>(null);
  const [revoked, setRevoked] = useState<{ device: string; notified: boolean } | null>(null);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [leaving, setLeaving] = useState(false);

  const keyGen = room?.keyGen ?? 0;
  const me = info?.deviceId ?? null;
  const isOwner = info?.isOwner ?? false;
  const members = room?.roster ?? [];
  const online = new Set(info?.peers ?? []);

  // Re-mint whenever the room's generation moves: after a revoke the owner must
  // hand out the NEW code, and a code from the old generation would send the
  // recipient straight back to a hash nobody reads (§6.7 step 4).
  //
  // Only the OWNER mints. A member holds the room key and could build a
  // fragment, but §6.7 makes the owner the only distributor — and a member
  // screen that quietly held a live key string in state would be the wrong
  // default even if it never rendered it.
  useEffect(() => {
    if (!isOwner) return;
    let cancelled = false;
    void pairing
      .mint(roomId)
      .then((reply) => {
        if (cancelled) return;
        setMint(
          reply.ok
            ? { keyGen, fragment: reply.fragment }
            : { keyGen, error: describePairingFailure(reply.reason) },
        );
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setMint({
          keyGen,
          error: cause instanceof Error ? cause.message : "Could not build an invite.",
        });
      });
    return () => {
      cancelled = true;
    };
  }, [roomId, keyGen, isOwner]);

  // A stale mint (previous generation) is treated as "not yet" rather than
  // shown: displaying the old code for a frame is how someone scans the wrong
  // one. No `setX` in the effect body above, so this stays a pure derivation.
  const fragment = mint !== null && mint.keyGen === keyGen ? (mint.fragment ?? null) : null;
  const mintError = mint !== null && mint.keyGen === keyGen ? (mint.error ?? "") : "";

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1_800);
    return () => clearTimeout(timer);
  }, [copied]);

  const handleCopy = async () => {
    if (!fragment) return;
    const ok = await copyText(fragment);
    if (ok) {
      setCopied(true);
      setError("");
    } else {
      setError("Your browser blocked the clipboard. Select the code and copy it by hand.");
    }
  };

  const handleRevoke = async (deviceId: string) => {
    setBusyDevice(deviceId);
    setError("");
    try {
      const reply = await pairing.revoke(roomId, deviceId);
      if (!reply.ok) {
        setError(describePairingFailure(reply.reason));
        return;
      }
      setRevoked({ device: deviceId, notified: reply.notified ?? false });
      setConfirmDevice(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not remove that device.");
    } finally {
      setBusyDevice(null);
    }
  };

  const handleLeave = async () => {
    setLeaving(true);
    setError("");
    try {
      await pairing.leave(roomId);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not leave this shelf.");
    } finally {
      setLeaving(false);
    }
  };

  return (
    <div
      className="dialog-backdrop"
      role="presentation"
      onClick={(event) => event.target === event.currentTarget && onClose()}
    >
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="share-room-title"
        style={{ maxWidth: 480 }}
      >
        <div className="dialog-header">
          <div>
            <h2 id="share-room-title" className="dialog-title">
              {isOwner ? `Share “${roomName}”` : `“${roomName}” devices`}
            </h2>
            <p className="dialog-subtitle">
              {isOwner
                ? "One code, one shelf. Share it in person or through a channel you trust."
                : "This shelf was shared with you by its owner."}
            </p>
          </div>
          <button className="dialog-close" onClick={onClose} aria-label="Close">
            <X size={18} strokeWidth={2} />
          </button>
        </div>

        <div className="dialog-divider" />

        <div className="dialog-body share-body">
          {revoked && (
            <div className="share-callout" role="status">
              <ShieldAlert size={16} strokeWidth={2} />
              <div>
                <p className="share-callout-title">
                  Removed {shortId(revoked.device)}. The key is new.
                </p>
                <p className="share-callout-detail">
                  {revoked.notified
                    ? "That device was connected and has been told to stop writing. It still holds the old key, so its copy is not erased."
                    : "That device was not connected, so it was not told. It still holds the old key and keeps writing to its own copy until it re-pairs — the copy is not erased either way."}
                  {" "}Hand the new code below to every device you want to keep.
                </p>
              </div>
            </div>
          )}

          {info === null ? (
            // Ownership needs `getDeviceId`, which only the worker can answer.
            // Rendering the member view while that is in flight would flash a
            // "Leave this shelf" button at the owner.
            <p className="field-hint">Checking this device…</p>
          ) : isOwner ? (
            <>
              {fragment ? (
                <div className="share-qr-row">
                  <ShareQr text={fragment} />
                  <div className="share-qr-side">
                    <button className="btn-primary" onClick={handleCopy} type="button">
                      {copied ? <Check size={14} strokeWidth={2.4} /> : <Copy size={14} strokeWidth={2} />}
                      {copied ? "Copied" : "Copy invite"}
                    </button>
                    <p className="field-hint">
                      Anyone with this code can read and edit this shelf. It contains the room
                      key — treat it like a password.
                    </p>
                  </div>
                </div>
              ) : mintError ? (
                <p className="field-error" role="alert">
                  {mintError}
                </p>
              ) : (
                <p className="field-hint">Building the invite…</p>
              )}

              {fragment && (
                <details className="share-text-block">
                  <summary>Show as text</summary>
                  <textarea
                    className="field-input share-invite-text"
                    value={fragment}
                    readOnly
                    rows={4}
                    onFocus={(event) => event.currentTarget.select()}
                  />
                </details>
              )}

              <p className="share-meta">
                Relay: {room?.relayUrl ?? "none set — this shelf cannot sync yet"} · key
                generation {keyGen}
              </p>
            </>
          ) : (
            <p className="share-meta">
              Only the owner's device can show an invite code. Relay:{" "}
              {room?.relayUrl ?? "none set"} · key generation {keyGen}
            </p>
          )}

          {/*
            The status the badge exists for. Before it, a shelf that had stopped
            syncing said nothing anywhere a user could see, and the close code
            that explained it was only in the dev panel.
          */}
          <div className="share-status-row">
            <RoomSyncPill roomId={roomId} />
          </div>
          {health?.trouble && (
            <p className={health.tone === "error" ? "field-error" : "field-hint"} role="status">
              {health.detail}
              {health.trouble.kind === "rotation" &&
                " Ask the owner for a fresh invite and use Re-pair."}
            </p>
          )}

          <div className="share-members">
            <p className="share-members-title">
              <Users size={13} strokeWidth={2} /> Devices on this shelf ({members.length})
            </p>
            <ul className="share-member-list">
              {members.map((member) => {
                const self = me !== null && member.deviceId === me;
                const pending = confirmDevice === member.deviceId;
                return (
                  <li key={member.deviceId} className="share-member">
                    <div className="share-member-body">
                      <span className="share-member-id">
                        {self ? "This device" : shortId(member.deviceId)}
                      </span>
                      <span className="share-badges">
                        <span className={`share-badge share-badge--${member.role}`}>
                          {member.role}
                        </span>
                        {online.has(member.deviceId) && (
                          <span className="share-badge share-badge--online">online</span>
                        )}
                      </span>
                    </div>
                    {isOwner && member.role !== "owner" && (
                      <div className="share-member-actions">
                        {pending ? (
                          <>
                            <button
                              className="btn-ghost share-danger"
                              type="button"
                              disabled={busyDevice === member.deviceId}
                              onClick={() => void handleRevoke(member.deviceId)}
                            >
                              {busyDevice === member.deviceId ? "Removing…" : "Remove"}
                            </button>
                            <button
                              className="btn-ghost"
                              type="button"
                              onClick={() => setConfirmDevice(null)}
                            >
                              Cancel
                            </button>
                          </>
                        ) : (
                          <button
                            className="btn-ghost"
                            type="button"
                            onClick={() => {
                              setConfirmDevice(member.deviceId);
                              setError("");
                            }}
                          >
                            Remove…
                          </button>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>

            {confirmDevice !== null && (
              <p className="share-warning" role="alert">
                Removing a device changes the shelf key. Every device — including this one —
                must re-pair with the new code, and the removed device keeps the copy it
                already has.
              </p>
            )}
          </div>

          {info !== null && !isOwner && (
            <div className="share-leave">
              {confirmLeave ? (
                <>
                  <p className="share-warning" role="alert">
                    Leaving deletes this shelf's copy from this device, including items and
                    media. Other devices keep their copies.
                  </p>
                  <div className="share-leave-actions">
                    <button
                      className="btn-ghost"
                      type="button"
                      onClick={() => setConfirmLeave(false)}
                      disabled={leaving}
                    >
                      Cancel
                    </button>
                    <button
                      className="btn-primary share-danger-solid"
                      type="button"
                      onClick={() => void handleLeave()}
                      disabled={leaving}
                    >
                      {leaving ? "Leaving…" : "Leave shelf"}
                    </button>
                  </div>
                </>
              ) : (
                <button
                  className="btn-ghost share-danger"
                  type="button"
                  onClick={() => setConfirmLeave(true)}
                >
                  Leave this shelf…
                </button>
              )}
            </div>
          )}

          {error && (
            <p className="field-error" role="alert">
              {error}
            </p>
          )}
        </div>

        <div className="dialog-footer">
          <button className="btn-ghost" onClick={onClose} type="button">
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

/** A device id is a full UUID; eight characters is enough to tell two apart. */
function shortId(deviceId: string): string {
  return deviceId.length > 12 ? deviceId.slice(0, 8) : deviceId;
}

// `statusLabel` used to live here and printed "connected"/"offline" with no
// code. It is `syncErrors.ts` now: one vocabulary for the badge, the tooltip
// and the sentence, so the dialog cannot say "offline" while the pill says
// "Can't reach the relay (1006)".
