// Regression tests for the defects found in the v4 audit:
// retired AIFS model id, blocking slow soil/snow channel, silent heuristics,
// stored XSS through imported JSON, MET.no daily precipitation, 35-day coverage gaps.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getAbanClimatology } from '../js/config.js';
import { computeRollingMos, buildUnifiedDataset, buildPentadSummary } from '../js/ensemble.js';
import {
  fetchAllWeatherSources,
  normalizeOpenMeteoModelKeys,
  listEmptyModels,
  mergeQuantileFallback,
} from '../js/api.js';
import {
  sanitizeDataset,
  importDatasetJsonFile,
  saveDatasetCache,
  loadDatasetCache,
  clearDatasetCache,
  saveCompanionCache,
  loadCompanionCache,
} from '../js/storage.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readText = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const TODAY = '2026-11-20';

function addDaysIso(baseIso, deltaDays) {
  const [y, m, d] = baseIso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + deltaDays)).toISOString().slice(0, 10);
}

function hourlyTimes(startOffset, endOffset) {
  const out = [];
  for (let d = startOffset; d <= endOffset; d++) {
    const iso = addDaysIso(TODAY, d);
    for (let h = 0; h < 24; h++) out.push(`${iso}T${String(h).padStart(2, '0')}:00`);
  }
  return out;
}

function dailyTimes(startOffset, endOffset) {
  const out = [];
  for (let d = startOffset; d <= endOffset; d++) out.push(addDaysIso(TODAY, d));
  return out;
}

/** Open-Meteo style multi-model payload; `nullModels` come back as all-null series (retired ids). */
function makeMultiPayload(modelIds, nullModels = []) {
  const hTimes = hourlyTimes(-1, 2);
  const dTimes = dailyTimes(-1, 2);
  const hourly = { time: hTimes };
  const daily = { time: dTimes };
  modelIds.forEach((id, idx) => {
    const dead = nullModels.includes(id);
    hourly[`temperature_2m_${id}`] = hTimes.map((_, i) => (dead ? null : -8 + idx * 0.3 + Math.sin(i / 4)));
    hourly[`relative_humidity_2m_${id}`] = hTimes.map(() => (dead ? null : 80));
    hourly[`precipitation_${id}`] = hTimes.map(() => (dead ? null : 0));
    hourly[`wind_speed_10m_${id}`] = hTimes.map(() => (dead ? null : 3));
    hourly[`wind_direction_10m_${id}`] = hTimes.map(() => (dead ? null : 200));
    daily[`temperature_2m_max_${id}`] = dTimes.map(() => (dead ? null : -4 + idx * 0.3));
    daily[`temperature_2m_min_${id}`] = dTimes.map(() => (dead ? null : -11 + idx * 0.3));
    daily[`precipitation_sum_${id}`] = dTimes.map(() => (dead ? null : 0));
  });
  return { hourly, daily };
}

function makeCompanionPayload() {
  const hTimes = hourlyTimes(-1, 2);
  const dTimes = dailyTimes(-1, 2);
  return {
    current: { time: `${TODAY}T02:00`, temperature_2m: -8.5, surface_pressure: 999 },
    hourly_units: { snow_depth: 'm' },
    hourly: {
      time: hTimes,
      precipitation_probability: hTimes.map(() => 10),
      snow_depth: hTimes.map(() => 0.16),
      soil_temperature_0cm: hTimes.map(() => -2.1),
      soil_temperature_6cm: hTimes.map(() => -1.4),
      soil_temperature_18cm: hTimes.map(() => -0.3),
      soil_temperature_54cm: hTimes.map(() => 1.9),
      pressure_msl: hTimes.map(() => 1031),
      surface_pressure: hTimes.map(() => 999),
    },
    daily: {
      time: dTimes,
      uv_index_max: dTimes.map(() => 1),
      precipitation_probability_max: dTimes.map(() => 12),
      shortwave_radiation_sum: dTimes.map(() => 3.1),
    },
  };
}

