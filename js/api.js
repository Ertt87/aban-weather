import { ABAN_COORDS } from './config.js';
import {
  loadMosCache,
  saveMosCache,
  loadCompanionCache,
  saveCompanionCache,
  loadArchiveSlice,
  saveArchiveSlice,
} from './storage.js';

const REQUEST_TIMEOUT_MS = 12000;
// The soil / snow companion query is heavy on the Open-Meteo side (~10 s is normal),
// so it gets its own generous timeout; it no longer blocks the first paint (see onPartial).
const COMPANION_TIMEOUT_MS = 25000;
// Previous-runs and seasonal queries can take ~12 s on a cold upstream cache. They refine the
// picture (MOS weights, days 33–35) but never gate the first paint, so they may wait longer.
const SLOW_CHANNEL_TIMEOUT_MS = 20000;
const MOS_TTL_MS = 60 * 60 * 1000;
const COMPANION_TTL_MS = 60 * 60 * 1000;
const COMPANION_STALE_MAX_MS = 12 * 60 * 60 * 1000;
const PARTIAL_GRACE_MS = 1200;
const RECENT_ARCHIVE_TTL_MS = 30 * 60 * 1000;
const MIN_ARCHIVE_ISO = '1940-01-01';
const OM_MODELS = ['ecmwf_ifs025', 'ecmwf_aifs025', 'icon_seamless', 'gfs_seamless'];

// Open-Meteo retired the `ecmwf_aifs025` id: it still answers HTTP 200, but every series is null.
// We keep the stable internal id and translate it to the live API id only on the wire.
const OM_API_MODEL_ALIASES = Object.freeze({
  ecmwf_aifs025: 'ecmwf_aifs025_single',
});

function toApiModelId(modelId) {
  return OM_API_MODEL_ALIASES[modelId] || modelId;
}

/**
 * Renames `<var>_<apiModelId>` response keys back to `<var>_<internalModelId>` (in place).
 */
export function normalizeOpenMeteoModelKeys(payload) {
  if (!payload || typeof payload !== 'object') return payload;
  for (const section of ['hourly', 'daily', 'hourly_units', 'daily_units']) {
    const sec = payload[section];
    if (!sec || typeof sec !== 'object') continue;
    for (const [internalId, apiId] of Object.entries(OM_API_MODEL_ALIASES)) {
      const suffix = `_${apiId}`;
      for (const key of Object.keys(sec)) {
        if (!key.endsWith(suffix)) continue;
        sec[`${key.slice(0, -suffix.length)}_${internalId}`] = sec[key];
        delete sec[key];
      }
    }
  }
  return payload;
}

function hasFiniteValue(arr) {
  if (!Array.isArray(arr)) return false;
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i];
    if (v !== null && v !== undefined && Number.isFinite(Number(v))) return true;
  }
  return false;
}

/**
 * Lists requested models whose temperature series came back empty (all null / absent),
 * so a silently retired upstream model id shows up in the channel diagnostics.
 */
export function listEmptyModels(payload, modelIds = OM_MODELS) {
  if (!payload || typeof payload !== 'object') return [];
  const single = modelIds.length === 1;
  return modelIds.filter((id) => {
    const hourly = payload.hourly?.[`temperature_2m_${id}`] ?? (single ? payload.hourly?.temperature_2m : undefined);
    const daily = payload.daily?.[`temperature_2m_max_${id}`] ?? (single ? payload.daily?.temperature_2m_max : undefined);
    return !hasFiniteValue(hourly) && !hasFiniteValue(daily);
  });
}

const MODEL_SHORT_LABELS = {
  ecmwf_ifs025: 'IFS',
  ecmwf_aifs025: 'AIFS',
  icon_seamless: 'ICON',
  gfs_seamless: 'GFS',
};

const CHANNEL_LABELS = {
  openMeteoMulti: 'Open-Meteo Multi (4 мод.)',
  openMeteoCompanion: 'Open-Meteo Почва / Снег',
  previousRuns: 'Open-Meteo MOS (14д)',
  ensemble35: 'Ансамбль 35д (P10–P90)',
  airQuality: 'Качество воздуха (AQI)',
  metNo: 'MET Norway Global',
  google: 'Google WeatherNext 3',
};

function round1(val) {
  return Number.isFinite(val) ? Math.round(val * 10) / 10 : null;
}

function round2(val) {
  return Number.isFinite(val) ? Math.round(val * 100) / 100 : null;
}

/** Finite number or null. Guards the `Number(null) === 0` / `Math.round(null) === 0` traps. */
function finiteOrNull(val) {
  if (val === null || val === undefined || val === '') return null;
  const n = Number(val);
  return Number.isFinite(n) ? n : null;
}

function roundOrNull(val) {
  const n = finiteOrNull(val);
  return n === null ? null : Math.round(n);
}

function avgFinite(arr) {
  let sum = 0;
  let count = 0;
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i];
    if (v !== null && v !== undefined && Number.isFinite(Number(v))) {
      sum += Number(v);
      count++;
    }
  }
  return count ? sum / count : null;
}

function maxFinite(arr) {
  let best = -Infinity;
  let found = false;
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i];
    if (v !== null && v !== undefined && Number.isFinite(Number(v))) {
      const n = Number(v);
      if (n > best) best = n;
      found = true;
    }
  }
  return found ? best : null;
}

function createTimeoutSignal(ms) {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    return { signal: AbortSignal.timeout(ms), cleanup: () => {} };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`Timeout ${ms}ms`)), ms);
  return {
    signal: controller.signal,
    cleanup: () => clearTimeout(timer),
  };
}

async function fetchJsonWithTimeout(url, timeoutMs = REQUEST_TIMEOUT_MS, init = {}) {
  const { signal, cleanup } = createTimeoutSignal(timeoutMs);
  try {
    const resp = await fetch(url, { ...init, signal });
    if (!resp.ok) {
      let detail = `HTTP ${resp.status}`;
      try {
        const errJson = await resp.json();
        detail = errJson?.error?.message || errJson?.reason || detail;
      } catch (_) {}
      const err = new Error(detail);
      err.status = resp.status;
      throw err;
    }
    return await resp.json();
  } finally {
    cleanup();
  }
}

export function getAbanTodayIso(offsetDays = 0) {
  const tz = ABAN_COORDS.tz || 'Asia/Krasnoyarsk';
  let baseIso;
  try {
    baseIso = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
  } catch (_) {
    const utcPlus7 = new Date(Date.now() + 7 * 3600 * 1000);
    baseIso = utcPlus7.toISOString().slice(0, 10);
  }
  if (!offsetDays) return baseIso;
  const [y, m, d] = baseIso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + offsetDays)).toISOString().slice(0, 10);
}

