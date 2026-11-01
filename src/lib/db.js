const DB_NAME = 'GetFullPageDB';
const DB_VERSION = 1;
const STORE_CAPTURES = 'captures';

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(STORE_CAPTURES)) {
        const store = db.createObjectStore(STORE_CAPTURES, { keyPath: 'id' });
        store.createIndex('createdAt', 'createdAt', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveCaptureRecord(record) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_CAPTURES, 'readwrite');
    const store = tx.objectStore(STORE_CAPTURES);
    const item = {
      ...record,
      id: record.id || `cap_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      createdAt: record.createdAt || Date.now(),
      updatedAt: Date.now()
    };
    store.put(item);
    tx.oncomplete = () => {
      db.close();
      resolve(item);
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}

export async function getCaptureRecord(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_CAPTURES, 'readonly');
    const store = tx.objectStore(STORE_CAPTURES);
    const req = store.get(id);
    req.onsuccess = () => {
      db.close();
      resolve(req.result || null);
    };
    req.onerror = () => {
      db.close();
      reject(req.error);
    };
  });
}

export async function updateCaptureRecord(id, patch) {
  const existing = await getCaptureRecord(id);
  if (!existing) throw new Error(`Captura ${id} não encontrada no banco local.`);
  const merged = {
    ...existing,
    ...patch,
    id: existing.id,
    updatedAt: Date.now()
  };
  return saveCaptureRecord(merged);
}

export async function listCaptureRecords() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_CAPTURES, 'readonly');
    const store = tx.objectStore(STORE_CAPTURES);
    const req = store.getAll();
    req.onsuccess = () => {
      db.close();
      const items = (req.result || []).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      resolve(items);
    };
    req.onerror = () => {
      db.close();
      reject(req.error);
    };
  });
}

export async function deleteCaptureRecords(ids) {
  const idList = Array.isArray(ids) ? ids : [ids];
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_CAPTURES, 'readwrite');
    const store = tx.objectStore(STORE_CAPTURES);
    for (const id of idList) {
      store.delete(id);
    }
    tx.oncomplete = () => {
      db.close();
      resolve(idList.length);
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}
