import { Plus, Search } from "lucide-react";
import type { Profile, Location } from "@/types/item";
import logoSrc from "@/assets/logo.png";

interface TopbarProps {
  profile: Profile;
  location: Location;
  onBack: () => void;
  onAddItem: () => void;
  onOpenSearch: () => void;
}

export function Topbar({ profile, location, onBack, onAddItem, onOpenSearch }: TopbarProps) {
  return (
    <header className="topbar">
      {/* Breadcrumb / back */}
      <div className="topbar-brand">
        <button id="topbar-back" className="topbar-back-btn" onClick={onBack}>
          ←
        </button>
        <img src={logoSrc} alt="Owlshelf" className="topbar-logo" />
        <div className="topbar-breadcrumb">
          <span className="breadcrumb-profile">
            {profile.name}
          </span>
          <span className="breadcrumb-sep">›</span>
          <span className="breadcrumb-location">
            {location.icon} {location.name}
          </span>
        </div>
      </div>

      {/* Actions */}
      <div className="topbar-actions">
        <button
          id="btn-global-search"
          className="topbar-search-btn"
          onClick={onOpenSearch}
          aria-label="Search all items"
        >
          <Search size={18} strokeWidth={2} />
        </button>

        <button id="btn-add-item" className="btn-add" onClick={onAddItem}>
          <Plus size={16} strokeWidth={2.2} />
          Add Item
        </button>
      </div>
    </header>
  );
}
