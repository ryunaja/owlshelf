import { Minus } from "lucide-react";
import { cn } from "@/lib/utils";
import type { CategoryFilter } from "@/types/item";

interface SidebarProps {
  categories: CategoryFilter[];
  activeCategory: string | null;
  onCategoryChange: (cat: string | null) => void;
}

export function Sidebar({
  categories,
  activeCategory,
  onCategoryChange,
}: SidebarProps) {
  return (
    <aside className="sidebar">
      <h2 className="sidebar-title">Sort &amp; Sift</h2>

      {/* Dashed divider */}
      <div className="sidebar-divider" />

      <section className="sidebar-section">
        <div className="sidebar-section-header">
          <Minus size={12} strokeWidth={2} className="sidebar-dash" />
          <span className="sidebar-section-label">Category</span>
        </div>

        <ul className="sidebar-list" role="listbox" aria-label="Category filter">
          {/* "All" option */}
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
              <span className="filter-label">All Items</span>
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
