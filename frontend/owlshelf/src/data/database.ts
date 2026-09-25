/**
 * @typedef {object} Item
 * Interface for inventory items, derived from InventoryPage.tsx context.
 */
export interface Item {
  id: string;
  locationId: string;
  category: string;
  imageUrl: string;
  name: string;
  subtitle: string;
  itemType: "book" | "electronics" | "etc"; // Assuming defined types for itemType
  stock: number;
  tags: string[];
  condition: number;
  description: string;
}

let dbPromise: Promise<IDBDatabase> | null = null;
const DB_NAME = "inventoryDB";
const STORE_NAME = "items";

/**
 * Initializes the IndexedDB database.
 * @returns {Promise<IDBDatabase>} A promise that resolves to the IDBDatabase instance.
 */
export const initDatabase = (): Promise<IDBDatabase> => {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);

    request.onerror = (event) => {
      console.error("IndexedDB error during open:", event);
      reject("Failed to open IndexedDB.");
    };

    request.onsuccess = (event) => {
      const db = (event.target as IDBOpenDBRequest).result as IDBDatabase;
      resolve(db);
    };

    // Create the object store if it doesn't exist
    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result as IDBDatabase;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "id" });
        console.log("IndexedDB object store created.");
      }
    };
  });
  return dbPromise;
};

/**
 * Retrieves a single item by its ID.
 * @param itemId The ID of the item to retrieve.
 * @returns A promise that resolves to the Item or null if not found.
 */
export const getItemById = async (
  itemId: string,
): Promise<Item | undefined> => {
  const db = await initDatabase();

  return new Promise((resolve) => {
    const transaction = db.transaction([STORE_NAME], "readonly");
    const store = transaction.objectStore(STORE_NAME);
    const request = store.get(itemId);

    request.onsuccess = () => {
      resolve((request.result as Item) ? (request.result as Item) : undefined);
    };
  });
};

/**
 * Retrieves all items from the database.
 * @returns A promise that resolves to an array of Items.
 */
export const getAllItems = async (): Promise<Item[]> => {
  const db = await initDatabase();

  return new Promise((resolve) => {
    const transaction = db.transaction([STORE_NAME], "readonly");
    const store = transaction.objectStore(STORE_NAME);
    const request = store.getAll();

    request.onsuccess = () => {
      // IndexedDB returns an array of values; we cast them to Item[]
      resolve((request.result as Item[]) || []);
    };
  });
};

/**
 * Saves or updates an item in the database.
 * @param item The item object (must have a unique 'id').
 * @returns A promise that resolves when the operation is complete.
 */
export const saveItem = async (item: Item): Promise<void> => {
  const db = await initDatabase();

  return new Promise((resolve, reject) => {
    try {
      // Use put() to either add a new record or update an existing one based on the keyPath ('id')
      const transaction = db.transaction([STORE_NAME], "readwrite");
      const store = transaction.objectStore(STORE_NAME);
      const request = store.put(item);

      request.onsuccess = () => {
        resolve();
      };
      request.onerror = (event) => {
        const target = event.target as IDBRequest;
        reject("Database save error: " + target?.error);
      };
    } catch (error) {
      reject(
        `Error while saving item to IndexedDB: ${(error as Error).message}`,
      );
    }
  });
};

/**
 * Deletes an item from the database by its ID.
 * @param itemId The ID of the item to delete.
 * @returns A promise that resolves when the operation is complete.
 */
export const deleteItem = async (itemId: string): Promise<void> => {
  const db = await initDatabase();

  return new Promise((resolve) => {
    const transaction = db.transaction([STORE_NAME], "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    const request = store.delete(itemId);

    request.onsuccess = () => resolve();
  });
};