function addDaysIso(isoDate, deltaDays) {
  const [y, m, d] = isoDate.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + deltaDays)).toISOString().slice(0, 10);
}

function diffDaysIso(startIso, endIso) {
  const [sy, sm, sd] = startIso.split('-').map(Number);
  const [ey, em, ed] = endIso.split('-').map(Number);
  return Math.round((Date.UTC(ey, em - 1, ed) - Date.UTC(sy, sm - 1, sd)) / 86400000);
}

// ============================================================================
// GOOGLE WEATHER API v1 (WeatherNext 3)
// ============================================================================
function buildGoogleBaseQuery(apiKey) {
  return new URLSearchParams({
    key: apiKey.trim(),
    'location.latitude': String(ABAN_COORDS.lat),
    'location.longitude': String(ABAN_COORDS.lon),
    languageCode: 'ru',
    unitsSystem: 'METRIC',
  });
}

async function fetchGooglePaginated(endpoint, baseParams, extraParams, arrayField, maxPages, maxItems) {
  const collected = [];
  let pageToken = '';
  let page = 0;

  while (page < maxPages && collected.length < maxItems) {
    const params = new URLSearchParams(baseParams);
    for (const [k, v] of Object.entries(extraParams)) {
      params.set(k, String(v));
    }
    if (pageToken) {
      params.set('pageToken', pageToken);
    }
    const json = await fetchJsonWithTimeout(`https://weather.googleapis.com/v1/${endpoint}?${params.toString()}`);
    const items = Array.isArray(json?.[arrayField]) ? json[arrayField] : [];
    if (items.length) {
      collected.push(...items);
    }
    pageToken = json?.nextPageToken || '';
    page++;
    if (!pageToken) break;
  }

  return collected.slice(0, maxItems);
}

async function fetchGoogleWeatherBundle(apiKey) {
  const t0 = performance.now();
  const baseParams = buildGoogleBaseQuery(apiKey);

  const [curRes, daysRes, hoursRes, histRes] = await Promise.allSettled([
    fetchJsonWithTimeout(`https://weather.googleapis.com/v1/currentConditions:lookup?${baseParams.toString()}`),
    fetchGooglePaginated('forecast/days:lookup', baseParams, { days: 10, pageSize: 10 }, 'forecastDays', 3, 10),
    fetchGooglePaginated('forecast/hours:lookup', baseParams, { hours: 240, pageSize: 24 }, 'forecastHours', 10, 240),
    fetchGooglePaginated('history/hours:lookup', baseParams, { hours: 24, pageSize: 24 }, 'historyHours', 2, 24),
  ]);

  if (curRes.status === 'rejected' && daysRes.status === 'rejected') {
    throw new Error(daysRes.reason?.message || curRes.reason?.message || 'Google Weather API error');
  }
  if (daysRes.status === 'rejected') {
    throw new Error(daysRes.reason?.message || 'Google Weather days lookup failed');
  }

  return {
    current: curRes.status === 'fulfilled' ? curRes.value : null,
    forecastDays: daysRes.value || [],
    forecastHours: hoursRes.status === 'fulfilled' ? hoursRes.value : [],
    historyHours: histRes.status === 'fulfilled' ? histRes.value : [],
    latencyMs: Math.round(performance.now() - t0),
  };
}

export async function testGoogleApiKey(apiKey) {
  const cleanKey = typeof apiKey === 'string' ? apiKey.trim() : '';
  if (!cleanKey || cleanKey.length <= 10) {
    return {
      ok: false,
      daysCount: 0,
      hoursCount: 0,
      hasMoreHours: false,
      latencyMs: 0,
      error: 'Сначала введите корректный ключ Google Maps Platform Weather API',
    };
  }

  const t0 = performance.now();
  const baseParams = buildGoogleBaseQuery(cleanKey);
  const daysParams = new URLSearchParams(baseParams);
  daysParams.set('days', '10');
  daysParams.set('pageSize', '10');

  const hoursParams = new URLSearchParams(baseParams);
  hoursParams.set('hours', '240');
  hoursParams.set('pageSize', '24');

  try {
    const [daysJson, hoursJson] = await Promise.all([
      fetchJsonWithTimeout(`https://weather.googleapis.com/v1/forecast/days:lookup?${daysParams.toString()}`),
      fetchJsonWithTimeout(`https://weather.googleapis.com/v1/forecast/hours:lookup?${hoursParams.toString()}`),
    ]);

    const daysCount = Array.isArray(daysJson?.forecastDays) ? daysJson.forecastDays.length : 0;
    const hoursCount = Array.isArray(hoursJson?.forecastHours) ? hoursJson.forecastHours.length : 0;
    return {
      ok: daysCount > 0 && hoursCount > 0,
      daysCount,
      hoursCount,
      hasMoreHours: Boolean(hoursJson?.nextPageToken),
      latencyMs: Math.round(performance.now() - t0),
      error: daysCount > 0 && hoursCount > 0 ? null : 'API вернул пустой прогноз',
    };
  } catch (err) {
    return {
      ok: false,
      daysCount: 0,
      hoursCount: 0,
      hasMoreHours: false,
      latencyMs: Math.round(performance.now() - t0),
      error: err?.message || 'Ошибка проверки ключа API',
    };
  }
}

// ============================================================================
// OPEN-METEO MULTI-MODEL + COMPANION + PREVIOUS RUNS
// ============================================================================
const MULTI_HOURLY_VARS = [
  'temperature_2m',
  'apparent_temperature',
  'relative_humidity_2m',
  'dew_point_2m',
  'precipitation',
  'rain',
  'snowfall',
  'weather_code',
  'pressure_msl',
  'surface_pressure',
  'cloud_cover',
  'wind_speed_10m',
  'wind_direction_10m',
  'wind_gusts_10m',
].join(',');

const MULTI_DAILY_VARS = [
  'weather_code',
  'temperature_2m_max',
  'temperature_2m_min',
  'precipitation_sum',
  'rain_sum',
  'snowfall_sum',
  'wind_speed_10m_max',
  'wind_gusts_10m_max',
  'wind_direction_10m_dominant',
].join(',');

function mergeSingleModelIntoMulti(target, singleJson, modelName) {
  if (!singleJson || !target) return target;
  for (const section of ['hourly', 'daily']) {
    const srcSec = singleJson[section];
    const dstSec = target[section];
    if (!srcSec || !dstSec) continue;
    for (const [k, arr] of Object.entries(srcSec)) {
      if (k === 'time' || !Array.isArray(arr)) continue;
      const suffixedKey = k.endsWith(`_${modelName}`) ? k : `${k}_${modelName}`;
      dstSec[suffixedKey] = arr;
    }
  }
  return target;
}

