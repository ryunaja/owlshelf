import { useState, useMemo } from "react";
import { Topbar } from "@/components/layout/Topbar";
import { Sidebar } from "@/components/layout/Sidebar";
import { ItemGrid } from "@/components/items/ItemGrid";
import { AddItemDialog } from "@/components/items/AddItemDialog";
import {
  mockItems,
  personalCategories,
  businessCategories,
} from "@/data/mockItems";
import type { AppMode } from "@/types/item";

export function InventoryPage() {
  const [mode, setMode] = useState<AppMode>("personal");
  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

  /* Reset filter when switching modes */
  const handleModeChange = (next: AppMode) => {
    setMode(next);
    setActiveCategory(null);
  };

  const categories =
    mode === "personal" ? personalCategories : businessCategories;

  const visibleItems = useMemo(() => {
    return mockItems
      .filter((item) => item.mode === mode)
      .filter((item) =>
        activeCategory
          ? item.category === activeCategory || item.tags.includes(activeCategory)
          : true
      );
  }, [mode, activeCategory]);

  const totalStock = visibleItems.reduce((s, i) => s + i.stock, 0);

  return (
    <div className="inventory-layout">
      <Topbar
        mode={mode}
        onModeChange={handleModeChange}
        onAddItem={() => setDialogOpen(true)}
      />

      <div className="inventory-body">
        <Sidebar
          categories={categories}
          activeCategory={activeCategory}
          onCategoryChange={setActiveCategory}
        />

        {/* Main content */}
        <main className="inventory-main">
          {/* Section header */}
          <div className="section-header">
            <div>
              <h2 className="section-title">
                {mode === "personal" ? "My Collection" : "Stock Overview"}
              </h2>
              <p className="section-meta">
                {visibleItems.length} item
                {visibleItems.length !== 1 ? "s" : ""} &middot; {totalStock}{" "}
                total {mode === "personal" ? "copies" : "units"}
              </p>
            </div>
          </div>

          <div className="section-divider" />

          <ItemGrid
            items={visibleItems}
            onItemClick={() => {
              /* detail view — phase 2 */
            }}
          />
        </main>
      </div>

      <AddItemDialog
        open={dialogOpen}
        mode={mode}
        onClose={() => setDialogOpen(false)}
      />
    </div>
  );
}
