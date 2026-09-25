import { Minus } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ItemType, CategoryFilter, Item } from "@/types/item";
import { ITEM_TYPE_PRESETS, getItemTypeLabel } from "@/types/item";

interface SidebarProps {
  items: Item[];                          // full unfiltered list — used to discover custom types
  categories: CategoryFilter[];
  activeCategory: string | null;
  onCategoryChange: (cat: string | null) => void;
  activeType: ItemType | "all";
  onTypeChange: (type: ItemType | "all") => void;
}

export function Sidebar({
  items,
  categories,
  activeCategory,
  onCategoryChange,
  activeType,
  onTypeChange,
}: SidebarProps) {
  // Build type list: hardcoded presets first, then any extra custom types from real items
  const presetSet = new Set<string>(ITEM_TYPE_PRESETS);
  const customTypes = Array.from(
    new Set(items.map((i) => i.itemType).filter((t) => t && !presetSet.has(t)))
  );

  const allTypes: { value: ItemType | "all"; label: string }[] = [
    { value: "all", label: "All Types" },
    ...ITEM_TYPE_PRESETS.map((v) => ({ value: v, label: getItemTypeLabel(v) })),
    ...customTypes.map((v) => ({ value: v, label: getItemTypeLabel(v) })),
  ];

  return (
    <aside className="sidebar">
      <h2 className="sidebar-title">Sort &amp; Sift</h2>
      <div className="sidebar-divider" />

      {/* Item Type dropdown */}
      <section className="sidebar-section">
        <div className="sidebar-section-header">
          <Minus size={12} strokeWidth={2} className="sidebar-dash" />
          <span className="sidebar-section-label">Item Type</span>
        </div>
        <select
          id="select-item-type"
          className="type-select"
          value={activeType}
          onChange={(e) => {
            onTypeChange(e.target.value as ItemType | "all");
            onCategoryChange(null); // reset category when type changes
          }}
        >
          {allTypes.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </select>
      </section>

      <div className="sidebar-divider" style={{ marginTop: 16 }} />

      {/* Category filter */}
      <section className="sidebar-section">
        <div className="sidebar-section-header">
          <Minus size={12} strokeWidth={2} className="sidebar-dash" />
          <span className="sidebar-section-label">Category</span>
        </div>

        <ul className="sidebar-list" role="listbox" aria-label="Category filter">
          <li>
            <button
              id="filter-all"
              role="option"
              aria-selected={activeCategory === null}
              className={cn(
                "sidebar-filter-btn",
                activeCategory === null && "sidebar-filter-btn--active"
              )}
              onClick={() => onCategoryChange(null)}
            >
              <span className="filter-label">All</span>
              <span className="filter-count">
                {categories.reduce((s, c) => s + c.count, 0)}
              </span>
            </button>
          </li>
          {categories.map((cat) => (
            <li key={cat.name}>
              <button
                id={`filter-${cat.name.toLowerCase().replace(/\s+/g, "-")}`}
                role="option"
                aria-selected={activeCategory === cat.name}
                className={cn(
                  "sidebar-filter-btn",
                  activeCategory === cat.name && "sidebar-filter-btn--active"
                )}
                onClick={() =>
                  onCategoryChange(activeCategory === cat.name ? null : cat.name)
                }
              >
                <span className="filter-icon" aria-hidden="true" />
                <span className="filter-label">{cat.name}</span>
                <span className="filter-count">{cat.count}</span>
              </button>
            </li>
          ))}
        </ul>
      </section>
    </aside>
  );
}
