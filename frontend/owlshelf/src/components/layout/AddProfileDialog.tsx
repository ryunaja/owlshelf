import { useState, useEffect } from "react";
import { X, User } from "lucide-react";
import type { Profile, AccountType } from "@/types/item";

const AVATAR_PRESETS = ["🦉", "👤", "🏡", "💼", "📚", "🧺", "🏬", "📦"];

const PROFILE_TYPES: { value: AccountType; label: string }[] = [
  { value: "personal", label: "Personal" },
  { value: "business", label: "Business" },
];

interface AddProfileDialogProps {
  open: boolean;
  onClose: () => void;
  onSave: (data: Omit<Profile, "id">) => Promise<void>;
}

export function AddProfileDialog({ open, onClose, onSave }: AddProfileDialogProps) {
  const [name, setName] = useState("");
  const [type, setType] = useState<AccountType>("personal");
  const [avatarEmoji, setAvatarEmoji] = useState("👤");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (open) {
      setName("");
      setType("personal");
      setAvatarEmoji("👤");
      setError("");
    }
  }, [open]);

  if (!open) return null;

  const handleSave = async () => {
    if (!name.trim()) {
      setError("Profile name is required.");
      return;
    }
    setSaving(true);
    try {
      await onSave({
        name: name.trim(),
        type,
        avatarEmoji: avatarEmoji || "👤",
      });
      // Success — the parent (useProfiles) has already added the card.
      onClose();
    } catch {
      // Failure — keep the dialog open with the user's input so they
      // can retry without retyping (same contract as AddLocationDialog).
      setError("Failed to create profile. Please try again.");
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
        aria-labelledby="add-profile-title"
        style={{ maxWidth: 440 }}
      >
        {/* Header */}
        <div className="dialog-header">
          <div>
            <h2 id="add-profile-title" className="dialog-title">
              Create Profile
            </h2>
            <p className="dialog-subtitle">
              Set up your first shelf on this device
            </p>
          </div>
          <button
            id="add-profile-close"
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
            {/* Name */}
            <div className="field-group">
              <label htmlFor="profile-name" className="field-label">
                Profile Name <span style={{ color: "var(--danger)" }}>*</span>
              </label>
              <input
                id="profile-name"
                type="text"
                placeholder="e.g. My Shelf, Workshop, Back Office…"
                value={name}
                onChange={(e) => { setName(e.target.value); setError(""); }}
                className={`field-input${error ? " field-input--error" : ""}`}
                autoFocus
              />
              {error && <p className="field-error">{error}</p>}
            </div>

            {/* Avatar picker */}
            <div className="field-group">
              <label className="field-label">
                <User size={12} strokeWidth={2} />
                Avatar
              </label>
              <div className="loc-icon-grid">
                {AVATAR_PRESETS.map((emoji) => (
                  <button
                    key={emoji}
                    type="button"
                    className={`loc-icon-btn${avatarEmoji === emoji ? " loc-icon-btn--active" : ""}`}
                    onClick={() => setAvatarEmoji(emoji)}
                  >
                    {emoji}
                  </button>
                ))}
              </div>
              <input
                id="profile-avatar-custom"
                type="text"
                placeholder="Or type any emoji…"
                value={avatarEmoji}
                maxLength={4}
                onChange={(e) => setAvatarEmoji(e.target.value)}
                className="field-input"
                style={{ marginTop: 8 }}
              />
            </div>

            {/* Account type */}
            <div className="field-group">
              <label className="field-label">Account Type</label>
              <div className="condition-selector">
                {PROFILE_TYPES.map((t) => (
                  <button
                    key={t.value}
                    type="button"
                    id={`profile-type-${t.value}`}
                    className={`cond-btn${type === t.value ? " cond-btn--active" : ""}`}
                    style={{ flex: 1, padding: "8px 14px" }}
                    onClick={() => setType(t.value)}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
              <p className="field-hint">
                {type === "personal"
                  ? "Personal — your own collection"
                  : "Business — stock or workspace inventory"}
              </p>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="dialog-footer">
          <div style={{ display: "flex", gap: "12px", marginLeft: "auto" }}>
            <button id="profile-cancel" className="btn-ghost" onClick={onClose}>
              Cancel
            </button>
            <button
              id="profile-save"
              className="btn-primary"
              onClick={handleSave}
              disabled={saving}
            >
              {saving ? "Creating…" : "Create Profile"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