async function fetchOpenMeteoMulti() {
  const baseObj = {
    latitude: String(ABAN_COORDS.lat),
    longitude: String(ABAN_COORDS.lon),
    elevation: String(ABAN_COORDS.elev),
    cell_selection: 'land',
    timezone: ABAN_COORDS.tz,
    wind_speed_unit: 'ms',
    past_days: '14',
    forecast_days: '16',
    models: OM_MODELS.map(toApiModelId).join(','),
    hourly: MULTI_HOURLY_VARS,
    daily: MULTI_DAILY_VARS,
  };

  let data;
  try {
    data = normalizeOpenMeteoModelKeys(
      await fetchJsonWithTimeout(`https://api.open-meteo.com/v1/forecast?${new URLSearchParams(baseObj).toString()}`)
    );
  } catch (err) {
    if (err.status !== 400) throw err;

    // Fallback: query the 3 core NWP models and fetch AIFS separately with core fields
    const coreParams = new URLSearchParams({
      ...baseObj,
      models: 'ecmwf_ifs025,icon_seamless,gfs_seamless',
    });
    const aifsParams = new URLSearchParams({
      ...baseObj,
      models: toApiModelId('ecmwf_aifs025'),
      hourly: 'temperature_2m,relative_humidity_2m,dew_point_2m,precipitation,pressure_msl,surface_pressure,cloud_cover,wind_speed_10m,wind_direction_10m',
      daily: 'temperature_2m_max,temperature_2m_min,precipitation_sum,wind_speed_10m_max,wind_direction_10m_dominant',
    });

    const [coreRes, aifsRes] = await Promise.allSettled([
      fetchJsonWithTimeout(`https://api.open-meteo.com/v1/forecast?${coreParams.toString()}`),
      fetchJsonWithTimeout(`https://api.open-meteo.com/v1/forecast?${aifsParams.toString()}`),
    ]);

    if (coreRes.status === 'rejected') throw coreRes.reason;
    data = normalizeOpenMeteoModelKeys(coreRes.value);
    if (aifsRes.status === 'fulfilled') {
      mergeSingleModelIntoMulti(data, normalizeOpenMeteoModelKeys(aifsRes.value), 'ecmwf_aifs025');
    }
  }

  const emptyModels = listEmptyModels(data);
  if (emptyModels.length) {
    const names = emptyModels.map((id) => MODEL_SHORT_LABELS[id] || id).join(', ');
    return { data, fromCache: false, degraded: true, detail: `Нет данных от моделей: ${names}` };
  }
  return { data, fromCache: false, detail: `Все ${OM_MODELS.length} модели отдали данные` };
}

async function fetchOpenMeteoCompanion(forceRefresh = false) {
  if (!forceRefresh) {
    const fresh = loadCompanionCache(COMPANION_TTL_MS);
    if (fresh?.payload) {
      return { data: fresh.payload, fromCache: true, detail: 'Локальный кэш (TTL 1ч)' };
    }
  }

  // Only the variables the ensemble actually consumes: soil profile, snow depth, precipitation
  // probability, pressure fallback and UV. Extra fields make this (already slow) query slower.
  const params = new URLSearchParams({
    latitude: String(ABAN_COORDS.lat),
    longitude: String(ABAN_COORDS.lon),
    elevation: String(ABAN_COORDS.elev),
    cell_selection: 'land',
    timezone: ABAN_COORDS.tz,
    wind_speed_unit: 'ms',
    past_days: '14',
    forecast_days: '16',
    models: 'best_match',
    current: 'temperature_2m,surface_pressure',
    hourly: [
      'precipitation_probability',
      'snow_depth',
      'soil_temperature_0cm',
      'soil_temperature_6cm',
      'soil_temperature_18cm',
      'soil_temperature_54cm',
      'pressure_msl',
      'surface_pressure',
    ].join(','),
    daily: ['uv_index_max', 'precipitation_probability_max', 'shortwave_radiation_sum'].join(','),
  });

  try {
    const data = await fetchJsonWithTimeout(
      `https://api.open-meteo.com/v1/forecast?${params.toString()}`,
      COMPANION_TIMEOUT_MS
    );
    // `current` is time-stamped: never persist it, or a cached slice would pin "today" to the past
    saveCompanionCache({ ...data, current: undefined });
    return { data, fromCache: false };
  } catch (err) {
    // Stale-if-error: soil temperature and snow depth drift slowly, so a few-hours-old slice
    // is far closer to the truth than an air-temperature heuristic.
    const stale = loadCompanionCache(COMPANION_STALE_MAX_MS);
    if (stale?.payload) {
      const ageMin = Math.max(1, Math.round((Date.now() - stale.savedAtMs) / 60000));
      const ageLabel = ageMin >= 90 ? `${Math.round(ageMin / 60)} ч` : `${ageMin} мин`;
      return {
        data: stale.payload,
        fromCache: true,
        detail: `Кэш ${ageLabel} назад (сервер: ${err?.message || 'нет ответа'})`,
      };
    }
    throw err;
  }
}

async function fetchPreviousRunsMos(forceRefresh = false) {
  if (!forceRefresh) {
    const cached = loadMosCache(MOS_TTL_MS);
    if (cached) return { data: cached, fromCache: true };
  }

  const baseObj = {
    latitude: String(ABAN_COORDS.lat),
    longitude: String(ABAN_COORDS.lon),
    elevation: String(ABAN_COORDS.elev),
    timezone: ABAN_COORDS.tz,
    past_days: '14',
    forecast_days: '1',
    models: OM_MODELS.map(toApiModelId).join(','),
    hourly: 'temperature_2m,temperature_2m_previous_day1,temperature_2m_previous_day2',
  };

  let data;
  try {
    data = await fetchJsonWithTimeout(
      `https://previous-runs-api.open-meteo.com/v1/forecast?${new URLSearchParams(baseObj).toString()}`,
      SLOW_CHANNEL_TIMEOUT_MS
    );
  } catch (err) {
    if (err.status !== 400) throw err;
    const fallbackParams = new URLSearchParams({
      ...baseObj,
      models: 'ecmwf_ifs025,icon_seamless,gfs_seamless',
    });
    data = await fetchJsonWithTimeout(
      `https://previous-runs-api.open-meteo.com/v1/forecast?${fallbackParams.toString()}`,
      SLOW_CHANNEL_TIMEOUT_MS
    );
  }

  normalizeOpenMeteoModelKeys(data);
  saveMosCache(data);
  return { data, fromCache: false };
}

