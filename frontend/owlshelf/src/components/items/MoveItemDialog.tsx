/**
 * MoveItemDialog.tsx — move one item to another shelf or another profile.
 *
 * The command path has supported both moves since step 3 (`moveItem`: one put
 * for a same-room move, copy-then-delete across rooms), but nothing in the UI
 * ever called it, so the capability was unreachable. This is the affordance.
 *
 * Two selects, because a destination is a PAIR: a profile and a location
 * inside it. The location list is scoped to the chosen profile, so a
 * cross-room move cannot name a location that belongs to the source room —
 * which the command path would reject anyway, but a picker that offers it is
 * a bug the user has to discover.
 *
 * The current location is excluded from the list: "move here" is a no-op that
 * would still mint an op.
 *
 * The amount field only appears when the row holds more than one copy. A
 * partial move SPLITS the row — the destination gets a new row with the moved
 * count, the source keeps the rest — because the reducer is last-writer-wins
 * per row and incrementing a shared counter would lose copies under
 * concurrency. The dialog says so, since "move 2 of 5" leaving a row behind is
 * otherwise surprising.
 */

import { useState } from "react";
import { X } from "lucide-react";
import { useLocations, useProfiles } from "@/lib/hooks";
import type { Item } from "@/types/item";

interface MoveItemDialogProps {
  item: Item;
  onClose: () => void;
  onMove: (
    itemId: string,
    destination: { roomId: string; locationId: string },
    amount?: number,
  ) => Promise<string>;
}

export function MoveItemDialog({ item, onClose, onMove }: MoveItemDialogProps) {
  const { profiles } = useProfiles();
  const [roomId, setRoomId] = useState(item.profileId);
  const { locations, loading } = useLocations(roomId);
  const [locationId, setLocationId] = useState("");
  const [amount, setAmount] = useState(String(item.stock));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  // A location from the previous room is not a valid destination in this one.
  const options = locations.filter(
    (location) => !(roomId === item.profileId && location.id === item.locationId),
  );
  const selected = options.some((location) => location.id === locationId) ? locationId : "";

  const splittable = item.stock > 1;
  const parsed = Number(amount);
  const amountValid =
    !splittable || (Number.isInteger(parsed) && parsed >= 1 && parsed <= item.stock);
  const moving = splittable ? parsed : item.stock;

  const handleMove = async () => {
    if (!selected) {
      setError("Pick a destination first.");
      return;
    }
    if (!amountValid) {
      setError(`Move between 1 and ${item.stock} copies.`);
      return;
    }
    setSaving(true);
    setError("");
    try {
      await onMove(item.id, { roomId, locationId: selected }, splittable ? moving : undefined);
      onClose();
    } catch (e) {
      // Keep the dialog open with the selection intact: a quota or validation
      // failure must not make the user redo the pick.
      setError(e instanceof Error ? e.message : "Couldn't move the item. Try again.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="dialog-backdrop"
      role="presentation"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="move-title">
        <div className="dialog-header">
          <h2 id="move-title" className="dialog-title">
            Move “{item.name}”
          </h2>
          <button className="dialog-close" onClick={onClose} aria-label="Close">
            <X size={16} strokeWidth={2.5} />
          </button>
        </div>

        <div className="dialog-body">
          <div className="dialog-fields">
            <div className="field-group">
              <label htmlFor="move-profile" className="field-label">
                Profile
              </label>
              <select
                id="move-profile"
                className="field-input"
                value={roomId}
                onChange={(e) => {
                  setRoomId(e.target.value);
                  setLocationId("");
                }}
              >
                {profiles.map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {profile.avatarEmoji} {profile.name}
                  </option>
                ))}
              </select>
            </div>

            <div className="field-group">
              <label htmlFor="move-shelf" className="field-label">
                Shelf
              </label>
              <select
                id="move-shelf"
                className="field-input"
                value={selected}
                onChange={(e) => setLocationId(e.target.value)}
                disabled={loading || options.length === 0}
              >
                <option value="">
                  {loading
                    ? "Loading…"
                    : options.length === 0
                      ? "No other shelf here"
                      : "Pick a shelf"}
                </option>
                {options.map((location) => (
                  <option key={location.id} value={location.id}>
                    {location.icon} {location.name}
                  </option>
                ))}
              </select>
              <p className="field-hint">
                {roomId === item.profileId
                  ? "Moves the item to another shelf in this profile."
                  : "Copies the item and its photo into the other profile, then removes it from this one."}
              </p>
            </div>

            {splittable && (
              <div className="field-group">
                <label htmlFor="move-amount" className="field-label">
                  Copies
                </label>
                <input
                  id="move-amount"
                  className="field-input"
                  type="number"
                  min={1}
                  max={item.stock}
                  step={1}
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                />
                <p className="field-hint">
                  {amountValid && moving < item.stock
                    ? `Moves ${moving} of ${item.stock}. The other ${item.stock - moving} stay on this shelf as a separate entry.`
                    : `This entry holds ${item.stock} copies.`}
                </p>
              </div>
            )}
          </div>

          {error && <p className="field-error">{error}</p>}
        </div>

        <div className="dialog-footer">
          <div style={{ display: "flex", gap: "12px", marginLeft: "auto" }}>
            <button className="btn-ghost" onClick={onClose} disabled={saving}>
              Cancel
            </button>
            <button
              className="btn-primary"
              onClick={handleMove}
              disabled={saving || !selected || !amountValid}
            >
              {saving ? "Moving…" : "Move"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
