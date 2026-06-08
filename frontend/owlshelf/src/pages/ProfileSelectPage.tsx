import { mockProfiles } from "@/data/mockItems";
import type { Profile } from "@/types/item";
import { cn } from "@/lib/utils";

interface ProfileSelectPageProps {
  onSelect: (profile: Profile) => void;
}

export function ProfileSelectPage({ onSelect }: ProfileSelectPageProps) {
  return (
    <div className="profile-select-page">
      <div className="profile-select-inner">
        {/* Header */}
        <div className="profile-select-header">
          <div className="app-logo-block">
            <span className="app-logo-emoji">🦉</span>
            <h1 className="app-logo-name">Owlshelf</h1>
          </div>
          <p className="profile-select-sub">
            Choose a profile to continue
          </p>
        </div>

        {/* Profile cards */}
        <div className="profile-cards">
          {mockProfiles.map((profile) => (
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
          ))}
        </div>

        <p className="profile-select-foot">
          Profiles are stored locally on this device
        </p>
      </div>
    </div>
  );
}
