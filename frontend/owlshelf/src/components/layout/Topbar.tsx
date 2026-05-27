import { BookOpen, Briefcase, Plus } from "lucide-react";
import { cn } from "@/lib/utils";
import type { AppMode } from "@/types/item";

interface TopbarProps {
  mode: AppMode;
  onModeChange: (mode: AppMode) => void;
  onAddItem: () => void;
}

export function Topbar({ mode, onModeChange, onAddItem }: TopbarProps) {
  return (
    <header className="topbar">
      {/* Brand */}
      <div className="topbar-brand">
        <div className="brand-icon">🦉</div>
        <div>
          <h1 className="brand-name">Owlshelf</h1>
          <p className="brand-sub">
            {mode === "personal"
              ? "Manage your personal collection"
              : "Manage your business inventory"}
          </p>
        </div>
      </div>

      {/* Mode tabs */}
      <nav className="mode-tabs" aria-label="App mode">
        <button
          id="tab-personal"
          role="tab"
          aria-selected={mode === "personal"}
          className={cn("mode-tab", mode === "personal" && "mode-tab--active")}
          onClick={() => onModeChange("personal")}
        >
          <BookOpen size={15} strokeWidth={1.8} />
          Personal
        </button>
        <button
          id="tab-business"
          role="tab"
          aria-selected={mode === "business"}
          className={cn("mode-tab", mode === "business" && "mode-tab--active")}
          onClick={() => onModeChange("business")}
        >
          <Briefcase size={15} strokeWidth={1.8} />
          Business
        </button>
      </nav>

      {/* Add button */}
      <button id="btn-add-item" className="btn-add" onClick={onAddItem}>
        <Plus size={16} strokeWidth={2.2} />
        Add Item
      </button>
    </header>
  );
}
