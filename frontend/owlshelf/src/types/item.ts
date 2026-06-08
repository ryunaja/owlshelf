export type AccountType = "personal" | "business";

export type ItemType =
  | "book"
  | "collection"
  | "electronics"
  | "clothing"
  | "food"
  | "other";

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
  itemCount: number;
}

export interface Item {
  id: string;
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

export const ITEM_TYPE_LABELS: Record<ItemType, string> = {
  book: "Book",
  collection: "Collection",
  electronics: "Electronics",
  clothing: "Clothing",
  food: "Food",
  other: "Other",
};