// ============================================================================
// OPEN-METEO 35-DAY ENSEMBLE & QUANTILE AGGREGATION
// ============================================================================
function quantile(sorted, q) {
  if (!sorted.length) return null;
  if (sorted.length === 1) return sorted[0];
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  const next = sorted[base + 1] !== undefined ? sorted[base + 1] : sorted[base];
  return sorted[base] + rest * (next - sorted[base]);
}

function classifyEnsembleKey(key) {
  if (/^temperature_2m_max(?:_member\d+)?(?:_.*)?$/.test(key)) return 'maxVals';
  if (/^temperature_2m_min(?:_member\d+)?(?:_.*)?$/.test(key)) return 'minVals';
  if (/^precipitation_sum(?:_member\d+)?(?:_.*)?$/.test(key)) return 'precipVals';
  if (/^wind_speed_10m_max(?:_member\d+)?(?:_.*)?$/.test(key)) return 'windVals';
  return null;
}

function addSixHourlyToDailyBuckets(sixHourly, byDate) {
  const times = sixHourly?.time;
  if (!Array.isArray(times) || !times.length) return;

  const tempKeys = Object.keys(sixHourly).filter((k) => /^temperature_2m(?:_member\d+)?(?:_.*)?$/.test(k));
  const precipKeys = Object.keys(sixHourly).filter((k) => /^precipitation(?:_member\d+)?(?:_.*)?$/.test(k));
  const windKeys = Object.keys(sixHourly).filter((k) => /^wind_speed_10m(?:_member\d+)?(?:_.*)?$/.test(k));

  const dayMemberAcc = new Map();
  const ensureMember = (isoDate, key) => {
    let dm = dayMemberAcc.get(isoDate);
    if (!dm) {
      dm = new Map();
      dayMemberAcc.set(isoDate, dm);
    }
    let rec = dm.get(key);
    if (!rec) {
      rec = { max: -Infinity, min: Infinity, precip: 0, hasPrecip: false, wind: -Infinity };
      dm.set(key, rec);
    }
    return rec;
  };

  for (let i = 0; i < times.length; i++) {
    const isoDate = String(times[i]).slice(0, 10);
    for (const k of tempKeys) {
      const v = sixHourly[k]?.[i];
      if (v !== null && v !== undefined && Number.isFinite(Number(v))) {
        const suffix = k.replace(/^temperature_2m/, '');
        const m = ensureMember(isoDate, suffix);
        const n = Number(v);
        if (n > m.max) m.max = n;
        if (n < m.min) m.min = n;
      }
    }
    for (const k of precipKeys) {
      const v = sixHourly[k]?.[i];
      if (v !== null && v !== undefined && Number.isFinite(Number(v))) {
        const suffix = k.replace(/^precipitation/, '');
        const m = ensureMember(isoDate, suffix);
        m.precip += Number(v);
        m.hasPrecip = true;
      }
    }
    for (const k of windKeys) {
      const v = sixHourly[k]?.[i];
      if (v !== null && v !== undefined && Number.isFinite(Number(v))) {
        const suffix = k.replace(/^wind_speed_10m/, '');
        const m = ensureMember(isoDate, suffix);
        const n = Number(v);
        if (n > m.wind) m.wind = n;
      }
    }
  }

  for (const [isoDate, members] of dayMemberAcc.entries()) {
    let bucket = byDate.get(isoDate);
    if (!bucket) {
      bucket = { maxVals: [], minVals: [], precipVals: [], windVals: [] };
      byDate.set(isoDate, bucket);
    }
    for (const m of members.values()) {
      if (m.max > -Infinity) bucket.maxVals.push(m.max);
      if (m.min < Infinity) bucket.minVals.push(m.min);
      if (m.hasPrecip) bucket.precipVals.push(m.precip);
      if (m.wind > -Infinity) bucket.windVals.push(m.wind);
    }
  }
}

export function aggregateEnsembleQuantiles(entries) {
  const byDate = new Map();
  const sources = [];

  for (const entry of entries || []) {
    if (!entry || !entry.payload) continue;
    const { source, payload } = entry;
    if (source && !sources.includes(source)) sources.push(source);

    if (payload.daily && Array.isArray(payload.daily.time)) {
      const times = payload.daily.time;
      const keysByBucket = [];
      for (const [k, arr] of Object.entries(payload.daily)) {
        if (k === 'time' || !Array.isArray(arr)) continue;
        const field = classifyEnsembleKey(k);
        if (field) keysByBucket.push([field, arr]);
      }

      for (let i = 0; i < times.length; i++) {
        const isoDate = String(times[i]).slice(0, 10);
        let bucket = byDate.get(isoDate);
        if (!bucket) {
          bucket = { maxVals: [], minVals: [], precipVals: [], windVals: [] };
          byDate.set(isoDate, bucket);
        }
        for (const [field, arr] of keysByBucket) {
          const val = arr[i];
          if (val !== null && val !== undefined && Number.isFinite(Number(val))) {
            bucket[field].push(Number(val));
          }
        }
      }
    } else if (payload.six_hourly && Array.isArray(payload.six_hourly.time)) {
      addSixHourlyToDailyBuckets(payload.six_hourly, byDate);
    }
  }

  const sortedDates = [...byDate.keys()].sort();
  const dailyQuantiles = [];

  for (const isoDate of sortedDates) {
    const b = byDate.get(isoDate);
    const maxS = [...b.maxVals].sort((a, c) => a - c);
    const minS = [...b.minVals].sort((a, c) => a - c);
    const pS = [...b.precipVals].sort((a, c) => a - c);
    const wS = [...b.windVals].sort((a, c) => a - c);

    if (!maxS.length && !minS.length) continue;

    const maxP10C = round1(quantile(maxS, 0.1));
    const maxP25C = round1(quantile(maxS, 0.25));
    const maxP50C = round1(quantile(maxS, 0.5));
    const maxP75C = round1(quantile(maxS, 0.75));
    const maxP90C = round1(quantile(maxS, 0.9));

    const minP10C = round1(quantile(minS, 0.1));
    const minP25C = round1(quantile(minS, 0.25));
    const minP50C = round1(quantile(minS, 0.5));
    const minP75C = round1(quantile(minS, 0.75));
    const minP90C = round1(quantile(minS, 0.9));

    const precipP50Mm = round1(quantile(pS, 0.5) ?? 0);
    const precipP75Mm = round1(quantile(pS, 0.75) ?? precipP50Mm ?? 0);
    const precipP90Mm = round1(quantile(pS, 0.9) ?? precipP75Mm ?? 0);

    const windP50Ms = round1(quantile(wS, 0.5) ?? 3.5);
    const windP90Ms = round1(quantile(wS, 0.9) ?? windP50Ms ?? 6.0);

    const probBelowMinus20 = minS.length
      ? Math.round((minS.filter((v) => v <= -20).length / minS.length) * 100)
      : 0;
    const probPrecipOver5 = pS.length
      ? Math.round((pS.filter((v) => v >= 5).length / pS.length) * 100)
      : 0;

    dailyQuantiles.push({
      isoDate,
      maxP10C,
      maxP25C,
      maxP50C,
      maxP75C,
      maxP90C,
      minP10C,
      minP25C,
      minP50C,
      minP75C,
      minP90C,
      precipP50Mm,
      precipP75Mm,
      precipP90Mm,
      windP50Ms,
      windP90Ms,
      probBelowMinus20,
      probPrecipOver5,
      memberCount: Math.max(maxS.length, minS.length),
    });
  }

  return { sources, dailyQuantiles };
}

