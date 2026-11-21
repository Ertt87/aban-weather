import test from 'node:test';
import assert from 'node:assert/strict';
import { buildUnifiedDataset } from '../js/ensemble.js';
import { buildDynamicReferenceDataset } from '../js/config.js';
import { computeFieldOpsMetrics } from '../js/physics.js';
import { sanitizeDataset } from '../js/storage.js';

const date = '2026-11-22';
const model = 'ecmwf_ifs025';

function forecast(code, { hourly = true, daily = true } = {}) {
  const values = value => Array(24).fill(value);
  return {
    hourly: hourly ? {
      time: values('').map((_, hour) => `${date}T${String(hour).padStart(2, '0')}:00`),
      [`temperature_2m_${model}`]: values(8),
      [`weather_code_${model}`]: values(code),
      [`precipitation_${model}`]: values(0),
      [`wind_speed_10m_${model}`]: values(0),
      [`wind_gusts_10m_${model}`]: values(0),
    } : undefined,
    daily: daily ? {
      time: [date],
      [`temperature_2m_max_${model}`]: [8], [`temperature_2m_min_${model}`]: [6],
      [`weather_code_${model}`]: [code], [`precipitation_sum_${model}`]: [0],
      [`wind_speed_10m_max_${model}`]: [0], [`wind_gusts_10m_max_${model}`]: [0],
    } : undefined,
  };
}

function build(payload, extra = {}) {
  // 12:00 in Aban. The primary API supplies hourly + daily data, without a current block.
  return buildUnifiedDataset({ openMeteoMulti: payload, fetchedAtIso: date + 'T05:00:00Z', ...extra });
}

for (const [code, condition, icon] of [
  [45, 'Туман / дымка', 'fog'], [95, 'Гроза', 'thunderstorm'],
  [96, 'Гроза с небольшим градом', 'thunder-hail'], [97, 'Сильная гроза', 'thunderstorm'],
  [99, 'Гроза с сильным градом', 'thunder-hail'],
]) {
  test(`WMO ${code} survives from the provider to the current, hourly, daily and shift forecasts`, () => {
    const { current, controlPoint, days: [day] } = build(forecast(code));
    assert.equal(day.hours[12].weather.code, code);
    assert.equal(day.hours[12].weather.source, model);
    assert.equal(day.hours[12].weather.ru, condition);
    for (const text of [current.condRu, day.dayCond, controlPoint.condRu]) assert.ok(text.includes(condition), text);
    for (const actual of [current.iconType, day.hours[12].iconType, day.iconType, controlPoint.iconType]) assert.equal(actual, icon);
  });
}

test('a weaker model can report hail for one hour without assigning it to adjacent hours', () => {
  const p = forecast(61);
  // ICON reports a code even though its temperature is missing for this hour.
  p.hourly.weather_code_icon_seamless = Array(24).fill(null);
  p.hourly.weather_code_icon_seamless[12] = 99;
  const { current, days: [day] } = build(p);
  assert.match(current.condRu, /градом.*ICON/i);
  assert.match(day.dayCond, /градом.*ICON/i);
  assert.match(day.hours[11].weather.ru, /дождь/i);
  assert.doesNotMatch(day.nightCond, /гроз|град/i);
});

test('a daily hail code does not create a timed warning; sparse hours keep their own report', () => {
  const dailyOnly = build(forecast(99, { hourly: false }));
  assert.match(dailyOnly.days[0].dayCond, /градом.*за сутки/);
  assert.equal(dailyOnly.current.iconType, 'unknown');
  assert.ok(dailyOnly.days[0].hours.every(h => !h.weather && h.iconType !== 'thunder-hail'));
  const p = forecast(0);
  p.hourly = { time: [date + 'T12:00'], [`weather_code_${model}`]: [95] };
  const sparse = build(p);
  assert.match(sparse.current.condRu, /Гроза/);
  assert.equal(sparse.days[0].hours[11].weather, undefined);
});

const risk = day => computeFieldOpsMetrics(day).roadRisk.level;

test('the upcoming night does not repeat a thunderstorm from the previous morning', () => {
  const p = forecast(0);
  p.hourly[`weather_code_${model}`][3] = 95;
  const day = build(p).days[0];
  assert.match(day.nightCond, /Гроза/);
  assert.doesNotMatch(day.nextNightCond, /Гроза/);
  p.hourly[`weather_code_${model}`][21] = 99;
  assert.match(build(p).days[0].nextNightCond, /сильным градом/);
});

test('reference, absent forecast days and legacy snapshots all have unknown road risk', () => {
  assert.equal(risk({}), 'unknown');
  assert.ok(buildDynamicReferenceDataset(date).days.every(day => risk(day) === 'unknown'));
  const ds = build(forecast(0));
  assert.equal(risk(ds.days[1]), 'unknown');
  const saved = sanitizeDataset(JSON.parse(JSON.stringify(ds)));
  assert.equal(risk(saved.days[0]), 'low');
  delete saved.days[0].dataQuality.roadRiskInputsAvailable;
  assert.equal(risk(saved.days[0]), 'unknown');
});

test('missing core road inputs stay unknown while real zero and strong gusts remain assessable', () => {
  for (const field of ['precipitation_sum', 'wind_speed_10m_max', 'wind_gusts_10m_max', 'temperature_2m_min']) {
    const p = forecast(0, { hourly: false });
    p.daily[`${field}_${model}`] = [null];
    assert.equal(risk(build(p).days[0]), 'unknown', field);
  }
  const p = forecast(0, { hourly: false });
  assert.equal(risk(build(p).days[0]), 'low');
  p.daily[`wind_gusts_10m_max_${model}`] = [15];
  assert.equal(risk(build(p).days[0]), 'moderate');
  const hours = forecast(0, { daily: false });
  // The day's last precipitation amount is reported at the following midnight.
  hours.hourly.time.push('2026-11-23T00:00');
  hours.hourly[`precipitation_${model}`].push(0);
  assert.equal(risk(build(hours).days[0]), 'low');
  hours.hourly[`precipitation_${model}`][12] = null;
  assert.equal(risk(build(hours).days[0]), 'unknown');
});
