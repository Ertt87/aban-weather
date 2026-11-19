import { ABAN_COORDS, MODEL_META, TIME_WINDOWS, REFERENCE_DATASET, buildDynamicReferenceDataset } from './config.js';
import { cToF, msToMph, formatSignedC, computeFieldOpsMetrics, toFiniteNumber } from './physics.js';
import {
  buildUnifiedDataset,
  mergeArchiveDaysIntoDataset,
  computeDayWindowStats,
  buildPentadSummary,
} from './ensemble.js';
import {
  loadPrefs,
  savePrefs,
  getApiKey,
  setApiKey,
  saveDatasetCache,
  loadDatasetCache,
  clearDatasetCache,
  getCacheStats,
  exportDatasetJson,
  importDatasetJsonFile,
  saveArchiveSlice,
  loadArchiveSlice,
} from './storage.js';
import {
  fetchAllWeatherSources,
  fetchCustomArchiveRange,
  testGoogleApiKey,
} from './api.js';
import {
  getWeatherSvg,
  renderDiurnalChart,
  renderTempEnsembleChart,
  renderPrecipSnowChart,
  renderWindPressureChart,
  renderSoilProfileChart,
} from './charts.js';

// ============================================================================
// CONSTANTS & APPLICATION STATE
// ============================================================================
const PRECIP_PHASE_LABELS = {
  dry: 'Сухо',
  rain: 'Дождь',
  sleet: 'Мокрый снег',
  freezing_rain: 'Гололёд',
  snow: 'Снег',
};

const ZONE_BADGE_META = {
  archive: { short: 'Арх', label: 'Архив', cls: 'zone-pill--archive' },
  deterministic: { short: 'Точн', label: 'Точный 10д', cls: 'zone-pill--deterministic' },
  extended_ensemble: { short: 'Анс', label: 'Ансамбль 11–16д', cls: 'zone-pill--extended_ensemble' },
  subseasonal: { short: 'Тренд', label: 'Тренд 17–35д', cls: 'zone-pill--subseasonal' },
  // Far-range day that no ensemble covers: the numbers are the 1991–2020 normal, not a forecast
  climatology: { short: 'Норма', label: 'Клим. норма (нет ансамбля)', cls: 'zone-pill--subseasonal' },
};

function isClimatologyOnlyDay(day) {
  return day?.zone === 'subseasonal' && day?.dataQuality?.ensembleBacked === false;
}

function getZoneMeta(day, fallbackKey = 'deterministic') {
  if (isClimatologyOnlyDay(day)) return ZONE_BADGE_META.climatology;
  return ZONE_BADGE_META[day?.zone] || ZONE_BADGE_META[fallbackKey];
}

const SOURCE_MODE_LABELS = {
  hybrid: '⚡ Супер-Ансамбль',
  google_wn3: '🛰️ WeatherNext 3',
  open_meteo: '🌍 Open-Meteo (16д+35д)',
  offline_cache: '💾 Офлайн-кэш',
};

const PRESET_LABELS = {
  archive7_7: 'Архив 7д + 7д',
  '3d': '3 дня',
  '7d': '7 дней',
  '10d': '10 дней',
  '16d': '16 дней',
  '35d': '35 дней',
  weekend: 'Выходные',
  custom: 'Произвольный',
};

const AUTO_REFRESH_MS = 30 * 60 * 1000;
const AUTO_REFRESH_RETRY_MS = 3 * 60 * 1000;
const AUTO_REFRESH_TICK_MS = 5 * 60 * 1000;

let refreshSeq = 0;

const prefs = loadPrefs();

const state = {
  dataset: null,
  fromCache: false,
  isLoading: false,
  isArchiveLoading: false,
  apiKey: getApiKey(),
  unit: prefs.unit || 'metric',
  pressureMode: prefs.pressureMode || 'station',
  sourceMode: prefs.sourceMode || 'hybrid',
  preferredOmModel: prefs.preferredOmModel || 'multi',
  activePreset: prefs.activePreset || '10d',
  timeWindow: prefs.timeWindow || 'full',
  showClimatology: Boolean(prefs.showClimatology),
  showModelLines: Boolean(prefs.showModelLines),
  groupByPentad: Boolean(prefs.groupByPentad),
  filter: 'all',
  activeTab: 'temp',
  dirtyTabs: { temp: true, precip: true, wind: true, ops: true },
  waitingSw: null,
  lastFetchMs: 0,
  lastAttemptMs: 0,
  startIso: null,
  endIso: null,
  selectedDayId: null,
  selectedHourSlot: 12,
  drawerOpenMobile: false,
  radarCollapsed: false,
  radarLoaded: false,
  radarOverlay: 'rain',
};

// ============================================================================
// UTILITY & FORMATTING HELPERS
// ============================================================================
function $(id) {
  return document.getElementById(id);
}

