import type { Profile, Location, Item } from "@/types/item";

// ── Profiles ────────────────────────────────────────────────
export const mockProfiles: Profile[] = [
  {
    id: "profile-personal",
    name: "My Personal",
    type: "personal",
    avatarEmoji: "📚",
  },
  {
    id: "profile-business",
    name: "My Store",
    type: "business",
    avatarEmoji: "🏪",
  },
];

// ── Locations ───────────────────────────────────────────────
export const mockLocations: Location[] = [
  // Personal locations
  {
    id: "loc-home-shelf",
    profileId: "profile-personal",
    name: "Home Shelf",
    icon: "🏠",
    description: "Physical books and collectibles at home",
    itemCount: 4,
  },
  {
    id: "loc-ebook",
    profileId: "profile-personal",
    name: "E-Books",
    icon: "📱",
    description: "Digital reading library",
    itemCount: 2,
  },
  {
    id: "loc-storage",
    profileId: "profile-personal",
    name: "Storage Box",
    icon: "📦",
    description: "Archived items in storage",
    itemCount: 1,
  },

  // Business locations
  {
    id: "loc-warehouse",
    profileId: "profile-business",
    name: "Warehouse A",
    icon: "🏭",
    description: "Main product warehouse",
    itemCount: 3,
  },
  {
    id: "loc-storefront",
    profileId: "profile-business",
    name: "Store Front",
    icon: "🏬",
    description: "Display stock on the floor",
    itemCount: 2,
  },
  {
    id: "loc-office",
    profileId: "profile-business",
    name: "Office Supplies",
    icon: "🖥️",
    description: "Internal office equipment",
    itemCount: 1,
  },
];

// ── Items ────────────────────────────────────────────────────
export const mockItems: Item[] = [
  // Home Shelf — books
  {
    id: "p1",
    locationId: "loc-home-shelf",
    name: "Dune",
    subtitle: "Frank Herbert · 1965",
    description:
      "A sweeping science-fiction epic set on the desert planet Arrakis, exploring politics, religion, and ecology through the eyes of Paul Atreides.",
    stock: 2,
    tags: ["Sci-Fi", "Classic"],
    category: "Novel",
    itemType: "book",
    condition: 4,
    imageUrl: "https://covers.openlibrary.org/b/id/8226151-L.jpg",
  },
  {
    id: "p2",
    locationId: "loc-home-shelf",
    name: "The Design of Everyday Things",
    subtitle: "Don Norman · 1988",
    description:
      "A landmark book that explores the principles of good design and why some products satisfy customers while others only frustrate.",
    stock: 1,
    tags: ["Design", "Non-Fiction"],
    category: "Non-Fiction",
    itemType: "book",
    condition: 5,
  },
  {
    id: "p3",
    locationId: "loc-home-shelf",
    name: "Vintage World Map",
    subtitle: "Antique Print · c. 1890",
    description:
      "Hand-coloured lithograph depicting the world. Some foxing on edges, mounted on card backing.",
    stock: 1,
    tags: ["Antique", "Map"],
    category: "Collection",
    itemType: "collection",
    condition: 3,
  },
  {
    id: "p4",
    locationId: "loc-home-shelf",
    name: "Sapiens",
    subtitle: "Yuval Noah Harari · 2011",
    description:
      "A brief history of humankind from the Stone Age to the twenty-first century.",
    stock: 3,
    tags: ["History", "Non-Fiction"],
    category: "Non-Fiction",
    itemType: "book",
    condition: 3,
  },

  // E-Books
  {
    id: "p5",
    locationId: "loc-ebook",
    name: "Project Hail Mary",
    subtitle: "Andy Weir · 2021",
    description:
      "A lone astronaut must save Earth from disaster. Packed with clever science and heart.",
    stock: 1,
    tags: ["Sci-Fi", "Novel"],
    category: "Novel",
    itemType: "book",
    condition: 5,
  },
  {
    id: "p6",
    locationId: "loc-ebook",
    name: "Atomic Habits",
    subtitle: "James Clear · 2018",
    description:
      "Tiny changes, remarkable results. An easy and proven way to build good habits and break bad ones.",
    stock: 1,
    tags: ["Self-Help", "Non-Fiction"],
    category: "Non-Fiction",
    itemType: "book",
    condition: 5,
  },

  // Storage
  {
    id: "p7",
    locationId: "loc-storage",
    name: "The Name of the Wind",
    subtitle: "Patrick Rothfuss · 2007",
    description:
      "The tale of Kvothe, a legendary wizard and adventurer, told in his own words.",
    stock: 1,
    tags: ["Fantasy", "Novel"],
    category: "Novel",
    itemType: "book",
    condition: 2,
  },

  // Warehouse A
  {
    id: "b1",
    locationId: "loc-warehouse",
    name: "Wireless Mechanical Keyboard",
    subtitle: "Keychron · K8 Pro",
    description:
      "Compact tenkeyless layout, hot-swappable switches, RGB backlight. Perfect for productivity setups.",
    stock: 14,
    tags: ["Peripherals", "Keyboard"],
    category: "Electronics",
    itemType: "electronics",
    condition: 5,
  },
  {
    id: "b2",
    locationId: "loc-warehouse",
    name: "USB-C Hub 7-in-1",
    subtitle: "Anker · PowerExpand",
    description:
      "HDMI 4K, 100W PD charging, SD/microSD reader, and three USB-A ports in a slim aluminium shell.",
    stock: 22,
    tags: ["Accessories", "Hub"],
    category: "Electronics",
    itemType: "electronics",
    condition: 4,
  },
  {
    id: "b3",
    locationId: "loc-warehouse",
    name: "Standing Desk Mat",
    subtitle: "Topo · Anti-Fatigue",
    description:
      "Ergonomic anti-fatigue mat with raised nodules to encourage subtle movement throughout the workday.",
    stock: 7,
    tags: ["Ergonomics", "Desk"],
    category: "Office",
    itemType: "other",
    condition: 5,
  },

  // Store Front
  {
    id: "b4",
    locationId: "loc-storefront",
    name: "Monitor Arm Dual",
    subtitle: "Ergotron · LX Series",
    description:
      "Spring-balanced, fully adjustable dual monitor arm. Supports displays up to 32\" and 9 kg each.",
    stock: 5,
    tags: ["Peripherals", "Monitor"],
    category: "Electronics",
    itemType: "electronics",
    condition: 3,
  },
  {
    id: "b5",
    locationId: "loc-storefront",
    name: "Noise-Cancelling Headphones",
    subtitle: "Sony · WH-1000XM5",
    description:
      "Industry-leading active noise cancellation with 30-hour battery life and multipoint Bluetooth.",
    stock: 9,
    tags: ["Audio", "Wireless"],
    category: "Electronics",
    itemType: "electronics",
    condition: 5,
  },

  // Office
  {
    id: "b6",
    locationId: "loc-office",
    name: "Ergonomic Office Chair",
    subtitle: "Herman Miller · Aeron",
    description:
      "Fully adjustable mesh chair with PostureFit SL back support. Size B, graphite frame.",
    stock: 2,
    tags: ["Furniture", "Ergonomics"],
    category: "Furniture",
    itemType: "other",
    condition: 4,
  },
];
