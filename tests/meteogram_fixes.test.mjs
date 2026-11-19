// Regression tests for the "Метеограммы, веер P10–P90 и полевая таблица" section:
// zeros in °F mode, invented far-range series, inconsistent pentads, chart axes / labels, keyboard.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getAbanClimatology } from '../js/config.js';
import { toFiniteNumber, blendWindVectors, NO_DIRECTION } from '../js/physics.js';
import { buildUnifiedDataset, buildPentadSummary, computeDayWindowStats } from '../js/ensemble.js';
import {
  renderTempEnsembleChart,
  renderPrecipSnowChart,
  renderWindPressureChart,
  renderSoilProfileChart,
} from '../js/charts.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readText = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const TODAY = '2026-11-20';
const MODELS = ['ecmwf_ifs025', 'icon_seamless', 'gfs_seamless'];

function addDaysIso(baseIso, deltaDays) {
  const [y, m, d] = baseIso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + deltaDays)).toISOString().slice(0, 10);
}

/** Full pipeline dataset: 1 archive day, 16 modelled days (0..15), ensemble quantiles for 0..34. */
function buildDataset() {
  const dayOffsets = Array.from({ length: 17 }, (_, i) => i - 1); // -1..15
  const dTimes = dayOffsets.map((o) => addDaysIso(TODAY, o));
  const hTimes = dTimes.flatMap((iso) => Array.from({ length: 24 }, (_, h) => `${iso}T${String(h).padStart(2, '0')}:00`));
  // Day-mean MSL pressure with two sharp day-to-day swings (offsets 3 and 4)
  const mslByOffset = (o) => 1020 + (o === 3 ? -14 : o === 4 ? 6 : 0);

  const hourly = { time: hTimes };
  const daily = { time: dTimes };
  MODELS.forEach((id, idx) => {
    hourly[`temperature_2m_${id}`] = hTimes.map((_, i) => -9 + idx * 0.4 + 3 * Math.sin((i % 24) / 24 * 2 * Math.PI));
    hourly[`relative_humidity_2m_${id}`] = hTimes.map(() => 82);
    hourly[`dew_point_2m_${id}`] = hTimes.map(() => -11.5);
    hourly[`precipitation_${id}`] = hTimes.map((_, i) => (i % 24 === 14 ? 0.5 : 0));
    hourly[`pressure_msl_${id}`] = hTimes.map((_, i) => mslByOffset(dayOffsets[Math.floor(i / 24)]));
    hourly[`cloud_cover_${id}`] = hTimes.map(() => 60);
    hourly[`wind_speed_10m_${id}`] = hTimes.map(() => 3.5);
    hourly[`wind_direction_10m_${id}`] = hTimes.map(() => 225);
    hourly[`wind_gusts_10m_${id}`] = hTimes.map(() => 7);
    daily[`temperature_2m_max_${id}`] = dTimes.map(() => -6 + idx * 0.4);
    daily[`temperature_2m_min_${id}`] = dTimes.map(() => -12 + idx * 0.4);
    daily[`precipitation_sum_${id}`] = dTimes.map(() => 0.5);
    daily[`wind_speed_10m_max_${id}`] = dTimes.map(() => 5);
    daily[`wind_gusts_10m_max_${id}`] = dTimes.map(() => 9);
    daily[`wind_direction_10m_dominant_${id}`] = dTimes.map(() => 225);
  });

  const companion = {
    hourly_units: { snow_depth: 'm' },
    hourly: {
      time: hTimes,
      precipitation_probability: hTimes.map(() => 20),
      snow_depth: hTimes.map(() => 0.24),
      soil_temperature_0cm: hTimes.map(() => -6),
      soil_temperature_6cm: hTimes.map(() => -1),
      soil_temperature_18cm: hTimes.map(() => -0.2),
      soil_temperature_54cm: hTimes.map(() => 0.9),
    },
    daily: { time: dTimes, uv_index_max: dTimes.map(() => 1) },
  };

  const dailyQuantiles = Array.from({ length: 35 }, (_, o) => {
    const clim = getAbanClimatology(addDaysIso(TODAY, o));
    return {
      isoDate: addDaysIso(TODAY, o),
      maxP10C: clim.climMaxC - 6, maxP25C: clim.climMaxC - 3, maxP50C: clim.climMaxC, maxP75C: clim.climMaxC + 3, maxP90C: clim.climMaxC + 6,
      minP10C: clim.climMinC - 7, minP25C: clim.climMinC - 3, minP50C: clim.climMinC, minP75C: clim.climMinC + 3, minP90C: clim.climMinC + 7,
      precipP50Mm: 0.4, precipP75Mm: 1.5, precipP90Mm: 3, windP50Ms: 4.2, windP90Ms: 7.5,
      probBelowMinus20: 30, probPrecipOver5: 5,
    };
  });

  return buildUnifiedDataset(
    {
      mode: 'open_meteo',
      fetchedAtIso: `${TODAY}T03:00:00.000Z`,
      openMeteoMulti: { hourly, daily },
      openMeteoCompanion: companion,
      ensemble35: { sources: ['gfs_seamless_ensemble'], dailyQuantiles },
    },
    { todayIso: TODAY }
  );
}

