import { useState, useMemo } from "react";
import { Topbar } from "@/components/layout/Topbar";
import { Sidebar } from "@/components/layout/Sidebar";
import { ItemGrid } from "@/components/items/ItemGrid";
import { SearchBar } from "@/components/items/SearchBar";
import { AddItemDialog } from "@/components/items/AddItemDialog";
import { ItemDetailDialog } from "@/components/items/ItemDetailDialog";
import { useItems } from "@/lib/useDB";
import type { Profile, Location, Item, ItemType } from "@/types/item";

interface InventoryPageProps {
  profile: Profile;
  location: Location;
  onBack: () => void;
  onOpenSearch: () => void;
}

export function InventoryPage({ profile, location, onBack, onOpenSearch }: InventoryPageProps) {
  const { items, loading, addItem, updateItem, deleteItem } = useItems(location.id);

  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  const [activeType, setActiveType] = useState<ItemType | "all">("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [editingItem, setEditingItem] = useState<Item | null>(null);
  const [detailItem, setDetailItem] = useState<Item | null>(null);

  /* Filtered items */
  const visibleItems = useMemo(() => {
    return items
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
  }, [items, activeType, activeCategory, searchQuery]);

  /* Category filter list */
  const categories = useMemo(() => {
    const source =
      activeType !== "all"
        ? items.filter((i) => i.itemType === activeType)
        : items;
    const counts: Record<string, number> = {};
    source.forEach((i) => {
      counts[i.category] = (counts[i.category] ?? 0) + 1;
    });
    return Object.entries(counts).map(([name, count]) => ({ name, count }));
  }, [items, activeType]);

  const totalStock = visibleItems.reduce((s, i) => s + i.stock, 0);

  /* Handlers */
  const handleDelete = async (id: string) => {
    await deleteItem(id);
    if (detailItem?.id === id) setDetailItem(null);
  };

  const handleEdit = (item: Item) => {
    setEditingItem(item);
    setAddDialogOpen(true);
  };

  const handleDialogClose = () => {
    setAddDialogOpen(false);
    setEditingItem(null);
  };

  const handleSaveItem = async (itemData: Partial<Item>) => {
    if (editingItem) {
      const updated = { ...editingItem, ...itemData } as Item;
      await updateItem(updated);
      if (detailItem?.id === updated.id) setDetailItem(updated);
    } else {
      await addItem(location.id, {
        name:        itemData.name        ?? "Untitled",
        subtitle:    itemData.subtitle    ?? "",
        description: itemData.description ?? "",
        stock:       itemData.stock,
        tags:        itemData.tags,
        category:    itemData.category,
        itemType:    itemData.itemType,
        condition:   itemData.condition,
        imageUrl:    itemData.imageUrl,
      });
    }
  };

  return (
    <div className="inventory-layout">
      <Topbar
        profile={profile}
        location={location}
        onBack={onBack}
        onAddItem={() => setAddDialogOpen(true)}
        onOpenSearch={onOpenSearch}
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

          {loading ? (
            <div className="items-loading">Loading items…</div>
          ) : (
            <ItemGrid
              items={visibleItems}
              onItemClick={setDetailItem}
              onEdit={handleEdit}
              onDelete={handleDelete}
            />
          )}
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
