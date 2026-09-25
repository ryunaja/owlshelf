import { useState, useEffect, useMemo, useRef } from "react";
import { Search, X, ArrowLeft, Diamond, MapPin } from "lucide-react";
import { itemsDB, locationsDB } from "@/lib/database";
import type { Profile, Item, Location } from "@/types/item";
import logoSrc from "@/assets/logo.png";

interface GlobalSearchPageProps {
  profile: Profile;
  onBack: () => void;
  onNavigateToLocation: (location: Location) => void;
}

interface EnrichedItem extends Item {
  locationName: string;
  locationIcon: string;
  location: Location;
}

export function GlobalSearchPage({
  profile,
  onBack,
  onNavigateToLocation,
}: GlobalSearchPageProps) {
  const [query, setQuery] = useState("");
  const [allItems, setAllItems] = useState<EnrichedItem[]>([]);
  const [loading, setLoading] = useState(true);
  const inputRef = useRef<HTMLInputElement>(null);

  // Load all items for this profile and enrich them with location data
  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const locations = await locationsDB.getByProfile(profile.id);
        const locationMap = new Map<string, Location>(
          locations.map((l) => [l.id, l])
        );

        const items = await itemsDB.getAll();
        const profileItems = items.filter((i) =>
          locationMap.has(i.locationId)
        );

        const enriched: EnrichedItem[] = profileItems.map((item) => {
          const loc = locationMap.get(item.locationId)!;
          return {
            ...item,
            locationName: loc.name,
            locationIcon: loc.icon,
            location: loc,
          };
        });

        if (!cancelled) setAllItems(enriched);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [profile.id]);

  // Auto-focus search input
  useEffect(() => {
    const t = setTimeout(() => inputRef.current?.focus(), 80);
    return () => clearTimeout(t);
  }, []);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return allItems.filter(
      (item) =>
        item.name.toLowerCase().includes(q) ||
        item.subtitle.toLowerCase().includes(q) ||
        item.description.toLowerCase().includes(q) ||
        item.tags.some((t) => t.toLowerCase().includes(q)) ||
        item.category.toLowerCase().includes(q) ||
        item.locationName.toLowerCase().includes(q)
    );
  }, [allItems, query]);

  const showEmpty = query.trim().length > 0 && results.length === 0 && !loading;
  const showIdle = query.trim().length === 0;

  return (
    <div className="gsearch-page">
      {/* ── Header ── */}
      <header className="gsearch-header">
        <button
          id="gsearch-back"
          className="gsearch-back-btn"
          onClick={onBack}
          aria-label="Go back"
        >
          <ArrowLeft size={18} strokeWidth={2} />
        </button>

        <img src={logoSrc} alt="Owlshelf" className="gsearch-logo" />

        <div className="gsearch-input-wrap">
          <Search size={16} strokeWidth={2} className="gsearch-input-icon" />
          <input
            ref={inputRef}
            id="gsearch-input"
            type="search"
            className="gsearch-input"
            placeholder={`Search across all of ${profile.name}…`}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoComplete="off"
          />
          {query && (
            <button
              className="gsearch-clear"
              onClick={() => {
                setQuery("");
                inputRef.current?.focus();
              }}
              aria-label="Clear search"
            >
              <X size={14} strokeWidth={2.5} />
            </button>
          )}
        </div>
      </header>

      {/* ── Body ── */}
      <div className="gsearch-body">
        {/* Loading */}
        {loading && (
          <div className="gsearch-state">
            <div className="gsearch-spinner" />
            <p className="gsearch-state-text">Loading your inventory…</p>
          </div>
        )}

        {/* Idle (no query yet) */}
        {!loading && showIdle && (
          <div className="gsearch-state">
            <div className="gsearch-state-icon">
              <Search size={36} strokeWidth={1} />
            </div>
            <p className="gsearch-state-title">Search everything</p>
            <p className="gsearch-state-text">
              Find items across all {allItems.length > 0 ? allItems.length + " items in all " : ""}your locations
            </p>
          </div>
        )}

        {/* Empty results */}
        {!loading && showEmpty && (
          <div className="gsearch-state">
            <div className="gsearch-state-icon">
              <Diamond size={36} strokeWidth={1} />
            </div>
            <p className="gsearch-state-title">No results for "{query}"</p>
            <p className="gsearch-state-text">
              Try a different name, tag, or category
            </p>
          </div>
        )}

        {/* Results */}
        {!loading && results.length > 0 && (
          <div className="gsearch-results-wrap">
            <p className="gsearch-results-count">
              {results.length} result{results.length !== 1 ? "s" : ""} for &ldquo;{query}&rdquo;
            </p>
            <ul className="gsearch-results" role="list">
              {results.map((item) => (
                <li key={item.id}>
                  <button
                    className="gsearch-result-row"
                    onClick={() => onNavigateToLocation(item.location)}
                    id={`gsearch-result-${item.id}`}
                  >
                    {/* Thumbnail */}
                    <div className="gsearch-thumb">
                      {item.imageUrl ? (
                        <img
                          src={item.imageUrl}
                          alt={item.name}
                          className="gsearch-thumb-img"
                          loading="lazy"
                        />
                      ) : (
                        <div className="gsearch-thumb-placeholder">
                          <Diamond size={18} strokeWidth={1} />
                        </div>
                      )}
                    </div>

                    {/* Info */}
                    <div className="gsearch-result-info">
                      <span className="gsearch-result-name">{item.name}</span>
                      {item.subtitle && (
                        <span className="gsearch-result-subtitle">
                          {item.subtitle}
                        </span>
                      )}
                      <span className="gsearch-result-loc">
                        <MapPin size={11} strokeWidth={2} />
                        {item.locationIcon} {item.locationName}
                      </span>
                    </div>

                    {/* Tags + stock */}
                    <div className="gsearch-result-meta">
                      {item.tags[0] && (
                        <span className="gsearch-tag-pill">{item.tags[0]}</span>
                      )}
                      <span className="gsearch-stock-badge">×{item.stock}</span>
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
