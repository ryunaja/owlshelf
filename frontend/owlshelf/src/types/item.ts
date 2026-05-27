export type AppMode = "personal" | "business";

export type Condition = 1 | 2 | 3 | 4 | 5;

export interface Item {
  id: string;
  name: string;
  subtitle: string; // e.g. author, origin, supplier
  description: string;
  stock: number;
  tags: string[];
  category: string;
  condition: Condition;
  imageUrl?: string;
  mode: AppMode;
}

export interface CategoryFilter {
  name: string;
  count: number;
}
