import { useState } from "react";
import { X, MapPin } from "lucide-react";
import type { Location, Profile } from "@/types/item";

const ICON_PRESETS = ["📚", "📦", "🏠", "🖥️", "🏭", "🏬", "🗄️", "🧳", "📁", "🛒"];

interface AddLocationDialogProps {
  open: boolean;
  profile: Profile;
  onClose: () => void;
  onSave: (data: Omit<Location, "id" | "itemCount">) => Promise<Location | void>;
}

export function AddLocationDialog({
  open,
  profile,
  onClose,
  onSave,
}: AddLocationDialogProps) {
  const [name, setName] = useState("");
  const [icon, setIcon] = useState("📁");
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  if (!open) return null;

  const handleSave = async () => {
    if (!name.trim()) {
      setError("Location name is required.");
      return;
    }
    setSaving(true);
    try {
      await onSave({
        profileId: profile.id,
        name: name.trim(),
        icon: icon || "📁",
        description: description.trim(),
      });
      // Reset
      setName("");
      setIcon("📁");
      setDescription("");
      setError("");
      onClose();
    } catch {
      setError("Failed to save. Please try again.");
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
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-loc-title"
        style={{ maxWidth: 440 }}
      >
        {/* Header */}
        <div className="dialog-header">
          <div>
            <h2 id="add-loc-title" className="dialog-title">
              Add Location
            </h2>
            <p className="dialog-subtitle">
              New shelf for <strong>{profile.name}</strong>
            </p>
          </div>
          <button
            id="add-loc-close"
            className="dialog-close"
            onClick={onClose}
            aria-label="Close"
          >
            <X size={18} strokeWidth={2} />
          </button>
        </div>

        <div className="dialog-divider" />

        <div className="dialog-body">
          <div className="dialog-fields">
            {/* Icon picker */}
            <div className="field-group">
              <label className="field-label">
                <MapPin size={12} strokeWidth={2} />
                Icon
              </label>
              <div className="loc-icon-grid">
                {ICON_PRESETS.map((emoji) => (
                  <button
                    key={emoji}
                    type="button"
                    className={`loc-icon-btn${icon === emoji ? " loc-icon-btn--active" : ""}`}
                    onClick={() => setIcon(emoji)}
                  >
                    {emoji}
                  </button>
                ))}
              </div>
              <input
                id="loc-icon-custom"
                type="text"
                placeholder="Or type any emoji…"
                value={icon}
                maxLength={4}
                onChange={(e) => setIcon(e.target.value)}
                className="field-input"
                style={{ marginTop: 8 }}
              />
            </div>

            {/* Name */}
            <div className="field-group">
              <label htmlFor="loc-name" className="field-label">
                Location Name <span style={{ color: "var(--danger)" }}>*</span>
              </label>
              <input
                id="loc-name"
                type="text"
                placeholder="e.g. Bedroom Shelf"
                value={name}
                onChange={(e) => { setName(e.target.value); setError(""); }}
                className={`field-input${error ? " field-input--error" : ""}`}
                autoFocus
              />
              {error && <p className="field-error">{error}</p>}
            </div>

            {/* Description */}
            <div className="field-group">
              <label htmlFor="loc-desc" className="field-label">
                Description
              </label>
              <input
                id="loc-desc"
                type="text"
                placeholder="Short description (optional)"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                className="field-input"
              />
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="dialog-footer">
          <button id="loc-cancel" className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            id="loc-save"
            className="btn-primary"
            onClick={handleSave}
            disabled={saving}
          >
            {saving ? "Saving…" : "Add Location"}
          </button>
        </div>
      </div>
    </div>
  );
}
