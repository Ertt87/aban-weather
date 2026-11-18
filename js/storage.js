import { ABAN_COORDS, STORAGE_KEYS } from './config.js';

const LEGACY_SOURCE_KEY = 'aban_preferred_source_mode';
const LEGACY_OM_MODEL_KEY = 'aban_open_meteo_model';
const LEGACY_CACHE_KEY = 'aban_weather_cache_v3';
const MAX_ARCHIVE_SLICES = 5;

const memoryStorage = new Map();

export const DEFAULT_PREFS = Object.freeze({
  unit: 'metric',
  pressureMode: 'station',
  sourceMode: 'hybrid',
  preferredOmModel: 'multi',
  activePreset: '10d',
  timeWindow: 'full',
  showClimatology: true,
  showModelLines: false,
  groupByPentad: false,
});

function getStore() {
  try {
    if (typeof globalThis !== 'undefined' && globalThis.localStorage) {
      return globalThis.localStorage;
    }
  } catch (_) {
    // Restricted browser contexts may block localStorage access
  }
  return {
    getItem(key) {
      return memoryStorage.has(key) ? memoryStorage.get(key) : null;
    },
    setItem(key, val) {
      memoryStorage.set(key, String(val));
    },
    removeItem(key) {
      memoryStorage.delete(key);
    },
  };
}

function byteLength(str) {
  if (!str) return 0;
  try {
    return new TextEncoder().encode(str).length;
  } catch (_) {
    return str.length * 2;
  }
}

