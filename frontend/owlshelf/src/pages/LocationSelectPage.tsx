import { useState } from "react";
import { Plus, Pencil, Search, Users } from "lucide-react";
import { useLocations } from "@/lib/hooks";
import { AddLocationDialog } from "@/components/layout/AddLocationDialog";
import { ShareRoomDialog } from "@/components/rooms/ShareRoomDialog";
import type { Profile, Location } from "@/types/item";
import logoSrc from "@/assets/logo.png";

interface LocationSelectPageProps {
  profile: Profile;
  onSelectLocation: (location: Location) => void;
  onBack: () => void;
  onOpenSearch: () => void;
}

export function LocationSelectPage({
  profile,
  onSelectLocation,
  onBack,
  onOpenSearch,
}: LocationSelectPageProps) {
  const { locations, loading, addLocation, updateLocation, deleteLocation } = useLocations(profile.id);
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [editingLocation, setEditingLocation] = useState<Location | null>(null);
  const [shareOpen, setShareOpen] = useState(false);

  const handleEditClick = (e: React.MouseEvent, loc: Location) => {
    e.stopPropagation();
    setEditingLocation(loc);
    setAddDialogOpen(true);
  };

  const handleSaveLocation = async (data: Omit<Location, "id">) => {
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
          <img src={logoSrc} alt="Owlshelf" className="loc-topbar-logo" />
          <span className="location-topbar-name">{profile.name}</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <button
            id="loc-share-btn"
            className="loc-search-btn"
            onClick={() => setShareOpen(true)}
            aria-label="Share this shelf"
            title="Devices and invites"
          >
            <Users size={18} strokeWidth={2} />
          </button>
          <button
            id="loc-search-btn"
            className="loc-search-btn"
            onClick={onOpenSearch}
            aria-label="Global search"
          >
            <Search size={18} strokeWidth={2} />
          </button>
        </div>
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
              <div
                key={loc.id}
                id={`location-${loc.id}`}
                className="location-card"
                role="button"
                tabIndex={0}
                onClick={() => onSelectLocation(loc)}
                onKeyDown={(e) => e.key === "Enter" && onSelectLocation(loc)}
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
              </div>
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
        onDelete={deleteLocation}
      />

      <ShareRoomDialog
        open={shareOpen}
        roomId={profile.id}
        roomName={profile.name}
        onClose={() => setShareOpen(false)}
      />
    </div>
  );
}
