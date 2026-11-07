export type PageImage = { blob: Blob; dpi: number };
export type ImageBatchStore = {
  put: (number: number, image: PageImage) => Promise<void>;
  get: (number: number) => Promise<PageImage>;
  remove: (number: number) => Promise<void>;
  dispose: () => Promise<void>;
};

// The two phases are deliberately separate: every PDF page must be a stored
// image before the first one reaches Tesseract. Only one decoded page is live.
export async function processImageBatch({ count, store, render, recognize, signal }: {
  count: number;
  store: ImageBatchStore;
  render: (number: number) => Promise<PageImage>;
  recognize: (image: PageImage, number: number) => Promise<void>;
  signal: AbortSignal;
}) {
  function checkAbort() { signal.throwIfAborted(); }
  try {
    for (let number = 1; number <= count; number++) {
      checkAbort();
      const image = await render(number);
      checkAbort();
      await store.put(number, image);
    }
    for (let number = 1; number <= count; number++) {
      checkAbort();
      const image = await store.get(number);
      checkAbort();
      await recognize(image, number);
      await store.remove(number);
    }
  } finally {
    await store.dispose();
  }
}

export async function createImageBatchStore(): Promise<ImageBatchStore> {
  const name = `khmer-ocr-page-batch-${crypto.randomUUID()}`;
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('pages');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error('Could not prepare page images. Allow browser storage and try again.'));
  });
  async function transaction<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>) {
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction('pages', mode);
      const request = action(tx.objectStore('pages'));
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = tx.onabort = () => reject(new Error(tx.error?.name === 'QuotaExceededError'
        ? 'Not enough browser storage for the page images. Split this PDF into smaller files.'
        : 'Could not store the page images. Allow browser storage and try again.'));
    });
  }
  return {
    async put(number, image) { await transaction('readwrite', (store) => store.put(image, number)); },
    async get(number) {
      const image = await transaction<PageImage | undefined>('readonly', (store) => store.get(number));
      if (!image) throw new Error(`Page image ${number} is unavailable. Try the document again.`);
      return image;
    },
    async remove(number) { await transaction('readwrite', (store) => store.delete(number)); },
    async dispose() {
      db.close();
      await new Promise<void>((resolve) => {
        const request = indexedDB.deleteDatabase(name);
        request.onsuccess = request.onerror = request.onblocked = () => resolve();
      });
    },
  };
}
