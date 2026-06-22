import { useState } from "react";
import { Plus } from "lucide-react";
import { useLocations } from "@/lib/useDB";
import { AddLocationDialog } from "@/components/layout/AddLocationDialog";
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
  const { locations, loading, addLocation } = useLocations(profile.id);
  const [addDialogOpen, setAddDialogOpen] = useState(false);

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
          {loading ? (
            // Skeleton placeholders
            Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="location-card location-card--skeleton" />
            ))
          ) : (
            locations.map((loc) => (
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
            ))
          )}

          {/* Add location button */}
          <button
            id="btn-add-location"
            className="location-card location-card--add"
            onClick={() => setAddDialogOpen(true)}
          >
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

      {/* Add Location Dialog */}
      <AddLocationDialog
        open={addDialogOpen}
        profile={profile}
        onClose={() => setAddDialogOpen(false)}
        onSave={addLocation}
      />
    </div>
  );
}