function makeContainer() {
  const listeners = {};
  return {
    innerHTML: '',
    listeners,
    addEventListener(type, fn) {
      (listeners[type] ||= []).push(fn);
    },
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
  };
}

const UI = {
  unit: 'metric',
  pressureMode: 'station',
  timeWindow: 'full',
  selectedDayId: `day_${TODAY}`,
  showClimatology: true,
  showModelLines: true,
  groupByPentad: false,
};

const nodeIds = (html) => [...html.matchAll(/<g class="cursor-pointer" data-day-id="([^"]+)"/g)].map((m) => m[1]);
const count = (html, re) => (html.match(re) || []).length;
const SELECTION_RECT = /stroke="rgba\(56,189,248,0\.4\d?\)"/g;

test('strict numeric coercion: a missing °F / mph override is not zero', () => {
  assert.equal(toFiniteNumber(null), null);
  assert.equal(toFiniteNumber(undefined), null);
  assert.equal(toFiniteNumber(''), null);
  assert.equal(toFiniteNumber('abc'), null);
  assert.equal(toFiniteNumber(0), 0);
  assert.equal(toFiniteNumber('13'), 13);

  // The formatters live in app.js (DOM module): pin the fix statically
  const appJs = readText('js/app.js');
  assert.equal(/Number\.isFinite\(Number\(fOverride\)\)/.test(appJs), false, 'Number(null) === 0 must not be read as a 0°F override');
  assert.equal(/Number\.isFinite\(Number\(mphOverride\)\)/.test(appJs), false, 'Number(null) === 0 must not be read as a 0 mph override');
  assert.match(appJs, /function resolveImperial\(override, convert, metricValue\)/);
  assert.match(appJs, /toFiniteNumber\(override\)/);
  // No pressure placeholder in the UI either
  assert.equal(/pressureMslMm \?\? 745|\?\? 745;|\?\? 765;/.test(appJs), false, 'getPressurePair must not fall back to 745 / 765 mm');
});

test('blendWindVectors never invents a bearing', () => {
  const speedOnly = blendWindVectors([
    { speedMs: 4, gustMs: 7, dirDeg: null },
    { speedMs: 6, gustMs: 9 },
  ]);
  assert.equal(speedOnly.windDeg, null);
  assert.equal(speedOnly.windDirShort, NO_DIRECTION.s);
  assert.equal(speedOnly.windDirFull, null);
  assert.equal(speedOnly.windMs, 5, 'speed is still averaged');

  const mixed = blendWindVectors([
    { speedMs: 4, dirDeg: null, weight: 5 },
    { speedMs: 4, dirDeg: 90, weight: 1 },
  ]);
  assert.equal(mixed.windDeg, 90, 'direction comes only from samples that have one');
  assert.equal(mixed.windDirShort, 'В');

  const empty = blendWindVectors([]);
  assert.equal(empty.windDeg, null);
  assert.equal(empty.windDirShort, '—');
});