function makeEnsemblePayload(days) {
  const time = dailyTimes(0, days - 1);
  const daily = { time };
  for (let m = 1; m <= 5; m++) {
    const tag = `member0${m}`;
    daily[`temperature_2m_max_${tag}`] = time.map(() => -6 + m);
    daily[`temperature_2m_min_${tag}`] = time.map(() => -15 + m);
    daily[`precipitation_sum_${tag}`] = time.map(() => m * 0.4);
    daily[`wind_speed_10m_max_${tag}`] = time.map(() => 3 + m * 0.5);
  }
  return { daily };
}

function jsonResponse(payload, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => payload };
}

/**
 * Installs a fake global fetch that mimics the upstream APIs.
 * The legacy `ecmwf_aifs025` id answers 200 with all-null series, exactly like the live API.
 */
function installFetchMock({ companionDelayMs = 120, companionStatus = 200, deadModels = ['ecmwf_aifs025'] } = {}) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    calls.push(url);
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const models = (url.searchParams.get('models') || '').split(',').filter(Boolean);

    if (url.hostname === 'api.open-meteo.com') {
      if (models.includes('best_match')) {
        await wait(companionDelayMs);
        return companionStatus === 200
          ? jsonResponse(makeCompanionPayload())
          : jsonResponse({ error: true, reason: 'Something went wrong.' }, companionStatus);
      }
      await wait(5);
      return jsonResponse(makeMultiPayload(models, deadModels));
    }
    if (url.hostname === 'previous-runs-api.open-meteo.com') {
      const time = hourlyTimes(-2, -1);
      const hourly = { time };
      for (const id of models) {
        const dead = deadModels.includes(id);
        hourly[`temperature_2m_${id}`] = time.map(() => (dead ? null : -8));
        hourly[`temperature_2m_previous_day1_${id}`] = time.map(() => (dead ? null : -7.4));
        hourly[`temperature_2m_previous_day2_${id}`] = time.map(() => (dead ? null : -7.1));
      }
      await wait(5);
      return jsonResponse({ hourly });
    }
    if (url.hostname === 'ensemble-api.open-meteo.com') {
      await wait(5);
      return jsonResponse(makeEnsemblePayload(models.includes('gfs_seamless') ? 33 : 16));
    }
    if (url.hostname === 'seasonal-api.open-meteo.com') {
      await wait(5);
      return jsonResponse(makeEnsemblePayload(35));
    }
    if (url.hostname === 'api.met.no') {
      return jsonResponse({ properties: { timeseries: [] } });
    }
    if (url.hostname === 'air-quality-api.open-meteo.com') {
      return jsonResponse({ current: { pm2_5: 4.2, pm10: 7, carbon_monoxide: 180, european_aqi: 18 } });
    }
    return jsonResponse({ error: true, reason: `unexpected host ${url.hostname}` }, 404);
  };
  return {
    calls,
    restore() {
      globalThis.fetch = original;
    },
  };
}

test('AIFS: live API id is requested and mapped back to the stable internal id', async () => {
  // Key mapping in isolation
  const mapped = normalizeOpenMeteoModelKeys({
    hourly: { time: ['t'], temperature_2m_ecmwf_aifs025_single: [1], temperature_2m_ecmwf_ifs025: [2] },
    daily: { time: ['d'], temperature_2m_max_ecmwf_aifs025_single: [3] },
  });
  assert.deepEqual(mapped.hourly.temperature_2m_ecmwf_aifs025, [1]);
  assert.deepEqual(mapped.daily.temperature_2m_max_ecmwf_aifs025, [3]);
  assert.equal('temperature_2m_ecmwf_aifs025_single' in mapped.hourly, false);
  assert.deepEqual(mapped.hourly.temperature_2m_ecmwf_ifs025, [2], 'other models must be untouched');

  // A model that answers with nothing but nulls is reported, not silently dropped
  assert.deepEqual(
    listEmptyModels({ hourly: { temperature_2m_a: [null, null], temperature_2m_b: [null, -3] } }, ['a', 'b', 'c']),
    ['a', 'c']
  );

  clearDatasetCache({ includeArchive: true, includeMos: true });
  const mock = installFetchMock();
  try {
    const bundle = await fetchAllWeatherSources({ mode: 'hybrid', forceRefresh: true });
    const multiCall = mock.calls.find(
      (u) => u.hostname === 'api.open-meteo.com' && !u.searchParams.get('models').includes('best_match')
    );
    const requested = multiCall.searchParams.get('models').split(',');
    assert.ok(requested.includes('ecmwf_aifs025_single'), `multi request must use the live AIFS id, got ${requested}`);
    assert.equal(requested.includes('ecmwf_aifs025'), false, 'retired AIFS id must not be requested');

    const aifs = bundle.openMeteoMulti.hourly.temperature_2m_ecmwf_aifs025;
    assert.ok(Array.isArray(aifs) && aifs.every((v) => Number.isFinite(v)), 'AIFS series must carry real values');
    assert.equal(bundle.channels.openMeteoMulti.status, 'ok');

    const prevCall = mock.calls.find((u) => u.hostname === 'previous-runs-api.open-meteo.com');
    assert.ok(prevCall.searchParams.get('models').split(',').includes('ecmwf_aifs025_single'));
    assert.ok(Array.isArray(bundle.previousRuns.hourly.temperature_2m_previous_day1_ecmwf_aifs025));

    const dataset = buildUnifiedDataset(bundle, { todayIso: TODAY });
    assert.ok(dataset.activeModels.includes('ecmwf_aifs025'), 'AIFS must take part in the ensemble');
    assert.ok(dataset.mos.models.ecmwf_aifs025, 'AIFS must be calibrated by MOS');
  } finally {
    mock.restore();
  }
});

