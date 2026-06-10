export interface UpdateLog {
  uuid: string;
  next: string;
  dataLocation: string;
  status: Status;
  lastUpdate: Date;
}

export type Status = "CREATE" | "UPDATE" | "DELETE";

export class Database {
  public db: IDBDatabase | null;

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