test('far-range days carry no invented pressure / bearing, and no fake baric jump appears where data ends', () => {
  const ds = buildDataset();
  const byOffset = (o) => ds.days.find((d) => d.offsetFromToday === o);

  const near = byOffset(1);
  assert.ok(Number.isFinite(near.pressureStationMm) && Number.isFinite(near.pressureMslMm));
  assert.equal(near.windDeg, 225);
  assert.equal(near.windDirShort, 'ЮЗ');
  assert.deepEqual(
    [near.dataQuality.hasPressure, near.dataQuality.hasWindDirection, near.dataQuality.humidityEstimated],
    [true, true, false]
  );

  for (const o of [16, 20, 34]) {
    const far = byOffset(o);
    assert.equal(far.zone, 'subseasonal');
    assert.equal(far.pressureStationMm, null, `day +${o}: station pressure must be null, not a default`);
    assert.equal(far.pressureMslMm, null);
    assert.equal(far.pressureStationHpa, null);
    assert.equal(far.windDeg, null, `day +${o}: wind bearing must be null, not 250°`);
    assert.equal(far.windDirShort, '—');
    assert.ok(far.windMs > 0, 'wind speed (ensemble P50) is still there');
    assert.equal(far.deltaP24hMm, null);
    assert.deepEqual(
      [far.dataQuality.hasPressure, far.dataQuality.hasWindDirection, far.dataQuality.humidityEstimated, far.dataQuality.soilEstimated, far.dataQuality.snowEstimated],
      [false, false, true, true, true]
    );
    assert.ok(far.hours.every((h) => h.pressureStationMm === null && h.windDirShort === '—'), 'synthetic hours inherit "no data"');
    assert.equal(far.nextNightWindDirShort, '—');
  }

  // The boundary day used to show a "jump" of real pressure against the 1013 hPa default
  assert.ok(Number.isFinite(byOffset(15).pressureStationMm));
  assert.equal(byOffset(16).deltaP24hMm, null);
  const falseJumps = ds.days.filter((d) => d.offsetFromToday >= 15 && Math.abs(d.deltaP24hMm ?? 0) >= 6);
  assert.deepEqual(falseJumps.map((d) => d.isoDate), []);

  // Real jumps are still detected (-14 hPa then +6 hPa day to day)
  assert.ok(byOffset(3).deltaP24hMm <= -9, `expected a sharp fall on day +3, got ${byOffset(3).deltaP24hMm}`);
  assert.ok(byOffset(4).deltaP24hMm >= 13, `expected a sharp rise on day +4, got ${byOffset(4).deltaP24hMm}`);

  // Window stats on a record without pressure must not resurrect a default either
  const stats = computeDayWindowStats({ ...byOffset(20), hours: [] }, 'full');
  assert.ok(stats.hours.every((h) => h.pressureStationMm === null));
});