test('a model that returns only nulls marks the channel as partial instead of passing silently', async () => {
  const mock = installFetchMock({ deadModels: ['ecmwf_aifs025', 'ecmwf_aifs025_single'] });
  try {
    const bundle = await fetchAllWeatherSources({ mode: 'hybrid', forceRefresh: true });
    assert.equal(bundle.channels.openMeteoMulti.status, 'partial');
    assert.match(bundle.channels.openMeteoMulti.detail, /AIFS/);
    assert.ok(bundle.openMeteoMulti, 'the remaining models are still delivered');
  } finally {
    mock.restore();
  }
});

test('slow soil/snow channel no longer blocks the first paint (onPartial) and falls back to stale cache', async () => {
  clearDatasetCache({ includeArchive: true, includeMos: true });
  let mock = installFetchMock({ companionDelayMs: 150 });
  try {
    const partials = [];
    const t0 = Date.now();
    let partialAtMs = null;
    const bundle = await fetchAllWeatherSources({
      mode: 'hybrid',
      forceRefresh: true,
      partialGraceMs: 15,
      onPartial: (b) => {
        partialAtMs = Date.now() - t0;
        partials.push(b);
      },
    });
    const totalMs = Date.now() - t0;

    assert.equal(partials.length, 1, 'exactly one partial slice is emitted');
    const partial = partials[0];
    assert.equal(partial.isPartial, true);
    assert.ok(partial.openMeteoMulti, 'partial slice already carries the core forecast');
    assert.equal(partial.openMeteoCompanion, null);
    assert.equal(partial.channels.openMeteoCompanion.status, 'pending');
    assert.ok(partial.pendingCount >= 1);
    assert.ok(partialAtMs < totalMs, `partial (${partialAtMs} ms) must precede the full bundle (${totalMs} ms)`);
    assert.ok(partialAtMs < 120, `partial slice must not wait for the 150 ms channel, took ${partialAtMs} ms`);

    // The partial slice is renderable and honest about what is missing
    const partialDs = buildUnifiedDataset(partial, { todayIso: TODAY });
    assert.equal(partialDs.isPartial, true);
    const partialToday = partialDs.days.find((d) => d.isoDate === TODAY);
    assert.equal(partialToday.dataQuality.soilEstimated, true);
    assert.equal(partialToday.dataQuality.snowEstimated, true);

    assert.equal(bundle.isPartial, false);
    assert.equal(bundle.pendingCount, 0);
    assert.equal(bundle.channels.openMeteoCompanion.status, 'ok');
    const fullToday = buildUnifiedDataset(bundle, { todayIso: TODAY }).days.find((d) => d.isoDate === TODAY);
    assert.equal(fullToday.dataQuality.soilEstimated, false);
    assert.equal(fullToday.dataQuality.snowEstimated, false);
    assert.equal(fullToday.snowDepthCm, 16);

    // Only the variables the ensemble consumes are requested (the old query asked for 20 hourly fields)
    const compCall = mock.calls.find(
      (u) => u.hostname === 'api.open-meteo.com' && u.searchParams.get('models') === 'best_match'
    );
    const hourlyVars = compCall.searchParams.get('hourly').split(',');
    assert.ok(hourlyVars.length <= 8, `companion query should stay lean, got ${hourlyVars.length} hourly vars`);
    assert.ok(hourlyVars.includes('snow_depth') && hourlyVars.includes('soil_temperature_54cm'));
  } finally {
    mock.restore();
  }

  // The fresh slice was cached without its time-stamped `current` block
  const cachedSlice = loadCompanionCache(60 * 60 * 1000);
  assert.ok(cachedSlice?.payload?.hourly?.snow_depth, 'companion slice must be cached');
  assert.equal(cachedSlice.payload.current, undefined, 'cached slice must not pin "now" to the past');

  // Upstream now fails: serve the stale slice instead of air-temperature heuristics
  mock = installFetchMock({ companionDelayMs: 5, companionStatus: 500 });
  try {
    const bundle = await fetchAllWeatherSources({ mode: 'hybrid', forceRefresh: true });
    assert.equal(bundle.channels.openMeteoCompanion.status, 'cached');
    assert.match(bundle.channels.openMeteoCompanion.detail, /Кэш/);
    assert.ok(bundle.openMeteoCompanion?.hourly?.snow_depth);
    const today = buildUnifiedDataset(bundle, { todayIso: TODAY }).days.find((d) => d.isoDate === TODAY);
    assert.equal(today.dataQuality.snowEstimated, false);
    assert.equal(today.snowDepthCm, 16);
  } finally {
    mock.restore();
  }

  // No cache and a failing upstream: the channel reports the error, nothing is invented
  clearDatasetCache({ includeArchive: true, includeMos: true });
  assert.equal(loadCompanionCache(), null);
  mock = installFetchMock({ companionDelayMs: 5, companionStatus: 500 });
  try {
    const bundle = await fetchAllWeatherSources({ mode: 'hybrid', forceRefresh: true });
    assert.equal(bundle.channels.openMeteoCompanion.status, 'error');
    assert.equal(bundle.openMeteoCompanion, null);
  } finally {
    mock.restore();
  }
});

