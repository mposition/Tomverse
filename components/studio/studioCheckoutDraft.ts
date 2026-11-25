"use client";

import { useEffect, useRef } from "react";
import { useSession } from "next-auth/react";
import { readStudioBlob } from "./studioCanvas";

const databaseName = "tomverse-studio-checkout";
const storeName = "drafts";
const tabKey = "tomverse-studio-checkout-tab";
const draftLifetimeMs = 24 * 60 * 60 * 1000;

type DraftRecord<T> = { key: string; expiresAt: number; value: T };

function draftKey(userId: string, tool: string, create: boolean) {
  let tab = sessionStorage.getItem(tabKey);
  if (!tab && create) {
    tab = crypto.randomUUID();
    sessionStorage.setItem(tabKey, tab);
  }
  return tab ? JSON.stringify([userId, tab, tool]) : null;
}

function openDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore(storeName, { keyPath: "key" });
      store.createIndex("expiresAt", "expiresAt");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("Studio draft storage is unavailable"));
  });
}

async function draftTransaction<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>) {
  const database = await openDatabase();
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = database.transaction(storeName, mode);
      const request = run(transaction.objectStore(storeName));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally {
    database.close();
  }
}

export function useStudioCheckoutDraft<T>(tool: string, restore: (draft: T) => void) {
  const { data: session } = useSession();
  const userId = session?.user?.id;
  const restoreRef = useRef(restore);
  useEffect(() => { restoreRef.current = restore; }, [restore]);

  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    try {
      const key = draftKey(userId, tool, false);
      if (key) void draftTransaction<DraftRecord<T> | undefined>("readonly", store => store.get(key))
        .then(record => {
          if (!cancelled && record && record.expiresAt > Date.now()) restoreRef.current(record.value);
        })
        .catch(() => undefined);
    } catch { /* Browsers may block storage until sign-in or consent. */ }
    return () => { cancelled = true; };
  }, [tool, userId]);

  return {
    async save(value: T) {
      const key = userId && draftKey(userId, tool, true);
      if (!key) throw new Error("Studio checkout needs a signed-in draft owner");
      await draftTransaction("readwrite", store => {
        const now = Date.now();
        const expired = store.index("expiresAt").openCursor(IDBKeyRange.upperBound(now));
        expired.onsuccess = () => {
          const cursor = expired.result;
          if (cursor) { cursor.delete(); cursor.continue(); }
        };
        return store.put({ key, value, expiresAt: now + draftLifetimeMs } satisfies DraftRecord<T>);
      });
    },
    async clear() {
      try {
        const key = userId && draftKey(userId, tool, false);
        if (key) await draftTransaction("readwrite", store => store.delete(key));
      } catch { /* Generation has already finished. The snapshot still expires. */ }
    },
  };
}

export type StudioDraftImage = string | Blob;

export async function captureStudioDraftImage(source: string): Promise<StudioDraftImage> {
  return source.startsWith("blob:") ? readStudioBlob(source) : source;
}
