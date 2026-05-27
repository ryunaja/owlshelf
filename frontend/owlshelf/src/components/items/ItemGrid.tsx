import { ItemCard } from "./ItemCard";
import type { Item } from "@/types/item";

interface ItemGridProps {
  items: Item[];
  onItemClick?: (item: Item) => void;
}

export function ItemGrid({ items, onItemClick }: ItemGridProps) {
  if (items.length === 0) {
    return (
      <div className="grid-empty">
        <p className="grid-empty-text">No items found.</p>
      </div>
    );
  }

  return (
    <div className="item-grid" role="list" aria-label="Inventory items">
      {items.map((item) => (
        <div key={item.id} role="listitem">
          <ItemCard item={item} onClick={() => onItemClick?.(item)} />
        </div>
      ))}
    </div>
  );
}