test('soil and snow estimates are flagged; missing snow falls back to climatology, not 0 cm', () => {
  const bundle = {
    mode: 'open_meteo',
    fetchedAtIso: `${TODAY}T03:00:00.000Z`,
    openMeteoMulti: makeMultiPayload(['ecmwf_ifs025', 'icon_seamless', 'gfs_seamless']),
  };

  const noCompanion = buildUnifiedDataset(bundle, { todayIso: TODAY });
  const day = noCompanion.days.find((d) => d.isoDate === TODAY);
  const clim = getAbanClimatology(TODAY);
  assert.equal(day.dataQuality.soilEstimated, true);
  assert.equal(day.dataQuality.snowEstimated, true);
  assert.ok(clim.climSnowDepthCm > 3, 'sanity: late November has snow cover in Aban');
  assert.equal(day.snowDepthCm, clim.climSnowDepthCm, 'missing snow depth must use the flagged climatological normal');
  assert.equal(noCompanion.current.soilEstimated, true);
  assert.equal(noCompanion.current.snowEstimated, true);

  const withCompanion = buildUnifiedDataset(
    { ...bundle, openMeteoCompanion: makeCompanionPayload() },
    { todayIso: TODAY }
  );
  const day2 = withCompanion.days.find((d) => d.isoDate === TODAY);
  assert.equal(day2.dataQuality.soilEstimated, false);
  assert.equal(day2.dataQuality.snowEstimated, false);
  assert.equal(day2.snowDepthCm, 16);
  assert.equal(day2.soil54C, 1.9);
  assert.equal(withCompanion.current.soilEstimated, false);

  const pentads = buildPentadSummary(noCompanion.days);
  assert.equal(pentads[0].dataQuality.soilEstimated, true);
  assert.equal(pentads[0].dataQuality.snowEstimated, true);
});

