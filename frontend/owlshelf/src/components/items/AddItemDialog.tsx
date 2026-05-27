import { useState } from "react";
import { X, Plus, Minus, Tag, Upload } from "lucide-react";
import { cn } from "@/lib/utils";
import type { AppMode } from "@/types/item";

interface AddItemDialogProps {
  open: boolean;
  mode: AppMode;
  onClose: () => void;
}

const CONDITIONS = [
  { value: 1, label: "Poor" },
  { value: 2, label: "Fair" },
  { value: 3, label: "Good" },
  { value: 4, label: "Very Good" },
  { value: 5, label: "Pristine" },
];

export function AddItemDialog({ open, mode, onClose }: AddItemDialogProps) {
  const [quantity, setQuantity] = useState(1);
  const [condition, setCondition] = useState(3);

  if (!open) return null;

  return (
    /* Backdrop */
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
              {mode === "personal" ? "Log New Book" : "Add Inventory Item"}
            </h2>
            <p className="dialog-subtitle">
              {mode === "personal"
                ? "Add a book or item to your personal collection"
                : "Register a new product to your business stock"}
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

        {/* Divider */}
        <div className="dialog-divider" />

        {/* Body */}
        <div className="dialog-body">
          {/* Image upload zone */}
          <div className="upload-zone" role="button" tabIndex={0}>
            <Upload size={22} strokeWidth={1.5} className="upload-icon" />
            <span className="upload-label">Drop image or click to upload</span>
            <span className="upload-hint">PNG, JPG up to 4 MB</span>
          </div>

          {/* Fields */}
          <div className="dialog-fields">
            {/* Item name */}
            <div className="field-group">
              <label htmlFor="field-name" className="field-label">
                {mode === "personal" ? "Book / Item Title" : "Product Name"}
              </label>
              <input
                id="field-name"
                type="text"
                placeholder={
                  mode === "personal"
                    ? "e.g. Dune by Frank Herbert"
                    : "e.g. Wireless Keyboard Pro"
                }
                className="field-input"
              />
            </div>

            {/* Subtitle / source */}
            <div className="field-group">
              <label htmlFor="field-subtitle" className="field-label">
                {mode === "personal" ? "Author · Year" : "Brand · Model"}
              </label>
              <input
                id="field-subtitle"
                type="text"
                placeholder={
                  mode === "personal"
                    ? "e.g. Frank Herbert · 1965"
                    : "e.g. Keychron · K8 Pro"
                }
                className="field-input"
              />
            </div>

            {/* Quantity */}
            <div className="field-group">
              <label className="field-label">
                {mode === "personal" ? "Copies" : "Stock Quantity"}
              </label>
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
          <button id="dialog-save" className="btn-primary">
            <Plus size={15} strokeWidth={2.2} />
            {mode === "personal" ? "Log Item" : "Add to Stock"}
          </button>
        </div>
      </div>
    </div>
  );
}
