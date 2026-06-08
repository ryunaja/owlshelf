import { Plus } from "lucide-react";
import type { Profile, Location } from "@/types/item";

interface TopbarProps {
  profile: Profile;
  location: Location;
  onBack: () => void;
  onAddItem: () => void;
}

export function Topbar({ profile, location, onBack, onAddItem }: TopbarProps) {
  return (
    <header className="topbar">
      {/* Breadcrumb / back */}
      <div className="topbar-brand">
        <button id="topbar-back" className="topbar-back-btn" onClick={onBack}>
          ←
        </button>
        <div className="topbar-breadcrumb">
          <span className="breadcrumb-profile">
            {profile.avatarEmoji} {profile.name}
          </span>
          <span className="breadcrumb-sep">›</span>
          <span className="breadcrumb-location">
            {location.icon} {location.name}
          </span>
        </div>
      </div>

      {/* Add button */}
      <button id="btn-add-item" className="btn-add" onClick={onAddItem}>
        <Plus size={16} strokeWidth={2.2} />
        Add Item
      </button>
    </header>
  );
}
