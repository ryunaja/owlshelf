export class Database {
  public db: IDBDatabase | null;
  private blob: IDBDatabase | null = null;

  constructor(name: string) {
    this.db = null;
    const request = window.indexedDB.open(name);
    request.onsuccess = (event) => {
      if (event.target === null) {
        return;
      }
      this.db = request.result;
    };

    request.onerror = () => {
      console.log("database named " + name + " cannot be initialized!");
    };
  }
}
