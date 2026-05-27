import type { Item } from "@/types/item";

export const mockItems: Item[] = [
  // ── Personal mode ──────────────────────────────────────────────
  {
    id: "p1",
    name: "Dune",
    subtitle: "Frank Herbert · 1965",
    description:
      "A sweeping science-fiction epic set on the desert planet Arrakis, exploring politics, religion, and ecology through the eyes of Paul Atreides.",
    stock: 2,
    tags: ["Novel", "Sci-Fi"],
    category: "Novel",
    condition: 4,
    imageUrl: "https://covers.openlibrary.org/b/id/8226151-L.jpg",
    mode: "personal",
  },
  {
    id: "p2",
    name: "The Design of Everyday Things",
    subtitle: "Don Norman · 1988",
    description:
      "A landmark book that explores the principles of good design and why some products satisfy customers while others only frustrate.",
    stock: 1,
    tags: ["Non-Fiction", "Design"],
    category: "Non-Fiction",
    condition: 5,
    mode: "personal",
  },
  {
    id: "p3",
    name: "Project Hail Mary",
    subtitle: "Andy Weir · 2021",
    description:
      "A lone astronaut must save Earth from disaster. An irresistibly entertaining read packed with clever science and heart.",
    stock: 1,
    tags: ["Novel", "Sci-Fi"],
    category: "Novel",
    condition: 5,
    mode: "personal",
  },
  {
    id: "p4",
    name: "Sapiens",
    subtitle: "Yuval Noah Harari · 2011",
    description:
      "A brief history of humankind from the Stone Age to the twenty-first century, examining how Homo sapiens came to rule the world.",
    stock: 3,
    tags: ["Non-Fiction", "History"],
    category: "Non-Fiction",
    condition: 3,
    mode: "personal",
  },
  {
    id: "p5",
    name: "The Name of the Wind",
    subtitle: "Patrick Rothfuss · 2007",
    description:
      "The tale of Kvothe, a legendary wizard and adventurer, told in his own words over the course of three days.",
    stock: 1,
    tags: ["Novel", "Fantasy"],
    category: "Novel",
    condition: 4,
    mode: "personal",
  },
  {
    id: "p6",
    name: "Atomic Habits",
    subtitle: "James Clear · 2018",
    description:
      "Tiny changes, remarkable results. An easy and proven way to build good habits and break bad ones.",
    stock: 2,
    tags: ["Non-Fiction", "Self-Help"],
    category: "Non-Fiction",
    condition: 5,
    mode: "personal",
  },

  // ── Business mode ───────────────────────────────────────────────
  {
    id: "b1",
    name: "Wireless Mechanical Keyboard",
    subtitle: "Keychron · K8 Pro",
    description:
      "Compact tenkeyless layout, hot-swappable switches, RGB backlight. Perfect for productivity setups and desk bundles.",
    stock: 14,
    tags: ["Electronics", "Peripherals"],
    category: "Electronics",
    condition: 5,
    mode: "business",
  },
  {
    id: "b2",
    name: "Standing Desk Mat",
    subtitle: "Topo · Anti-Fatigue",
    description:
      "Ergonomic anti-fatigue mat with raised nodules to encourage subtle movement throughout the workday.",
    stock: 7,
    tags: ["Furniture", "Ergonomics"],
    category: "Furniture",
    condition: 5,
    mode: "business",
  },
  {
    id: "b3",
    name: "USB-C Hub 7-in-1",
    subtitle: "Anker · PowerExpand",
    description:
      "HDMI 4K, 100W PD charging, SD/microSD reader, and three USB-A ports in a slim aluminium shell.",
    stock: 22,
    tags: ["Electronics", "Accessories"],
    category: "Electronics",
    condition: 4,
    mode: "business",
  },
  {
    id: "b4",
    name: "Monitor Arm Dual",
    subtitle: "Ergotron · LX Series",
    description:
      "Spring-balanced, fully adjustable dual monitor arm. Supports displays up to 32\" and 9 kg each.",
    stock: 5,
    tags: ["Furniture", "Peripherals"],
    category: "Furniture",
    condition: 3,
    mode: "business",
  },
  {
    id: "b5",
    name: "Noise-Cancelling Headphones",
    subtitle: "Sony · WH-1000XM5",
    description:
      "Industry-leading active noise cancellation with 30-hour battery life and multipoint Bluetooth.",
    stock: 9,
    tags: ["Electronics", "Audio"],
    category: "Electronics",
    condition: 5,
    mode: "business",
  },
];

export const personalCategories = [
  { name: "Novel", count: 3 },
  { name: "Non-Fiction", count: 3 },
  { name: "Sci-Fi", count: 2 },
  { name: "Fantasy", count: 1 },
  { name: "Design", count: 1 },
  { name: "Self-Help", count: 1 },
];

export const businessCategories = [
  { name: "Electronics", count: 3 },
  { name: "Furniture", count: 2 },
  { name: "Peripherals", count: 2 },
  { name: "Accessories", count: 1 },
  { name: "Audio", count: 1 },
  { name: "Ergonomics", count: 1 },
];
