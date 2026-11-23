import { useState } from "react";
import { Plus } from "lucide-react";
import { useProfiles } from "@/lib/hooks";
import type { Profile } from "@/types/item";
import { cn } from "@/lib/utils";
import logoImg from "@/assets/logo.png";
import { TypewriterBrand } from "@/components/layout/TypewriterBrand";
import { AddProfileDialog } from "@/components/layout/AddProfileDialog";

interface ProfileSelectPageProps {
  onSelect: (profile: Profile) => void;
}

export function ProfileSelectPage({ onSelect }: ProfileSelectPageProps) {
  const { profiles, loading, error, addProfile, reload } = useProfiles();
  const [addDialogOpen, setAddDialogOpen] = useState(false);

  return (
    <div className="profile-select-page">
      <div className="profile-select-inner">
        {/* Header */}
        <div className="profile-select-header">
          <div style={{ marginBottom: '1.5rem' }}>
            <TypewriterBrand text="Owlshelf" />
          </div>
          <div className="app-logo-block">
            <img src={logoImg} alt="Owlshelf Logo" className="app-logo-img" />
          </div>
          <p className="profile-select-sub">
            Choose a profile to continue
          </p>
        </div>

        {/* Profile cards */}
        <div className="profile-cards">
          {loading ? (
            <>
              <div className="profile-card profile-card--skeleton" />
              <div className="profile-card profile-card--skeleton" />
            </>
          ) : profiles.length === 0 && !error ? (
            /* First-run empty state: prod installs start with no demo
               data, so the user must be able to create profile #1 here. */
            <div
              id="profile-empty-state"
              className="profile-card"
              style={{
                gridColumn: "1 / -1",
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: "12px",
                padding: "2.5rem 2rem",
                textAlign: "center",
              }}
            >
              <span style={{ fontSize: "2.5rem" }}>🦉</span>
              <div>
                <p className="profile-card-name" style={{ marginBottom: 4 }}>
                  No profiles yet
                </p>
                <p className="profile-card-type">
                  Create your first profile to start building your shelf
                </p>
              </div>
              <button
                id="btn-add-profile"
                className="btn-primary"
                onClick={() => setAddDialogOpen(true)}
              >
                <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                  <Plus size={16} strokeWidth={2} />
                  Create Profile
                </span>
              </button>
            </div>
          ) : (
            profiles.map((profile) => (
              <button
                key={profile.id}
                id={`profile-${profile.id}`}
                className={cn(
                  "profile-card",
                  profile.type === "personal"
                    ? "profile-card--personal"
                    : "profile-card--business"
                )}
                onClick={() => onSelect(profile)}
              >
                <span className="profile-card-emoji">{profile.avatarEmoji}</span>
                <div>
                  <p className="profile-card-name">{profile.name}</p>
                  <p className="profile-card-type">
                    {profile.type === "personal"
                      ? "Personal collection"
                      : "Business inventory"}
                  </p>
                </div>
                <span className="profile-card-arrow">→</span>
              </button>
            ))
          )}

          {/* Create Profile — persistent entry point: profiles are rooms,
              so another can be created at any time, not just at first run. */}
          {!loading && !error && profiles.length > 0 && (
            <button
              id="btn-add-profile"
              className="profile-card"
              style={{
                borderStyle: "dashed",
                borderColor: "var(--border-dashed)",
                background: "transparent",
                boxShadow: "none",
              }}
              onClick={() => setAddDialogOpen(true)}
            >
              <span
                className="profile-card-emoji"
                style={{ fontSize: 24, color: "var(--text-muted)", lineHeight: 1 }}
              >
                <Plus size={22} strokeWidth={1.5} />
              </span>
              <div>
                <p className="profile-card-name">Create Profile</p>
                <p className="profile-card-type">
                  Set up another shelf on this device
                </p>
              </div>
            </button>
          )}
        </div>

        {error && (
          <div
            id="db-open-error"
            role="alert"
            style={{
              marginTop: 16,
              padding: "14px 16px",
              border: "1px solid var(--danger)",
              borderRadius: 10,
              background: "rgba(220, 38, 38, 0.06)",
              textAlign: "left",
              maxWidth: 520,
            }}
          >
            <p style={{ fontWeight: 600, marginBottom: 4 }}>
              Couldn't open your shelf
            </p>
            <p style={{ fontSize: 13, color: "var(--text-muted)", marginBottom: 8 }}>
              Your data is still on this device. Retrying resumes the migration
              where it stopped — nothing is deleted.
            </p>
            <p
              style={{
                fontSize: 12,
                color: "var(--text-muted)",
                marginBottom: 10,
                wordBreak: "break-word",
              }}
            >
              {error.message}
            </p>
            <button
              id="btn-retry-open"
              className="btn-primary"
              onClick={() => void reload()}
              disabled={loading}
            >
              {loading ? "Retrying…" : "Retry"}
            </button>
          </div>
        )}

        <p className="profile-select-foot">
          Profiles are stored locally on this device
        </p>
      </div>

      {/* Create Profile (first-run / empty state) */}
      <AddProfileDialog
        open={addDialogOpen}
        onClose={() => setAddDialogOpen(false)}
        onSave={addProfile}
      />
    </div>
  );
}