function escapeHtml(val) {
  return String(val ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Coerces a value headed for an HTML template to a finite number. Dataset fields can originate
 * from an imported file or from localStorage, so nothing is interpolated into markup raw.
 */
function num(val, fallback = 0) {
  const n = typeof val === 'number' ? val : Number(val);
  return Number.isFinite(n) ? n : fallback;
}

/** "≈" marks a value that is an estimate (climatology / air-temperature heuristic), not model data. */
function approxMark(isEstimated) {
  return isEstimated ? '≈' : '';
}

function formatSnowCm(cm, isEstimated = false, decimals = 1) {
  return `${approxMark(isEstimated)}${num(cm).toFixed(decimals)}`;
}

function formatSoilCompact(c, isEstimated = false) {
  const txt = formatTempCompact(c);
  return txt === '—' ? txt : `${approxMark(isEstimated)}${txt}`;
}

function getAbanNowParts() {
  try {
    const now = new Date();
    const isoDate = new Intl.DateTimeFormat('en-CA', {
      timeZone: ABAN_COORDS.tz || 'Asia/Krasnoyarsk',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(now);
    const hourStr = new Intl.DateTimeFormat('en-GB', {
      timeZone: ABAN_COORDS.tz || 'Asia/Krasnoyarsk',
      hour: '2-digit',
      hour12: false,
    }).format(now);
    return { isoDate, hour: Math.min(23, Math.max(0, Number(hourStr) || 12)) };
  } catch (_) {
    const d = new Date(Date.now() + 7 * 3600000);
    return { isoDate: d.toISOString().slice(0, 10), hour: d.getUTCHours() };
  }
}

function addDaysIso(isoDate, deltaDays) {
  const [y, m, d] = String(isoDate).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + deltaDays)).toISOString().slice(0, 10);
}

/**
 * Imperial value for display: the precomputed override when one exists, otherwise converted.
 * The override must go through toFiniteNumber — `Number(null)` is 0, and treating a missing
 * override as "0°F" / "0 mph" is exactly the bug this guards against.
 */
function resolveImperial(override, convert, metricValue) {
  const fromOverride = toFiniteNumber(override);
  return fromOverride !== null ? Math.round(fromOverride) : convert(metricValue);
}

function formatTemp(c, fOverride = null, withDual = true) {
  const numC = toFiniteNumber(c);
  if (numC === null) return '—';
  const numF = resolveImperial(fOverride, cToF, numC);
  if (state.unit === 'imperial') return `${numF}°F`;
  const strC = formatSignedC(numC);
  if (state.unit === 'dual' && withDual) return `${strC} (${numF}°F)`;
  return strC;
}

function formatTempCompact(c, fOverride = null) {
  const numC = toFiniteNumber(c);
  if (numC === null) return '—';
  if (state.unit === 'imperial') return `${resolveImperial(fOverride, cToF, numC)}°`;
  return formatSignedC(numC).replace(/°C$/, '°');
}

function formatTempSecondary(c, fOverride = null) {
  const numC = toFiniteNumber(c);
  if (numC === null) return '';
  if (state.unit === 'imperial') return formatSignedC(numC);
  if (state.unit === 'dual') return '';
  return `${resolveImperial(fOverride, cToF, numC)}°F`;
}

function formatWind(ms, mphOverride = null) {
  const numMs = toFiniteNumber(ms);
  if (numMs === null) return '—';
  if (state.unit === 'imperial') return `${resolveImperial(mphOverride, msToMph, numMs)} mph`;
  return `${numMs.toFixed(1)} м/с`;
}

function formatSignedInt(val, unit = 'мм') {
  const n = toFiniteNumber(val);
  if (n === null) return '—';
  const r = Math.round(n);
  return `${r > 0 ? '+' : ''}${r} ${unit}`;
}

/**
 * Pressure for the active reference (station 246 m / sea level). `has` is false when the record
 * carries no pressure at all (far-range trend days, daily-only archive): callers then print «—»
 * instead of a plausible-looking default.
 */
function getPressurePair(obj) {
  const isMsl = state.pressureMode === 'msl';
  const mm = toFiniteNumber(
    isMsl
      ? obj?.pressureMslMm ?? obj?.pressureStationMm ?? obj?.pressureMm
      : obj?.pressureStationMm ?? obj?.pressureMm ?? obj?.pressureMslMm
  );
  const hpa = toFiniteNumber(
    isMsl
      ? obj?.pressureMslHpa ?? obj?.pressureStationHpa ?? obj?.pressureHpa
      : obj?.pressureStationHpa ?? obj?.pressureHpa ?? obj?.pressureMslHpa
  );
  return {
    mm,
    hpa,
    has: mm !== null,
    label: isMsl ? 'Ур. моря' : '246м',
    mmText: mm !== null ? `${Math.round(mm)} мм` : '—',
    hpaText: hpa !== null ? `${Math.round(hpa)} гПа` : '—',
  };
}

function markAllAnalyticsTabsDirty() {
  state.dirtyTabs.temp = true;
  state.dirtyTabs.precip = true;
  state.dirtyTabs.wind = true;
  state.dirtyTabs.ops = true;
}

function showToast(message) {
  const container = $('toastContainer');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = 'toast-item';
  toast.innerHTML = `<span class="status-dot text-sky-400"></span><span>${escapeHtml(message)}</span>`;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 3400);
}

// ============================================================================
// DATASET & DATE RANGE RESOLUTION
// ============================================================================
function getAllDays() {
  return Array.isArray(state.dataset?.days) ? state.dataset.days : [];
}

function getTodayDay() {
  const days = getAllDays();
  if (!days.length) return null;
  return days.find((d) => d.offsetFromToday === 0) || days.find((d) => !d.isArchive) || days[0];
}

function getSelectedPeriodDays() {
  const days = getAllDays();
  if (!days.length) return [];
  const start = state.startIso || days[0].isoDate;
  const end = state.endIso || days[days.length - 1].isoDate;
  const sliced = days.filter((d) => d.isoDate >= start && d.isoDate <= end);
  return sliced.length ? sliced : [getTodayDay() || days[0]];
}

function ensureSelectionConsistency() {
  const days = getAllDays();
  if (!days.length) return;
  const minIso = days[0].isoDate;
  const maxIso = days[days.length - 1].isoDate;

  if (!state.startIso || !state.endIso) {
    applyPeriodPreset(state.activePreset, { silent: true });
    return;
  }

  if (state.startIso < minIso) state.startIso = minIso;
  if (state.endIso > maxIso) state.endIso = maxIso;
  if (state.startIso > state.endIso) state.startIso = state.endIso;

  const periodDays = getSelectedPeriodDays();
  if (periodDays.length && !periodDays.some((d) => d.id === state.selectedDayId)) {
    const todayInRange = periodDays.find((d) => d.offsetFromToday === 0);
    state.selectedDayId = (todayInRange || periodDays[0]).id;
  }
}

function findNearestWeekendIsoRange() {
  const days = getAllDays().filter((d) => !d.isArchive);
  const weekends = days.filter((d) => d.dayShort === 'Сб' || d.dayShort === 'Вс');
  if (weekends.length >= 2) {
    for (let i = 0; i < weekends.length - 1; i++) {
      if (weekends[i].dayShort === 'Сб' && weekends[i + 1].dayShort === 'Вс') {
        return [weekends[i].isoDate, weekends[i + 1].isoDate];
      }
    }
    return [weekends[0].isoDate, weekends[0].isoDate];
  }
  if (weekends.length === 1) return [weekends[0].isoDate, weekends[0].isoDate];
  const fallbackStart = days[0]?.isoDate || getAllDays()[0]?.isoDate;
  const fallbackEnd = days[Math.min(1, days.length - 1)]?.isoDate || fallbackStart;
  return [fallbackStart, fallbackEnd];
}

function applyPeriodPreset(presetKey, { silent = false } = {}) {
  const days = getAllDays();
  if (!days.length) return;

  const today = getTodayDay() || days[0];
  const firstIso = days[0].isoDate;
  const lastIso = days[days.length - 1].isoDate;

  const clampIso = (target) => {
    if (target < firstIso) return firstIso;
    if (target > lastIso) return lastIso;
    return target;
  };

  let sIso = today.isoDate;
  let eIso = clampIso(addDaysIso(today.isoDate, 9));

  if (presetKey === 'archive7_7') {
    sIso = clampIso(addDaysIso(today.isoDate, -7));
    eIso = clampIso(addDaysIso(today.isoDate, 6));
  } else if (presetKey === '3d') {
    sIso = today.isoDate;
    eIso = clampIso(addDaysIso(today.isoDate, 2));
  } else if (presetKey === '7d') {
    sIso = today.isoDate;
    eIso = clampIso(addDaysIso(today.isoDate, 6));
  } else if (presetKey === '10d') {
    sIso = today.isoDate;
    eIso = clampIso(addDaysIso(today.isoDate, 9));
  } else if (presetKey === '16d') {
    sIso = today.isoDate;
    eIso = clampIso(addDaysIso(today.isoDate, 15));
  } else if (presetKey === '35d') {
    sIso = today.isoDate;
    eIso = clampIso(addDaysIso(today.isoDate, 34));
  } else if (presetKey === 'weekend') {
    [sIso, eIso] = findNearestWeekendIsoRange();
  }

  state.activePreset = presetKey;
  state.startIso = sIso;
  state.endIso = eIso;
  savePrefs({ activePreset: presetKey });
  ensureSelectionConsistency();
  if (!silent) updateAllViews();
}

// ============================================================================
// ARBITRARY DATE RANGE + LAZY ERA5 ARCHIVE FETCH (1940-01-01 .. +35d)
// ============================================================================
function hasMissingArchiveDates(startIso, endIso, todayIso) {
  const cappedEnd = endIso < todayIso ? endIso : todayIso;
  if (startIso > cappedEnd) return false;
  const loadedSet = new Set(getAllDays().map((d) => d.isoDate));
  let cur = startIso;
  let guard = 0;
  while (cur <= cappedEnd && guard < 400) {
    if (!loadedSet.has(cur)) return true;
    cur = addDaysIso(cur, 1);
    guard++;
  }
  return false;
}

async function handleCustomDateRangeChange(changedSide) {
  const startInput = $('inputStartDate');
  const endInput = $('inputEndDate');
  const hint = $('archiveLoadHint');
  if (!startInput || !endInput) return;

  let startIso = startInput.value || state.startIso;
  let endIso = endInput.value || state.endIso;
  if (!startIso || !endIso) return;

  if (startIso < '1940-01-01') startIso = '1940-01-01';
  const days = getAllDays();
  const todayIso = getTodayDay()?.isoDate || getAbanNowParts().isoDate;
  const maxAllowedIso = days[days.length - 1]?.isoDate || addDaysIso(todayIso, 34);
  if (endIso > maxAllowedIso) endIso = maxAllowedIso;

  // When user picks a historical archive start date while end date is still in the forecast horizon,
  // auto-frame a crisp 14-day historical window (which the user can freely widen via "По дату").
  if (changedSide === 'start' && endIso >= todayIso && startIso < addDaysIso(todayIso, -45)) {
    const candidateEnd = addDaysIso(startIso, 13);
    endIso = candidateEnd < todayIso ? candidateEnd : addDaysIso(todayIso, -1);
    if (hint) {
      hint.textContent = 'Выбран архив 14 дн. (можно изменить «По дату»)';
      hint.className = 'text-[11px] font-mono text-sky-300';
    }
  }

  if (startIso > endIso) {
    if (changedSide === 'start') endIso = startIso;
    else startIso = endIso;
    if (hint) {
      hint.textContent = 'Диапазон скорректирован («С» ≤ «По»)';
      hint.className = 'text-[11px] font-mono text-amber-300';
    }
  }

  startInput.value = startIso;
  endInput.value = endIso;

  if (startIso < todayIso && hasMissingArchiveDates(startIso, endIso, todayIso)) {
    const fetchEnd = endIso < todayIso ? endIso : addDaysIso(todayIso, -1);
    const sliceKey = `${startIso}__${fetchEnd}`;
    const recentCutoff = addDaysIso(todayIso, -13);
    const ttlMs = fetchEnd >= recentCutoff ? 30 * 60 * 1000 : null;

    let archiveResult = loadArchiveSlice(sliceKey, ttlMs);
    if (!archiveResult) {
      state.isArchiveLoading = true;
      if (hint) {
        hint.textContent = `⏳ Загрузка архива ERA5 (${startIso} .. ${fetchEnd})...`;
        hint.className = 'text-[11px] font-mono text-sky-300';
      }
      try {
        archiveResult = await fetchCustomArchiveRange(startIso, fetchEnd);
        if (archiveResult?.days?.length) {
          try {
            if (JSON.stringify(archiveResult).length <= 350000) {
              saveArchiveSlice(sliceKey, archiveResult);
            }
          } catch (_) {}
        }
      } catch (err) {
        state.isArchiveLoading = false;
        if (hint) {
          hint.textContent = `❌ Ошибка архива: ${err?.message || 'нет связи'}`;
          hint.className = 'text-[11px] font-mono text-rose-300';
        }
        showToast(`Не удалось загрузить архив ERA5: ${err?.message || 'офлайн'}`);
        return;
      }
      state.isArchiveLoading = false;
    }

    if (archiveResult?.days?.length) {
      state.dataset = mergeArchiveDaysIntoDataset(state.dataset, archiveResult);
      if (hint) {
        hint.textContent = `✅ Загружено суток архива: ${archiveResult.days.length}`;
        hint.className = 'text-[11px] font-mono text-emerald-300';
      }
      showToast(`Архив ERA5-Land: добавлено ${archiveResult.days.length} сут.`);
    }
  } else if (hint) {
    hint.textContent = 'ERA5-Land + Прогноз';
    hint.className = 'text-[11px] font-mono text-slate-400';
  }

  state.activePreset = 'custom';
  state.startIso = startIso;
  state.endIso = endIso;
  state.selectedDayId = `day_${startIso}`;
  ensureSelectionConsistency();
  updateAllViews();
}

// ============================================================================
// NETWORK REFRESH & SOURCE SWITCHING
// ============================================================================
function setLoadingState(loading) {
  state.isLoading = loading;
  const btn = $('refreshDataBtn');
  const icon = $('refreshSpinnerIcon');
  if (btn) btn.disabled = loading;
  if (icon) icon.classList.toggle('animate-spin-fast', loading);
  renderHeader();
}

async function refreshWeatherData(showNotice = true) {
  if (state.sourceMode === 'offline_cache') {
    const cached = loadDatasetCache();
    if (cached) {
      state.dataset = cached;
      state.fromCache = true;
      ensureSelectionConsistency();
      updateAllViews();
      if (showNotice) showToast('Загружен локальный офлайн-кэш');
    } else {
      state.dataset = buildDynamicReferenceDataset();
      state.fromCache = false;
      applyPeriodPreset('10d', { silent: true });
      updateAllViews();
      if (showNotice) showToast('Кэш пуст — показан сезонный эталон п. Абан');
    }
    return;
  }

  if (state.sourceMode === 'google_wn3' && (!state.apiKey || state.apiKey.length <= 10)) {
    if (showNotice) {
      showToast('Для режима WeatherNext 3 введите ключ Google API в настройках');
      openSettingsModal();
    }
    return;
  }

  // Only the newest refresh may touch the UI: a source/mode switch mid-flight starts a new one
  const seq = ++refreshSeq;
  state.lastAttemptMs = Date.now();
  setLoadingState(true);

  // Applied twice at most: once for the fast partial slice (core forecast in ~1–2 s),
  // then for the complete bundle when the slow channels (soil / snow, 35-day ensemble) land.
  const applyBundle = (rawBundle) => {
    if (seq !== refreshSeq) return null;

    const prevDays = getAllDays().filter((d) => d.isArchive);
    const baseUnified = buildUnifiedDataset(rawBundle, {
      mosCache: state.dataset?.mos?.bestModelId ? state.dataset.mos : null,
    });
    if (!baseUnified.days.length) {
      if (rawBundle.isPartial) return null;
      throw new Error('метеосерверы вернули пустой прогноз');
    }

    // Preserve any lazily loaded custom historical archive slices (older than 14d past_days)
    const earliestNewIso = baseUnified.days[0]?.isoDate;
    const customOlderArchive = earliestNewIso
      ? prevDays.filter((d) => d.isoDate < earliestNewIso)
      : [];
    const unified = customOlderArchive.length
      ? mergeArchiveDaysIntoDataset(baseUnified, customOlderArchive)
      : baseUnified;

    state.dataset = unified;
    state.fromCache = false;
    if (!rawBundle.isPartial) {
      // Persist the forecast slice only: custom archive ranges already live in the 5-slot LRU,
      // and multi-year ranges would blow the localStorage quota.
      saveDatasetCache(baseUnified);
      state.lastFetchMs = Date.now();
    }

    if (state.activePreset !== 'custom') {
      applyPeriodPreset(state.activePreset, { silent: true });
    } else {
      ensureSelectionConsistency();
    }
    updateAllViews();
    return unified;
  };

  try {
    const rawBundle = await fetchAllWeatherSources({
      apiKey: state.apiKey,
      mode: state.sourceMode,
      preferredOmModel: state.preferredOmModel,
      forceRefresh: showNotice,
      onPartial: applyBundle,
    });

    const unified = applyBundle(rawBundle);
    if (unified && showNotice) {
      showToast(`Обновлено: ${unified.sourceLabel} (${unified.latencyMs} мс)`);
    }
  } catch (err) {
    if (seq !== refreshSeq) return;
    const hasLiveData = Boolean(state.dataset?.days?.length) && state.dataset.sourceType !== 'reference_wn3';
    const cached = hasLiveData ? null : loadDatasetCache();
    if (cached) {
      state.dataset = cached;
      state.fromCache = true;
      ensureSelectionConsistency();
      updateAllViews();
    }
    if (showNotice) {
      showToast(`Ошибка сети (${err?.message || 'таймаут'}) — активен кэш`);
    }
  } finally {
    if (seq === refreshSeq) setLoadingState(false);
  }
}

/**
 * Keeps an open dashboard (or a PWA resumed from the background) from silently showing
 * hours-old numbers: refresh when the tab becomes visible / the network returns / on a timer.
 */
function maybeAutoRefresh() {
  if (state.sourceMode === 'offline_cache' || state.isLoading) return;
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
  const now = Date.now();
  if (now - state.lastFetchMs < AUTO_REFRESH_MS) return;
  if (now - state.lastAttemptMs < AUTO_REFRESH_RETRY_MS) return;
  refreshWeatherData(false);
}

function setDataSourceMode(mode) {
  state.sourceMode = mode;
  savePrefs({ sourceMode: mode });
  renderFiltersAndKpis();
  refreshWeatherData(true);
}

// ============================================================================
// RENDERING: HEADER & SECTION 1 (CURRENT + CONTROL MILESTONE)
// ============================================================================
function renderHeader() {
  const ds = state.dataset || REFERENCE_DATASET;
  const pill = $('liveStatusPill');
  const dot = $('liveStatusDot');
  const text = $('liveStatusText');

  let pillCls = 'status-pill status-pill--reference';
  let pillLabel = 'ЭТАЛОН';
  let pulse = false;

  if (state.isLoading) {
    pillCls = 'status-pill status-pill--ensemble';
    pillLabel = 'ОБНОВЛ...';
    pulse = true;
  } else if (ds.sourceType === 'reference_wn3') {
    pillCls = 'status-pill status-pill--reference';
    pillLabel = 'ЭТАЛОН';
  } else if (state.fromCache || state.sourceMode === 'offline_cache') {
    pillCls = 'status-pill status-pill--cache';
    pillLabel = 'КЭШ';
  } else if (ds.sourceType === 'live_super_ensemble' || ds.sourceType === 'live_multi_ensemble' || (ds.activeModels?.length || 0) > 1) {
    pillCls = 'status-pill status-pill--ensemble';
    pillLabel = 'АНСАМБЛЬ';
    pulse = true;
  } else {
    pillCls = 'status-pill status-pill--live';
    pillLabel = 'LIVE';
    pulse = true;
  }

  if (pill) pill.className = pillCls;
  if (text) text.textContent = pillLabel;
  if (dot) dot.className = pulse ? 'status-dot status-dot--pulse' : 'status-dot';

  const mosBestId = ds.mos?.bestModelId;
  const mosTextEl = $('mosStatusText');
  if (mosTextEl) {
    if (mosBestId && ds.mos?.models?.[mosBestId]) {
      const mShort = MODEL_META[mosBestId]?.shortName || mosBestId;
      // No "±": this MAE is measured against the model's own analysis, not station observations
      mosTextEl.textContent = `MOS: ${mShort} • MAE ${num(ds.mos.models[mosBestId].maeC).toFixed(1)}°`;
    } else {
      mosTextEl.textContent = 'MOS: веса моделей';
    }
  }

  const channelList = Object.values(ds.channels || {});
  const problemCount = channelList.filter((ch) => ch?.status === 'error' || ch?.status === 'partial').length;
  const pendingCount = channelList.filter((ch) => ch?.status === 'pending').length;
  const syncEl = $('syncTimestampText');
  if (syncEl) {
    const lat = ds.latencyMs ? ` • ${num(ds.latencyMs)} мс` : '';
    const pendTag = pendingCount > 0 ? ` • ⏳ ещё ${pendingCount} канал.` : '';
    const errTag = problemCount > 0 ? ` • ⚠️ ${problemCount} канал.` : '';
    syncEl.textContent = `Синхр.: ${ds.syncedAt || '—'}${lat}${pendTag}${errTag}`;
  }

  const pressBtnText = $('pressureToggleText');
  if (pressBtnText) {
    pressBtnText.textContent = state.pressureMode === 'msl' ? 'Ур. моря' : '246м Абан';
  }

  // Unit toggle buttons (header & modal)
  const unitPairs = [
    ['metric', 'btnUnitMetric', 'modalUnitMetric'],
    ['imperial', 'btnUnitImperial', 'modalUnitImperial'],
    ['dual', 'btnUnitDual', 'modalUnitDual'],
  ];
  for (const [key, hId, mId] of unitPairs) {
    const hBtn = $(hId);
    const mBtn = $(mId);
    if (hBtn) hBtn.classList.toggle('is-active', state.unit === key);
    if (mBtn) {
      mBtn.className =
        state.unit === key
          ? 'btn-action btn-action--solid font-mono'
          : 'btn-action font-mono';
    }
  }
}

function renderCurrentConditions() {
  const ds = state.dataset || REFERENCE_DATASET;
  const cur = ds.current || REFERENCE_DATASET.current;
  const cp = ds.controlPoint || REFERENCE_DATASET.controlPoint;
  const aq = ds.airQuality || REFERENCE_DATASET.airQuality;
  const today = getTodayDay();

  $('currentObsTimeBadge').textContent = cur.obsTimeLabel || 'UTC+7 • Абан';
  $('currentWeatherIcon').innerHTML = getWeatherSvg(cur.iconType || 'sunny', 'w-14 h-14');

  $('currentTempDisplay').textContent = formatTemp(cur.tempC, cur.tempF, state.unit === 'dual');
  $('currentTempSecondary').textContent = state.unit === 'dual' ? '' : `(${formatTempSecondary(cur.tempC, cur.tempF)})`;
  $('currentCondText').textContent = cur.condRu || '—';
  $('currentFeelsDisplay').textContent = formatTemp(cur.feelsC, cur.feelsF, true);
  $('currentWetBulbDisplay').textContent = formatTemp(cur.wetBulbC, null, false);

  $('currentWindDirTag').textContent =
    toFiniteNumber(cur.windDeg) !== null ? `${Math.round(cur.windDeg)}° ${cur.windDirShort || '—'}` : '—';
  $('currentWindDisplay').textContent = formatWind(cur.windMs, cur.windMph);
  $('currentGustSub').textContent = `Порывы ${formatWind(cur.gustMs, cur.gustMph)}`;

  const phaseRu = PRECIP_PHASE_LABELS[cur.precipPhase] || cur.precipPhase || 'Сухо';
  $('currentPrecipPhaseTag').textContent = phaseRu;
  $('currentPrecipProbDisplay').textContent = `${cur.precipProb ?? 0}% • ${Number(cur.precipMm ?? 0).toFixed(1)} мм`;
  $('currentSnowDepthDisplay').textContent = cur.snowEstimated
    ? `Покров: ${formatSnowCm(cur.snowDepthCm, true)} см (норма)`
    : `Покров: ${formatSnowCm(cur.snowDepthCm)} см`;

  $('currentHumidityDisplay').textContent = `${cur.humidity ?? 0}%`;
  $('currentHumidityBar').style.width = `${Math.min(100, Math.max(0, Number(cur.humidity ?? 0)))}%`;
  $('currentDewPointDisplay').textContent = `Td: ${formatTempCompact(cur.dewPointC)}`;
  $('currentCloudDisplay').textContent = `Облачность: ${cur.cloudCoverPct ?? 0}%`;

  const pPair = getPressurePair(cur);
  $('currentPressureRefLabel').textContent = `Давление (${pPair.label})`;
  $('currentPressureDisplay').textContent = pPair.has ? `${pPair.mmText} (${pPair.hpaText})` : '— (нет данных)';
  $('currentUvTag').textContent = `УФ: ${cur.uv ?? 0}`;

  const dp3 = toFiniteNumber(cur.deltaP3hMm);
  const dp24 = toFiniteNumber(cur.deltaP24hMm);
  const dpEl = $('currentDeltaPBadge');
  dpEl.textContent = `ΔP3ч: ${formatSignedInt(dp3)} • ΔP24ч: ${formatSignedInt(dp24)}`;
  dpEl.className =
    Math.abs(dp24 ?? 0) >= 6 || Math.abs(dp3 ?? 0) >= 3
      ? 'metric-box__sub text-rose-400 font-bold'
      : 'metric-box__sub text-slate-400';

  // 4-layer soil preview
  const soilEst = Boolean(cur.soilEstimated);
  $('currentSoil0').textContent = formatSoilCompact(cur.soil0C, soilEst);
  $('currentSoil6').textContent = formatSoilCompact(cur.soil6C, soilEst);
  $('currentSoil18').textContent = formatSoilCompact(cur.soil18C, soilEst);
  $('currentSoil54').textContent = formatSoilCompact(cur.soil54C, soilEst);

  // Honesty note: say out loud when soil / snow are estimates rather than model output
  const qualityEl = $('currentDataQualityNote');
  if (qualityEl) {
    const companionStatus = ds.channels?.openMeteoCompanion?.status;
    const parts = [];
    if (soilEst) parts.push('почва — оценка по воздуху');
    if (cur.snowEstimated) parts.push('снег — клим. норма');
    if (parts.length) {
      const reason =
        companionStatus === 'pending'
          ? 'канал почвы/снега ещё загружается'
          : companionStatus === 'error'
          ? 'канал почвы/снега недоступен'
          : 'нет данных модели';
      qualityEl.textContent = `≈ ${parts.join(', ')} (${reason})`;
      qualityEl.classList.remove('hidden');
    } else {
      qualityEl.textContent = '';
      qualityEl.classList.add('hidden');
    }
  }

  // Air quality badge
  const aqiEl = $('currentAqiBadge');
  const aqiVal = aq?.aqi !== null && aq?.aqi !== undefined ? aq.aqi : '—';
  const pmVal = aq?.pm25 !== null && aq?.pm25 !== undefined ? `${aq.pm25} мкг` : '—';
  aqiEl.textContent = `AQI ${aqiVal} • PM2.5 ${pmVal} (${aq?.statusRu || 'н/д'})`;
  aqiEl.className =
    aq?.smogRisk === 'high'
      ? 'font-bold text-rose-400'
      : aq?.smogRisk === 'moderate'
      ? 'font-bold text-amber-300'
      : 'font-bold text-emerald-300';

  // Astronomy (Sunrise/Sunset/Daylight)
  if (today?.astronomy) {
    $('currentAstroText').textContent = `${today.astronomy.sunriseStr}–${today.astronomy.sunsetStr} (${today.astronomy.daylightHours} ч)`;
  } else {
    $('currentAstroText').textContent = '—';
  }

  // Dynamic Control Milestone (+3h & nearest 08:00/20:00 shift anchor)
  $('controlTargetBadge').textContent = cp.targetLabel || 'Смена';
  $('controlCondBadge').textContent = cp.badgeRu || '—';
  $('controlIcon').innerHTML = getWeatherSvg(cp.iconType || 'partly-sunny', 'w-9 h-9');
  $('controlTemp').textContent = formatTemp(cp.tempC, cp.tempF, state.unit === 'dual');
  $('controlFeels').textContent = `Ощущ. ${formatTemp(cp.feelsC)}`;
  $('controlCondDesc').textContent = cp.condRu || '—';
  $('controlPrecip').textContent = `${cp.precipProb ?? 0}%`;
  $('controlWind').textContent = `${formatWind(cp.windMs, cp.windMph)} ${cp.windDirShort || ''}`;
  $('controlSoil0').textContent = formatSoilCompact(cp.soil0C, soilEst);

  $('controlNext3hLabel').textContent = cp.next3hLabel || 'Через 3 ч';
  $('controlNext3hTemp').textContent = formatTemp(cp.next3hTempC, null, state.unit === 'dual');
  const diff3h = Number.isFinite(cp.next3hTempC) && Number.isFinite(cur.tempC) ? cp.next3hTempC - cur.tempC : 0;
  $('controlNext3hDetails').textContent =
    Math.abs(diff3h) < 0.3 ? 'Без резкого сдвига' : `Тренд ${diff3h > 0 ? '+' : ''}${diff3h.toFixed(1)}°C`;

  // Today extremes
  if (today) {
    $('todayExtremesLabel').textContent = `Сегодня (${today.dateStr}):`;
    $('todayMinBadge').textContent = formatTemp(today.minC, today.minF);
    $('todayMaxBadge').textContent = formatTemp(today.maxC, today.maxF);
  }
}

// ============================================================================
// RENDERING: SECTION 1.5 (FILTERS, TIMELINE STRIP & PERIOD KPIs)
// ============================================================================
function renderFiltersAndKpis() {
  const allDays = getAllDays();
  const periodDays = getSelectedPeriodDays();
  const firstDay = periodDays[0];
  const lastDay = periodDays[periodDays.length - 1];
  const count = periodDays.length;

  // Source mode buttons
  $('activeSourceBadge').textContent = state.dataset?.sourceLabel || SOURCE_MODE_LABELS[state.sourceMode];
  const hasKey = Boolean(state.apiKey && state.apiKey.length > 10);
  $('wn3ModeSubTag').textContent = hasKey ? '10д / 240ч LIVE' : 'Нужен ключ API';
  ['hybrid', 'google_wn3', 'open_meteo', 'offline_cache'].forEach((m) => {
    const btn = $(`srcBtn-${m}`);
    if (btn) btn.classList.toggle('source-btn-active', state.sourceMode === m);
  });

  // Horizon preset buttons
  $('activePresetBadge').textContent = PRESET_LABELS[state.activePreset] || `${count} дн.`;
  ['archive7_7', '3d', '7d', '10d', '16d', '35d', 'weekend'].forEach((p) => {
    const btn = $(`presetBtn-${p}`);
    if (btn) btn.classList.toggle('preset-btn-active', state.activePreset === p);
  });

  // Arbitrary Date Range Inputs
  const maxIso = allDays[allDays.length - 1]?.isoDate || addDaysIso(getAbanNowParts().isoDate, 34);
  const startInput = $('inputStartDate');
  const endInput = $('inputEndDate');
  if (startInput && endInput) {
    startInput.max = maxIso;
    endInput.max = maxIso;
    if (state.startIso) startInput.value = state.startIso;
    if (state.endIso) endInput.value = state.endIso;
  }

  // Pentad toggle (>14 days)
  const showPentadOption = count > 14;
  $('pentadToggleWrap')?.classList.toggle('hidden', !showPentadOption);
  $('stripPentadToggleBtn')?.classList.toggle('hidden', !showPentadOption);
  $('tableViewModeToggle')?.classList.toggle('hidden', !showPentadOption);

  if (showPentadOption) {
    $('btnGroupByPentad')?.classList.toggle('is-active', state.groupByPentad);
    $('pentadToggleLabel').textContent = state.groupByPentad ? 'Режим: По 5-дневкам' : 'Режим: По суткам';
    $('stripPentadToggleBtn')?.classList.toggle('is-active', state.groupByPentad);
    $('stripPentadToggleBtn').textContent = state.groupByPentad ? 'Показать по суткам' : 'По 5-дневкам';
    $('tableViewModeToggle')?.classList.toggle('is-active', state.groupByPentad);
    $('tableViewModeToggle').textContent = state.groupByPentad ? 'Таблица: По 5-дневкам' : 'Таблица: По суткам';
  }

  // Horizontally scrollable color-coded confidence timeline strip
  const track = $('confidenceTimelineTrack');
  if (track) {
    track.innerHTML = allDays
      .map((d) => {
        const inRange = d.isoDate >= state.startIso && d.isoDate <= state.endIso;
        const isEdge = d.isoDate === state.startIso || d.isoDate === state.endIso;
        const isSelected = d.id === state.selectedDayId;
        const dayPart = d.dateStr ? d.dateStr.split(' ')[0] : d.isoDate.slice(8);
        return `<button type="button" data-timeline-iso="${escapeHtml(d.isoDate)}" class="timeline-node timeline-node--${escapeHtml(d.zone || 'deterministic')} ${inRange ? 'in-range' : ''} ${isEdge ? 'is-edge' : ''} ${isSelected ? 'is-selected' : ''}" title="${escapeHtml(d.fullDateLabel || d.isoDate)} • ${num(d.confidencePct, 80)}%">
          <div class="font-bold">${escapeHtml(dayPart)}</div>
          <div style="font-size:9px;opacity:0.85">${escapeHtml(d.dayShort || '')}</div>
        </button>`;
      })
      .join('');
  }

  // Time-of-day window buttons
  const winCfg = TIME_WINDOWS[state.timeWindow] || TIME_WINDOWS.full;
  $('activeTimeWindowBadge').textContent = winCfg.label;
  ['full', 'day_shift', 'daylight', 'night'].forEach((w) => {
    const btn = $(`windowBtn-${w}`);
    if (btn) btn.classList.toggle('window-btn-active', state.timeWindow === w);
  });

  const activeDay = periodDays.find((d) => d.id === state.selectedDayId) || firstDay;
  if (activeDay?.astronomy) {
    $('windowDaylightSpanHint').textContent = `${activeDay.astronomy.sunriseStr}–${activeDay.astronomy.sunsetStr}`;
  }
  const sampleWinStats = activeDay ? computeDayWindowStats(activeDay, state.timeWindow) : { activeHours: [] };
  $('windowHoursCount').textContent = `${sampleWinStats.activeHours.length}/24 ч`;

  // Compute KPI summaries across periodDays
  if (!periodDays.length) return;
  let maxDayObj = periodDays[0];
  let minDayObj = periodDays[0];
  let maxWindObj = periodDays[0];
  let sumMaxC = 0;
  let sumMinC = 0;
  let sumWinC = 0;
  let sumAnom = 0;
  let anomCount = 0;
  let sumPrecipMm = 0;
  let maxSnowCm = 0;
  let maxSnowEstimated = false;
  let dryDays = 0;

  let minP10 = Infinity;
  let maxP90 = -Infinity;
  let hasQuantiles = false;

  for (const d of periodDays) {
    if (d.maxC > maxDayObj.maxC) maxDayObj = d;
    if (d.minC < minDayObj.minC) minDayObj = d;
    if ((d.gustMs ?? d.windMs) > (maxWindObj.gustMs ?? maxWindObj.windMs)) maxWindObj = d;
    sumMaxC += d.maxC;
    sumMinC += d.minC;
    sumWinC += computeDayWindowStats(d, state.timeWindow).avgC;

    if (Number.isFinite(d.climAnomalyC)) {
      sumAnom += d.climAnomalyC;
      anomCount++;
    } else if (Number.isFinite(d.climMaxC) && Number.isFinite(d.climMinC)) {
      sumAnom += (d.maxC + d.minC) / 2 - (d.climMaxC + d.climMinC) / 2;
      anomCount++;
    }

    sumPrecipMm += num(d.precipMm);
    if (num(d.snowDepthCm) > maxSnowCm) {
      maxSnowCm = num(d.snowDepthCm);
      maxSnowEstimated = Boolean(d.dataQuality?.snowEstimated);
    }
    if ((d.precipDay ?? 0) < 15 && (d.precipNight ?? 0) < 15 && (d.precipMm ?? 0) < 0.5) {
      dryDays++;
    }

    if (Number.isFinite(d.minP10C) && Number.isFinite(d.maxP90C)) {
      hasQuantiles = true;
      if (d.minP10C < minP10) minP10 = d.minP10C;
      if (d.maxP90C > maxP90) maxP90 = d.maxP90C;
    }
  }

  const avgMaxC = +(sumMaxC / count).toFixed(1);
  const avgMinC = +(sumMinC / count).toFixed(1);
  const avgWinC = +(sumWinC / count).toFixed(1);
  const avgAnomC = anomCount ? +(sumAnom / anomCount).toFixed(1) : null;

  const zoneNames = [...new Set(periodDays.map((d) => ZONE_BADGE_META[d.zone]?.label || d.zone))];

  // Drawer summary chips
  $('drawerChipSource').textContent = SOURCE_MODE_LABELS[state.sourceMode] || '⚡ Супер-Ансамбль';
  $('drawerChipPeriod').textContent = `${firstDay.dateStr}–${lastDay.dateStr} (${count}д)`;
  $('drawerChipWindow').textContent = winCfg.shortLabel;
  $('drawerChipExtremes').textContent = `${formatTempCompact(minDayObj.minC, minDayObj.minF)}..${formatTempCompact(maxDayObj.maxC, maxDayObj.maxF)}`;

  // 5 KPI Cards
  $('periodSumDaysCount').textContent = `${count} ${count === 1 ? 'сутки' : 'суток'}`;
  $('periodSumDateSpan').textContent = `${firstDay.dateStr} – ${lastDay.dateStr}`;
  $('periodSumZones').textContent = zoneNames.join(' + ');

  $('periodSumAbsMax').textContent = formatTemp(maxDayObj.maxC, maxDayObj.maxF);
  $('periodSumAbsMin').textContent = formatTemp(minDayObj.minC, minDayObj.minF);
  $('periodSumCorridor').textContent = hasQuantiles
    ? `P10–P90: ${formatTempCompact(minP10)} .. ${formatTempCompact(maxP90)}`
    : 'Коридор детерминированный';
  $('periodSumAbsDates').textContent = `Max: ${maxDayObj.dateStr} • Min: ${minDayObj.dateStr}`;

  $('periodSumAvgDay').textContent = formatTemp(avgMaxC);
  $('periodSumAvgNight').textContent = formatTemp(avgMinC);
  $('periodSumAnomaly').textContent =
    avgAnomC !== null
      ? `К норме 1991–2020: ${avgAnomC > 0 ? '+' : ''}${avgAnomC.toFixed(1)}°C`
      : 'К норме 1991–2020: —';
  $('periodSumWindowAvg').textContent = `Окно (${winCfg.shortLabel}): ${formatTemp(avgWinC)}`;

  $('periodSumPrecipMm').textContent = `Σ ${sumPrecipMm.toFixed(1)} мм`;
  $('periodSumSnowCm').textContent = `❄ до ${formatSnowCm(maxSnowCm, maxSnowEstimated)} см${maxSnowEstimated ? ' (норма)' : ''}`;
  $('periodSumDryDays').textContent = `Сухих дней: ${dryDays} из ${count}`;

  $('periodSumMaxWind').textContent = `${formatWind(maxWindObj.windMs, maxWindObj.windMph)} (пор. ${formatWind(maxWindObj.gustMs, maxWindObj.gustMph)})`;
  $('periodSumWindMeta').textContent = `Пик: ${maxWindObj.dateStr} (${maxWindObj.windDirShort || '—'})`;
}

// ============================================================================
// RENDERING: SECTION 2 (FORECAST STRIP & RISK FILTERS)
// ============================================================================
function matchesRiskFilter(day, filterKey, prevDays = []) {
  if (filterKey === 'all') return true;
  if (filterKey === 'frost') return day.minC < 0;
  if (filterKey === 'ice_blizzard') {
    const ops = computeFieldOpsMetrics(day, prevDays);
    return ops.roadRisk.level !== 'low' || day.precipPhase === 'freezing_rain';
  }
  if (filterKey === 'precip') {
    return (day.precipDay ?? 0) >= 15 || (day.precipNight ?? 0) >= 15 || (day.precipMm ?? 0) >= 0.5;
  }
  if (filterKey === 'clear') {
    return (day.precipDay ?? 0) < 15 && (day.precipNight ?? 0) < 15 && (day.precipMm ?? 0) < 0.5;
  }
  return true;
}

function renderForecastStrip() {
  const container = $('forecastStripContainer');
  const days = getSelectedPeriodDays();
  if (!container || !days.length) return;

  const firstDay = days[0];
  const lastDay = days[days.length - 1];
  $('stripSectionTitle').textContent = `Прогноз: ${firstDay.dateStr} – ${lastDay.dateStr} (${days.length} сут.)`;

  const frostCount = days.filter((d) => matchesRiskFilter(d, 'frost')).length;
  const iceCount = days.filter((d, i) => matchesRiskFilter(d, 'ice_blizzard', days.slice(0, i))).length;
  const precipCount = days.filter((d) => matchesRiskFilter(d, 'precip')).length;
  const clearCount = days.filter((d) => matchesRiskFilter(d, 'clear')).length;

  $('filterBtn-all').textContent = `Все (${days.length})`;
  $('filterLabel-frost').textContent = `Заморозки (${frostCount})`;
  $('filterLabel-ice_blizzard').textContent = `Гололедица/Метель (${iceCount})`;
  $('filterLabel-precip').textContent = `Осадки ≥15% (${precipCount})`;
  $('filterLabel-clear').textContent = `Сухие окна (${clearCount})`;

  ['all', 'frost', 'ice_blizzard', 'precip', 'clear'].forEach((f) => {
    $(`filterBtn-${f}`)?.classList.toggle('is-active', state.filter === f);
  });

  const usePentad = state.groupByPentad && days.length > 14;
  container.classList.toggle('forecast-strip--pentad', usePentad);

  if (usePentad) {
    const pentads = buildPentadSummary(days);
    container.innerHTML = pentads
      .map((p) => {
        const isSel = Array.isArray(p.dayIds) ? p.dayIds.includes(state.selectedDayId) : p.id === state.selectedDayId;
        const zMeta = ZONE_BADGE_META[p.zone] || ZONE_BADGE_META.subseasonal;
        const showSpread = p.zone === 'extended_ensemble' || p.zone === 'subseasonal';
        const iconType = p.precipPhase === 'snow' ? 'snow' : p.precipPhase === 'sleet' ? 'sleet' : p.precipMm > 5 ? 'rain-cloudy' : 'partly-sunny';

        return `<button type="button" data-day-id="${escapeHtml(p.id)}" class="glass-card day-card ${isSel ? 'day-card-active' : ''}">
          <div class="flex items-center justify-between gap-1">
            <span class="zone-pill ${zMeta.cls}">${escapeHtml(zMeta.short)} ${num(p.confidencePct)}%</span>
            <span class="text-[10px] font-mono text-slate-400">${num(p.dayCount)} дн.</span>
          </div>
          <div class="mt-1">
            <div class="text-xs font-extrabold ${isSel ? 'text-sky-300' : 'text-white'}">${escapeHtml(p.label)}</div>
            <div class="text-[10px] font-mono text-slate-400">Экстр.: ${formatTempCompact(p.absMinC)}..${formatTempCompact(p.absMaxC)}</div>
          </div>
          <div class="my-2 flex items-center justify-center">${getWeatherSvg(iconType, 'w-11 h-11')}</div>
          <div class="flex flex-col gap-1">
            <div class="flex items-baseline justify-between font-mono">
              <span class="text-sm font-extrabold text-white">${formatTempCompact(p.maxC, p.maxF)}</span>
              <span class="text-xs font-bold ${p.minC < 0 ? 'text-cyan-300' : 'text-slate-400'}">${formatTempCompact(p.minC, p.minF)}</span>
            </div>
            ${showSpread ? `<div class="text-[10px] font-mono text-purple-300">P25–75: ${formatTempCompact(p.minP25C)}..${formatTempCompact(p.maxP75C)}</div>` : ''}
            <div class="flex items-center justify-between text-[10px] font-mono pt-1" style="border-top:1px solid rgba(30,41,59,0.85)">
              <span class="text-cyan-300">${num(p.precipMm).toFixed(1)}мм • ❄${formatSnowCm(p.snowDepthCm, p.dataQuality?.snowEstimated)}см</span>
              <span class="text-slate-300 font-bold">${escapeHtml(p.windDirShort || '—')}</span>
            </div>
          </div>
        </button>`;
      })
      .join('');
    return;
  }

  container.innerHTML = days
    .map((day, idx) => {
      const isSelected = day.id === state.selectedDayId;
      const isMatch = matchesRiskFilter(day, state.filter, days.slice(0, idx));
      const zMeta = getZoneMeta(day);
      const showSpread = day.zone === 'extended_ensemble' || day.zone === 'subseasonal' || day.offsetFromToday >= 10;
      const maxPrecip = Math.max(num(day.precipDay), num(day.precipNight));
      const iconName = state.timeWindow === 'night' ? day.nightIconType : day.iconType;

      return `<button type="button" data-day-id="${escapeHtml(day.id)}" class="glass-card day-card ${isSelected ? 'day-card-active' : ''} ${!isMatch ? 'day-card-dimmed' : ''}">
        <div class="flex items-center justify-between gap-1">
          <span class="zone-pill ${zMeta.cls}">${escapeHtml(zMeta.short)} ${num(day.confidencePct, 85)}%</span>
          ${num(day.snowDepthCm) > 0 ? `<span class="text-[10px] font-mono text-cyan-300">❄${formatSnowCm(day.snowDepthCm, day.dataQuality?.snowEstimated, 0)}см</span>` : ''}
        </div>
        <div class="mt-1">
          <div class="text-xs font-extrabold ${isSelected ? 'text-sky-300' : 'text-white'}">${escapeHtml(day.dayShort)}, ${escapeHtml(day.dateStr)}</div>
          <div class="text-[10px] font-mono text-slate-400 truncate">${escapeHtml(day.label || '')}</div>
        </div>
        <div class="my-2 flex items-center justify-center">${getWeatherSvg(iconName || 'partly-sunny', 'w-11 h-11')}</div>
        <div class="flex flex-col gap-1">
          <div class="flex items-baseline justify-between font-mono">
            <span class="text-sm font-extrabold text-white">${formatTempCompact(day.maxC, day.maxF)}</span>
            <span class="text-xs font-bold ${day.minC < 0 ? 'text-cyan-300' : 'text-slate-400'}">${formatTempCompact(day.minC, day.minF)}</span>
          </div>
          ${showSpread ? `<div class="text-[10px] font-mono text-purple-300 truncate">P25–75: ${formatTempCompact(day.minP25C)}..${formatTempCompact(day.maxP75C)}</div>` : ''}
          <div class="flex items-center justify-between text-[10px] font-mono pt-1" style="border-top:1px solid rgba(30,41,59,0.85)">
            <span class="text-cyan-300">${maxPrecip}% • ${num(day.precipMm).toFixed(1)}мм</span>
            <span class="text-slate-300 font-bold">${escapeHtml(day.windDirShort || '—')}</span>
          </div>
        </div>
      </button>`;
    })
    .join('');
}

// ============================================================================
// RENDERING: SECTION 3 (DAY INSPECTOR, DIURNAL CHART & 4 FIELD OPS CARDS)
// ============================================================================
function updateSelectedHourBar(day) {
  const winCfg = TIME_WINDOWS[state.timeWindow] || TIME_WINDOWS.full;
  const winStats = computeDayWindowStats(day, state.timeWindow);
  const hours = winStats.hours || [];
  const selPt = hours.find((p) => p.hour === state.selectedHourSlot) || hours[12] || hours[0];

  $('inspectorWindowLabel').textContent = `Окно: ${winCfg.shortLabel}`;
  $('diurnalWindowAvgTemp').textContent = formatTemp(winStats.avgC, winStats.avgF);
  $('diurnalWindowMinMax').textContent = `Min/Max: ${formatTempCompact(winStats.minC)} .. ${formatTempCompact(winStats.maxC)}`;

  if (selPt) {
    const pPair = getPressurePair(selPt);
    const phaseRu = PRECIP_PHASE_LABELS[selPt.precipPhase] || selPt.precipPhase || 'Сухо';
    $('selectedHourTitle').textContent = `Час (${selPt.hourStr}):`;
    $('selectedHourTemp').textContent = `${formatTemp(selPt.tempC, selPt.tempF)} (Ощущ. ${formatTemp(selPt.feelsC)})`;
    $('selectedHourWetBulb').textContent = `Tw: ${formatTempCompact(selPt.wetBulbC)} • Td: ${formatTempCompact(selPt.dewPointC)}`;
    $('diurnalWindowWind').textContent = `${formatWind(selPt.windMs, selPt.windMph)} (пор. ${formatWind(selPt.gustMs)}) ${selPt.windDirShort || ''}`;
    $('diurnalWindowPressure').textContent = pPair.has ? `Давл.: ${pPair.mmText} (${pPair.label})` : 'Давл.: — (нет данных)';
    $('diurnalWindowPrecip').textContent = `${selPt.precipProb ?? 0}% • ${Number(selPt.precipMm ?? 0).toFixed(1)} мм (${phaseRu})`;
    $('diurnalWindowSoil').textContent = `Почва 0см: ${formatSoilCompact(selPt.soil0C, day.dataQuality?.soilEstimated)}`;
  } else {
    $('selectedHourTitle').textContent = 'Диапазон суток:';
    $('selectedHourTemp').textContent = `${formatTemp(day.minC, day.minF)} .. ${formatTemp(day.maxC, day.maxF)}`;
    $('selectedHourWetBulb').textContent = 'Без почасовой сетки';
    $('diurnalWindowWind').textContent = `${formatWind(day.windMs, day.windMph)} ${day.windDirShort || ''}`;
    $('diurnalWindowPressure').textContent = `Давл.: ${getPressurePair(day).mmText}`;
    $('diurnalWindowPrecip').textContent = `${day.precipDay ?? 0}% • ${Number(day.precipMm ?? 0).toFixed(1)} мм`;
    $('diurnalWindowSoil').textContent = `Почва 0см: ${formatSoilCompact(day.soil0C, day.dataQuality?.soilEstimated)}`;
  }
}

function getUiChartState() {
  return {
    unit: state.unit,
    pressureMode: state.pressureMode,
    timeWindow: state.timeWindow,
    selectedDayId: state.selectedDayId,
    selectedHourSlot: state.selectedHourSlot,
    showClimatology: state.showClimatology,
    showModelLines: state.showModelLines,
    groupByPentad: state.groupByPentad,
  };
}

function handleSelectHour(hour) {
  state.selectedHourSlot = hour;
  const days = getSelectedPeriodDays();
  const day = days.find((d) => d.id === state.selectedDayId) || days[0];
  if (!day) return;
  updateSelectedHourBar(day);
  renderDiurnalChart($('diurnalChartContainer'), day, getUiChartState(), handleSelectHour);
}

function renderDayInspector() {
  const days = getSelectedPeriodDays();
  if (!days.length) return;
  let dayIndex = days.findIndex((d) => d.id === state.selectedDayId);
  if (dayIndex === -1) {
    dayIndex = 0;
    state.selectedDayId = days[0].id;
  }
  const day = days[dayIndex];
  const allDays = getAllDays();
  const globalIdx = allDays.findIndex((d) => d.id === day.id);
  const prevDays = globalIdx > 0 ? allDays.slice(Math.max(0, globalIdx - 4), globalIdx) : [];
  const ops = computeFieldOpsMetrics(day, prevDays);

  $('inspectorDateBadge').textContent = `${day.dayShort}, ${day.dateStr} (${day.label || day.isoDate})`;
  const zMeta = getZoneMeta(day);
  const zBadge = $('inspectorZoneBadge');
  zBadge.className = `zone-pill ${zMeta.cls}`;
  zBadge.textContent = `${zMeta.label} • ${num(day.confidencePct, 85)}%`;

  $('inspectorTitle').textContent = `${day.dayCond || '—'} днём • ${day.nightCond || '—'} ночью`;
  $('inspectorIndexCounter').textContent = `День ${dayIndex + 1} / ${days.length}`;

  // Risk Badges
  const badges = [];
  if (day.minC < 0) {
    badges.push(`<span class="badge-mono text-cyan-300">❄️ Заморозок ${formatTempCompact(day.minC, day.minF)}</span>`);
  }
  if (ops.frostCrossZero) {
    badges.push('<span class="badge-mono text-amber-300">⚠️ Переход 0°C</span>');
  }
  if (ops.roadRisk.level === 'high' || ops.roadRisk.level === 'severe') {
    badges.push(`<span class="badge-mono text-rose-300">🛣️ ${escapeHtml(ops.roadRisk.labelRu)}</span>`);
  }
  if (day.inversion?.active) {
    badges.push(`<span class="badge-mono text-purple-300">🌫️ Инверсия −${num(day.inversion.deltaC).toFixed(1)}°</span>`);
  }
  if (day.dataQuality?.soilEstimated && !day.isArchive && day.zone !== 'subseasonal') {
    badges.push('<span class="badge-mono text-amber-300">≈ Почва: оценка</span>');
  }
  if (Math.abs(day.deltaP24hMm ?? 0) >= 6) {
    badges.push(`<span class="badge-mono text-rose-300">📉 Скачок ΔP ${formatSignedInt(day.deltaP24hMm)}</span>`);
  }
  $('inspectorRiskBadges').innerHTML = badges.join('');

  // Diurnal Chart & Honesty Notice
  const honestyEl = $('diurnalHonestyNotice');
  if (honestyEl) {
    if (isClimatologyOnlyDay(day)) {
      honestyEl.textContent = 'Ансамбли не покрывают эту дату: показана климатическая норма 1991–2020, это не прогноз';
      honestyEl.classList.remove('hidden');
    } else if (day.zone === 'subseasonal') {
      honestyEl.textContent = '17–35д: сглаженный суточный ход из квантилей P10–P90';
      honestyEl.classList.remove('hidden');
    } else {
      honestyEl.classList.add('hidden');
    }
  }
  updateSelectedHourBar(day);
  renderDiurnalChart($('diurnalChartContainer'), day, getUiChartState(), handleSelectHour);

  // Advisory line
  $('inspectorAdvisoryText').textContent = `${ops.roadRisk.labelRu}: ${ops.roadRisk.detailRu}`;

  // Day Card
  $('inspectorDayIcon').innerHTML = getWeatherSvg(day.iconType || 'partly-sunny', 'w-11 h-11');
  $('inspectorDayTemp').textContent = formatTemp(day.maxC, day.maxF, state.unit === 'dual');
  $('inspectorDayTempSub').textContent = formatTempSecondary(day.maxC, day.maxF);
  $('inspectorDayCond').textContent = day.dayCond || '—';
  $('inspectorAstroSummary').textContent = day.astronomy
    ? `Восход ${day.astronomy.sunriseStr} • Закат ${day.astronomy.sunsetStr} • День ${day.astronomy.daylightHours} ч`
    : 'Астрономия п. Абан';
  $('inspectorDayPrecip').textContent = `${day.precipDay ?? 0}% • ${Number(day.precipMm ?? 0).toFixed(1)} мм (${day.precipDayType || 'сухо'})`;

  // Night Card (Explicitly Next-Night 20–08h!)
  const nMinC = day.nextNightMinC ?? day.minC;
  const nMinF = day.nextNightMinF ?? day.minF;
  const nProb = day.nextNightPrecipProb ?? day.precipNight ?? 0;
  const nMm = day.nextNightPrecipMm ?? 0;
  const nType = day.nextNightPrecipType || day.precipNightType || 'сухо';
  const nCond = day.nextNightCond || day.nightCond || '—';
  const nWindMs = day.nextNightWindMs ?? day.windMs;
  const nWindDir = day.nextNightWindDirShort || day.windDirShort;

  $('inspectorNightIcon').innerHTML = getWeatherSvg(day.nextNightIconType || day.nightIconType || 'clear-night', 'w-11 h-11');
  $('inspectorNightTemp').textContent = formatTemp(nMinC, nMinF, state.unit === 'dual');
  $('inspectorNightTempSub').textContent = formatTempSecondary(nMinC, nMinF);
  $('inspectorNightCond').textContent = nCond;
  $('inspectorNightNote').textContent = `Ветер 20–08ч: ${formatWind(nWindMs)} ${nWindDir || ''} • Охл. до ${formatTempCompact(nMinC)}`;
  $('inspectorNightPrecip').textContent = `${nProb}% • ${Number(nMm).toFixed(1)} мм (${nType})`;

  // Vector Wind Compass
  // No direction for far-range trend days (ensembles give speed only): show «—», hide the arrow
  const windDeg = toFiniteNumber(day.windDeg);
  const hasWindDir = windDeg !== null;
  $('inspectorWindDirCode').textContent = hasWindDir ? `${day.windDirShort || '—'} (${Math.round(windDeg)}°)` : '—';
  const arrowEl = $('compassArrowGroup');
  if (arrowEl) {
    arrowEl.setAttribute('transform', `rotate(${hasWindDir ? windDeg : 0}, 70, 70)`);
    arrowEl.setAttribute('opacity', hasWindDir ? '1' : '0');
  }
  $('inspectorWindSpeed').textContent = formatWind(day.windMs, day.windMph);
  $('inspectorWindGusts').textContent = `Порывы до: ${formatWind(day.gustMs, day.gustMph)}`;
  $('inspectorWindName').textContent = hasWindDir
    ? `${day.windDirFull || '—'} поток`
    : 'Направление: нет данных на этом горизонте';

  // 4 Aban Field Operational Cards
  $('opsRoadCard').className = `ops-card ops-card--${ops.roadRisk.level || 'low'}`;
  $('opsRoadLabel').textContent = ops.roadRisk.labelRu;
  $('opsRoadDetail').textContent = ops.roadRisk.detailRu;

  $('opsDieselGrade').textContent = `${ops.diesel.grade} (ПТФ ${ops.diesel.cutoffC}°C)`;
  $('opsDieselDetail').textContent = ops.diesel.noteRu;

  // Ground card: an air-temperature heuristic must not pose as a measured freeze depth
  const soilEst = Boolean(day.dataQuality?.soilEstimated);
  $('opsGroundLabel').textContent = soilEst ? `≈ ${ops.ground.labelRu} — оценка` : ops.ground.labelRu;
  $('opsGroundDetail').textContent = `${soilEst ? 'Нет данных модели почвы: ориентировочный расчёт по температуре воздуха. ' : ''}${ops.ground.detailRu} [0/6/18/54см: ${formatSoilCompact(day.soil0C, soilEst)} / ${formatSoilCompact(day.soil6C, soilEst)} / ${formatSoilCompact(day.soil18C, soilEst)} / ${formatSoilCompact(day.soil54C, soilEst)}]`;

  const pPair = getPressurePair(day);
  $('opsInversionLabel').textContent = day.inversion?.active
    ? `Активна (−${num(day.inversion.deltaC).toFixed(1)}°C • низины ${formatTempCompact(day.inversion.valleyMinC)})`
    : pPair.has
    ? `Инверсия слабая • ${pPair.mmText}`
    : 'Инверсия слабая';
  $('opsInversionDetail').textContent = pPair.has
    ? `${day.inversion?.noteRu || '—'} • Давл. ${pPair.mmText} (Δ24ч: ${formatSignedInt(day.deltaP24hMm)})`
    : `${day.inversion?.noteRu || '—'} • Давление: нет данных на этом горизонте`;
}

// ============================================================================
// RENDERING: SECTION 4 (LAZY-RENDERED ANALYTICS TABS & FIELD MATRIX)
// ============================================================================
function renderAnalyticsTab(tabKey) {
  const days = getSelectedPeriodDays();
  if (!days.length) return;

  const uiState = getUiChartState();
  const usePentad = state.groupByPentad && days.length > 14;
  const pentads = usePentad ? buildPentadSummary(days) : null;
  const chartItems = usePentad ? pentads : days;

  let maxDay = days[0];
  let minDay = days[0];
  let peakWind = days[0];
  let sumMm = 0;
  for (const d of days) {
    if (d.maxC > maxDay.maxC) maxDay = d;
    if (d.minC < minDay.minC) minDay = d;
    if ((d.gustMs ?? d.windMs) > (peakWind.gustMs ?? peakWind.windMs)) peakWind = d;
    sumMm += Number(d.precipMm ?? 0);
  }

  if (tabKey === 'temp') {
    $('tempChartDynamicSummary').textContent = `Max: ${maxDay.dateStr} (${formatTemp(maxDay.maxC, maxDay.maxF)}) • Min: ${minDay.dateStr} (${formatTemp(minDay.minC, minDay.minF)})`;
    // Same items as the other tabs and the table: pentads come from buildPentadSummary only
    renderTempEnsembleChart($('tempChartWrapper'), chartItems, uiState, selectDay);
  } else if (tabKey === 'precip') {
    $('precipChartDynamicSummary').textContent = `Сумма осадков: ${sumMm.toFixed(1)} мм • Пик снега: ${Math.max(...days.map((d) => d.snowDepthCm ?? 0)).toFixed(1)} см`;
    renderPrecipSnowChart($('precipChartWrapper'), chartItems, uiState, selectDay);
  } else if (tabKey === 'wind') {
    $('windChartDynamicSummary').textContent = `Пик: ${peakWind.dateStr} — ${formatWind(peakWind.windMs)} (пор. ${formatWind(peakWind.gustMs)})`;
    renderWindPressureChart($('windChartWrapper'), chartItems, uiState, selectDay);
  } else if (tabKey === 'ops') {
    renderSoilProfileChart($('soilChartWrapper'), chartItems, uiState, selectDay);

    const frostDays = days.filter((d) => d.minC < 0);
    const soilFreezeDays = days.filter((d) => (d.soil0C ?? 0) <= 0.2);
    const dryDays = days.filter((d) => (d.precipDay ?? 0) < 15 && (d.precipNight ?? 0) < 15 && (d.precipMm ?? 0) < 0.5);
    const iceDays = days.filter((d, i) => matchesRiskFilter(d, 'ice_blizzard', days.slice(0, i)));
    const soilAnyEstimated = days.some((d) => d.dataQuality?.soilEstimated);
    // Every dataset string is escaped before it reaches innerHTML (dataset may come from a file)
    const listDates = (list) => list.slice(0, 4).map((d) => escapeHtml(d.dateStr)).join(', ');

    $('opsSummaryCardsGrid').innerHTML = `
      <div class="ops-card">
        <div class="text-[11px] font-mono text-cyan-400 font-bold">❄️ ЗАМОРОЗКИ (${frostDays.length}/${days.length})</div>
        <div class="text-xs font-bold text-white">${frostDays.length ? listDates(frostDays) : 'Без заморозков'}</div>
      </div>
      <div class="ops-card">
        <div class="text-[11px] font-mono text-rose-400 font-bold">🛣️ ГОЛОЛЁД / МЕТЕЛЬ (${iceDays.length})</div>
        <div class="text-xs font-bold text-white">${iceDays.length ? listDates(iceDays) : 'Трасса чистая'}</div>
      </div>
      <div class="ops-card">
        <div class="text-[11px] font-mono text-amber-400 font-bold">🌱 ПОЧВА ≤0°C (${soilFreezeDays.length})${soilAnyEstimated ? ' • ≈ оценка' : ''}</div>
        <div class="text-xs font-bold text-white">${soilFreezeDays.length ? listDates(soilFreezeDays) : 'Почва талая'}</div>
      </div>
      <div class="ops-card">
        <div class="text-[11px] font-mono text-emerald-400 font-bold">☀️ СУХИЕ ОКНА (${dryDays.length})</div>
        <div class="text-xs font-bold text-white">${dryDays.length ? listDates(dryDays) : 'Влажный период'}</div>
      </div>
    `;

    const thead = $('operationalTableHead');
    const tbody = $('operationalTableBody');

    if (usePentad && pentads) {
      thead.innerHTML = `<tr>
        <th>Пентада</th>
        <th>Зона / Увер.</th>
        <th>Ср. Max / Min (Экстр.)</th>
        <th>Осадки / Снег</th>
        <th>Ветер (пор.)</th>
        <th>Почва 0/54см • Давл.</th>
        <th>Аномалия</th>
      </tr>`;
      tbody.innerHTML = pentads
        .map((p) => {
          const isSel = Array.isArray(p.dayIds) ? p.dayIds.includes(state.selectedDayId) : p.id === state.selectedDayId;
          const pPair = getPressurePair(p);
          const anom = num(p.climAnomalyC);
          const pSoilEst = Boolean(p.dataQuality?.soilEstimated);
          return `<tr data-day-id="${escapeHtml(p.id)}" tabindex="0" aria-selected="${isSel ? 'true' : 'false'}" class="${isSel ? 'is-selected' : ''}">
            <td class="font-bold text-white">${escapeHtml(p.label)} (${num(p.dayCount)}д)</td>
            <td><span class="zone-pill ${ZONE_BADGE_META[p.zone]?.cls || ''}">${escapeHtml(ZONE_BADGE_META[p.zone]?.short || p.zone)} ${num(p.confidencePct)}%</span></td>
            <td><span class="text-amber-300 font-bold">${formatTemp(p.maxC)}</span> / <span class="text-cyan-300">${formatTemp(p.minC)}</span> <span class="text-slate-400">(${formatTempCompact(p.absMinC)}..${formatTempCompact(p.absMaxC)})</span></td>
            <td class="text-cyan-300">${num(p.precipMm).toFixed(1)} мм • ❄${formatSnowCm(p.snowDepthCm, p.dataQuality?.snowEstimated)}см</td>
            <td class="text-slate-200">${formatWind(p.windMs)} (пор. ${formatWind(p.gustMs)}) ${escapeHtml(p.windDirShort || '')}</td>
            <td class="text-amber-300">${formatSoilCompact(p.soil0C, pSoilEst)} / ${formatSoilCompact(p.soil54C, pSoilEst)} • ${pPair.mmText}</td>
            <td class="${anom >= 0 ? 'text-amber-300' : 'text-cyan-300'}">${anom > 0 ? '+' : ''}${anom.toFixed(1)}°C</td>
          </tr>`;
        })
        .join('');
    } else {
      thead.innerHTML = `<tr>
        <th>Дата</th>
        <th>Условия / Зона</th>
        <th>Max / Min (Окно)</th>
        <th>Осадки / Снег</th>
        <th>Ветер (пор.)</th>
        <th>Почва 0/54см • Давл.</th>
        <th>Риск Р-255</th>
      </tr>`;

      tbody.innerHTML = days
        .map((d, idx) => {
          const winStats = computeDayWindowStats(d, state.timeWindow);
          const ops = computeFieldOpsMetrics(d, days.slice(Math.max(0, idx - 3), idx));
          const pPair = getPressurePair(d);
          const zMeta = getZoneMeta(d);
          const riskCls =
            ops.roadRisk.level === 'severe'
              ? 'text-rose-400 font-bold'
              : ops.roadRisk.level === 'high'
              ? 'text-amber-300 font-bold'
              : ops.roadRisk.level === 'moderate'
              ? 'text-sky-300'
              : 'text-emerald-300';

          return `<tr data-day-id="${escapeHtml(d.id)}" tabindex="0" aria-selected="${d.id === state.selectedDayId ? 'true' : 'false'}" class="${d.id === state.selectedDayId ? 'is-selected' : ''}">
            <td class="font-bold text-white">${escapeHtml(d.dayShort)}, ${escapeHtml(d.dateStr)}</td>
            <td class="font-sans text-slate-300">
              <span class="zone-pill ${zMeta.cls}">${escapeHtml(zMeta.short)} ${num(d.confidencePct, 85)}%</span>
              <span style="margin-left:4px">${escapeHtml(d.dayCond || '—')}</span>
            </td>
            <td>
              <span class="text-amber-300 font-bold">${formatTemp(d.maxC, d.maxF)}</span> /
              <span class="text-cyan-300">${formatTemp(d.minC, d.minF)}</span>
              <span class="text-sky-400">(${formatTempCompact(winStats.avgC, winStats.avgF)})</span>
            </td>
            <td class="text-cyan-300">${num(d.precipMm).toFixed(1)} мм (${num(d.precipDay)}%) • ❄${formatSnowCm(d.snowDepthCm, d.dataQuality?.snowEstimated, 0)}см</td>
            <td class="text-slate-200">${formatWind(d.windMs, d.windMph)} (пор. ${formatWind(d.gustMs, d.gustMph)}) ${escapeHtml(d.windDirShort || '')}</td>
            <td class="text-amber-300">${formatSoilCompact(d.soil0C, d.dataQuality?.soilEstimated)} / ${formatSoilCompact(d.soil54C, d.dataQuality?.soilEstimated)} • ${pPair.mmText}</td>
            <td class="${riskCls}">${escapeHtml(ops.roadRisk.labelRu)}</td>
          </tr>`;
        })
        .join('');
    }
  }

  state.dirtyTabs[tabKey] = false;
}

function renderAnalyticsAndTable() {
  const days = getSelectedPeriodDays();
  if (!days.length) return;

  const firstDay = days[0];
  const lastDay = days[days.length - 1];
  const winCfg = TIME_WINDOWS[state.timeWindow] || TIME_WINDOWS.full;
  const usePentad = state.groupByPentad && days.length > 14;

  $('analyticsPeriodBadge').textContent = `${firstDay.dateStr} – ${lastDay.dateStr} (${days.length} сут.${usePentad ? ' • 5-дневки' : ''} • ${winCfg.shortLabel})`;
  $('toggleModelLinesBtn')?.classList.toggle('is-active', state.showModelLines);
  $('toggleClimatologyBtn')?.classList.toggle('is-active', state.showClimatology);

  // Lazy tab rendering: only redraw active tab; hidden tabs render on switch
  renderAnalyticsTab(state.activeTab);
  renderChartSelectionSummary();
}

/**
 * One-line readout of the selected day (or of the pentad containing it) for the active tab.
 * This is also where the P10–P90 fan gets its numbers: the chart draws the band, the line names it.
 */
function renderChartSelectionSummary() {
  const el = $('activeChartSummaryText');
  if (!el) return;
  const days = getSelectedPeriodDays();
  const day = days.find((d) => d.id === state.selectedDayId);
  if (!day) {
    el.textContent = 'Выберите узел графика для синхронизации с инспектором';
    return;
  }

  const usePentad = state.groupByPentad && days.length > 14;
  const pentad = usePentad ? buildPentadSummary(days).find((p) => p.dayIds.includes(day.id)) : null;
  const item = pentad || day;
  const head = pentad ? `${pentad.label} (${pentad.dayCount} дн., средние)` : `${day.dayShort}, ${day.dateStr}`;
  const dq = item.dataQuality || {};
  const band = (lo, hi) =>
    toFiniteNumber(lo) !== null && toFiniteNumber(hi) !== null
      ? ` (P10–P90: ${formatTempCompact(lo)}…${formatTempCompact(hi)})`
      : '';

  let body;
  if (state.activeTab === 'precip') {
    const p75 = toFiniteNumber(item.precipP75Mm);
    body = [
      `осадки ${num(item.precipMm).toFixed(1)} мм${p75 !== null ? ` (P75 ${p75.toFixed(1)} мм)` : ''}`,
      `снег ${formatSnowCm(item.snowDepthCm, dq.snowEstimated)} см${dq.snowEstimated ? ' (норма)' : ''}`,
      `влажность ${dq.humidityEstimated ? '—' : `${Math.round(num(item.humidity))}%`}`,
    ].join(' • ');
  } else if (state.activeTab === 'wind') {
    const pPair = getPressurePair(item);
    const dp = toFiniteNumber(item.deltaP24hMm);
    body = [
      `ветер ${formatWind(item.windMs, item.windMph)} (пор. ${formatWind(item.gustMs, item.gustMph)}) ${item.windDirShort || '—'}`,
      pPair.has
        ? `давление ${pPair.mmText}${dp !== null ? ` (${pentad ? 'макс. суточный ' : ''}Δ ${formatSignedInt(dp)})` : ''}`
        : 'давление: нет данных',
    ].join(' • ');
  } else if (state.activeTab === 'ops') {
    const est = Boolean(dq.soilEstimated);
    body = [
      `почва 0/6/18/54 см: ${formatSoilCompact(item.soil0C, est)} / ${formatSoilCompact(item.soil6C, est)} / ${formatSoilCompact(item.soil18C, est)} / ${formatSoilCompact(item.soil54C, est)}${est ? ' (оценка)' : ''}`,
      `точка росы ${approxMark(dq.humidityEstimated)}${formatTempCompact(item.dewPointC)}`,
    ].join(' • ');
  } else {
    body = [
      `Max ${formatTemp(item.maxC, item.maxF)}${band(item.maxP10C, item.maxP90C)}`,
      `Min ${formatTemp(item.minC, item.minF)}${band(item.minP10C, item.minP90C)}`,
      `норма ${formatTempCompact(item.climMinC)}…${formatTempCompact(item.climMaxC)}`,
    ].join(' • ');
  }
  el.textContent = `${head} • ${body}`;
  el.title = el.textContent;
}

// ============================================================================
// RENDERING: SETTINGS MODAL, API CHANNEL STATUS & 14-DAY MODEL MAE LEADERBOARD
// ============================================================================
function renderApiChannelsPanel() {
  const body = $('apiChannelsBody');
  const badge = $('apiChannelsBadge');
  if (!body) return;

  const list = Object.values(state.dataset?.channels || {});
  if (!list.length) {
    if (badge) {
      badge.textContent = 'Нет сетевого среза';
      badge.className = 'badge-mono text-slate-400';
    }
    body.innerHTML = '<tr><td colspan="4" class="text-slate-400">Данные загружаются или используется сезонный офлайн-эталон. Нажмите «Обновить» для диагностики всех 7 каналов.</td></tr>';
    return;
  }

  let okCount = 0;
  let errCount = 0;
  let pendingCount = 0;
  let activeCount = 0;
  for (const ch of list) {
    if (!ch || ch.status === 'disabled') continue;
    activeCount++;
    if (ch.status === 'ok' || ch.status === 'cached') okCount++;
    else if (ch.status === 'error' || ch.status === 'partial') errCount++;
    else if (ch.status === 'pending') pendingCount++;
  }

  if (badge) {
    const tags = [`${okCount}/${activeCount} OK`];
    if (pendingCount > 0) tags.push(`⏳ ${pendingCount}`);
    if (errCount > 0) tags.push(`${errCount} с проблемой`);
    badge.textContent = tags.join(' • ');
    badge.className = errCount > 0 ? 'badge-mono text-amber-300' : 'badge-mono text-emerald-300';
  }

  const statusMeta = {
    ok: { label: '✅ OK', cls: 'chan-pill--ok' },
    cached: { label: '💾 Кэш', cls: 'chan-pill--cached' },
    partial: { label: '⚠️ Частично', cls: 'chan-pill--partial' },
    pending: { label: '⏳ Загрузка', cls: 'chan-pill--pending' },
    error: { label: '⚠️ Ошибка', cls: 'chan-pill--error' },
    disabled: { label: '⏸ Выкл', cls: 'chan-pill--disabled' },
  };

  body.innerHTML = list
    .filter(Boolean)
    .map((ch) => {
      const m = statusMeta[ch.status] || statusMeta.disabled;
      const latText = num(ch.latencyMs) > 0 ? `${Math.round(num(ch.latencyMs))} мс` : '—';
      const detail = ch.error || ch.detail || '—';
      const detailCls =
        ch.status === 'error' ? 'text-rose-300' : ch.status === 'partial' ? 'text-amber-300' : 'text-slate-400';
      return `<tr>
        <td class="font-sans font-bold text-white">${escapeHtml(ch.label || ch.id)}</td>
        <td><span class="chan-pill ${m.cls}">${m.label}</span></td>
        <td class="text-slate-300">${latText}</td>
        <td class="${detailCls}">${escapeHtml(detail)}</td>
      </tr>`;
    })
    .join('');
}

function renderSettingsModal() {
  renderApiChannelsPanel();
  const keyInput = $('googleApiKeyInput');
  const keyBadge = $('modalKeyStatusBadge');
  if (keyInput && document.activeElement !== keyInput) {
    keyInput.value = state.apiKey || '';
  }
  if (keyBadge) {
    if (state.apiKey && state.apiKey.length > 10) {
      keyBadge.textContent = `Ключ задан (${state.apiKey.length} симв.)`;
      keyBadge.className = 'badge-mono text-emerald-300';
    } else {
      keyBadge.textContent = 'Ключ не задан';
      keyBadge.className = 'badge-mono text-slate-400';
    }
  }

  // Pressure reference buttons in modal
  $('modalPressStation').className =
    state.pressureMode === 'station' ? 'btn-action btn-action--solid font-mono' : 'btn-action font-mono';
  $('modalPressMsl').className =
    state.pressureMode === 'msl' ? 'btn-action btn-action--solid font-mono' : 'btn-action font-mono';

  // Open-Meteo preference buttons
  document.querySelectorAll('[data-om-model]').forEach((btn) => {
    btn.classList.toggle('source-btn-active', btn.dataset.omModel === state.preferredOmModel);
  });

  // 14-day Model MAE Leaderboard from dataset.mos
  const mos = state.dataset?.mos;
  const mosBestBadge = $('mosBestBadge');
  const mosSummaryLine = $('mosSummaryLine');
  const mosBody = $('mosLeaderboardBody');
  const entries = Object.entries(mos?.models || {}).sort((a, b) => (a[1]?.maeC ?? 99) - (b[1]?.maeC ?? 99));

  if (mosBestBadge) {
    mosBestBadge.textContent = mos?.bestModelId
      ? `Лидер: ${MODEL_META[mos.bestModelId]?.shortName || mos.bestModelId}`
      : 'Нет данных 14д';
  }
  if (mosSummaryLine) {
    mosSummaryLine.textContent = mos?.summaryRu || 'Сравнение прошлых прогнозов Open-Meteo за последние 14 суток.';
  }
  if (mosBody) {
    if (!entries.length) {
      mosBody.innerHTML = '<tr><td colspan="6" class="text-slate-400">Калибровка MOS появится после загрузки онлайн-данных Open-Meteo Previous Runs.</td></tr>';
    } else {
      mosBody.innerHTML = entries
        .map(([modelId, m]) => {
          const meta = MODEL_META[modelId] || { name: modelId, shortName: modelId, color: '#38bdf8' };
          const isBest = modelId === mos?.bestModelId;
          const fmtBias = (v) => `${num(v) > 0 ? '+' : ''}${num(v).toFixed(2)}°C`;
          return `<tr class="${isBest ? 'is-selected' : ''}">
            <td class="font-sans font-bold text-white">
              <span style="display:inline-block;width:8px;height:8px;border-radius:999px;background:${escapeHtml(meta.color)};margin-right:6px"></span>
              ${escapeHtml(meta.name)}
              ${isBest ? '<span class="badge-mono text-emerald-300" style="margin-left:6px">🏆 Лидер</span>' : ''}
            </td>
            <td class="font-bold text-sky-300">${num(m.maeC).toFixed(2)}°C</td>
            <td class="text-amber-300">${fmtBias(m.dayBiasC)}</td>
            <td class="text-cyan-300">${fmtBias(m.nightBiasC)}</td>
            <td class="text-emerald-300">×${num(m.weightMultiplier, 1).toFixed(2)}</td>
            <td class="text-slate-400">${Math.round(num(m.samples))} ч</td>
          </tr>`;
        })
        .join('');
    }
  }

  // Offline Cache Manager Stats
  const stats = getCacheStats();
  $('modalCacheSizeBadge').textContent = `Кэш: ${stats.totalKb} КБ (архивов: ${stats.archiveSlicesCount}/5)`;
  $('modalCacheMetaInfo').textContent = stats.hasCache
    ? `Слепок: ${stats.savedAtLabel || '—'} • ${stats.sourceLabel || '—'} • ${stats.daysCount} сут. (${stats.kb} КБ)`
    : 'Кэш прогноза пуст. Нажмите «В память» после загрузки онлайн-данных.';
}

let settingsModalOpener = null;

function isSettingsModalOpen() {
  return Boolean($('settingsModal')?.classList.contains('is-open'));
}

function openSettingsModal() {
  renderSettingsModal();
  if (!isSettingsModalOpen() && typeof document !== 'undefined') {
    settingsModalOpener = document.activeElement;
  }
  $('settingsModal')?.classList.add('is-open');
  $('btnCloseSettings')?.focus?.();
}

function closeSettingsModal() {
  if (!isSettingsModalOpen()) return;
  $('settingsModal')?.classList.remove('is-open');
  // Hand keyboard focus back to whatever opened the dialog
  settingsModalOpener?.focus?.();
  settingsModalOpener = null;
}

// ============================================================================
// INTERACTION HANDLERS & SHARE SUMMARY
// ============================================================================
function selectDay(dayId) {
  if (!dayId) return;
  state.selectedDayId = dayId;
  updateAllViews();
}

function navigateDay(delta) {
  const days = getSelectedPeriodDays();
  if (!days.length) return;
  const idx = days.findIndex((d) => d.id === state.selectedDayId);
  const nextIdx = (idx + delta + days.length) % days.length;
  state.selectedDayId = days[nextIdx].id;
  updateAllViews();
}

function setUnitSystem(unit) {
  state.unit = unit;
  savePrefs({ unit });
  updateAllViews();
}

function setPressureMode(mode) {
  state.pressureMode = mode;
  savePrefs({ pressureMode: mode });
  updateAllViews();
}

function setTimeOfDayWindow(winKey) {
  state.timeWindow = winKey;
  savePrefs({ timeWindow: winKey });
  updateAllViews();
}

const ANALYTICS_TABS = ['temp', 'precip', 'wind', 'ops'];

function switchAnalyticsTab(tabKey) {
  state.activeTab = tabKey;
  ANALYTICS_TABS.forEach((t) => {
    const btn = $(`tabBtn-${t}`);
    const isActive = t === tabKey;
    if (btn) {
      btn.classList.toggle('is-active', isActive);
      btn.setAttribute('aria-selected', String(isActive));
      // Roving tabindex: Tab enters the tab list once, arrow keys move between tabs
      btn.setAttribute('tabindex', isActive ? '0' : '-1');
    }
    $(`tabContent-${t}`)?.classList.toggle('hidden', !isActive);
  });
  if (state.dirtyTabs[tabKey]) {
    renderAnalyticsTab(tabKey);
  }
  renderChartSelectionSummary();
}

/** Selects a day and, if keyboard focus was inside `containerId`, returns it to the same day there. */
function selectDayKeepingFocus(dayId, containerId) {
  if (!dayId) return;
  const container = $(containerId);
  const hadFocus = Boolean(container && document.activeElement && container.contains(document.activeElement));
  selectDay(dayId);
  if (!hadFocus) return;
  const again = [...container.querySelectorAll('[data-day-id]')].find((el) => el.dataset.dayId === dayId);
  again?.focus?.({ preventScroll: true });
}

function buildTelegramSummaryText() {
  const ds = state.dataset || REFERENCE_DATASET;
  const cur = ds.current || REFERENCE_DATASET.current;
  const periodDays = getSelectedPeriodDays();
  const firstDay = periodDays[0];
  const lastDay = periodDays[periodDays.length - 1];
  const pPair = getPressurePair(cur);
  const winCfg = TIME_WINDOWS[state.timeWindow] || TIME_WINDOWS.full;

  const lines = [
    `🌦️ *п. Абан • ВМО ${ABAN_COORDS.wmoId}* (${ABAN_COORDS.lat}°N, ${ABAN_COORDS.lon}°E, 246 м)`,
    `📡 Источник: ${ds.sourceLabel} | ${ds.syncedAt}`,
    ds.mos?.summaryRu ? `🎯 ${ds.mos.summaryRu}` : null,
    `🌡️ Сейчас: *${formatSignedC(cur.tempC)}* (ощущ. ${formatSignedC(cur.feelsC)}, Tw ${formatSignedC(cur.wetBulbC)}), ${cur.condRu}`,
    `💨 Ветер: ${cur.windMs.toFixed(1)} м/с (пор. ${cur.gustMs.toFixed(1)}) ${cur.windDirShort} | 🧭 Давл. (${pPair.label}): ${pPair.mmText} (Δ24ч ${formatSignedInt(cur.deltaP24hMm)})`,
    `🌱 Почва 0/6/18/54см${cur.soilEstimated ? ' (≈ оценка)' : ''}: ${formatSignedC(cur.soil0C)} / ${formatSignedC(cur.soil6C)} / ${formatSignedC(cur.soil18C)} / ${formatSignedC(cur.soil54C)} | ❄️ Снег: ${formatSnowCm(cur.snowDepthCm, cur.snowEstimated)} см${cur.snowEstimated ? ' (норма)' : ''}`,
    `📅 Период (${firstDay.dateStr}–${lastDay.dateStr}, ${periodDays.length} сут., ${winCfg.shortLabel}):`,
    ...periodDays.slice(0, 10).map((d) =>
      `• ${d.dayShort} ${d.dateStr}: ${formatSignedC(d.maxC)} / ${formatSignedC(d.minC)} | ${Number(d.precipMm ?? 0).toFixed(1)}мм | ${d.windMs.toFixed(1)} м/с ${d.windDirShort}`
    ),
  ].filter(Boolean);

  if (periodDays.length > 10) {
    lines.push(`… и ещё ${periodDays.length - 10} сут. до ${lastDay.dateStr}`);
  }
  return lines.join('\n');
}

async function copyOrShareSummary() {
  const text = buildTelegramSummaryText();
  if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
    try {
      await navigator.share({ title: 'Сводка погоды • п. Абан (ВМО 29485)', text });
      showToast('Сводка отправлена');
      return;
    } catch (err) {
      if (err?.name === 'AbortError') return;
    }
  }

  let copied = false;
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      copied = true;
    } catch (_) {}
  }
  if (!copied) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try {
      copied = document.execCommand('copy');
    } catch (_) {}
    document.body.removeChild(ta);
  }
  showToast(copied ? 'Сводка для Telegram скопирована в буфер обмена' : 'Не удалось скопировать сводку');
}

