import type { TranscriptSegment } from "@/lib/audio/transcription";

export type ClipBoardHandoff = {
  id: string;
  name: string;
  audio: Blob;
  durationSec: number;
  transcript: string;
  segments: TranscriptSegment[];
  createdAt: number;
};

const DB_NAME = "neuralboard-clip-finder";
const STORE = "board-handoffs";

function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: "id" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function saveClipBoardHandoff(value: ClipBoardHandoff): Promise<void> {
  const db = await database();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(value);
    tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error);
  });
  db.close();
}

export async function takeClipBoardHandoff(id: string): Promise<ClipBoardHandoff | null> {
  const db = await database();
  const value = await new Promise<ClipBoardHandoff | undefined>((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const request = tx.objectStore(STORE).get(id);
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
  if (value) {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(id);
  }
  db.close();
  return value ?? null;
}