async function fetchEnsemble35() {
  const commonParams = {
    latitude: String(ABAN_COORDS.lat),
    longitude: String(ABAN_COORDS.lon),
    elevation: String(ABAN_COORDS.elev),
    timezone: ABAN_COORDS.tz,
    wind_speed_unit: 'ms',
    daily: 'temperature_2m_max,temperature_2m_min,precipitation_sum,wind_speed_10m_max',
  };

  const ecmwfParams = new URLSearchParams({
    ...commonParams,
    forecast_days: '16',
    models: 'ecmwf_ifs025_ensemble',
  });
  const gefsParams = new URLSearchParams({
    ...commonParams,
    forecast_days: '35',
    models: 'gfs_seamless',
  });

  // GEFS usually ends 1–2 days short of the 35-day horizon, so the seasonal ensemble is fetched
  // in parallel and used ONLY for the dates the primary ensembles leave uncovered.
  const [ecmwfRes, gefsRes, seasonalRes] = await Promise.allSettled([
    fetchJsonWithTimeout(`https://ensemble-api.open-meteo.com/v1/ensemble?${ecmwfParams.toString()}`),
    fetchJsonWithTimeout(`https://ensemble-api.open-meteo.com/v1/ensemble?${gefsParams.toString()}`),
    fetchSeasonalEnsemble(commonParams),
  ]);

  const payloads = [];
  if (ecmwfRes.status === 'fulfilled') {
    payloads.push({ source: 'ecmwf_ifs025_ensemble', payload: ecmwfRes.value });
  }
  if (gefsRes.status === 'fulfilled') {
    payloads.push({ source: 'gfs_seamless_ensemble', payload: gefsRes.value });
  }

  let aggregated = aggregateEnsembleQuantiles(payloads);
  if (seasonalRes.status === 'fulfilled' && seasonalRes.value) {
    aggregated = mergeQuantileFallback(
      aggregated,
      aggregateEnsembleQuantiles([{ source: 'ecmwf_seasonal', payload: seasonalRes.value }])
    );
  }

  if (!aggregated.dailyQuantiles.length) return null;
  return aggregated;
}

async function fetchSeasonalEnsemble(commonParams) {
  const seasonalParams = new URLSearchParams({
    ...commonParams,
    forecast_days: '35',
  });
  try {
    return await fetchJsonWithTimeout(
      `https://seasonal-api.open-meteo.com/v1/seasonal?${seasonalParams.toString()}`,
      SLOW_CHANNEL_TIMEOUT_MS
    );
  } catch (err) {
    if (err.status !== 400) throw err;
    const sixHourlyParams = new URLSearchParams({
      latitude: String(ABAN_COORDS.lat),
      longitude: String(ABAN_COORDS.lon),
      elevation: String(ABAN_COORDS.elev),
      timezone: ABAN_COORDS.tz,
      wind_speed_unit: 'ms',
      forecast_days: '35',
      six_hourly: 'temperature_2m,precipitation,wind_speed_10m',
    });
    return fetchJsonWithTimeout(
      `https://seasonal-api.open-meteo.com/v1/seasonal?${sixHourlyParams.toString()}`,
      SLOW_CHANNEL_TIMEOUT_MS
    );
  }
}

/**
 * Appends fallback quantile days for dates the primary aggregate does not cover.
 * Primary days are never altered, so coarser fallback members cannot dilute them.
 */
export function mergeQuantileFallback(primary, fallback) {
  const base = primary && Array.isArray(primary.dailyQuantiles) ? primary : { sources: [], dailyQuantiles: [] };
  const extra = fallback && Array.isArray(fallback.dailyQuantiles) ? fallback.dailyQuantiles : [];
  const covered = new Set(base.dailyQuantiles.map((d) => d.isoDate));
  const added = extra.filter((d) => d && d.isoDate && !covered.has(d.isoDate));
  if (!added.length) return base;

  const sources = [...(base.sources || [])];
  for (const src of fallback.sources || []) {
    if (!sources.includes(src)) sources.push(src);
  }
  return {
    sources,
    dailyQuantiles: [...base.dailyQuantiles, ...added].sort((a, b) =>
      a.isoDate < b.isoDate ? -1 : a.isoDate > b.isoDate ? 1 : 0
    ),
  };
}

// ============================================================================
// MET NORWAY & OPEN-METEO AIR QUALITY
// ============================================================================
async function fetchMetNo() {
  const url = `https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=${ABAN_COORDS.lat}&lon=${ABAN_COORDS.lon}&altitude=${ABAN_COORDS.elev}`;
  return fetchJsonWithTimeout(url);
}

async function fetchAirQuality() {
  const params = new URLSearchParams({
    latitude: String(ABAN_COORDS.lat),
    longitude: String(ABAN_COORDS.lon),
    current: 'pm2_5,pm10,carbon_monoxide,european_aqi',
    timezone: ABAN_COORDS.tz,
  });
  return fetchJsonWithTimeout(`https://air-quality-api.open-meteo.com/v1/air-quality?${params.toString()}`);
}

