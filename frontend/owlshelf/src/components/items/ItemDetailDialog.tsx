import { X, Diamond } from "lucide-react";
import type { Item } from "@/types/item";
import { ITEM_TYPE_LABELS } from "@/types/item";

interface ItemDetailDialogProps {
  item: Item | null;
  onClose: () => void;
  onEdit: (item: Item) => void;
}

function ConditionDots({ value }: { value: number }) {
  const labels = ["", "Poor", "Fair", "Good", "Very Good", "Pristine"];
  return (
    <div className="detail-condition">
      <div className="condition-dots">
        {Array.from({ length: 5 }).map((_, i) => (
          <span
            key={i}
            className={`condition-dot${i < value ? " condition-dot--filled" : ""}`}
          />
        ))}
      </div>
      <span className="condition-label">{labels[value]}</span>
    </div>
  );
}

export function ItemDetailDialog({
  item,
  onClose,
  onEdit,
}: ItemDetailDialogProps) {
  if (!item) return null;

  return (
    <div
      className="dialog-backdrop"
      role="presentation"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        className="dialog detail-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="detail-title"
      >
        {/* Image */}
        <div className="detail-image-wrap">
          {item.imageUrl ? (
            <img
              src={item.imageUrl}
              alt={item.name}
              className="detail-image"
            />
          ) : (
            <div className="detail-image-placeholder">
              <Diamond size={40} strokeWidth={0.8} className="placeholder-icon" />
            </div>
          )}

          {/* Close button */}
          <button
            id="detail-close"
            className="detail-close-btn"
            onClick={onClose}
            aria-label="Close"
          >
            <X size={16} strokeWidth={2.5} />
          </button>

          {/* Stock badge */}
          {item.stock > 0 && (
            <div className="detail-stock-badge">
              ×{item.stock} in stock
            </div>
          )}
        </div>

        {/* Content */}
        <div className="detail-body">
          {/* Type pill */}
          <div className="detail-type-row">
            <span className="detail-type-pill">
              {ITEM_TYPE_LABELS[item.itemType]}
            </span>
            {item.tags.map((tag) => (
              <span key={tag} className="card-tag-pill">
                {tag}
              </span>
            ))}
          </div>

          <h2 id="detail-title" className="detail-name">
            {item.name}
          </h2>
          <p className="detail-subtitle">{item.subtitle}</p>

          <p className="detail-desc">{item.description}</p>

          <div className="detail-divider" />

          {/* Meta row */}
          <div className="detail-meta">
            <div className="detail-meta-item">
              <span className="detail-meta-label">Condition</span>
              <ConditionDots value={item.condition} />
            </div>
            <div className="detail-meta-item">
              <span className="detail-meta-label">Category</span>
              <span className="detail-meta-value">{item.category}</span>
            </div>
          </div>

          {/* Edit button */}
          <button
            id="detail-edit"
            className="btn-primary detail-edit-btn"
            onClick={() => {
              onClose();
              onEdit(item);
            }}
          >
            Edit Item
          </button>
        </div>
      </div>
    </div>
  );
}
