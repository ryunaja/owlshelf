import { useState, useMemo } from "react";
import { Topbar } from "@/components/layout/Topbar";
import { Sidebar } from "@/components/layout/Sidebar";
import { ItemGrid } from "@/components/items/ItemGrid";
import { SearchBar } from "@/components/items/SearchBar";
import { AddItemDialog } from "@/components/items/AddItemDialog";
import { ItemDetailDialog } from "@/components/items/ItemDetailDialog";
import { mockItems } from "@/data/mockItems";
import { useLocalStorage } from "@/lib/useLocalStorage";
import type { Profile, Location, Item, ItemType } from "@/types/item";

interface InventoryPageProps {
  profile: Profile;
  location: Location;
  onBack: () => void;
}

export function InventoryPage({ profile, location, onBack }: InventoryPageProps) {
  // Persists to localStorage; falls back to mockItems on first visit
  const [items, setItems] = useLocalStorage<Item[]>("owlshelf-items", mockItems);
  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  const [activeType, setActiveType] = useState<ItemType | "all">("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [editingItem, setEditingItem] = useState<Item | null>(null);
  const [detailItem, setDetailItem] = useState<Item | null>(null);

  /* Filtered items */
  const locationItems = useMemo(
    () => items.filter((i) => i.locationId === location.id),
    [items, location.id]
  );

  const visibleItems = useMemo(() => {
    return locationItems
      .filter((item) =>
        activeType !== "all" ? item.itemType === activeType : true
      )
      .filter((item) =>
        activeCategory
          ? item.category === activeCategory || item.tags.includes(activeCategory)
          : true
      )
      .filter((item) => {
        if (!searchQuery) return true;
        const q = searchQuery.toLowerCase();
        return (
          item.name.toLowerCase().includes(q) ||
          item.subtitle.toLowerCase().includes(q) ||
          item.tags.some((t) => t.toLowerCase().includes(q))
        );
      });
  }, [locationItems, activeType, activeCategory, searchQuery]);

  /* Build category filter list from current type-filtered items */
  const categories = useMemo(() => {
    const typeFiltered =
      activeType !== "all"
        ? locationItems.filter((i) => i.itemType === activeType)
        : locationItems;

    const counts: Record<string, number> = {};
    typeFiltered.forEach((i) => {
      counts[i.category] = (counts[i.category] ?? 0) + 1;
    });
    return Object.entries(counts).map(([name, count]) => ({ name, count }));
  }, [locationItems, activeType]);

  const totalStock = visibleItems.reduce((s, i) => s + i.stock, 0);

  /* Handlers */
  const handleDelete = (id: string) => {
    setItems((prev) => prev.filter((i) => i.id !== id));
  };

  const handleEdit = (item: Item) => {
    setEditingItem(item);
    setAddDialogOpen(true);
  };

  const handleDialogClose = () => {
    setAddDialogOpen(false);
    setEditingItem(null);
  };

  const handleSaveItem = (itemData: Partial<Item>) => {
    if (editingItem) {
      const updatedItem = { ...editingItem, ...itemData } as Item;
      setItems((prev) =>
        prev.map((i) => (i.id === editingItem.id ? updatedItem : i))
      );
      if (detailItem?.id === editingItem.id) {
        setDetailItem(updatedItem);
      }
    } else {
      const newItem: Item = {
        id: Math.random().toString(36).substring(2, 9),
        locationId: location.id,
        category: "Uncategorized",
        imageUrl: "https://images.unsplash.com/photo-1544947950-fa07a98d237f?auto=format&fit=crop&q=80&w=800",
        name: itemData.name || "Untitled",
        subtitle: itemData.subtitle || "",
        itemType: itemData.itemType || "book",
        stock: itemData.stock || 1,
        tags: itemData.tags || [],
        condition: itemData.condition || 3,
        description: itemData.description || "",
      } as Item;
      setItems((prev) => [...prev, newItem]);
    }
  };

  return (
    <div className="inventory-layout">
      <Topbar
        profile={profile}
        location={location}
        onBack={onBack}
        onAddItem={() => setAddDialogOpen(true)}
      />

      <div className="inventory-body">
        <Sidebar
          categories={categories}
          activeCategory={activeCategory}
          onCategoryChange={setActiveCategory}
          activeType={activeType}
          onTypeChange={(t) => {
            setActiveType(t);
            setActiveCategory(null);
          }}
        />

        <main className="inventory-main">
          {/* Section header */}
          <div className="section-header">
            <div>
              <h2 className="section-title">
                {location.icon} {location.name}
              </h2>
              <p className="section-meta">
                {visibleItems.length} item{visibleItems.length !== 1 ? "s" : ""}{" "}
                &middot; {totalStock} total{" "}
                {profile.type === "personal" ? "copies" : "units"}
              </p>
            </div>
            <SearchBar value={searchQuery} onChange={setSearchQuery} />
          </div>

          <div className="section-divider" />

          <ItemGrid
            items={visibleItems}
            onItemClick={setDetailItem}
            onEdit={handleEdit}
            onDelete={handleDelete}
          />
        </main>
      </div>

      {/* Dialogs */}
      <AddItemDialog
        open={addDialogOpen}
        locationName={location.name}
        editItem={editingItem}
        onClose={handleDialogClose}
        onSave={handleSaveItem}
      />

      <ItemDetailDialog
        item={detailItem}
        onClose={() => setDetailItem(null)}
        onEdit={handleEdit}
      />
    </div>
  );
}