// ============================================================================
// UNIFIED SOURCE ORCHESTRATOR WITH PER-CHANNEL TELEMETRY
// ============================================================================
async function runTimedChannel(id, enabled, fn, disabledReason = 'Отключён режимом') {
  const label = CHANNEL_LABELS[id] || id;
  if (!enabled) {
    return {
      value: null,
      channel: { id, label, status: 'disabled', latencyMs: 0, error: null, detail: disabledReason },
    };
  }
  const t0 = performance.now();
  try {
    const out = await fn();
    const latencyMs = Math.round(performance.now() - t0);
    if (out && typeof out === 'object' && 'fromCache' in out && 'data' in out) {
      return {
        value: out.data,
        channel: {
          id,
          label,
          status: out.degraded ? 'partial' : out.fromCache ? 'cached' : 'ok',
          latencyMs,
          error: null,
          detail: out.detail || (out.fromCache ? 'Локальный кэш (TTL 1ч)' : 'Обновлено'),
        },
      };
    }
    return {
      value: out,
      channel: { id, label, status: 'ok', latencyMs, error: null, detail: 'Ответ получен' },
    };
  } catch (err) {
    return {
      value: null,
      channel: {
        id,
        label,
        status: 'error',
        latencyMs: Math.round(performance.now() - t0),
        error: err?.message || 'Ошибка сети',
        detail: err?.message || 'Ошибка сети',
      },
    };
  }
}

const CHANNEL_ORDER = [
  'openMeteoMulti',
  'openMeteoCompanion',
  'previousRuns',
  'ensemble35',
  'airQuality',
  'metNo',
  'google',
];

/**
 * Fetches every data channel in parallel.
 *
 * `onPartial(bundle)` (optional) fires at most once, as soon as the core forecast channel has
 * answered and slower channels are still in flight: the caller can paint real data within ~1–2 s
 * instead of waiting for the slowest channel. The returned promise still resolves with the
 * complete bundle. In a partial bundle unfinished channels carry `status: 'pending'`.
 */
export async function fetchAllWeatherSources({
  apiKey = '',
  mode = 'hybrid',
  preferredOmModel = 'multi',
  forceRefresh = false,
  onPartial = null,
  partialGraceMs = PARTIAL_GRACE_MS,
} = {}) {
  const t0 = performance.now();
  const cleanKey = typeof apiKey === 'string' ? apiKey.trim() : '';
  const hasGoogleKey = cleanKey.length > 10;
  const shouldGoogle = hasGoogleKey && (mode === 'hybrid' || mode === 'google_wn3');
  const shouldOpenMeteo = mode !== 'google_wn3';

  const tasks = {
    google: runTimedChannel(
      'google',
      shouldGoogle,
      () => fetchGoogleWeatherBundle(cleanKey),
      hasGoogleKey ? 'Отключён режимом' : 'Ключ API не задан'
    ),
    openMeteoMulti: runTimedChannel('openMeteoMulti', shouldOpenMeteo, () => fetchOpenMeteoMulti()),
    openMeteoCompanion: runTimedChannel('openMeteoCompanion', shouldOpenMeteo, () => fetchOpenMeteoCompanion(forceRefresh)),
    previousRuns: runTimedChannel('previousRuns', shouldOpenMeteo, () => fetchPreviousRunsMos(forceRefresh)),
    ensemble35: runTimedChannel('ensemble35', shouldOpenMeteo, () => fetchEnsemble35()),
    metNo: runTimedChannel('metNo', shouldOpenMeteo && mode === 'hybrid', () => fetchMetNo()),
    airQuality: runTimedChannel('airQuality', true, () => fetchAirQuality()),
  };

  // runTimedChannel never rejects, so these trackers are safe to await/race directly
  const settled = {};
  const tracked = CHANNEL_ORDER.map((id) =>
    tasks[id].then((res) => {
      settled[id] = res;
      return res;
    })
  );

  const assembleBundle = (isPartial) => {
    const values = {};
    const channels = {};
    const errors = {};
    let pendingCount = 0;
    for (const id of CHANNEL_ORDER) {
      const res = settled[id];
      if (res) {
        values[id] = res.value;
        channels[id] = res.channel;
        if (res.channel.status === 'error' && res.channel.error) errors[id] = res.channel.error;
      } else {
        pendingCount++;
        values[id] = null;
        channels[id] = {
          id,
          label: CHANNEL_LABELS[id] || id,
          status: 'pending',
          latencyMs: 0,
          error: null,
          detail: 'Загружается…',
        };
      }
    }
    return {
      mode,
      preferredOmModel,
      isPartial,
      pendingCount,
      latencyMs: Math.round(performance.now() - t0),
      fetchedAtIso: new Date().toISOString(),
      google: values.google,
      openMeteoMulti: values.openMeteoMulti,
      openMeteoCompanion: values.openMeteoCompanion,
      previousRuns: values.previousRuns,
      ensemble35: values.ensemble35,
      metNo: values.metNo,
      airQuality: values.airQuality,
      channels,
      errors,
    };
  };

  const allDone = Promise.all(tracked).then(() => 'all');

  if (typeof onPartial === 'function') {
    const coreId = mode === 'google_wn3' ? 'google' : 'openMeteoMulti';
    const coreThenGrace = tasks[coreId].then((res) =>
      res.value
        ? new Promise((resolve) => setTimeout(() => resolve('partial'), Math.max(0, partialGraceMs)))
        : allDone
    );
    const first = await Promise.race([allDone, coreThenGrace]);
    if (first === 'partial' && Object.keys(settled).length < CHANNEL_ORDER.length) {
      try {
        onPartial(assembleBundle(true));
      } catch (_) {
        // A rendering failure on the partial slice must not abort the full refresh
      }
    }
  }

  await allDone;
  const bundle = assembleBundle(false);

  if (mode === 'google_wn3' && hasGoogleKey && !bundle.google) {
    throw new Error(bundle.errors.google || 'Google Weather API недоступен');
  }
  if (
    shouldOpenMeteo &&
    !bundle.openMeteoMulti &&
    !bundle.openMeteoCompanion &&
    !bundle.google
  ) {
    throw new Error(bundle.errors.openMeteoMulti || bundle.errors.openMeteoCompanion || 'Нет связи с метеосерверами');
  }

  return bundle;
}

// ============================================================================
// CUSTOM ARCHIVE RANGE (ERA5-Land 1940+ SEAMLESSLY STITCHED WITH RECENT 14 DAYS)
// ============================================================================
const ARCHIVE_DAILY_VARS = [
  'weather_code',
  'temperature_2m_max',
  'temperature_2m_min',
  'temperature_2m_mean',
  'precipitation_sum',
  'rain_sum',
  'snowfall_sum',
  'wind_speed_10m_max',
  'wind_gusts_10m_max',
  'wind_direction_10m_dominant',
  'shortwave_radiation_sum',
].join(',');

