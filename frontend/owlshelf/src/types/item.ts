export type AccountType = "personal" | "business";

// ItemType is a free-form string; the presets below are the built-in suggestions.
export type ItemType = string;

export type Condition = 1 | 2 | 3 | 4 | 5;

export interface Profile {
  id: string;
  name: string;
  type: AccountType;
  avatarEmoji: string;
}

export interface Location {
  id: string;
  profileId: string;
  name: string;
  icon: string; // emoji
  description: string;
}

/** A location plus its count, DERIVED from live visible items (audit 4.2.6).
 *  Never stored: a denormalized counter is a lost-update window and a remote
 *  recount drift for nothing. `useLocations` attaches it. */
export interface LocationWithCount extends Location {
  itemCount: number;
}

export interface Item {
  id: string;
  /** The owning room. Required: a row minted without it broke the
   *  room-scoped identity check on the second op (audit-2 N13). */
  profileId: string;
  locationId: string;
  name: string;
  subtitle: string;
  description: string;
  stock: number;
  tags: string[];
  category: string;
  itemType: ItemType;
  condition: Condition;
  imageUrl?: string;
}

export interface CategoryFilter {
  name: string;
  count: number;
}

export const ITEM_TYPE_PRESETS: string[] = [
  "book",
  "collection",
  "electronics",
  "clothing",
  "food",
  "other",
];

export const ITEM_TYPE_LABELS: Record<string, string> = {
  book: "Book",
  collection: "Collection",
  electronics: "Electronics",
  clothing: "Clothing",
  food: "Food",
  other: "Other",
};

/** Returns a human-readable label for any item type (preset or custom). */
export function getItemTypeLabel(type: string): string {
  return ITEM_TYPE_LABELS[type] ?? (type ? type.charAt(0).toUpperCase() + type.slice(1) : "Other");
}