test('35-day horizon: fallback ensemble fills only uncovered dates; uncovered days are marked', () => {
  const primary = {
    sources: ['gfs_seamless_ensemble'],
    dailyQuantiles: [
      { isoDate: '2026-12-21', maxP50C: -10 },
      { isoDate: '2026-12-22', maxP50C: -11 },
    ],
  };
  const fallback = {
    sources: ['ecmwf_seasonal'],
    dailyQuantiles: [
      { isoDate: '2026-12-22', maxP50C: 99 },
      { isoDate: '2026-12-23', maxP50C: -12 },
      { isoDate: '2026-12-24', maxP50C: -13 },
    ],
  };
  const merged = mergeQuantileFallback(primary, fallback);
  assert.deepEqual(merged.dailyQuantiles.map((d) => d.isoDate), ['2026-12-21', '2026-12-22', '2026-12-23', '2026-12-24']);
  assert.equal(merged.dailyQuantiles[1].maxP50C, -11, 'primary ensemble days must never be overwritten');
  assert.deepEqual(merged.sources, ['gfs_seamless_ensemble', 'ecmwf_seasonal']);
  assert.equal(mergeQuantileFallback(primary, { sources: [], dailyQuantiles: [] }), primary);
  assert.equal(mergeQuantileFallback(null, fallback).dailyQuantiles.length, 3);

  // Days without any ensemble behind them are flagged so the UI can label them "norm, not forecast"
  const ds = buildUnifiedDataset(
    {
      mode: 'open_meteo',
      fetchedAtIso: `${TODAY}T03:00:00.000Z`,
      openMeteoMulti: makeMultiPayload(['ecmwf_ifs025', 'icon_seamless', 'gfs_seamless']),
      ensemble35: {
        sources: ['gfs_seamless_ensemble'],
        dailyQuantiles: [
          { isoDate: addDaysIso(TODAY, 20), maxP10C: -20, maxP25C: -17, maxP50C: -14, maxP75C: -11, maxP90C: -8, minP10C: -30, minP25C: -26, minP50C: -22, minP75C: -19, minP90C: -15 },
        ],
      },
    },
    { todayIso: TODAY }
  );
  const covered = ds.days.find((d) => d.offsetFromToday === 20);
  const uncovered = ds.days.find((d) => d.offsetFromToday === 34);
  assert.equal(covered.dataQuality.ensembleBacked, true);
  assert.equal(uncovered.zone, 'subseasonal');
  assert.equal(uncovered.dataQuality.ensembleBacked, false);
});

test('MET.no daily precipitation counts each 6-hourly block in full', () => {
  // Local date 2026-11-25 (UTC+7): four 6-hourly steps, 3 mm per block => 12 mm for the day
  const step = (utcIso) => ({
    time: utcIso,
    data: {
      instant: { details: { air_temperature: -6, wind_speed: 3, wind_from_direction: 220, relative_humidity: 80 } },
      next_6_hours: { details: { precipitation_amount: 3 } },
    },
  });
  const ds = buildUnifiedDataset(
    {
      mode: 'hybrid',
      fetchedAtIso: `${TODAY}T03:00:00.000Z`,
      openMeteoMulti: makeMultiPayload(['ecmwf_ifs025']),
      metNo: {
        properties: {
          timeseries: [
            step('2026-11-24T17:00:00Z'),
            step('2026-11-24T23:00:00Z'),
            step('2026-11-25T05:00:00Z'),
            step('2026-11-25T11:00:00Z'),
          ],
        },
      },
    },
    { todayIso: TODAY }
  );
  const day = ds.days.find((d) => d.isoDate === '2026-11-25');
  assert.ok(day?.modelBreakdown?.met_no, 'MET.no must contribute to 2026-11-25');
  assert.equal(day.modelBreakdown.met_no.precipMm, 12, 'the daily sum used to be divided by 6 (2 mm)');
});

