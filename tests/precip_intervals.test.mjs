import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregateEnsembleQuantiles, normalizeDailyFromPayload } from '../js/api.js';
import { buildUnifiedDataset, computeDayWindowStats } from '../js/ensemble.js';
import { sanitizeDataset } from '../js/storage.js';

const date = '2026-11-22';
const origin = Date.parse(date + 'T00:00:00+07:00');
const hourMs = 3_600_000;
const utc = h => new Date(origin + h * hourMs).toISOString();
const local = h => new Date(origin + (h + 7) * hourMs).toISOString().slice(0, 16);
const sequence = n => Array.from({ length: n }, (_, i) => i);

function openMeteo(amount, n = 49) {
  const t = sequence(n);
  return { hourly: {
    time: t.map(local),
    temperature_2m: t.map(i => i % 24),
    precipitation: t.map(i => amount(i - 1)),
  } };
}

function metNo(t, details) {
  return { properties: { timeseries: t.map(i => ({
    time: utc(i), data: { instant: { details: { air_temperature: i % 24 } }, ...details(i) },
  })) } };
}
const build = sources => buildUnifiedDataset({ fetchedAtIso: utc(12), ...sources });
const dayAt = (ds, offset = 0) => ds.days.find(d => d.offsetFromToday === offset);

test('three providers and their blend place 19–20 and 23–00 impulses in the same local hour', () => {
  const amount = i => i === 19 ? 4 : i === 23 ? 6 : 0;
  const providers = {
    openMeteoMulti: openMeteo(amount),
    google: { forecastHours: sequence(48).map(i => ({
      interval: { startTime: utc(i), endTime: utc(i + 1) }, temperature: { degrees: i % 24 },
      precipitation: { qpf: { quantity: amount(i) } },
    })) },
    metNo: metNo(sequence(48), i => ({ next_1_hours: { details: { precipitation_amount: amount(i) } } })),
  };
  for (const sources of [...Object.entries(providers).map(([k, v]) => ({ [k]: v })), providers]) {
    const ds = build(sources);
    const day = dayAt(ds);
    assert.deepEqual(day.hours.map(h => h.precipMm), sequence(24).map(amount));
    assert.equal(day.hours[19].tempC, 19);
    assert.deepEqual(day.hours[23].precipInterval, {
      startMs: Date.parse(utc(23)), endMs: Date.parse(utc(24)), durationHours: 1, mm: 6,
    });
    assert.equal(dayAt(ds, 1).hours[0].precipMm, 0);
    assert.equal(day.dayShiftPrecip.mm, 4);
    assert.equal(day.nextNightPrecipMm, 6);
    assert.equal(day.precipMm, 10);
  }
});

test('12-hour shifts exclude the end, cross midnight once, and report incomplete coverage', () => {
  const rain = i => i === 7 ? 4 : i >= 20 && i < 32 ? 1 : i === 32 ? 9 : 0;
  const ds = build({ openMeteoMulti: openMeteo(rain) });
  const day = dayAt(ds);
  assert.equal(day.dayShiftPrecip.mm, 0);
  assert.doesNotMatch(day.dayCond, /дождь|ливень/i);
  assert.equal(day.precipMm, 8);
  assert.deepEqual(day.nextNightPrecip, { mm: 12, coveredHours: 12, hours: 12 });
  assert.equal(computeDayWindowStats(day, 'night').sumPrecipMm, 12);
  assert.equal(computeDayWindowStats(dayAt(ds, 1), 'day_shift').sumPrecipMm, 9);
  for (const payload of [openMeteo(i => i === 31 ? null : rain(i)), openMeteo(rain, 25)]) {
    const incomplete = dayAt(build({ openMeteoMulti: payload }));
    assert.equal(incomplete.nextNightPrecip.mm, null);
    assert.equal(incomplete.nextNightPrecip.coveredHours, payload.hourly.time.length === 25 ? 4 : 11);
    assert.equal(computeDayWindowStats(incomplete, 'night').sumPrecipMm, null);
  }
});

test('MET six-hour blocks cover exact windows without splitting a boundary or double-counting hourly reports', () => {
  const coarse = i => ({ next_6_hours: { details: { precipitation_amount: i === 8 ? 9 : 3 } } });
  const ds = build({ metNo: metNo([8, 14, 20, 26], coarse) });
  const day = dayAt(ds);
  assert.equal(day.dayShiftPrecip.mm, 12);
  assert.equal(day.nextNightPrecipMm, 6);
  assert.ok(day.hours.every(h => h.precipMm === null));
  assert.deepEqual(day.precipBlocks.find(b => b.startMs === Date.parse(utc(20))), {
    startMs: Date.parse(utc(20)), endMs: Date.parse(utc(26)), durationHours: 6, mm: 3,
  });
  const overlap = dayAt(build({ metNo: metNo(sequence(24), i => ({
    next_1_hours: { details: { precipitation_amount: 1 } }, ...coarse(i),
  })) }));
  assert.equal(overlap.dayShiftPrecip.mm, 12);
  assert.equal(overlap.precipMm, 24);
  const unaligned = dayAt(build({ metNo: metNo([1, 7, 13, 19], coarse) }));
  assert.equal(unaligned.dayShiftPrecip.mm, null);
  assert.equal(unaligned.modelBreakdown.met_no.precipMm, null);
});