// ============================================================================
// SECTION 5: LAZY-LOAD WINDY WEATHER RADAR
// ============================================================================
function buildWindyIframeUrl(overlay = 'rain') {
  const params = new URLSearchParams({
    lat: String(ABAN_COORDS.lat),
    lon: String(ABAN_COORDS.lon),
    detailLat: String(ABAN_COORDS.lat),
    detailLon: String(ABAN_COORDS.lon),
    width: '650',
    height: '450',
    zoom: '8',
    level: 'surface',
    overlay,
    product: 'ecmwf',
    menu: '',
    message: 'true',
    marker: 'true',
    calendar: 'now',
    pressure: 'true',
    type: 'map',
    location: 'coordinates',
    detail: '',
    metricWind: 'm/s',
    metricTemp: '°C',
    radarRange: '-1',
  });
  return `https://embed.windy.com/embed2.html?${params.toString()}`;
}

function mountWindyRadar(overlay = state.radarOverlay) {
  state.radarOverlay = overlay;
  state.radarLoaded = true;
  const mountPoint = $('radarMountPoint');
  if (!mountPoint) return;

  const existing = mountPoint.querySelector('iframe');
  const src = buildWindyIframeUrl(overlay);
  if (existing) {
    existing.src = src;
  } else {
    const iframe = document.createElement('iframe');
    iframe.className = 'radar-iframe';
    iframe.title = 'Интерактивный метеорадар Windy — п. Абан';
    iframe.loading = 'lazy';
    iframe.allowFullscreen = true;
    iframe.src = src;
    mountPoint.appendChild(iframe);
  }

  $('radarPlaceholder')?.classList.add('hidden');
  $('radarFrameContainer')?.classList.remove('hidden');
  document.querySelectorAll('[data-radar-overlay]').forEach((btn) => {
    btn.classList.toggle('is-active', btn.dataset.radarOverlay === overlay);
  });
}

