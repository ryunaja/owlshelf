import { useState } from "react";
import { Diamond, MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Item } from "@/types/item";

interface ItemCardProps {
  item: Item;
  onClick: () => void;
  onEdit: (item: Item) => void;
  onDelete: (id: string) => void;
}

function ConditionDots({ value }: { value: number }) {
  return (
    <div className="condition-dots" aria-label={`Condition ${value} of 5`}>
      {Array.from({ length: 5 }).map((_, i) => (
        <span
          key={i}
          className={cn("condition-dot", i < value && "condition-dot--filled")}
        />
      ))}
    </div>
  );
}

export function ItemCard({ item, onClick, onEdit, onDelete }: ItemCardProps) {
  const [menuOpen, setMenuOpen] = useState(false);

  const conditionLabel = [
    "",
    "Poor",
    "Fair",
    "Good",
    "Very Good",
    "Pristine",
  ][item.condition];

  return (
    <article
      className="item-card"
      tabIndex={0}
      role="button"
      aria-label={`${item.name}, stock: ${item.stock}`}
      onClick={() => {
        if (!menuOpen) onClick();
      }}
      onKeyDown={(e) => e.key === "Enter" && !menuOpen && onClick()}
    >
      {/* Image area */}
      <div className="card-image-wrap">
        {item.imageUrl ? (
          <img
            src={item.imageUrl}
            alt={item.name}
            className="card-image"
            loading="lazy"
          />
        ) : (
          <div className="card-image-placeholder">
            <Diamond size={28} strokeWidth={1} className="placeholder-icon" />
          </div>
        )}

        {/* Stock badge */}
        {item.stock > 1 && (
          <div className="stock-badge">
            <Diamond size={10} strokeWidth={2} />
            &thinsp;×{item.stock}
          </div>
        )}

        {/* Three-dot menu */}
        <div className="card-menu-wrap" onClick={(e) => e.stopPropagation()}>
          <button
            id={`card-menu-${item.id}`}
            className={cn("card-menu-btn", menuOpen && "card-menu-btn--open")}
            aria-label="Item options"
            onClick={() => setMenuOpen((v) => !v)}
          >
            <MoreHorizontal size={15} strokeWidth={2} />
          </button>

          {menuOpen && (
            <div className="card-menu-dropdown" role="menu">
              <button
                id={`card-edit-${item.id}`}
                role="menuitem"
                className="card-menu-item"
                onClick={() => {
                  setMenuOpen(false);
                  onEdit(item);
                }}
              >
                <Pencil size={13} strokeWidth={2} />
                Edit
              </button>
              <button
                id={`card-delete-${item.id}`}
                role="menuitem"
                className="card-menu-item card-menu-item--danger"
                onClick={() => {
                  setMenuOpen(false);
                  onDelete(item.id);
                }}
              >
                <Trash2 size={13} strokeWidth={2} />
                Delete
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Card body */}
      <div className="card-body">
        <Diamond
          size={11}
          strokeWidth={1.5}
          className="card-diamond"
          aria-hidden
        />
        <h3 className="card-name">{item.name}</h3>
        <p className="card-subtitle">{item.subtitle}</p>
        <p className="card-desc">{item.description}</p>

        <div className="card-footer">
          <div className="card-footer-left">
            <ConditionDots value={item.condition} />
            <span className="condition-label">{conditionLabel}</span>
          </div>
          <span className="card-tag-pill">{item.tags[0]}</span>
        </div>
      </div>
    </article>
  );
}