test('archive accumulations and companion probability shift with time while temperature stays at its sample', () => {
  const payload = openMeteo(i => i === 23 ? 5 : 0);
  payload.daily = { time: [date], temperature_2m_max: [23], temperature_2m_min: [0], precipitation_sum: [5] };
  const [archive] = normalizeDailyFromPayload(payload);
  const day = dayAt(build({ customArchive: [archive] }));
  assert.equal(day.hours[23].precipMm, 5);
  assert.equal(day.hours[23].tempC, 23);
  const companion = { hourly: { time: [utc(24)], precipitation_probability: [65], surface_pressure: [992] } };
  const mixed = build({ openMeteoMulti: payload, openMeteoCompanion: companion });
  assert.equal(dayAt(mixed).hours[23].precipProb, 65);
  assert.equal(dayAt(mixed, 1).hours[0].precipProb, null);
});

test('Google 07–19 and 19–07 day parts cannot stand for the 08–20 shift or a calendar day', () => {
  const part = (start, end, amount) => ({
    interval: { startTime: utc(start), endTime: utc(end) },
    precipitation: { qpf: { quantity: amount } },
  });
  const google = { forecastDays: [{
    displayDate: { year: 2026, month: 11, day: 22 },
    interval: { startTime: utc(7), endTime: utc(31) },
    maxTemperature: { degrees: 10 }, minTemperature: { degrees: 2 },
    daytimeForecast: part(7, 19, 4), nighttimeForecast: part(19, 31, 8),
  }] };
  const day = dayAt(build({ google }));
  assert.equal(day.precipMm, null);
  assert.equal(day.dayShiftPrecip.mm, null);
  assert.equal(day.nextNightPrecip.mm, null);
  assert.deepEqual(day.precipBlocks.map(b => [b.durationHours, b.mm]), [[12, 4], [12, 8]]);
  assert.ok(day.hours.every(h => h.precipMm === null));
});

test('current 15-minute observations, last-hour observations and the forecast hour keep their own amounts', () => {
  const openMeteoMulti = { ...openMeteo(() => 2),
    current: { time: local(12), temperature_2m: 10, interval: 900, precipitation: 1 } };
  const one = build({ openMeteoMulti });
  assert.equal(one.current.precipMm, 1);
  assert.match(one.current.precipPeriodLabel, /15 мин/);
  const two = build({ openMeteoMulti, google: { current: {
    temperature: { degrees: 10 }, precipitation: { qpf: { quantity: 5 }, probability: { percent: 80 } },
  } } });
  assert.equal(two.current.precipMm, 5);
  assert.equal(two.current.precipProb, 80);
  assert.match(two.current.precipPeriodLabel, /последний час/);
  assert.equal(dayAt(two).hours[12].precipMm, 2);
});

test('seasonal six-hour ending timestamps require four entire blocks per member and local day', () => {
  const quantiles = ends => aggregateEnsembleQuantiles([{ source: 'seasonal', payload: { six_hourly: {
    time: ends.map(local), temperature_2m_member01: ends.map(() => 3),
    precipitation_member01: ends.map(h => h === 24 ? 6 : 1),
  } } }]).dailyQuantiles.find(d => d.isoDate === date);
  assert.equal(quantiles([0, 6, 12, 18, 24]).precipP50Mm, 9);
  assert.equal(quantiles([0, 6, 18, 24]).precipP50Mm, null);
});

test('a restored dataset keeps explicit intervals while an old mixed-source snapshot cannot claim an hourly total', () => {
  const ds = build({ openMeteoMulti: openMeteo(() => 1) });
  const saved = sanitizeDataset(JSON.parse(JSON.stringify(ds)));
  assert.deepEqual(dayAt(saved).nextNightPrecip, { mm: 12, coveredHours: 12, hours: 12 });
  assert.deepEqual(dayAt(saved).hours[23].precipInterval, dayAt(ds).hours[23].precipInterval);
  delete dayAt(ds).precipTimeBasis;
  const legacy = dayAt(sanitizeDataset(ds));
  assert.equal(legacy.precipMm, 24);
  assert.equal(legacy.hours[23].precipMm, null);
  assert.equal(legacy.dayShiftPrecip, null);
  assert.equal(legacy.nextNightPrecipMm, null);
});
