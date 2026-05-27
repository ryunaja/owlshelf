import { Diamond } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Item } from "@/types/item";

interface ItemCardProps {
  item: Item;
  onClick?: () => void;
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

export function ItemCard({ item, onClick }: ItemCardProps) {
  const conditionLabel = ["", "Poor", "Fair", "Good", "Very Good", "Pristine"][
    item.condition
  ];

  return (
    <article
      className="item-card"
      onClick={onClick}
      tabIndex={0}
      role="button"
      aria-label={`${item.name}, stock: ${item.stock}`}
      onKeyDown={(e) => e.key === "Enter" && onClick?.()}
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
            <Diamond
              size={28}
              strokeWidth={1}
              className="placeholder-icon"
            />
          </div>
        )}

        {/* Stock badge */}
        {item.stock > 1 && (
          <div className="stock-badge" aria-label={`${item.stock} in stock`}>
            <Diamond size={10} strokeWidth={2} />
            &thinsp;×{item.stock}
          </div>
        )}
      </div>

      {/* Card body */}
      <div className="card-body">
        {/* Tiny diamond decorator (top-right like prototype) */}
        <Diamond
          size={11}
          strokeWidth={1.5}
          className="card-diamond"
          aria-hidden
        />

        <h3 className="card-name">{item.name}</h3>
        <p className="card-subtitle">{item.subtitle}</p>
        <p className="card-desc">{item.description}</p>

        {/* Footer row */}
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