function formatRuTimestamp(isoStr) {
  try {
    return new Date(isoStr).toLocaleString('ru-RU', {
      timeZone: ABAN_COORDS.tz || 'Asia/Krasnoyarsk',
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch (_) {
    return isoStr;
  }
}

function sanitizePrefs(raw) {
  const merged = { ...DEFAULT_PREFS, ...(raw && typeof raw === 'object' ? raw : {}) };
  if (!['metric', 'imperial', 'dual'].includes(merged.unit)) merged.unit = DEFAULT_PREFS.unit;
  if (!['station', 'msl'].includes(merged.pressureMode)) merged.pressureMode = DEFAULT_PREFS.pressureMode;
  if (!['hybrid', 'google_wn3', 'open_meteo', 'offline_cache'].includes(merged.sourceMode)) {
    merged.sourceMode = DEFAULT_PREFS.sourceMode;
  }
  if (!['full', 'day_shift', 'daylight', 'night'].includes(merged.timeWindow)) {
    merged.timeWindow = DEFAULT_PREFS.timeWindow;
  }
  merged.showClimatology = Boolean(merged.showClimatology);
  merged.showModelLines = Boolean(merged.showModelLines);
  merged.groupByPentad = Boolean(merged.groupByPentad);
  return merged;
}

export function loadPrefs() {
  const store = getStore();
  try {
    const raw = store.getItem(STORAGE_KEYS.PREFS);
    if (raw) {
      return sanitizePrefs(JSON.parse(raw));
    }
    const legacyPatch = {};
    const legacySource = store.getItem(LEGACY_SOURCE_KEY);
    const legacyModel = store.getItem(LEGACY_OM_MODEL_KEY);
    if (legacySource) legacyPatch.sourceMode = legacySource;
    if (legacyModel) legacyPatch.preferredOmModel = legacyModel;
    return sanitizePrefs(legacyPatch);
  } catch (_) {
    return { ...DEFAULT_PREFS };
  }
}

export function savePrefs(patch = {}) {
  const store = getStore();
  const next = sanitizePrefs({ ...loadPrefs(), ...(patch || {}) });
  try {
    store.setItem(STORAGE_KEYS.PREFS, JSON.stringify(next));
  } catch (_) {}
  return next;
}

export function getApiKey() {
  const store = getStore();
  try {
    const primary = store.getItem(STORAGE_KEYS.GOOGLE_API_KEY);
    if (primary && primary.trim()) return primary.trim();
    const legacy = store.getItem(STORAGE_KEYS.LEGACY_API_KEY);
    return legacy ? legacy.trim() : '';
  } catch (_) {
    return '';
  }
}

export function setApiKey(key = '') {
  const store = getStore();
  const clean = typeof key === 'string' ? key.trim() : String(key ?? '').trim();
  try {
    if (clean) {
      store.setItem(STORAGE_KEYS.GOOGLE_API_KEY, clean);
      store.setItem(STORAGE_KEYS.LEGACY_API_KEY, clean);
    } else {
      store.removeItem(STORAGE_KEYS.GOOGLE_API_KEY);
      store.removeItem(STORAGE_KEYS.LEGACY_API_KEY);
    }
  } catch (_) {}
  return clean;
}

export function saveDatasetCache(dataset) {
  if (!dataset || typeof dataset !== 'object' || !Array.isArray(dataset.days) || !dataset.days.length) {
    return { ok: false, bytes: 0, kb: 0 };
  }
  const store = getStore();
  const savedAtIso = new Date().toISOString();
  const savedAtLabel = formatRuTimestamp(savedAtIso);
  const record = {
    version: 4,
    savedAtIso,
    savedAtLabel,
    dataset,
  };
  const json = JSON.stringify(record);
  const bytes = byteLength(json);

  try {
    store.setItem(STORAGE_KEYS.CACHE_V4, json);
    return { ok: true, bytes, kb: +(bytes / 1024).toFixed(1), savedAtIso, savedAtLabel };
  } catch (_) {
    // Evict LRU archive slices and MOS cache if storage quota is tight, then retry
    try {
      store.removeItem(STORAGE_KEYS.ARCHIVE_LRU);
      store.removeItem(STORAGE_KEYS.MOS_CACHE);
      store.removeItem(LEGACY_CACHE_KEY);
      store.setItem(STORAGE_KEYS.CACHE_V4, json);
      return { ok: true, bytes, kb: +(bytes / 1024).toFixed(1), savedAtIso, savedAtLabel };
    } catch (_) {
      return { ok: false, bytes, kb: +(bytes / 1024).toFixed(1), error: 'QuotaExceededError' };
    }
  }
}

export function loadDatasetCache() {
  const store = getStore();
  try {
    const raw = store.getItem(STORAGE_KEYS.CACHE_V4);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const ds = parsed?.dataset || parsed?.payload || (Array.isArray(parsed?.days) ? parsed : null);
    if (!ds || !Array.isArray(ds.days) || !ds.days.length) return null;
    return {
      ...ds,
      cacheSavedAtIso: parsed?.savedAtIso || null,
      cacheSavedAtLabel: parsed?.savedAtLabel || null,
    };
  } catch (_) {
    return null;
  }
}

export function clearDatasetCache({ includeArchive = false, includeMos = false } = {}) {
  const store = getStore();
  try {
    store.removeItem(STORAGE_KEYS.CACHE_V4);
    store.removeItem(LEGACY_CACHE_KEY);
    if (includeArchive) store.removeItem(STORAGE_KEYS.ARCHIVE_LRU);
    if (includeMos) store.removeItem(STORAGE_KEYS.MOS_CACHE);
  } catch (_) {}
}

export function getCacheStats() {
  const store = getStore();
  let rawCache = null;
  let rawArchive = null;
  let rawMos = null;
  try {
    rawCache = store.getItem(STORAGE_KEYS.CACHE_V4);
    rawArchive = store.getItem(STORAGE_KEYS.ARCHIVE_LRU);
    rawMos = store.getItem(STORAGE_KEYS.MOS_CACHE);
  } catch (_) {}

  let parsedCache = null;
  try {
    if (rawCache) parsedCache = JSON.parse(rawCache);
  } catch (_) {}

  let archiveList = [];
  try {
    if (rawArchive) {
      const parsedLru = JSON.parse(rawArchive);
      if (Array.isArray(parsedLru)) archiveList = parsedLru;
    }
  } catch (_) {}

  const cacheBytes = byteLength(rawCache);
  const archiveBytes = byteLength(rawArchive);
  const mosBytes = byteLength(rawMos);
  const totalBytes = cacheBytes + archiveBytes + mosBytes;

  return {
    hasCache: Boolean(parsedCache?.dataset?.days?.length || parsedCache?.days?.length),
    bytes: cacheBytes,
    kb: +(cacheBytes / 1024).toFixed(1),
    savedAtIso: parsedCache?.savedAtIso || null,
    savedAtLabel: parsedCache?.savedAtLabel || null,
    sourceLabel: parsedCache?.dataset?.sourceLabel || parsedCache?.sourceLabel || null,
    daysCount: parsedCache?.dataset?.days?.length || parsedCache?.days?.length || 0,
    archiveSlicesCount: archiveList.length,
    archiveBytes,
    archiveKb: +(archiveBytes / 1024).toFixed(1),
    mosCached: Boolean(rawMos),
    mosBytes,
    totalBytes,
    totalKb: +(totalBytes / 1024).toFixed(1),
  };
}

export function exportDatasetJson(dataset) {
  if (!dataset || typeof dataset !== 'object' || !Array.isArray(dataset.days)) {
    throw new Error('Нет корректного набора данных для экспорта');
  }
  const dateTag = new Date().toISOString().slice(0, 10);
  const filename = `aban_weather_v4_${dateTag}.json`;
  const json = JSON.stringify(dataset, null, 2);

  if (
    typeof document !== 'undefined' &&
    typeof Blob !== 'undefined' &&
    typeof URL !== 'undefined' &&
    typeof URL.createObjectURL === 'function'
  ) {
    const blob = new Blob([json], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }

  return {
    filename,
    json,
    bytes: byteLength(json),
  };
}

function readFileAsText(file) {
  if (typeof file === 'string') return Promise.resolve(file);
  if (file && typeof file.text === 'function') return file.text();
  if (typeof FileReader !== 'undefined' && file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(new Error('Не удалось прочитать файл'));
      reader.readAsText(file);
    });
  }
  return Promise.reject(new Error('Неподдерживаемый источник файла'));
}

export async function importDatasetJsonFile(file) {
  if (!file) throw new Error('Файл не выбран');
  const rawText = await readFileAsText(file);
  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch (_) {
    throw new Error('Некорректный JSON-файл');
  }

  const ds = parsed?.dataset || parsed?.payload || parsed;
  if (!ds || typeof ds !== 'object' || !Array.isArray(ds.days) || !ds.days.length) {
    throw new Error('Неверный формат JSON-среза (отсутствует массив days)');
  }
  const first = ds.days[0];
  if (!first || (typeof first.maxC !== 'number' && typeof first.minC !== 'number')) {
    throw new Error('Неверная структура записей в JSON-срезе');
  }

  saveDatasetCache(ds);
  return ds;
}

function readArchiveLruList() {
  const store = getStore();
  try {
    const raw = store.getItem(STORAGE_KEYS.ARCHIVE_LRU);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x) => x && typeof x.key === 'string') : [];
  } catch (_) {
    return [];
  }
}

