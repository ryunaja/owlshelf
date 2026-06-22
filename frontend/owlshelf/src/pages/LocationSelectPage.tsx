import { useState } from "react";
import { Plus, Pencil } from "lucide-react";
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
  const { locations, loading, addLocation, updateLocation } = useLocations(profile.id);
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [editingLocation, setEditingLocation] = useState<Location | null>(null);

  const handleEditClick = (e: React.MouseEvent, loc: Location) => {
    e.stopPropagation();
    setEditingLocation(loc);
    setAddDialogOpen(true);
  };

  const handleSaveLocation = async (data: Omit<Location, "id" | "itemCount">) => {
    if (editingLocation) {
      await updateLocation({ ...editingLocation, ...data });
    } else {
      await addLocation(data);
    }
  };

  const handleCloseDialog = () => {
    setAddDialogOpen(false);
    setEditingLocation(null);
  };

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
                <button 
                  className="card-menu-btn" 
                  onClick={(e) => handleEditClick(e, loc)}
                  aria-label="Edit location"
                  style={{ position: "absolute", top: 12, right: 12 }}
                >
                  <Pencil size={14} strokeWidth={2.5} />
                </button>
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

      {/* Add / Edit Location Dialog */}
      <AddLocationDialog
        open={addDialogOpen}
        profile={profile}
        editLocation={editingLocation}
        onClose={handleCloseDialog}
        onSave={handleSaveLocation}
      />
    </div>
  );
}