const ARCHIVE_HOURLY_VARS = [
  'temperature_2m',
  'relative_humidity_2m',
  'dew_point_2m',
  'precipitation',
  'snowfall',
  'weather_code',
  'pressure_msl',
  'surface_pressure',
  'cloud_cover',
  'wind_speed_10m',
  'wind_direction_10m',
  'wind_gusts_10m',
  'soil_temperature_0_to_7cm',
  'soil_temperature_7_to_28cm',
  'soil_temperature_28_to_100cm',
  'snow_depth',
].join(',');

const RECENT_HOURLY_VARS = [
  'temperature_2m',
  'relative_humidity_2m',
  'dew_point_2m',
  'precipitation',
  'snowfall',
  'weather_code',
  'pressure_msl',
  'surface_pressure',
  'cloud_cover',
  'wind_speed_10m',
  'wind_direction_10m',
  'wind_gusts_10m',
  'soil_temperature_0cm',
  'soil_temperature_6cm',
  'soil_temperature_18cm',
  'soil_temperature_54cm',
  'snow_depth',
].join(',');

/**
 * Open-Meteo archive / recent-forecast payload -> raw archive day rows.
 * A value the source does not have stays null. Earlier this layer filled gaps with constants
 * (humidity 75 %, pressure 1015 / 985 hPa, wind from 240°, soil 0 °C, "partly cloudy"), and those
 * constants then travelled through the ensemble into charts and tables as if they were data.
 * The only fallbacks kept are other real values of the same day (daily mean / max / dominant).
 */
export function normalizeDailyFromPayload(payload, isRecentForecast = false, minIso = null, maxIso = null) {
  const daily = payload?.daily;
  if (!daily || !Array.isArray(daily.time)) return [];

  const hourly = payload?.hourly;
  const hourlyByDate = new Map();
  if (hourly && Array.isArray(hourly.time)) {
    for (let i = 0; i < hourly.time.length; i++) {
      const tStr = String(hourly.time[i]);
      const isoDate = tStr.slice(0, 10);
      const hour = Number(tStr.slice(11, 13));
      if (!hourlyByDate.has(isoDate)) hourlyByDate.set(isoDate, []);
      hourlyByDate.get(isoDate).push({
        hour,
        tempC: hourly.temperature_2m?.[i] ?? null,
        humidity: hourly.relative_humidity_2m?.[i] ?? null,
        dewPointC: hourly.dew_point_2m?.[i] ?? null,
        precipMm: hourly.precipitation?.[i] ?? null,
        snowfallCm: hourly.snowfall?.[i] ?? null,
        weatherCode: hourly.weather_code?.[i] ?? null,
        pressureMslHpa: hourly.pressure_msl?.[i] ?? null,
        surfacePressureHpa: hourly.surface_pressure?.[i] ?? null,
        cloudCoverPct: hourly.cloud_cover?.[i] ?? null,
        windMs: hourly.wind_speed_10m?.[i] ?? null,
        windDeg: hourly.wind_direction_10m?.[i] ?? null,
        gustMs: hourly.wind_gusts_10m?.[i] ?? null,
        soil0C: isRecentForecast
          ? (hourly.soil_temperature_0cm?.[i] ?? null)
          : (hourly.soil_temperature_0_to_7cm?.[i] ?? null),
        soil6C: isRecentForecast
          ? (hourly.soil_temperature_6cm?.[i] ?? null)
          : (hourly.soil_temperature_0_to_7cm?.[i] ?? null),
        soil18C: isRecentForecast
          ? (hourly.soil_temperature_18cm?.[i] ?? null)
          : (hourly.soil_temperature_7_to_28cm?.[i] ?? null),
        soil54C: isRecentForecast
          ? (hourly.soil_temperature_54cm?.[i] ?? null)
          : (hourly.soil_temperature_28_to_100cm?.[i] ?? null),
        snowDepthM: hourly.snow_depth?.[i] ?? null,
      });
    }
  }

  const results = [];
  for (let i = 0; i < daily.time.length; i++) {
    const isoDate = String(daily.time[i]).slice(0, 10);
    if (minIso && isoDate < minIso) continue;
    if (maxIso && isoDate > maxIso) continue;

    const rawMax = daily.temperature_2m_max?.[i];
    const rawMin = daily.temperature_2m_min?.[i];
    if (rawMax === null || rawMax === undefined || rawMin === null || rawMin === undefined) {
      continue;
    }

    const maxC = round1(Number(rawMax));
    const minC = round1(Number(rawMin));
    const meanC = round1(
      daily.temperature_2m_mean?.[i] !== null && daily.temperature_2m_mean?.[i] !== undefined
        ? Number(daily.temperature_2m_mean[i])
        : (maxC + minC) / 2
    );

    const hRows = hourlyByDate.get(isoDate) || [];
    const snowDepthM = maxFinite(hRows.map((h) => h.snowDepthM));
    const snowDepthCm = snowDepthM !== null ? round1(snowDepthM * 100) : null;
    const humidity = roundOrNull(avgFinite(hRows.map((h) => h.humidity)));
    const dewPointC = round1(avgFinite(hRows.map((h) => h.dewPointC)));
    const cloudCoverPct = roundOrNull(avgFinite(hRows.map((h) => h.cloudCoverPct)));
    const pressureMslHpa = round1(avgFinite(hRows.map((h) => h.pressureMslHpa)));
    const surfacePressureHpa = round1(avgFinite(hRows.map((h) => h.surfacePressureHpa)));
    const soil0C = round1(avgFinite(hRows.map((h) => h.soil0C)));
    const soil6C = round1(avgFinite(hRows.map((h) => h.soil6C)));
    const soil18C = round1(avgFinite(hRows.map((h) => h.soil18C)));
    const soil54C = round1(avgFinite(hRows.map((h) => h.soil54C)));

    const dayWindMs = finiteOrNull(daily.wind_speed_10m_max?.[i]);
    const dayGustMs = finiteOrNull(daily.wind_gusts_10m_max?.[i]);
    const dayWindDeg = finiteOrNull(daily.wind_direction_10m_dominant?.[i]);
    const dayWeatherCode = finiteOrNull(daily.weather_code?.[i]);

    const hourlyRaw = hRows.length === 24
      ? hRows.map((h) => ({
          hour: h.hour,
          tempC: round1(finiteOrNull(h.tempC) ?? meanC),
          precipMm: round2(finiteOrNull(h.precipMm) ?? 0),
          windMs: round1(finiteOrNull(h.windMs) ?? dayWindMs),
          windDeg: roundOrNull(finiteOrNull(h.windDeg) ?? dayWindDeg),
          gustMs: round1(finiteOrNull(h.gustMs) ?? dayGustMs),
          humidity: roundOrNull(h.humidity),
          dewPointC: round1(finiteOrNull(h.dewPointC)),
          cloudCoverPct: roundOrNull(h.cloudCoverPct),
          pressureMslHpa: round1(finiteOrNull(h.pressureMslHpa)),
          surfacePressureHpa: round1(finiteOrNull(h.surfacePressureHpa)),
          soil0C: round1(finiteOrNull(h.soil0C)),
          weatherCode: finiteOrNull(h.weatherCode) ?? dayWeatherCode,
        }))
      : null;

    results.push({
      isoDate,
      zone: 'archive',
      confidencePct: 99,
      maxC,
      minC,
      meanC,
      weatherCode: dayWeatherCode,
      precipMm: round1(Number(daily.precipitation_sum?.[i] ?? 0)),
      rainMm: round1(Number(daily.rain_sum?.[i] ?? 0)),
      snowfallCm: round1(Number(daily.snowfall_sum?.[i] ?? 0)),
      snowDepthCm,
      windMs: round1(dayWindMs),
      gustMs: round1(dayGustMs),
      windDeg: roundOrNull(dayWindDeg),
      shortwaveRadMj: round1(Number(daily.shortwave_radiation_sum?.[i] ?? 0)),
      humidity,
      dewPointC,
      cloudCoverPct,
      pressureMslHpa,
      surfacePressureHpa,
      soil0C,
      soil6C,
      soil18C,
      soil54C,
      hourlyRaw,
    });
  }

  return results;
}

