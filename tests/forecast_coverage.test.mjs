import test from 'node:test';
import assert from 'node:assert/strict';
import { buildUnifiedDataset, computeDayWindowStats } from '../js/ensemble.js';
import { sanitizeDataset } from '../js/storage.js';

const today = '2026-11-22';
const tomorrow = '2026-11-23';
const model = 'ecmwf_ifs025';

function forecast({ dates = [today], hourly, amounts = [24], ...sources } = {}) {
  const daily = {
    time: dates,
    [`temperature_2m_max_${model}`]: dates.map(() => 8),
    [`temperature_2m_min_${model}`]: dates.map(() => 2),
    [`precipitation_sum_${model}`]: amounts,
  };
  return buildUnifiedDataset({ fetchedAtIso: today + 'T05:00:00Z', openMeteoMulti: { daily, hourly }, ...sources });
}

test('a single daily forecast covers exactly one calendar date, including after snapshot reload', () => {
  const ds = forecast();
  for (const snapshot of [ds, sanitizeDataset(JSON.parse(JSON.stringify(ds)))]) {
    assert.equal(snapshot.days.length, 16);
    assert.deepEqual(snapshot.days.filter(d => d.hasForecast).map(d => d.isoDate), [today]);
    for (const gap of snapshot.days.slice(1)) {
      assert.equal(gap.hasForecast, false);
      assert.deepEqual(gap.hours, []);
      assert.equal(gap.maxC, null);
      assert.equal(gap.minC, null);
      assert.equal(gap.precipMm, null);
      assert.equal(gap.confidencePct, null);
      assert.equal(gap.dataQuality.roadRiskInputsAvailable, false);
      assert.equal(computeDayWindowStats(gap).avgC, null);
    }
    assert.equal(snapshot.days[0].nextNightMinC, null);
  }
});

test('an interior gap stays empty and a later ensemble date retains its quantiles', () => {
  const far = '2026-12-14';
  const ds = forecast({ dates: [today, '2026-11-24'], amounts: [24, 3], ensemble35: {
    dailyQuantiles: [{ isoDate: far, maxP50C: -4, maxP90C: -1, minP50C: -12 }],
  } });
  assert.deepEqual(ds.days.filter(d => d.hasForecast).map(d => d.isoDate), [today, '2026-11-24', far]);
  const ensemble = ds.days.find(d => d.isoDate === far);
  assert.equal(ensemble.dataQuality.ensembleBacked, true);
  assert.ok(ensemble.maxP90C > ensemble.maxC);
});

test('24 mm reported for a day creates no hourly amount, probability, phase or overnight total', () => {
  const ds = forecast();
  const day = ds.days[0];
  assert.equal(day.precipMm, 24);
  assert.equal(day.hours.length, 24);
  assert.ok(day.hours.every(h => h.precipMm === null && h.precipProb === null && h.precipPhase === null));
  assert.equal(day.precipDay, null);
  assert.equal(day.precipNight, null);
  assert.equal(day.nextNightPrecipMm, null);
  assert.equal(ds.current.precipMm, null);
  assert.equal(ds.current.precipProb, null);
  assert.equal(ds.controlPoint.precipProb, null);
  for (const window of ['full', 'day_shift', 'night']) {
    assert.equal(computeDayWindowStats(day, window).sumPrecipMm, null);
    assert.equal(computeDayWindowStats(day, window).maxPrecipProb, null);
  }
});

test('sparse hourly rain, dry observations and probability-only readings stay in their own hour', () => {
  for (const temperatures of [[6, 6, 6, 6], [null, null, null, null]]) {
    const hourly = {
      // Open-Meteo timestamps mark the end of each precipitation interval.
      time: [10, 11, 13, 15].map(h => today + 'T' + String(h).padStart(2, '0') + ':00'),
      [`temperature_2m_${model}`]: temperatures,
      [`precipitation_${model}`]: [1.25, 0, null, 0.02],
      [`precipitation_probability_${model}`]: [80, 0, 25, null],
    };
    const { days: [day] } = forecast({ hourly });
    const fields = h => [day.hours[h].precipMm, day.hours[h].precipProb];
    assert.equal(day.precipMm, 24);
    assert.deepEqual(fields(9), [1.25, 80]);
    assert.deepEqual(fields(10), [0, 0]);
    assert.deepEqual(fields(11), [null, null]);
    assert.deepEqual(fields(12), [null, 25]);
    assert.deepEqual(fields(14), [0.02, null]);
    assert.equal(computeDayWindowStats(day).sumPrecipMm, null);
    assert.deepEqual(sanitizeDataset({ days: [day] }).days[0].hours, day.hours);
  }
});

test('a complete hourly series can report zero for a full night across two calendar dates', () => {
  const dates = [today, tomorrow];
  const time = dates.flatMap(date => Array.from({ length: 24 }, (_, h) => date + 'T' + String(h).padStart(2, '0') + ':00'));
  const hourly = { time, [`temperature_2m_${model}`]: time.map(() => 8), [`precipitation_${model}`]: time.map(() => 0) };
  const ds = forecast({ dates, amounts: [0, 0], hourly });
  assert.equal(computeDayWindowStats(ds.days[0]).sumPrecipMm, 0);
  assert.equal(ds.days[0].nextNightPrecipMm, 0);
  assert.equal(ds.days[1].nextNightPrecipMm, null);
});

test('an older live snapshot retains the daily total without its fabricated hours and uncovered date', () => {
  const ds = forecast();
  const [day, gap] = ds.days;
  delete day.hasForecast;
  day.hours.forEach(h => Object.assign(h, { precipMm: 1, precipProb: 95, precipPhase: 'rain' }));
  const legacyGap = { ...day, isoDate: gap.isoDate, modelBreakdown: {}, confidencePct: 91 };
  const restored = sanitizeDataset({ ...ds, days: [day, legacyGap] });
  assert.equal(restored.days[0].precipMm, 24);
  assert.ok(restored.days[0].hours.every(h => h.precipMm === null && h.precipProb === null));
  assert.equal(restored.days[1].hasForecast, false);
  assert.deepEqual(restored.days[1].hours, []);
});

test('future data does not supply today’s missing forecast or current hourly precipitation', () => {
  const ds = forecast({ dates: [tomorrow] });
  assert.equal(ds.days[0].hasForecast, false);
  assert.equal(ds.days[1].hasForecast, true);
  assert.equal(ds.current.hasMeasurements, false);
  assert.equal(ds.current.precipMm, null);
  assert.equal(ds.controlPoint.tempC, null);
});