function unloadWindyRadar() {
  state.radarLoaded = false;
  const mountPoint = $('radarMountPoint');
  if (mountPoint) mountPoint.innerHTML = '';
  $('radarFrameContainer')?.classList.add('hidden');
  $('radarPlaceholder')?.classList.remove('hidden');
}

// ============================================================================
// MASTER UPDATE & EVENT WIRING
// ============================================================================
function updateAllViews() {
  ensureSelectionConsistency();
  markAllAnalyticsTabsDirty();
  renderHeader();
  renderCurrentConditions();
  renderFiltersAndKpis();
  renderForecastStrip();
  renderDayInspector();
  renderAnalyticsAndTable();
  if ($('settingsModal')?.classList.contains('is-open')) {
    renderSettingsModal();
  }
}

function bindEventListeners() {
  // PWA Update Notification Banner
  $('btnApplyPwaUpdate')?.addEventListener('click', () => {
    if (state.waitingSw) {
      state.waitingSw.postMessage({ type: 'SKIP_WAITING' });
    } else if (typeof window !== 'undefined' && window.location?.reload) {
      window.location.reload();
    }
  });
  $('btnDismissPwaUpdate')?.addEventListener('click', () => {
    $('pwaUpdateBanner')?.classList.add('hidden');
  });

  // Header controls
  $('refreshDataBtn')?.addEventListener('click', () => refreshWeatherData(true));
  $('btnPressureToggle')?.addEventListener('click', () => {
    setPressureMode(state.pressureMode === 'station' ? 'msl' : 'station');
  });
  $('mosStatusPill')?.addEventListener('click', () => {
    openSettingsModal();
    $('mosLeaderboardSection')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });
  $('btnShareSummary')?.addEventListener('click', copyOrShareSummary);
  $('btnOpenSettings')?.addEventListener('click', openSettingsModal);
  $('btnCloseSettings')?.addEventListener('click', closeSettingsModal);
  $('settingsModal')?.addEventListener('click', (e) => {
    if (e.target?.id === 'settingsModal') closeSettingsModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isSettingsModalOpen()) {
      e.preventDefault();
      closeSettingsModal();
    }
  });

  // Auto-refresh: tab shown again, network back, or the 30-minute freshness window elapsed
  document.addEventListener('visibilitychange', maybeAutoRefresh);
  window.addEventListener('online', maybeAutoRefresh);
  setInterval(maybeAutoRefresh, AUTO_REFRESH_TICK_MS);

  // Units (Header + Modal)
  [
    ['metric', 'btnUnitMetric', 'modalUnitMetric'],
    ['imperial', 'btnUnitImperial', 'modalUnitImperial'],
    ['dual', 'btnUnitDual', 'modalUnitDual'],
  ].forEach(([unitKey, hId, mId]) => {
    $(hId)?.addEventListener('click', () => setUnitSystem(unitKey));
    $(mId)?.addEventListener('click', () => setUnitSystem(unitKey));
  });

  // Modal Pressure & Open-Meteo Model & API Key & Cache
  $('modalPressStation')?.addEventListener('click', () => setPressureMode('station'));
  $('modalPressMsl')?.addEventListener('click', () => setPressureMode('msl'));

  document.querySelectorAll('[data-om-model]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.preferredOmModel = btn.dataset.omModel || 'multi';
      savePrefs({ preferredOmModel: state.preferredOmModel });
      renderSettingsModal();
      if (state.sourceMode === 'open_meteo') {
        refreshWeatherData(true);
      } else {
        // The single-model preference only re-weights the blend in the «Open-Meteo» source mode
        showToast(
          state.preferredOmModel === 'multi'
            ? 'Выбран супер-ансамбль: все модели с весами MOS'
            : `Модель ${state.preferredOmModel} будет применена в режиме «Open-Meteo»`
        );
      }
    });
  });

  $('btnSaveApiKey')?.addEventListener('click', () => {
    const val = ($('googleApiKeyInput')?.value || '').trim();
    state.apiKey = setApiKey(val);
    showToast(val ? 'Ключ Google Weather API сохранен' : 'Ключ удален');
    renderSettingsModal();
    refreshWeatherData(true);
  });

  $('btnTestApiKey')?.addEventListener('click', async () => {
    const val = ($('googleApiKeyInput')?.value || '').trim();
    const resEl = $('apiKeyTestResult');
    if (resEl) {
      resEl.textContent = '⏳ Проверка 10-дн. (days=10) и 240-ч. (hours=240) эндпоинтов...';
      resEl.className = 'text-xs font-mono text-sky-300';
    }
    const res = await testGoogleApiKey(val);
    if (!resEl) return;
    if (res.ok) {
      resEl.textContent = `✅ Успешно (${res.latencyMs} мс): получено ${res.daysCount} сут. и ${res.hoursCount} ч.${res.hasMoreHours ? ' (+ пагинация 240ч)' : ''}`;
      resEl.className = 'text-xs font-mono text-emerald-300';
    } else {
      resEl.textContent = `❌ Ошибка: ${res.error}`;
      resEl.className = 'text-xs font-mono text-rose-300';
    }
  });

  $('btnSaveCache')?.addEventListener('click', () => {
    const res = saveDatasetCache(state.dataset);
    renderSettingsModal();
    showToast(res.ok ? `Сохранено в кэш (${res.kb} КБ)` : `Ошибка сохранения кэша: ${res.error}`);
  });

  $('btnExportJson')?.addEventListener('click', () => {
    try {
      const res = exportDatasetJson(state.dataset);
      showToast(`Экспортирован ${res.filename}`);
    } catch (err) {
      showToast(err?.message || 'Ошибка экспорта');
    }
  });

  $('inputImportJson')?.addEventListener('change', async (e) => {
    const file = e.target?.files?.[0];
    if (!file) return;
    try {
      const imported = await importDatasetJsonFile(file);
      state.dataset = imported;
      state.fromCache = true;
      state.activePreset = 'custom';
      state.startIso = imported.days[0].isoDate;
      state.endIso = imported.days[imported.days.length - 1].isoDate;
      ensureSelectionConsistency();
      updateAllViews();
      showToast(`Импортировано ${imported.days.length} сут. из JSON`);
    } catch (err) {
      showToast(err?.message || 'Ошибка импорта JSON');
    } finally {
      e.target.value = '';
    }
  });

  $('btnClearCache')?.addEventListener('click', () => {
    clearDatasetCache({ includeArchive: true, includeMos: true });
    renderSettingsModal();
    showToast('Локальный кэш и архивные срезы очищены');
  });

  // Filters Drawer Toggle
  $('drawerToggleTrigger')?.addEventListener('click', () => {
    const body = $('controlsDrawerBody');
    const chevron = $('drawerToggleChevron');
    const trigger = $('drawerToggleTrigger');
    const btnText = $('drawerToggleBtnText');
    if (!body) return;

    const isDesktop = window.matchMedia('(min-width: 768px)').matches;
    if (isDesktop) {
      const willCollapse = !body.classList.contains('drawer-collapsed');
      body.classList.toggle('drawer-collapsed', willCollapse);
      body.classList.toggle('is-open', !willCollapse);
      if (chevron) chevron.classList.toggle('rotate-180', !willCollapse);
      if (btnText) btnText.textContent = willCollapse ? 'Настроить' : 'Свернуть';
      trigger?.setAttribute('aria-expanded', String(!willCollapse));
    } else {
      state.drawerOpenMobile = !state.drawerOpenMobile;
      body.classList.toggle('is-open', state.drawerOpenMobile);
      if (chevron) chevron.classList.toggle('rotate-180', state.drawerOpenMobile);
      if (btnText) btnText.textContent = state.drawerOpenMobile ? 'Свернуть' : 'Настроить';
      trigger?.setAttribute('aria-expanded', String(state.drawerOpenMobile));
    }
  });

  // Source modes, Presets, Time Windows
  document.querySelectorAll('[data-source-mode]').forEach((btn) => {
    btn.addEventListener('click', () => setDataSourceMode(btn.dataset.sourceMode));
  });
  document.querySelectorAll('[data-preset]').forEach((btn) => {
    btn.addEventListener('click', () => applyPeriodPreset(btn.dataset.preset));
  });
  document.querySelectorAll('[data-window]').forEach((btn) => {
    btn.addEventListener('click', () => setTimeOfDayWindow(btn.dataset.window));
  });

  // Date inputs & Timeline strip clicks
  $('inputStartDate')?.addEventListener('change', () => handleCustomDateRangeChange('start'));
  $('inputEndDate')?.addEventListener('change', () => handleCustomDateRangeChange('end'));
  $('confidenceTimelineTrack')?.addEventListener('click', (e) => {
    const btn = e.target?.closest?.('[data-timeline-iso]');
    if (!btn) return;
    const iso = btn.dataset.timelineIso;
    if (!iso) return;
    if (iso < state.startIso) state.startIso = iso;
    else if (iso > state.endIso) state.endIso = iso;
    state.activePreset = 'custom';
    state.selectedDayId = `day_${iso}`;
    ensureSelectionConsistency();
    updateAllViews();
  });

  // Pentad toggles
  const togglePentadMode = () => {
    state.groupByPentad = !state.groupByPentad;
    savePrefs({ groupByPentad: state.groupByPentad });
    updateAllViews();
  };
  $('btnGroupByPentad')?.addEventListener('click', togglePentadMode);
  $('stripPentadToggleBtn')?.addEventListener('click', togglePentadMode);
  $('tableViewModeToggle')?.addEventListener('click', togglePentadMode);

  // Risk filters & Day Strip selection
  document.querySelectorAll('[data-filter]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.filter = btn.dataset.filter || 'all';
      renderForecastStrip();
    });
  });
  $('forecastStripContainer')?.addEventListener('click', (e) => {
    const card = e.target?.closest?.('[data-day-id]');
    if (card?.dataset?.dayId) selectDayKeepingFocus(card.dataset.dayId, 'forecastStripContainer');
  });

  // Day Inspector stepper
  $('btnPrevDay')?.addEventListener('click', () => navigateDay(-1));
  $('btnNextDay')?.addEventListener('click', () => navigateDay(1));

  // Analytics Tabs & Model/Climatology Toggles & Table row clicks
  document.querySelectorAll('[data-tab]').forEach((btn) => {
    btn.addEventListener('click', () => switchAnalyticsTab(btn.dataset.tab));
    btn.addEventListener('keydown', (e) => {
      const idx = ANALYTICS_TABS.indexOf(btn.dataset.tab);
      let next = -1;
      if (e.key === 'ArrowRight') next = (idx + 1) % ANALYTICS_TABS.length;
      else if (e.key === 'ArrowLeft') next = (idx - 1 + ANALYTICS_TABS.length) % ANALYTICS_TABS.length;
      else if (e.key === 'Home') next = 0;
      else if (e.key === 'End') next = ANALYTICS_TABS.length - 1;
      if (next === -1) return;
      e.preventDefault();
      switchAnalyticsTab(ANALYTICS_TABS[next]);
      $(`tabBtn-${ANALYTICS_TABS[next]}`)?.focus();
    });
  });
  $('toggleModelLinesBtn')?.addEventListener('click', () => {
    state.showModelLines = !state.showModelLines;
    savePrefs({ showModelLines: state.showModelLines });
    state.dirtyTabs.temp = true;
    renderAnalyticsAndTable();
  });
  $('toggleClimatologyBtn')?.addEventListener('click', () => {
    state.showClimatology = !state.showClimatology;
    savePrefs({ showClimatology: state.showClimatology });
    state.dirtyTabs.temp = true;
    renderAnalyticsAndTable();
  });
  $('operationalTableBody')?.addEventListener('click', (e) => {
    const row = e.target?.closest?.('[data-day-id]');
    if (row?.dataset?.dayId) selectDayKeepingFocus(row.dataset.dayId, 'operationalTableBody');
  });
  $('operationalTableBody')?.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const row = e.target?.closest?.('tr[data-day-id]');
    if (!row?.dataset?.dayId) return;
    e.preventDefault();
    selectDayKeepingFocus(row.dataset.dayId, 'operationalTableBody');
  });

  // Lazy Windy Radar
  $('btnLoadWindyRadar')?.addEventListener('click', () => mountWindyRadar(state.radarOverlay));
  $('btnUnloadRadar')?.addEventListener('click', unloadWindyRadar);
  document.querySelectorAll('[data-radar-overlay]').forEach((btn) => {
    btn.addEventListener('click', () => mountWindyRadar(btn.dataset.radarOverlay || 'rain'));
  });
  $('btnToggleRadarCollapse')?.addEventListener('click', () => {
    state.radarCollapsed = !state.radarCollapsed;
    $('radarCardBody')?.classList.toggle('hidden', state.radarCollapsed);
    $('radarCollapseText').textContent = state.radarCollapsed ? 'Развернуть' : 'Свернуть';
    $('btnToggleRadarCollapse')?.setAttribute('aria-expanded', String(!state.radarCollapsed));
  });

  // Mobile Bottom Thumb Navigation
  document.querySelectorAll('.mobile-nav-btn[data-nav-target]').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.mobile-nav-btn').forEach((b) => b.classList.remove('is-active'));
      btn.classList.add('is-active');
      const targetId = btn.dataset.navTarget;
      if (targetId === 'sec-filters') {
        state.drawerOpenMobile = true;
        $('controlsDrawerBody')?.classList.add('is-open');
        $('drawerToggleChevron')?.classList.add('rotate-180');
        $('drawerToggleBtnText').textContent = 'Свернуть';
      }
      $(targetId)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });
}