test('MOS summary states that MAE is measured against the model analysis', () => {
  const time = hourlyTimes(-2, -1);
  const mos = computeRollingMos({
    hourly: {
      time,
      temperature_2m_ecmwf_ifs025: time.map(() => -8),
      temperature_2m_previous_day1_ecmwf_ifs025: time.map(() => -7.5),
      temperature_2m_previous_day2_ecmwf_ifs025: time.map(() => -7.2),
    },
  });
  assert.equal(mos.bestModelId, 'ecmwf_ifs025');
  assert.match(mos.summaryRu, /MAE к анализу/);
  assert.match(mos.referenceRu, /анализ/);
});

test('imported / cached datasets are sanitised: no markup, numeric fields coerced', async () => {
  const collectStrings = (val, acc = []) => {
    if (typeof val === 'string') acc.push(val);
    else if (Array.isArray(val)) val.forEach((v) => collectStrings(v, acc));
    else if (val && typeof val === 'object') {
      for (const [k, v] of Object.entries(val)) {
        acc.push(k);
        collectStrings(v, acc);
      }
    }
    return acc;
  };
  const assertNoMarkup = (ds, label) => {
    for (const s of collectStrings(ds)) {
      assert.equal(/[<>"'`]/.test(s), false, `${label}: unsafe characters survived in "${s}"`);
    }
  };

  const payload = '<img src=x onerror="window.__xss=1">';
  const evil = {
    version: 4,
    sourceLabel: payload,
    syncedAt: "'><script>alert(1)</script>",
    channels: { evil: { id: 'evil', label: payload, status: 'error', error: payload, latencyMs: '5<b>' } },
    mos: { bestModelId: null, models: {}, summaryRu: payload },
    current: { tempC: -5, condRu: payload, obsTimeLabel: payload },
    days: [
      {
        isoDate: '2026-11-21',
        dateStr: payload,
        dayShort: '<b>Сб</b>',
        dayCond: payload,
        zone: 'deterministic"><svg onload=1>',
        maxC: -3,
        minC: '-9',
        confidencePct: '"><script>alert(1)</script>',
        snowDepthCm: '12',
        windDirShort: payload,
        inversion: { active: true, deltaC: '<i>', noteRu: payload },
        hours: [{ hour: 0, hourStr: '<b>00</b>', tempC: -5 }, { hourStr: 'no hour index' }, null],
      },
      { isoDate: '2026-11-20', maxC: -2, minC: -8 },
      { isoDate: 'not-a-date"><img>', maxC: 1, minC: 0 },
      { isoDate: '2026-11-22', maxC: 'NaN', minC: -4 },
      'garbage',
      null,
    ],
  };

  const clean = sanitizeDataset(evil);
  assertNoMarkup(clean, 'sanitizeDataset');
  assert.deepEqual(clean.days.map((d) => d.isoDate), ['2026-11-20', '2026-11-21'], 'invalid days dropped, valid ones sorted');
  const day = clean.days[1];
  assert.equal(day.id, 'day_2026-11-21');
  assert.equal(day.minC, -9, 'numeric strings are coerced');
  assert.equal(day.snowDepthCm, 12);
  assert.equal(day.confidencePct, null, 'non-numeric value in a numeric field is dropped');
  assert.equal(day.hours.length, 1, 'malformed hour rows are dropped');
  assert.equal(evil.days[0].dateStr, payload, 'input object must not be mutated');

  assert.equal(sanitizeDataset(null), null);
  assert.equal(sanitizeDataset({ days: 'nope' }), null);
  assert.equal(sanitizeDataset({ days: [{ isoDate: 'x' }] }), null);

  // Prototype pollution keys never make it through
  const polluted = sanitizeDataset(JSON.parse('{"days":[{"isoDate":"2026-11-20","maxC":1,"minC":0,"__proto__":{"polluted":true},"constructor":{"x":1}}]}'));
  assert.equal(Object.prototype.hasOwnProperty.call(polluted.days[0], '__proto__'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(polluted.days[0], 'constructor'), false);
  assert.equal({}.polluted, undefined);

  // Import path: the sanitised copy is what gets returned AND persisted
  clearDatasetCache({ includeArchive: true, includeMos: true });
  const imported = await importDatasetJsonFile(JSON.stringify({ dataset: evil }));
  assertNoMarkup(imported, 'importDatasetJsonFile');
  assertNoMarkup(loadDatasetCache(), 'loadDatasetCache after import');
  await assert.rejects(() => importDatasetJsonFile('{"days":[{"isoDate":"bad"}]}'), /Неверная структура/);
  await assert.rejects(() => importDatasetJsonFile('{not json'), /Некорректный JSON/);

  // A cache poisoned by something else on the same origin is neutralised on load
  saveDatasetCache(evil);
  assertNoMarkup(loadDatasetCache(), 'loadDatasetCache on a poisoned cache');
  clearDatasetCache({ includeArchive: true, includeMos: true });

  // Companion cache roundtrip + expiry
  saveCompanionCache({ hourly: { time: [] } });
  assert.ok(loadCompanionCache(1000));
  assert.equal(loadCompanionCache(-1), null, 'expired slice is not served');
  clearDatasetCache({ includeArchive: true, includeMos: true });
});

test('static hardening: CSP, escaped sinks, first-visit reload guard, auto-refresh, compact mobile header', () => {
  const indexHtml = readText('index.html');
  const appJs = readText('js/app.js');
  const css = readText('css/styles.css');

  // Content-Security-Policy: scripts only from this origin, no inline script execution
  const cspMatch = indexHtml.match(/<meta[^>]+http-equiv=["']Content-Security-Policy["'][^>]+content=["']([^"]+)["']/i);
  assert.ok(cspMatch, 'index.html must declare a Content-Security-Policy');
  const directives = Object.fromEntries(
    cspMatch[1].split(';').map((part) => {
      const [name, ...values] = part.trim().split(/\s+/);
      return [name, values];
    })
  );
  assert.deepEqual(directives['script-src'], ["'self'"], "script-src must be exactly 'self'");
  assert.deepEqual(directives['object-src'], ["'none'"]);
  assert.deepEqual(directives['frame-src'], ['https://embed.windy.com']);
  for (const host of [
    'https://weather.googleapis.com',
    'https://api.open-meteo.com',
    'https://previous-runs-api.open-meteo.com',
    'https://ensemble-api.open-meteo.com',
    'https://seasonal-api.open-meteo.com',
    'https://archive-api.open-meteo.com',
    'https://air-quality-api.open-meteo.com',
    'https://api.met.no',
  ]) {
    assert.ok(directives['connect-src'].includes(host), `connect-src must allow ${host}`);
  }
  // The policy is only viable while the page has no inline scripts / inline event handlers
  assert.equal(/<script(?![^>]*\bsrc=)[^>]*>/i.test(indexHtml), false, 'no inline <script> blocks');
  assert.equal(/\son[a-z]+\s*=\s*["']/i.test(indexHtml), false, 'no inline on*="" handlers');

  // Every API host the code talks to is covered by connect-src
  const apiJs = readText('js/api.js');
  const usedHosts = new Set([...apiJs.matchAll(/https:\/\/([a-z0-9.-]+)\//g)].map((m) => `https://${m[1]}`));
  for (const host of usedHosts) {
    assert.ok(directives['connect-src'].includes(host), `api.js talks to ${host}, which connect-src does not allow`);
  }

  // The XSS sink: dataset strings are escaped before they reach innerHTML
  assert.equal(/\.map\(\(d\)\s*=>\s*d\.dateStr\)/.test(appJs), false, 'dateStr must not be interpolated unescaped');
  assert.match(appJs, /escapeHtml\(d\.dateStr\)/);
  assert.equal(/\$\{(?:day|d|p)\.confidencePct\b/.test(appJs), false, 'confidencePct must go through num()');
  assert.equal(/\$\{p\.snowDepthCm\}/.test(appJs), false, 'snowDepthCm must not be interpolated raw');

  // First-visit double reload guard, auto-refresh and Esc for the dialog
  assert.match(appJs, /hasController/);
  assert.match(appJs, /visibilitychange/);
  assert.match(appJs, /e\.key === 'Escape'/);
  assert.match(appJs, /onPartial:\s*applyBundle/);

  // Compact mobile header
  assert.match(css, /@media \(max-width: 639\.98px\)[\s\S]*\.header-brand[\s\S]*display: contents/);
});
