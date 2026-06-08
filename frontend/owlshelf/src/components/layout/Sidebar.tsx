import { Minus } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ItemType, CategoryFilter } from "@/types/item";
import { ITEM_TYPE_LABELS } from "@/types/item";

const ALL_TYPES: { value: ItemType | "all"; label: string }[] = [
  { value: "all", label: "All Types" },
  { value: "book", label: ITEM_TYPE_LABELS.book },
  { value: "collection", label: ITEM_TYPE_LABELS.collection },
  { value: "electronics", label: ITEM_TYPE_LABELS.electronics },
  { value: "clothing", label: ITEM_TYPE_LABELS.clothing },
  { value: "food", label: ITEM_TYPE_LABELS.food },
  { value: "other", label: ITEM_TYPE_LABELS.other },
];

interface SidebarProps {
  categories: CategoryFilter[];
  activeCategory: string | null;
  onCategoryChange: (cat: string | null) => void;
  activeType: ItemType | "all";
  onTypeChange: (type: ItemType | "all") => void;
}

export function Sidebar({
  categories,
  activeCategory,
  onCategoryChange,
  activeType,
  onTypeChange,
}: SidebarProps) {
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
          {ALL_TYPES.map((t) => (
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
                  onCategoryChange(
                    activeCategory === cat.name ? null : cat.name
                  )
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