async function fetchEra5Segment(startIso, endIso, includeHourly) {
  const attemptFetch = async (endDateIso, withHourly) => {
    const params = new URLSearchParams({
      latitude: String(ABAN_COORDS.lat),
      longitude: String(ABAN_COORDS.lon),
      elevation: String(ABAN_COORDS.elev),
      timezone: ABAN_COORDS.tz,
      wind_speed_unit: 'ms',
      start_date: startIso,
      end_date: endDateIso,
      daily: ARCHIVE_DAILY_VARS,
    });
    if (withHourly) {
      params.set('hourly', ARCHIVE_HOURLY_VARS);
    }
    return fetchJsonWithTimeout(`https://archive-api.open-meteo.com/v1/archive?${params.toString()}`);
  };

  try {
    return await attemptFetch(endIso, includeHourly);
  } catch (err) {
    if (err.status === 400) {
      // Retry with 2-day earlier cutoff (in case ERA5 lag is >5 days) and/or daily-only
      const saferEnd = addDaysIso(endIso, -2);
      if (saferEnd >= startIso) {
        try {
          return await attemptFetch(saferEnd, includeHourly);
        } catch (_) {
          if (includeHourly) {
            return await attemptFetch(saferEnd, false);
          }
        }
      }
      if (includeHourly) {
        return await attemptFetch(endIso, false);
      }
    }
    throw err;
  }
}

async function fetchRecentArchiveSegment() {
  const params = new URLSearchParams({
    latitude: String(ABAN_COORDS.lat),
    longitude: String(ABAN_COORDS.lon),
    elevation: String(ABAN_COORDS.elev),
    cell_selection: 'land',
    timezone: ABAN_COORDS.tz,
    wind_speed_unit: 'ms',
    models: 'best_match',
    past_days: '14',
    forecast_days: '1',
    daily: ARCHIVE_DAILY_VARS.replace('temperature_2m_mean,', ''),
    hourly: RECENT_HOURLY_VARS,
  });
  return fetchJsonWithTimeout(`https://api.open-meteo.com/v1/forecast?${params.toString()}`);
}

export async function fetchCustomArchiveRange(rawStartIso, rawEndIso) {
  const todayIso = getAbanTodayIso(0);
  let startIso = String(rawStartIso || todayIso).slice(0, 10);
  let endIso = String(rawEndIso || todayIso).slice(0, 10);

  if (startIso > endIso) {
    [startIso, endIso] = [endIso, startIso];
  }
  if (startIso < MIN_ARCHIVE_ISO) startIso = MIN_ARCHIVE_ISO;
  if (endIso > todayIso) endIso = todayIso;
  if (startIso > endIso) startIso = endIso;

  const cacheKey = `${startIso}__${endIso}`;
  const recentWindowStart = getAbanTodayIso(-13);
  const ttlMs = endIso >= recentWindowStart ? RECENT_ARCHIVE_TTL_MS : null;
  const cached = loadArchiveSlice(cacheKey, ttlMs);
  if (cached) {
    return cached;
  }

  const era5SafeEnd = getAbanTodayIso(-5);
  const spanDays = diffDaysIso(startIso, endIso) + 1;
  const includeHourly = spanDays <= 45;

  const needEra5 = startIso <= era5SafeEnd;
  const era5EndIso = endIso <= era5SafeEnd ? endIso : era5SafeEnd;
  const needRecent = endIso > era5SafeEnd || endIso >= recentWindowStart;

  const [era5Res, recentRes] = await Promise.allSettled([
    needEra5 ? fetchEra5Segment(startIso, era5EndIso, includeHourly) : Promise.resolve(null),
    needRecent ? fetchRecentArchiveSegment() : Promise.resolve(null),
  ]);

  if (needEra5 && era5Res.status === 'rejected' && (!needRecent || recentRes.status === 'rejected')) {
    throw era5Res.reason;
  }
  if (!needEra5 && needRecent && recentRes.status === 'rejected') {
    throw recentRes.reason;
  }

  const dayMap = new Map();

  if (era5Res.status === 'fulfilled' && era5Res.value) {
    for (const d of normalizeDailyFromPayload(era5Res.value, false, startIso, endIso)) {
      dayMap.set(d.isoDate, d);
    }
  }

  // Seamlessly stitch recent forecast days (past 14 days) where ERA5 ends or has nulls
  if (recentRes.status === 'fulfilled' && recentRes.value) {
    for (const d of normalizeDailyFromPayload(recentRes.value, true, startIso, endIso)) {
      if (!dayMap.has(d.isoDate)) {
        dayMap.set(d.isoDate, d);
      }
    }
  }

  const days = [...dayMap.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, day]) => day);

  const result = {
    startIso,
    endIso,
    sourceLabel: needEra5 && needRecent
      ? 'ERA5-Land + Оперативный архив (14 дн.)'
      : needEra5
        ? 'Архив ERA5-Land (Open-Meteo)'
        : 'Оперативный архив (14 дн.)',
    days,
  };

  // Cache slice in 5-slot LRU if reasonably sized (<350 KB)
  try {
    const approxSize = JSON.stringify(result).length;
    if (approxSize <= 350000 && days.length > 0) {
      saveArchiveSlice(cacheKey, result);
    }
  } catch (_) {}

  return result;
}
