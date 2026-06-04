import { storage } from '../mmkv';

export const readJson = (key, fallback = []) => {
  try {
    const raw = storage.getString(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (error) {
    console.warn(`[SyncStore] Failed to parse ${key}:`, error?.message);
    return fallback;
  }
};

export const writeJson = (key, value) => {
  storage.set(key, JSON.stringify(value));
};
