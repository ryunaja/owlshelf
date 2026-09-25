import { Search, X } from "lucide-react";

interface SearchBarProps {
  value: string;
  onChange: (value: string) => void;
}

export function SearchBar({ value, onChange }: SearchBarProps) {
  return (
    <div className="search-bar-wrap">
      <Search size={15} strokeWidth={2} className="search-icon" />
      <input
        id="search-input"
        type="search"
        className="search-input"
        placeholder="Search by name, tag…"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      {value && (
        <button
          id="search-clear"
          className="search-clear"
          onClick={() => onChange("")}
          aria-label="Clear search"
        >
          <X size={14} strokeWidth={2.5} />
        </button>
      )}
    </div>
  );
}
