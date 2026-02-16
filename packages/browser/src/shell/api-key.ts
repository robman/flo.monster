import { openDB as idbOpenDB, idbGet, idbPut, idbDelete } from '../utils/idb-helpers.js';
import { deriveKey as sharedDeriveKey, encrypt, decrypt } from '../utils/encryption.js';

const DB_NAME = 'awe';
const STORE_NAME = 'config';
const KEY_RECORD = 'api-key';
const SALT = new Uint8Array([119, 101, 98, 104, 97, 114, 110, 101, 115, 115, 45, 115, 97, 108, 116, 49]);
const PASSPHRASE = 'awe-local-encryption-key';

function openDB(): Promise<IDBDatabase> {
  return idbOpenDB(DB_NAME, STORE_NAME);
}

function deriveCryptoKey(): Promise<CryptoKey> {
  return sharedDeriveKey(PASSPHRASE, SALT);
}

export async function storeApiKey(key: string): Promise<void> {
  const cryptoKey = await deriveCryptoKey();
  const { iv, ciphertext } = await encrypt(key, cryptoKey);
  const db = await openDB();
  await idbPut(db, STORE_NAME, KEY_RECORD, {
    iv: Array.from(iv),
    data: Array.from(new Uint8Array(ciphertext)),
  });
  db.close();
}

export async function retrieveApiKey(): Promise<string | null> {
  const db = await openDB();
  const record = await idbGet(db, STORE_NAME, KEY_RECORD) as { iv: number[]; data: number[] } | null;
  db.close();
  if (!record) return null;
  const cryptoKey = await deriveCryptoKey();
  return decrypt(new Uint8Array(record.iv), new Uint8Array(record.data).buffer, cryptoKey);
}

export async function deleteApiKey(): Promise<void> {
  const db = await openDB();
  await idbDelete(db, STORE_NAME, KEY_RECORD);
  db.close();
}

export async function hasStoredKey(): Promise<boolean> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const req = store.count(KEY_RECORD);
    req.onsuccess = () => { db.close(); resolve(req.result > 0); };
    req.onerror = () => { db.close(); reject(req.error); };
  });
}