test('pentads: one grouping for every chart and the table, honest ΔP and gaps', () => {
  const ds = buildDataset();
  const days = ds.days.filter((d) => d.offsetFromToday >= 0);
  assert.equal(days.length, 35);
  const pentads = buildPentadSummary(days);
  assert.equal(pentads.length, 7);
  assert.equal(pentads[2].label, '30 ноя–4 дек', 'cross-month label keeps both months');

  const first = pentads[0];
  assert.deepEqual(first.dayIds, days.slice(0, 5).map((d) => d.id));
  // Sharpest daily change inside the pentad (signed), not last-minus-first
  const dailyDeltas = days.slice(0, 5).map((d) => d.deltaP24hMm).filter((v) => v !== null);
  const peak = dailyDeltas.reduce((a, b) => (Math.abs(b) > Math.abs(a) ? b : a));
  assert.equal(first.deltaP24hMm, Math.round(peak));
  assert.notEqual(first.deltaP24hMm, Math.round(days[4].pressureStationMm - days[0].pressureStationMm));
  // Model lines survive grouping
  assert.ok(Number.isFinite(first.modelBreakdown.ecmwf_ifs025.maxC));
  assert.ok(Number.isFinite(first.modelBreakdown.gfs_seamless.minC));

  const farPentad = pentads[5];
  assert.equal(farPentad.pressureStationMm, null, 'no pressure in the group => null, not 745');
  assert.equal(farPentad.pressureMslMm, null);
  assert.equal(farPentad.deltaP24hMm, null);
  assert.equal(farPentad.windDirShort, '—');
  assert.equal(farPentad.dataQuality.hasPressure, false);
  assert.equal(farPentad.dataQuality.humidityEstimated, true);

  // Mixed group (days 15..19): mean over the days that have pressure
  const mixed = pentads[3];
  assert.equal(mixed.pressureStationMm, days[15].pressureStationMm);

  // Every chart renders exactly these 7 items, in the same order
  const selectedDayId = days[3].id; // 4th day of the first pentad — not its id
  const ui = { ...UI, groupByPentad: true, selectedDayId };
  const expectedIds = pentads.map((p) => p.id);
  for (const [name, fn] of [
    ['temp', renderTempEnsembleChart],
    ['precip', renderPrecipSnowChart],
    ['wind', renderWindPressureChart],
    ['soil', renderSoilProfileChart],
  ]) {
    const el = makeContainer();
    fn(el, pentads, ui, () => {});
    assert.deepEqual(nodeIds(el.innerHTML), expectedIds, `${name} chart must use the shared pentad grouping`);
    assert.equal(count(el.innerHTML, SELECTION_RECT), 1, `${name} chart must highlight the pentad containing the selected day`);
    assert.equal(/\bNaN\b|undefined|Infinity/.test(el.innerHTML), false, `${name} chart has NaN/undefined`);
  }

  // Wind chart in pentad mode: the marker is the sharpest daily change, and the legend says so
  const windEl = makeContainer();
  renderWindPressureChart(windEl, pentads, ui, () => {});
  assert.match(windEl.innerHTML, /макс\. суточный \|ΔP\| ≥ 6 мм/);
  const jumpLabels = [...windEl.innerHTML.matchAll(/data-pressure-jump="true"[^>]*>(Δ[+-]?\d+)</g)].map((m) => m[1]);
  assert.deepEqual(jumpLabels, [`Δ${first.deltaP24hMm > 0 ? '+' : ''}${first.deltaP24hMm}`]);

  // The chart no longer keeps a second, different grouping
  assert.equal(/groupDaysIntoPentads/.test(readText('js/charts.js')), false);
  assert.match(readText('js/app.js'), /renderTempEnsembleChart\(\$\('tempChartWrapper'\), chartItems,/);
});

test('charts: axes, units, estimate styling and explicit "no data" instead of invented lines', () => {
  const ds = buildDataset();
  const days = ds.days.filter((d) => d.offsetFromToday >= 0);
  const ui = { ...UI, selectedDayId: days[20].id };

  // --- temperature: a real Y axis, and the selected fan day gets P10/P90 whiskers
  const tempEl = makeContainer();
  renderTempEnsembleChart(tempEl, days, ui, () => {});
  const yTicks = [...tempEl.innerHTML.matchAll(/data-axis-tick="y"[^>]*>([^<]+)</g)].map((m) => m[1]);
  assert.ok(yTicks.length >= 6, `expected Y tick labels on both edges, got ${yTicks.length}`);
  assert.ok(yTicks.every((t) => /^[+-]?\d+°$/.test(t)), `unexpected tick labels: ${yTicks.join(' ')}`);
  assert.match(tempEl.innerHTML, /Веер P10–P90/);
  assert.equal(count(tempEl.innerHTML, /data-fan-whisker="max"/g), 1);
  assert.equal(count(tempEl.innerHTML, /data-fan-whisker="min"/g), 1);
  // Deep-winter scale follows the data: no tick above the warmest plotted value + padding
  const warmest = Math.max(...days.map((d) => Math.max(d.maxC, d.maxP90C ?? d.maxC, d.climMaxC)));
  assert.ok(Math.max(...yTicks.map((t) => parseInt(t, 10))) <= warmest + 3, 'scale must not be forced up to +7 °C');

  // --- precipitation: millimetres, estimated snow dashed + "≈", formula humidity not plotted
  const precipEl = makeContainer();
  renderPrecipSnowChart(precipEl, days, ui, () => {});
  const precipTicks = [...precipEl.innerHTML.matchAll(/data-axis-tick="precip"[^>]*>([^<]+)</g)].map((m) => m[1]);
  assert.equal(precipTicks.length, 3);
  assert.ok(precipTicks.every((t) => /^\d+\.\dмм$/.test(t)), `precip axis must be labelled in мм, got ${precipTicks.join(' ')}`);
  assert.equal(count(precipEl.innerHTML, /data-estimate="snow"/g), 1);
  assert.ok(count(precipEl.innerHTML, />≈\d+см</g) >= 3, 'estimated snow labels carry ≈');
  assert.ok(count(precipEl.innerHTML, />\d+см</g) >= 3, 'modelled snow labels stay plain');
  assert.match(precipEl.innerHTML, /P75 осадков/);
  assert.equal(/Покров см \(P75 усы\)/.test(precipEl.innerHTML), false);
  const humidityNodes = count(precipEl.innerHTML, /stroke="#a78bfa" stroke-width="2"\/>/g);
  assert.equal(humidityNodes, days.filter((d) => !d.dataQuality.humidityEstimated).length);

  // --- wind / pressure: gap + note where there is no pressure, value AND Δ on jump days, "—" bearing
  const windEl = makeContainer();
  renderWindPressureChart(windEl, days, ui, () => {});
  assert.equal(count(windEl.innerHTML, /data-no-pressure="true"/g), 1);
  assert.match(windEl.innerHTML, /давление: нет данных на этом горизонте/);
  const pressureLabels = count(windEl.innerHTML, /data-pressure-value="true"/g);
  assert.ok(pressureLabels >= 1 && pressureLabels <= 16, 'pressure values only where pressure exists');
  const groups = windEl.innerHTML.split('<g class="cursor-pointer"').slice(1);
  const jumpGroups = groups.filter((g) => g.includes('data-pressure-jump="true"'));
  assert.equal(jumpGroups.length, 2, 'the two real swings are flagged, nothing at the data boundary');
  assert.ok(jumpGroups.every((g) => g.includes('data-pressure-value="true"')), 'a jump marker must not replace the pressure value');
  assert.ok(groups[20].includes('>—</text>'), 'far-range day shows «—» for wind direction');
  assert.ok(count(windEl.innerHTML, /data-axis-tick="wind"/g) >= 2);
  assert.equal(/\bNaN\b|undefined|null/.test(windEl.innerHTML), false);

  // --- soil: estimated stretch dashed, labels with ≈, legend explains it
  const soilEl = makeContainer();
  renderSoilProfileChart(soilEl, days, ui, () => {});
  for (const key of ['soil0C', 'soil6C', 'soil18C', 'soil54C', 'dewPointC']) {
    assert.equal(count(soilEl.innerHTML, new RegExp(`data-estimate="${key}"`, 'g')), 1, `${key}: estimated run must be a separate dashed path`);
  }
  assert.match(soilEl.innerHTML, /≈ оценка \(нет данных модели\)/);
  assert.ok(count(soilEl.innerHTML, />≈[+-]?\d/g) >= 5);
  assert.ok(count(soilEl.innerHTML, /data-axis-tick="y"/g) >= 3);

  // Fully modelled period: no estimate styling at all
  const nearEl = makeContainer();
  renderSoilProfileChart(nearEl, days.slice(0, 10), ui, () => {});
  assert.equal(/data-estimate=|≈/.test(nearEl.innerHTML), false);
});

test('keyboard: Enter on a chart node selects the day and returns focus to it after re-render', () => {
  const ds = buildDataset();
  const days = ds.days.filter((d) => d.offsetFromToday >= 0 && d.offsetFromToday <= 9);
  const targetId = days[4].id;

  let focused = null;
  const makeNode = (id) => ({
    getAttribute: (name) => (name === 'data-day-id' ? id : null),
    closest: () => makeNode(id),
    focus: () => {
      focused = id;
    },
  });
  const el = makeContainer();
  el.querySelectorAll = () => days.map((d) => makeNode(d.id));

  const selected = [];
  renderTempEnsembleChart(el, days, UI, (id) => selected.push(id));
  assert.equal(el.listeners.keydown.length, 1);

  let prevented = false;
  el.listeners.keydown[0]({ key: 'Enter', target: makeNode(targetId), preventDefault: () => { prevented = true; } });
  assert.deepEqual(selected, [targetId]);
  assert.equal(prevented, true);
  assert.equal(focused, targetId, 'focus must come back to the selected day');

  focused = null;
  el.listeners.keydown[0]({ key: 'a', target: makeNode(targetId), preventDefault() {} });
  assert.equal(focused, null);
  assert.equal(selected.length, 1);
});

test('static: tabs are real ARIA tabs, the selection line is live, table rows are keyboard-reachable', () => {
  const indexHtml = readText('index.html');
  const appJs = readText('js/app.js');
  const css = readText('css/styles.css');

  const tabs = [...indexHtml.matchAll(/<button id="tabBtn-(\w+)"[^>]*>/g)];
  assert.equal(tabs.length, 4);
  for (const [tag, key] of tabs) {
    assert.match(tag, /role="tab"/, `tab ${key} needs role="tab"`);
    assert.match(tag, /aria-selected="(true|false)"/);
    assert.match(tag, new RegExp(`aria-controls="tabContent-${key}"`));
    assert.match(indexHtml, new RegExp(`id="tabContent-${key}"[^>]*role="tabpanel"[^>]*aria-labelledby="tabBtn-${key}"`));
  }
  assert.equal(count(indexHtml, /role="tab" aria-selected="true"/g), 1);
  assert.match(indexHtml, /id="activeChartSummaryText"[^>]*aria-live="polite"/);
  assert.match(indexHtml, /Линии моделей \(Max\)/);
  assert.match(indexHtml, /data-table data-table--sticky-first/);

  assert.match(appJs, /function renderChartSelectionSummary\(\)/);
  assert.match(appJs, /btn\.setAttribute\('aria-selected', String\(isActive\)\)/);
  assert.match(appJs, /function selectDayKeepingFocus\(dayId, containerId\)/);
  assert.match(appJs, /<tr data-day-id="\$\{escapeHtml\(d\.id\)\}" tabindex="0"/);
  assert.match(css, /\.data-table--sticky-first th:first-child,\s*\.data-table--sticky-first td:first-child \{\s*position: sticky;/);
});
