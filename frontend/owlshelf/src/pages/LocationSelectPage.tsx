import { Plus } from "lucide-react";
import { mockLocations } from "@/data/mockItems";
import type { Profile, Location } from "@/types/item";

interface LocationSelectPageProps {
  profile: Profile;
  onSelectLocation: (location: Location) => void;
  onBack: () => void;
}

export function LocationSelectPage({
  profile,
  onSelectLocation,
  onBack,
}: LocationSelectPageProps) {
  const locations = mockLocations.filter((l) => l.profileId === profile.id);

  return (
    <div className="location-page">
      {/* Top nav */}
      <header className="location-topbar">
        <button id="loc-back" className="loc-back-btn" onClick={onBack}>
          ← Back
        </button>
        <div className="location-topbar-brand">
          <span>{profile.avatarEmoji}</span>
          <span className="location-topbar-name">{profile.name}</span>
        </div>
        <div style={{ width: 80 }} />
      </header>

      <div className="location-page-inner">
        <div className="location-page-header">
          <h2 className="location-page-title">Where do you want to go?</h2>
          <p className="location-page-sub">Select a location to view its items</p>
        </div>

        {/* Location cards grid */}
        <div className="location-grid">
          {locations.map((loc) => (
            <button
              key={loc.id}
              id={`location-${loc.id}`}
              className="location-card"
              onClick={() => onSelectLocation(loc)}
            >
              <span className="location-card-icon">{loc.icon}</span>
              <div className="location-card-body">
                <p className="location-card-name">{loc.name}</p>
                <p className="location-card-desc">{loc.description}</p>
              </div>
              <span className="location-card-count">
                {loc.itemCount} item{loc.itemCount !== 1 ? "s" : ""}
              </span>
            </button>
          ))}

          {/* Add location placeholder */}
          <button id="btn-add-location" className="location-card location-card--add">
            <span className="location-card-icon">
              <Plus size={28} strokeWidth={1.5} />
            </span>
            <div className="location-card-body">
              <p className="location-card-name">Add Location</p>
              <p className="location-card-desc">Create a new shelf or space</p>
            </div>
          </button>
        </div>
      </div>
    </div>
  );
}