function writeArchiveLruList(list) {
  const store = getStore();
  let trimmed = list.slice(0, MAX_ARCHIVE_SLICES);
  while (trimmed.length > 0) {
    try {
      store.setItem(STORAGE_KEYS.ARCHIVE_LRU, JSON.stringify(trimmed));
      return true;
    } catch (_) {
      trimmed = trimmed.slice(0, -1);
    }
  }
  try {
    store.removeItem(STORAGE_KEYS.ARCHIVE_LRU);
  } catch (_) {}
  return false;
}

export function saveArchiveSlice(key, data) {
  if (!key || data === undefined) return data;
  const now = Date.now();
  const list = readArchiveLruList().filter((entry) => entry.key !== key);
  list.unshift({
    key: String(key),
    savedAtMs: now,
    lastAccessMs: now,
    data,
  });
  writeArchiveLruList(list.slice(0, MAX_ARCHIVE_SLICES));
  return data;
}

export function loadArchiveSlice(key, maxAgeMs = null) {
  if (!key) return null;
  const list = readArchiveLruList();
  const idx = list.findIndex((entry) => entry.key === key);
  if (idx === -1) return null;

  const entry = list[idx];
  if (maxAgeMs !== null && Number.isFinite(maxAgeMs) && Date.now() - (entry.savedAtMs || 0) > maxAgeMs) {
    const remaining = list.filter((_, i) => i !== idx);
    writeArchiveLruList(remaining);
    return null;
  }

  // Promote accessed slice to MRU head
  const updated = { ...entry, lastAccessMs: Date.now() };
  const reordered = [updated, ...list.filter((_, i) => i !== idx)];
  writeArchiveLruList(reordered);
  return entry.data;
}

export function saveMosCache(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const store = getStore();
  try {
    store.setItem(
      STORAGE_KEYS.MOS_CACHE,
      JSON.stringify({
        savedAtMs: Date.now(),
        payload,
      })
    );
  } catch (_) {}
  return payload;
}

export function loadMosCache(maxAgeMs = 60 * 60 * 1000) {
  const store = getStore();
  try {
    const raw = store.getItem(STORAGE_KEYS.MOS_CACHE);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.savedAtMs !== 'number' || !parsed.payload) return null;
    if (Date.now() - parsed.savedAtMs > maxAgeMs) return null;
    return parsed.payload;
  } catch (_) {
    return null;
  }
}
