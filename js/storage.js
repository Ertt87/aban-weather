import { ABAN_COORDS, STORAGE_KEYS, missingForecastDay } from './config.js';

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
  if (!['multi', 'ecmwf_ifs025', 'ecmwf_aifs025', 'icon_seamless', 'gfs_seamless'].includes(merged.preferredOmModel)) {
    merged.preferredOmModel = DEFAULT_PREFS.preferredOmModel;
  }
  if (typeof merged.activePreset !== 'string' || !/^[a-z0-9_]{1,16}$/i.test(merged.activePreset)) {
    merged.activePreset = DEFAULT_PREFS.activePreset;
  }
  merged.showClimatology = Boolean(merged.showClimatology);
  merged.showModelLines = Boolean(merged.showModelLines);
  merged.groupByPentad = Boolean(merged.groupByPentad);
  return merged;
}

// ============================================================================
// TRUST BOUNDARY: datasets read back from disk (imported JSON, localStorage) are untrusted
// ============================================================================
const SANITIZE_MAX_DEPTH = 8;
const SANITIZE_MAX_STRING = 400;
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function sanitizeString(str) {
  // No legitimate dataset string carries markup; neutralise anything that could open a tag,
  // break out of an attribute, or smuggle control characters.
  let out = str.length > SANITIZE_MAX_STRING ? str.slice(0, SANITIZE_MAX_STRING) : str;
  if (/[<>"'`\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(out)) {
    out = out
      .replace(/</g, '‹')
      .replace(/>/g, '›')
      .replace(/"/g, '″')
      .replace(/'/g, '′')
      .replace(/`/g, '′')
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
  }
  return out;
}

function sanitizeValue(val, depth) {
  if (val === null || val === undefined) return null;
  const type = typeof val;
  if (type === 'number') return Number.isFinite(val) ? val : null;
  if (type === 'boolean') return val;
  if (type === 'string') return sanitizeString(val);
  if (type !== 'object' || depth >= SANITIZE_MAX_DEPTH) return null;
  if (Array.isArray(val)) return val.map((item) => sanitizeValue(item, depth + 1));
  const out = {};
  for (const key of Object.keys(val)) {
    if (UNSAFE_KEYS.has(key)) continue;
    out[sanitizeString(String(key))] = sanitizeValue(val[key], depth + 1);
  }
  return out;
}

const DAY_NUMERIC_FIELDS = [
  'maxC', 'minC', 'maxF', 'minF', 'confidencePct', 'offsetFromToday', 'humidity',
  'precipMm', 'precipP75Mm', 'rainMm', 'snowMm', 'snowDepthCm', 'precipDay', 'precipNight', 'dailyPrecipProbability',
  'windMs', 'windMph', 'gustMs', 'gustMph', 'windDeg', 'cloudCoverPct', 'uv',
  'soil0C', 'soil6C', 'soil18C', 'soil54C', 'dewPointC', 'deltaP24hMm',
  'pressureStationMm', 'pressureStationHpa', 'pressureMslMm', 'pressureMslHpa',
];

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function snapshotNumber(value) {
  if (typeof value !== 'number' && !(typeof value === 'string' && value.trim())) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// Unversioned exports and v3 snapshots can be read if their actual fields pass v4 validation.
function supportedVersion(record) {
  return !Object.hasOwn(record, 'version') || [3, 4].includes(snapshotNumber(record.version));
}

/**
 * Returns a deep, markup-free copy of an untrusted dataset, or null when it is not a usable
 * forecast slice. Strings are neutralised, non-finite numbers dropped, and the fields the UI
 * formats as numbers are coerced so that a crafted file cannot inject HTML or crash rendering.
 */
export function sanitizeDataset(raw) {
  if (!isRecord(raw) || !Array.isArray(raw.days) || !supportedVersion(raw)) return null;
  const clean = sanitizeValue(raw, 0);
  if (['current', 'controlPoint', 'airQuality', 'mos', 'channels'].some(key =>
    clean[key] != null && !isRecord(clean[key]))) return null;
  if (clean.mos?.models != null && !isRecord(clean.mos.models)) return null;
  for (const group of [clean.channels, clean.mos?.models]) {
    for (const key of Object.keys(group || {})) {
      if (!isRecord(group[key])) delete group[key];
    }
  }

  clean.days = clean.days.map(day => {
    if (!isRecord(day) || typeof day.isoDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day.isoDate)) return null;
    const date = new Date(day.isoDate);
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== day.isoDate) return null;
    for (const field of ['dateStr', 'dayShort']) {
      if (typeof day[field] !== 'string') delete day[field];
    }
    if (day.hasForecast === false) return missingForecastDay(day);
    // Older live snapshots expanded the calendar with wholly synthetic, model-free days.
    const legacy = day.hasForecast === undefined && String(clean.sourceType).startsWith('live_');
    if (day.hasForecast === false || (legacy && !day.isArchive && day.dataQuality?.ensembleBacked === false &&
        day.modelBreakdown && !Object.keys(day.modelBreakdown).length && Array.isArray(day.hours) &&
        day.hours.every(h => h?.isSynthetic && !h.weather) && !day.dayConditionIsDaily)) {
      return missingForecastDay(day);
    }
    if (day.hasForecast === undefined && Array.isArray(day.hours) && day.hours.some(h => h?.isSynthetic)) {
      for (const h of day.hours) {
        if (h?.isSynthetic) Object.assign(h, { precipMm: null, precipProb: null, precipPhase: null });
      }
      day.nextNightPrecipMm = null;
      day.nextNightPrecipProb = null;
      if (day.hours.every(h => h?.isSynthetic)) {
        day.precipDay = null;
        day.precipNight = null;
      }
    }
    return day;
  }).filter((day) => {
    if (!day) return false;
    for (const field of DAY_NUMERIC_FIELDS) {
      if (field in day) day[field] = snapshotNumber(day[field]);
    }
    // Legacy v4 confidence percentages were derived solely from the lead time.
    day.confidencePct = null;
    if (day.hasForecast === false) return true;
    // Old blended snapshots do not identify whether the stored hour was a start or an end.
    if (day.precipTimeBasis !== 'interval-start') {
      for (const hour of Array.isArray(day.hours) ? day.hours : []) {
        if (hour && typeof hour === 'object') Object.assign(hour, { precipMm: null, precipProb: null, precipPhase: null, precipInterval: null });
      }
      day.precipBlocks = [];
      day.dayShiftPrecip = day.nextNightPrecip = day.nextNightPrecipProb = day.nextNightPrecipMm = null;
    }
    const partialForecast = day.hasForecast === true && (
      ['minC', 'maxC', 'precipMm', 'windMs', 'gustMs', 'pressureMslMm', 'dailyPrecipProbability'].some(key => Number.isFinite(day[key])) ||
      (Number.isFinite(day.snowDepthCm) && !day.dataQuality?.snowEstimated) ||
      [day.iconType, day.nightIconType].some(icon => typeof icon === 'string' && icon && icon !== 'unknown') ||
      (Array.isArray(day.hours) && day.hours.some(h => h && (
        (!h.isSynthetic && Number.isFinite(h.tempC)) || Number.isFinite(h.precipMm) || Number.isFinite(h.precipProb) || h.weather?.ru
      )))
    );
    if ((!Number.isFinite(day.maxC) || !Number.isFinite(day.minC)) && !partialForecast) return false;
    day.id = `day_${day.isoDate}`;
    if (!Array.isArray(day.hours)) day.hours = [];
    day.hours = day.hours.filter(h => {
      if (!isRecord(h)) return false;
      const hour = snapshotNumber(h.hour);
      if (!Number.isInteger(hour) || hour < 0 || hour > 23) return false;
      h.hour = hour;
      if (typeof h.hourStr !== 'string' || !h.hourStr) h.hourStr = String(hour).padStart(2, '0') + ':00';
      return true;
    });
    return true;
  });
  if (!clean.days.length) return null;
  if (!clean.days.some(d => d.precipTimeBasis === 'interval-start')) {
    if (clean.current) Object.assign(clean.current, { precipMm: null, precipProb: null, precipPhase: null });
    if (clean.controlPoint && typeof clean.controlPoint === 'object') clean.controlPoint.precipProb = null;
  }
  clean.days.sort((a, b) => (a.isoDate < b.isoDate ? -1 : a.isoDate > b.isoDate ? 1 : 0));
  return clean;
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
    // Evict LRU archive slices and MOS / companion caches if storage quota is tight, then retry
    try {
      store.removeItem(STORAGE_KEYS.ARCHIVE_LRU);
      store.removeItem(STORAGE_KEYS.MOS_CACHE);
      store.removeItem(STORAGE_KEYS.COMPANION_CACHE);
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
    if (!isRecord(parsed) || !supportedVersion(parsed)) return null;
    // localStorage is shared by everything served from this origin: re-validate on the way in
    const ds = sanitizeDataset(parsed?.dataset || parsed?.payload || (Array.isArray(parsed?.days) ? parsed : null));
    if (!ds) return null;
    const savedAtIso = typeof parsed?.savedAtIso === 'string' ? sanitizeString(parsed.savedAtIso) : null;
    const savedAtLabel = typeof parsed?.savedAtLabel === 'string' ? sanitizeString(parsed.savedAtLabel) : null;
    return {
      ...ds,
      cacheSavedAtIso: savedAtIso,
      cacheSavedAtLabel: savedAtLabel,
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
    if (includeMos) {
      store.removeItem(STORAGE_KEYS.MOS_CACHE);
      store.removeItem(STORAGE_KEYS.COMPANION_CACHE);
    }
  } catch (_) {}
}

export function getCacheStats() {
  const store = getStore();
  let rawCache = null;
  let rawArchive = null;
  let rawMos = null;
  let rawCompanion = null;
  try {
    rawCache = store.getItem(STORAGE_KEYS.CACHE_V4);
    rawArchive = store.getItem(STORAGE_KEYS.ARCHIVE_LRU);
    rawMos = store.getItem(STORAGE_KEYS.MOS_CACHE);
    rawCompanion = store.getItem(STORAGE_KEYS.COMPANION_CACHE);
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
  const mosBytes = byteLength(rawMos) + byteLength(rawCompanion);
  const totalBytes = cacheBytes + archiveBytes + mosBytes;
  const safeText = (v) => (typeof v === 'string' && v ? sanitizeString(v) : null);

  return {
    hasCache: Boolean(parsedCache?.dataset?.days?.length || parsedCache?.days?.length),
    bytes: cacheBytes,
    kb: +(cacheBytes / 1024).toFixed(1),
    savedAtIso: safeText(parsedCache?.savedAtIso),
    savedAtLabel: safeText(parsedCache?.savedAtLabel),
    sourceLabel: safeText(parsedCache?.dataset?.sourceLabel) || safeText(parsedCache?.sourceLabel),
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

export async function readDatasetJsonFile(file) {
  if (!file) throw new Error('Файл не выбран');
  const rawText = await readFileAsText(file);
  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch (_) {
    throw new Error('Некорректный JSON-файл');
  }

  const rawDs = parsed?.dataset || parsed?.payload || parsed;
  if (!rawDs || typeof rawDs !== 'object' || !Array.isArray(rawDs.days) || !rawDs.days.length) {
    throw new Error('Неверный формат JSON-среза (отсутствует массив days)');
  }

  if (!supportedVersion(parsed) || !supportedVersion(rawDs)) {
    throw new Error('Неподдерживаемая версия JSON-снимка');
  }
  // An imported file is untrusted input: keep only a validated, markup-free copy
  const ds = sanitizeDataset(rawDs);
  if (!ds || !ds.days.some(day => day.hasForecast !== false)) {
    throw new Error('Неверная структура записей в JSON-срезе. Проверьте разделы и наличие хотя бы одного дня с датой, минимумом и максимумом температуры');
  }

  if (!ds.sourceLabel) ds.sourceLabel = 'Снимок прогноза из JSON';
  return ds;
}

export async function importDatasetJsonFile(file) {
  const ds = await readDatasetJsonFile(file);
  if (!saveDatasetCache(ds).ok) throw new Error('Не удалось сохранить JSON-снимок в кэш');
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

/**
 * Soil / snow companion slice. Kept so a slow or failing upstream can be served stale
 * (stale-if-error) instead of falling back to air-temperature heuristics.
 */
export function saveCompanionCache(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const store = getStore();
  try {
    store.setItem(
      STORAGE_KEYS.COMPANION_CACHE,
      JSON.stringify({
        savedAtMs: Date.now(),
        payload,
      })
    );
  } catch (_) {}
  return payload;
}

/** @returns {{ payload: object, savedAtMs: number } | null} */
export function loadCompanionCache(maxAgeMs = 60 * 60 * 1000) {
  const store = getStore();
  try {
    const raw = store.getItem(STORAGE_KEYS.COMPANION_CACHE);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.savedAtMs !== 'number' || !parsed.payload || typeof parsed.payload !== 'object') {
      return null;
    }
    if (Date.now() - parsed.savedAtMs > maxAgeMs) return null;
    return { payload: parsed.payload, savedAtMs: parsed.savedAtMs };
  } catch (_) {
    return null;
  }
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
