// Recovery records contain only an opaque fingerprint and upload UUID. IndexedDB
// avoids sessionStorage's small quota when importing tens of thousands of files.
export async function recoveryUploadId(key: string, proposed: string): Promise<string> {
  if (typeof indexedDB !== "undefined") {
    try {
      return await new Promise<string>((resolve, reject) => {
        let database: IDBDatabase | undefined;
        let expired = false;
        let transaction: IDBTransaction | undefined;
        const timer = setTimeout(() => { expired = true; transaction?.abort(); database?.close(); reject(new Error("Recovery storage timed out")); }, 5000);
        const opened = indexedDB.open("document-upload-recovery", 1);
        opened.onupgradeneeded = () => opened.result.createObjectStore("uploads");
        opened.onerror = () => { clearTimeout(timer); reject(opened.error); };
        opened.onsuccess = () => {
          database = opened.result;
          if (expired) { database.close(); return; }
          const tx = database.transaction("uploads", "readwrite");
          transaction = tx;
          const store = tx.objectStore("uploads");
          const read = store.get(key);
          let id = proposed;
          read.onsuccess = () => {
            if (typeof read.result === "string") id = read.result;
            else store.put(id, key);
          };
          tx.oncomplete = () => { clearTimeout(timer); database?.close(); resolve(id); };
          tx.onabort = tx.onerror = () => { clearTimeout(timer); database?.close(); reject(tx.error); };
        };
      });
    } catch { /* Private browsing or disabled storage: try tab storage. */ }
  }
  const id = sessionStorage.getItem(key) ?? proposed;
  sessionStorage.setItem(key, id);
  return id;
}
