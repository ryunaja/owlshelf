/**
 * JoinRoomDialog.tsx — the joiner's half of §6.7 pairing.
 *
 * Two modes, one form, because the user action is identical ("paste the code
 * the owner sent you") and only the STORAGE outcome differs:
 *
 *  - `join`  — a shelf this device does not have. Refused if this device already
 *    holds data for that room (N10: a merge needs the explicit wizard, not a
 *    paste box).
 *  - `adopt` — the same shelf at a NEW generation, after a rotation. This is
 *    the "re-pair with the owner" step a revoked-or-rotated member must take,
 *    and it is why `join` cannot be reused: the room exists and has data.
 *
 * ── The restoring state ──────────────────────────────────────────────────
 *
 * A join's whole point is a full catch-up (§6.7 join step 3), and §6.7 requires
 * the joiner's UI to say so — including a FAILURE path (audit-4 R4-P2-11): if
 * no responder appears, the dialog degrades to "waiting for a peer" instead of
 * spinning forever. The 20 s budget is the plan's `CATCHUP_FIRST_REPLY_TIMEOUT`.
 * Nothing is blocked: "Continue" is always available, because the local rows
 * are already consistent and a user may want to look before history arrives.
 */

import { useEffect, useState } from "react";
import { ClipboardPaste, X } from "lucide-react";
import { pairing, useRoomInfo } from "@/lib/hooks";
import { describePairingFailure } from "@/lib/pairingErrors";

/** §6.7's budget before a silent catch-up is reported as "waiting for a peer". */
const CATCHUP_FIRST_REPLY_TIMEOUT = 20_000;

export interface JoinRoomDialogProps {
  open: boolean;
  /** `adopt` = re-pair after a rotation: the room already exists here. */
  mode?: "join" | "adopt";
  onClose: () => void;
  onJoined?: (roomId: string) => void;
}

/** Gate only — the form below owns the state, so closing resets everything. */
export function JoinRoomDialog({ open, mode = "join", onClose, onJoined }: JoinRoomDialogProps) {
  if (!open) return null;
  return <JoinRoomForm mode={mode} onClose={onClose} onJoined={onJoined} />;
}

interface JoinRoomFormProps {
  mode: "join" | "adopt";
  onClose: () => void;
  onJoined?: (roomId: string) => void;
}

function JoinRoomForm({ mode, onClose, onJoined }: JoinRoomFormProps) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [joined, setJoined] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);

  // Poll only while a join is actually restoring: `roomInfo` is a request, not a
  // live query, and the status it reports changes without a database write.
  const { info } = useRoomInfo(joined, joined ? 1_000 : 0);
  const restoring = joined !== null && mode === "join";
  const synced = info?.status === "synced";

  useEffect(() => {
    if (!restoring) return;
    const timer = setTimeout(() => setExpired(true), CATCHUP_FIRST_REPLY_TIMEOUT);
    return () => clearTimeout(timer);
  }, [restoring]);

  const submit = async () => {
    const invite = text.trim();
    if (!invite) {
      setError("Paste the invite first.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const reply =
        mode === "adopt" ? await pairing.adopt(invite) : await pairing.join(invite);
      if (!reply.ok) {
        // A refusal is a VALUE with a reason, never a thrown string: the copy
        // for each one lives in `pairingErrors.ts`.
        setError(describePairingFailure(reply.reason));
        return;
      }
      setJoined(reply.roomId);
      onJoined?.(reply.roomId);
      // `adopt` has nothing to download — the history is already here — and the
      // engine re-dials at the new generation in the worker.
      if (mode === "adopt") onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "That did not work. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const retryWait = () => {
    setExpired(false);
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
        aria-labelledby="join-room-title"
        style={{ maxWidth: 480 }}
      >
        <div className="dialog-header">
          <div>
            <h2 id="join-room-title" className="dialog-title">
              {mode === "adopt" ? "Re-pair this shelf" : "Join a shared shelf"}
            </h2>
            <p className="dialog-subtitle">
              {mode === "adopt"
                ? "The owner changed this shelf's key. Paste the new invite to keep using it."
                : "Paste the invite the owner sent you. It contains the shelf key, so treat it like a password."}
            </p>
          </div>
          <button className="dialog-close" onClick={onClose} aria-label="Close">
            <X size={18} strokeWidth={2} />
          </button>
        </div>

        <div className="dialog-divider" />

        <div className="dialog-body">
          {restoring ? (
            <div className="join-status" aria-live="polite">
              <p className="join-status-title">
                {synced ? "Up to date" : "Restoring your shelf…"}
              </p>
              <p className="join-status-detail">
                {synced
                  ? "History is on this device. You can start editing."
                  : expired
                    ? "Waiting for a peer — open your other device so it can send the history."
                    : `Receiving history from another device${
                        info && info.ops > 0 ? ` — ${info.ops} change${info.ops === 1 ? "" : "s"} so far` : ""
                      }.`}
              </p>
              {!synced && expired && (
                <button className="btn-ghost" onClick={retryWait} type="button">
                  Keep waiting
                </button>
              )}
            </div>
          ) : (
            <div className="dialog-fields">
              <div className="field-group">
                <label htmlFor="join-invite" className="field-label">
                  Invite
                </label>
                <textarea
                  id="join-invite"
                  className={`field-input join-input${error ? " field-input--error" : ""}`}
                  placeholder="owlshelf://join?v=1&r=…"
                  value={text}
                  onChange={(event) => {
                    setText(event.target.value);
                    setError("");
                  }}
                  rows={4}
                  spellCheck={false}
                  autoFocus
                />
                {error ? (
                  <p className="field-error" role="alert">
                    {error}
                  </p>
                ) : (
                  <p className="field-hint">
                    <ClipboardPaste size={12} strokeWidth={2} /> On the other device: Share →
                    Copy invite.
                  </p>
                )}
              </div>
            </div>
          )}
        </div>

        <div className="dialog-footer">
          {restoring ? (
            <button className="btn-primary" onClick={onClose} type="button">
              {synced ? "Open shelf" : "Continue"}
            </button>
          ) : (
            <>
              <button className="btn-ghost" onClick={onClose} type="button">
                Cancel
              </button>
              <button className="btn-primary" onClick={submit} disabled={busy} type="button">
                {busy ? "Checking…" : mode === "adopt" ? "Re-pair" : "Join"}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