// ============================================================================
// BOOTSTRAP & PWA UPDATE NOTIFICATION
// ============================================================================
function showPwaUpdateBanner(worker) {
  state.waitingSw = worker;
  $('pwaUpdateBanner')?.classList.remove('hidden');
}

function registerServiceWorker() {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  let reloading = false;
  // On the very first visit the fresh worker calls clients.claim(), which also fires
  // `controllerchange`. Reloading then would restart the page (and its data fetch) for nothing,
  // so only a change from one controller to another counts as an update.
  let hasController = Boolean(navigator.serviceWorker.controller);
  try {
    navigator.serviceWorker.addEventListener?.('controllerchange', () => {
      if (!hasController) {
        hasController = true;
        return;
      }
      if (reloading) return;
      reloading = true;
      if (typeof window !== 'undefined' && window.location?.reload) {
        window.location.reload();
      }
    });

    navigator.serviceWorker.register('./sw.js', { scope: './' })
      .then((reg) => {
        if (reg?.waiting) {
          showPwaUpdateBanner(reg.waiting);
        }
        reg?.addEventListener?.('updatefound', () => {
          const installing = reg.installing;
          if (!installing) return;
          installing.addEventListener('statechange', () => {
            if (installing.state === 'installed' && navigator.serviceWorker.controller) {
              showPwaUpdateBanner(installing);
            }
          });
        });
      })
      .catch(() => {});
  } catch (_) {}
}

function initApp() {
  registerServiceWorker();

  const cached = loadDatasetCache();
  if (cached && Array.isArray(cached.days) && cached.days.length) {
    state.dataset = cached;
    state.fromCache = true;
  } else {
    state.dataset = buildDynamicReferenceDataset();
    state.fromCache = false;
  }

  state.selectedHourSlot = getAbanNowParts().hour;
  applyPeriodPreset(state.activePreset, { silent: true });
  bindEventListeners();
  updateAllViews();

  if (state.sourceMode !== 'offline_cache') {
    refreshWeatherData(false);
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initApp);
} else {
  initApp();
}
