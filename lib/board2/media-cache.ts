// Uploaded media bytes for the board autosave. localStorage can only hold the board JSON, and the
// blob: URLs clips play from die with the page, so the bytes live here keyed by the
// `mediaCacheKey` the autosave writes in place of the dead URL.

const DB_NAME = "nb_media_cache";
const STORE_NAME = "files";

let dbPromise: Promise<IDBDatabase> | null = null;

function openMediaDb(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") return Promise.reject(new Error("IndexedDB is unavailable"));
  dbPromise ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  }).catch((error) => {
    dbPromise = null;
    throw error;
  });
  return dbPromise;
}

// Writes resolve on transaction completion: quota errors surface as an abort, not a request error.
async function write(action: (store: IDBObjectStore) => void): Promise<void> {
  const db = await openMediaDb();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readwrite");
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error ?? new Error("Media cache write aborted"));
    action(transaction.objectStore(STORE_NAME));
  });
}

export function mediaCacheKeyForFile(file: File): string {
  return `${file.name}-${file.size}-${file.lastModified}`;
}

export function saveFile(id: string, blob: Blob): Promise<void> {
  return write((store) => store.put(blob, id));
}

export async function getFile(id: string): Promise<Blob | null> {
  const db = await openMediaDb();
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE_NAME).objectStore(STORE_NAME).get(id);
    request.onsuccess = () => resolve(request.result instanceof Blob ? request.result : null);
    request.onerror = () => reject(request.error);
  });
}

export function deleteFile(id: string): Promise<void> {
  return write((store) => store.delete(id));
}

export function clearAll(): Promise<void> {
  return write((store) => store.clear());
}
