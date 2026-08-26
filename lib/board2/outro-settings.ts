export const DEFAULT_OUTRO_TEXT = "FULL EPISODE IN BIO";
export const AUTO_BUILD_OUTRO_DURATION_SECONDS = 2.5;

export const OUTRO_SETTINGS_DB_NAME = "neuralboard-settings";
export const OUTRO_SETTINGS_STORE_NAME = "settings";
export const OUTRO_SETTINGS_KEY = "board2:auto-build-outro:v1";

export type PersistedOutroImage = {
  blob: Blob;
  name: string;
  width: number;
  height: number;
};

export type PersistedOutroSettings = {
  text: string;
  image: PersistedOutroImage | null;
};

type OutroSettingsRecord = PersistedOutroSettings & { id: typeof OUTRO_SETTINGS_KEY };

function openOutroSettingsDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(OUTRO_SETTINGS_DB_NAME, 1);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(OUTRO_SETTINGS_STORE_NAME)) {
        database.createObjectStore(OUTRO_SETTINGS_STORE_NAME, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Could not open outro settings storage"));
  });
}

export async function loadOutroSettings(): Promise<PersistedOutroSettings> {
  if (typeof indexedDB === "undefined") return { text: DEFAULT_OUTRO_TEXT, image: null };
  const database = await openOutroSettingsDatabase();
  try {
    const record = await new Promise<OutroSettingsRecord | undefined>((resolve, reject) => {
      const request = database
        .transaction(OUTRO_SETTINGS_STORE_NAME, "readonly")
        .objectStore(OUTRO_SETTINGS_STORE_NAME)
        .get(OUTRO_SETTINGS_KEY);
      request.onsuccess = () => resolve(request.result as OutroSettingsRecord | undefined);
      request.onerror = () => reject(request.error ?? new Error("Could not read outro settings"));
    });
    return {
      text: typeof record?.text === "string" ? record.text : DEFAULT_OUTRO_TEXT,
      image: record?.image?.blob instanceof Blob ? record.image : null,
    };
  } finally {
    database.close();
  }
}

export async function saveOutroSettings(settings: PersistedOutroSettings): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  const database = await openOutroSettingsDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(OUTRO_SETTINGS_STORE_NAME, "readwrite");
      transaction.objectStore(OUTRO_SETTINGS_STORE_NAME).put({
        id: OUTRO_SETTINGS_KEY,
        text: settings.text,
        image: settings.image,
      } satisfies OutroSettingsRecord);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("Could not save outro settings"));
      transaction.onabort = () => reject(transaction.error ?? new Error("Outro settings save was aborted"));
    });
  } finally {
    database.close();
  }
}

export type OutroPlacement = {
  x: number;
  y: number;
  width: number;
  height: number;
  boardWidth: number;
  boardHeight: number;
};

/** Places the outro in a deliberately separated area to the right of all authored content. */
export function placeOutroCard(
  existingRects: ReadonlyArray<{ x: number; y: number; width: number; height: number }>,
  imageSize: { width: number; height: number },
  boardSize: { width: number; height: number },
): OutroPlacement {
  const maxWidth = 900;
  const maxHeight = 675;
  const sourceWidth = Math.max(1, imageSize.width);
  const sourceHeight = Math.max(1, imageSize.height);
  const maximumScale = Math.min(maxWidth / sourceWidth, maxHeight / sourceHeight);
  const minimumReadableScale = 640 / Math.max(sourceWidth, sourceHeight);
  const scale = Math.min(maximumScale, Math.max(1, minimumReadableScale));
  const width = Math.max(1, Math.round(sourceWidth * scale));
  const height = Math.max(1, Math.round(sourceHeight * scale));
  const furthestContentEdge = existingRects.length
    ? Math.max(...existingRects.map((rect) => rect.x + rect.width))
    : 0;
  const x = Math.round(Math.max(boardSize.width + 300, furthestContentEdge + 700));
  const y = Math.round(Math.max(300, (boardSize.height - height) / 2));
  return {
    x,
    y,
    width,
    height,
    boardWidth: Math.max(boardSize.width, x + width + 400),
    boardHeight: Math.max(boardSize.height, y + height + 300),
  };
}
