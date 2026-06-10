import { useState, useEffect } from "react";
import { X, Plus, Minus, Tag, Upload } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Item, ItemType, Condition } from "@/types/item";
import { ITEM_TYPE_LABELS } from "@/types/item";

interface AddItemDialogProps {
  open: boolean;
  locationName: string;
  editItem?: Item | null; // if provided → edit mode
  onClose: () => void;
  onSave?: (itemData: Partial<Item>) => void;
}

const CONDITIONS: { value: Condition; label: string }[] = [
  { value: 1, label: "Poor" },
  { value: 2, label: "Fair" },
  { value: 3, label: "Good" },
  { value: 4, label: "Very Good" },
  { value: 5, label: "Pristine" },
];

const ITEM_TYPES: { value: ItemType; label: string }[] = Object.entries(
  ITEM_TYPE_LABELS
).map(([value, label]) => ({ value: value as ItemType, label }));

export function AddItemDialog({
  open,
  locationName,
  editItem,
  onClose,
  onSave,
}: AddItemDialogProps) {
  const isEdit = !!editItem;

  const [quantity, setQuantity] = useState(1);
  const [condition, setCondition] = useState<Condition>(3);
  const [itemType, setItemType] = useState<ItemType>("book");

  /* Pre-fill when editing */
  useEffect(() => {
    if (editItem) {
      setQuantity(editItem.stock);
      setCondition(editItem.condition);
      setItemType(editItem.itemType);
    } else {
      setQuantity(1);
      setCondition(3);
      setItemType("book");
    }
  }, [editItem, open]);

  const handleSave = () => {
    const nameInput = document.getElementById("field-name") as HTMLInputElement;
    const subtitleInput = document.getElementById("field-subtitle") as HTMLInputElement;
    const tagsInput = document.getElementById("field-tags") as HTMLInputElement;
    const descInput = document.getElementById("field-desc") as HTMLTextAreaElement;

    const name = nameInput?.value || "";
    const subtitle = subtitleInput?.value || "";
    const tags = tagsInput?.value.split(",").map(t => t.trim()).filter(Boolean) || [];
    const description = descInput?.value || "";

    if (onSave) {
      onSave({
        name,
        subtitle,
        itemType,
        stock: quantity,
        tags,
        condition,
        description,
      });
    }
    onClose();
  };

  if (!open) return null;

  return (
    <div
      className="dialog-backdrop"
      role="presentation"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="dialog-title"
      >
        {/* Header */}
        <div className="dialog-header">
          <div>
            <h2 id="dialog-title" className="dialog-title">
              {isEdit ? "Edit Item" : "Add New Item"}
            </h2>
            <p className="dialog-subtitle">
              {isEdit
                ? `Editing in ${locationName}`
                : `Adding to ${locationName}`}
            </p>
          </div>
          <button
            id="dialog-close"
            className="dialog-close"
            onClick={onClose}
            aria-label="Close dialog"
          >
            <X size={18} strokeWidth={2} />
          </button>
        </div>

        <div className="dialog-divider" />

        <div className="dialog-body">
          {/* Image upload zone */}
          <div className="upload-zone" role="button" tabIndex={0}>
            {isEdit && editItem?.imageUrl ? (
              <img
                src={editItem.imageUrl}
                alt="Current item"
                style={{ width: "100%", height: 120, objectFit: "cover", borderRadius: 8 }}
              />
            ) : (
              <>
                <Upload size={22} strokeWidth={1.5} className="upload-icon" />
                <span className="upload-label">Drop image or click to upload</span>
                <span className="upload-hint">PNG, JPG up to 4 MB</span>
              </>
            )}
          </div>

          <div className="dialog-fields">
            {/* Item name */}
            <div className="field-group">
              <label htmlFor="field-name" className="field-label">
                Item Name
              </label>
              <input
                id="field-name"
                type="text"
                placeholder="e.g. Dune by Frank Herbert"
                defaultValue={editItem?.name ?? ""}
                className="field-input"
              />
            </div>

            {/* Subtitle */}
            <div className="field-group">
              <label htmlFor="field-subtitle" className="field-label">
                Subtitle / Source
              </label>
              <input
                id="field-subtitle"
                type="text"
                placeholder="e.g. Frank Herbert · 1965"
                defaultValue={editItem?.subtitle ?? ""}
                className="field-input"
              />
            </div>

            {/* Item Type */}
            <div className="field-group">
              <label htmlFor="field-type" className="field-label">
                Item Type
              </label>
              <select
                id="field-type"
                className="field-input type-select"
                value={itemType}
                onChange={(e) => setItemType(e.target.value as ItemType)}
              >
                {ITEM_TYPES.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </select>
            </div>

            {/* Quantity */}
            <div className="field-group">
              <label className="field-label">Stock Quantity</label>
              <div className="qty-control">
                <button
                  id="qty-decrease"
                  className="qty-btn"
                  onClick={() => setQuantity((q) => Math.max(1, q - 1))}
                  aria-label="Decrease quantity"
                >
                  <Minus size={14} strokeWidth={2.5} />
                </button>
                <span className="qty-value" aria-live="polite">
                  {quantity}
                </span>
                <button
                  id="qty-increase"
                  className="qty-btn"
                  onClick={() => setQuantity((q) => q + 1)}
                  aria-label="Increase quantity"
                >
                  <Plus size={14} strokeWidth={2.5} />
                </button>
              </div>
            </div>

            {/* Tags */}
            <div className="field-group">
              <label htmlFor="field-tags" className="field-label">
                <Tag size={12} strokeWidth={2} />
                Tags
              </label>
              <input
                id="field-tags"
                type="text"
                placeholder="e.g. Novel, Sci-Fi, Favourite"
                defaultValue={editItem?.tags.join(", ") ?? ""}
                className="field-input"
              />
              <p className="field-hint">Separate tags with commas</p>
            </div>

            {/* Condition */}
            <div className="field-group">
              <label className="field-label">Condition</label>
              <div className="condition-selector">
                {CONDITIONS.map((c) => (
                  <button
                    key={c.value}
                    id={`cond-${c.value}`}
                    className={cn(
                      "cond-btn",
                      condition === c.value && "cond-btn--active"
                    )}
                    onClick={() => setCondition(c.value)}
                  >
                    {c.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Description */}
            <div className="field-group">
              <label htmlFor="field-desc" className="field-label">
                Description
              </label>
              <textarea
                id="field-desc"
                rows={3}
                placeholder="Short description or notes…"
                defaultValue={editItem?.description ?? ""}
                className="field-input field-textarea"
              />
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="dialog-footer">
          <button id="dialog-cancel" className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button id="dialog-save" className="btn-primary" onClick={handleSave}>
            <Plus size={15} strokeWidth={2.2} />
            {isEdit ? "Save Changes" : "Add Item"}
          </button>
        </div>
      </div>
    </div>
  );
}
