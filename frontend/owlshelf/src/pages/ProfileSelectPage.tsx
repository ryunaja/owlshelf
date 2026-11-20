import { useState } from "react";
import { Plus } from "lucide-react";
import { useProfiles } from "@/lib/useDB";
import type { Profile } from "@/types/item";
import { cn } from "@/lib/utils";
import logoImg from "@/assets/logo.png";
import { TypewriterBrand } from "@/components/layout/TypewriterBrand";
import { AddProfileDialog } from "@/components/layout/AddProfileDialog";

interface ProfileSelectPageProps {
  onSelect: (profile: Profile) => void;
}

export function ProfileSelectPage({ onSelect }: ProfileSelectPageProps) {
  const { profiles, loading, error, addProfile } = useProfiles();
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
          ) : profiles.length === 0 ? (
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
        </div>

        {error && (
          <p className="field-error" style={{ marginTop: 12 }}>
            {error}
          </p>
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
