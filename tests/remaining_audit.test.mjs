import test from 'node:test';
import assert from 'node:assert/strict';
import { buildUnifiedDataset, buildPentadSummary, hasDryWindow } from '../js/ensemble.js';
import { aggregateEnsembleQuantiles } from '../js/api.js';
import { computeFieldOpsMetrics } from '../js/physics.js';
import { sanitizeDataset } from '../js/storage.js';
import { upcomingForecastHours } from '../js/snapshot.js';

const iso = '2026-11-22';
function dataset(fields, extras = {}) {
  const daily = { time: [iso] };
  for (const [field, value] of Object.entries(fields)) daily[field + '_ecmwf_ifs025'] = [value];
  return buildUnifiedDataset({ fetchedAtIso: iso + 'T05:00:00Z', openMeteoMulti: { daily }, ...extras }, { todayIso: iso });
}

test('a day reporting only precipitation keeps its total and no temperatures, wind or derived extremes', () => {
  const live = dataset({ precipitation_sum: 4 });
  for (const snapshot of [live, sanitizeDataset(live)]) {
    const day = snapshot.days.find(d => d.isoDate === iso);
    assert.equal(day.hasForecast, true);
    assert.equal(day.precipMm, 4);
    for (const key of ['minC','maxC','minF','maxF','maxP90C','minP10C','windMs','gustMs','soil0C','climAnomalyC']) {
      assert.equal(day[key], null, key);
    }
    assert.ok(day.hours.every(h => h.tempC == null && h.precipMm == null));
    const ops = computeFieldOpsMetrics(day);
    assert.equal(ops.ground.stateCode, 'unknown');
    assert.equal(ops.diesel.cutoffC, null);
  }
  const lone = dataset({ temperature_2m_max: 0 }).days[0];
  assert.equal(lone.maxC, 0);
  assert.equal(lone.minC, null);
});

test('ensemble wind quantiles and forecasts preserve both missing wind and calm on each horizon', () => {
  for (const speed of [null, 0, 4]) {
    const dates = [iso, '2026-12-04', '2026-12-12'];
    const daily = { time: dates, temperature_2m_max_member01: [3,3,3], temperature_2m_min_member01: [-2,-2,-2] };
    if (speed !== null) daily.wind_speed_10m_max_member01 = dates.map(() => speed);
    const ensemble35 = aggregateEnsembleQuantiles([{ source: 'ecmwf_seasonal', payload: { daily } }]);
    const forecast = dataset({ temperature_2m_max: 3 }, { ensemble35 });
    for (const row of ensemble35.dailyQuantiles) assert.equal(row.windP50Ms, speed);
    for (const date of dates) assert.equal(forecast.days.find(d => d.isoDate === date).windMs, speed);
  }
});

test('wind-only and precipitation-only providers supply no temperature as a side effect', () => {
  const calm = dataset({ wind_speed_10m_max: 0 }).days[0];
  assert.equal(calm.windMs, 0);
  assert.equal(calm.maxC, null);
  const daily = { time:[iso], precipitation_sum_member01:[4] };
  for (const ensemble35 of [{daily}, aggregateEnsembleQuantiles([{source:'gfs_seamless_ensemble',payload:{daily}}])]) {
    const day = dataset({}, {ensemble35}).days[0];
    assert.equal(day.precipMm, 4);
    assert.equal(day.maxC, null);
    assert.equal(day.probFrostBelowMinus20, null);
  }
});

test('a dry day requires a full-day probability or 24 distinct covered hours', () => {
  const base = { precipMm: 0.3, precipDay: 2, precipNight: 3, hours: [{hour: 8, precipProb: 2},{hour: 22, precipProb: 3}] };
  assert.equal(hasDryWindow(base), false);
  assert.equal(hasDryWindow({ ...base, dailyPrecipProbability: 0 }), true);
  assert.equal(hasDryWindow({ ...base, dailyPrecipProbability: 15 }), false);
  const slots = Array.from({length:24}, (_,hour) => ({hour, precipMm: 0}));
  assert.equal(hasDryWindow({ ...base, hours: slots }), true);
  assert.equal(hasDryWindow({ ...base, hours: [...slots.slice(1), slots[1]] }), false);
  assert.equal(hasDryWindow({ ...base, hours: [...slots.slice(1), {hour:0, precipProb:40}] }), false);
});

test('five-day totals require all daily values, while zero is a valid total and probability', () => {
  const make = amounts => amounts.map((precipMm,i) => ({id:'d'+i, isoDate:'2026-11-'+(22+i), dateStr:(22+i)+' ноя',
    hasForecast:true, precipMm, precipDay:precipMm === null ? null : 0, minC:null, maxC:null, gustMs:null}));
  for (const [amounts, expected] of [[[null,null,null,null,null],null], [[1,0,null,0,2],null], [[0,0,0,0,0],0], [[0.03,0.04,1,2,0],3.07]]) {
    const [group] = buildPentadSummary(make(amounts));
    assert.equal(group.precipMm, expected);
    assert.equal(group.precipDay, expected === null ? null : 0);
    for (const key of ['minC','maxC','absMinC','absMaxC','windMs','gustMs']) assert.equal(group[key],null,key);
  }
  const missing = make([1,1,1,1,1]);
  missing[2].hasForecast = false;
  assert.equal(buildPentadSummary(missing)[0].precipMm, null);
});

test('a partial air quality observation keeps the other reading unknown, including when zero is reported', () => {
  for (const [current, pm, aqi] of [[{pm2_5:0},0,null], [{european_aqi:0},null,0], [{european_aqi:41,pm2_5:6},6,41]]) {
    const aq = dataset({temperature_2m_max:0}, {airQuality:{current}}).airQuality;
    assert.equal(aq.pm25, pm);
    assert.equal(aq.aqi, aqi);
    if (aqi === null) assert.equal(aq.smogRisk,'unknown');
  }
});

test('upcoming hours cross the year boundary and suppress synthetic temperatures and empty slots', () => {
  const days = [{isoDate:'2026-12-31',hours:[{hour:23,tempC:0}]},
    {isoDate:'2027-01-01',hours:[{hour:0,tempC:10,isSynthetic:true}, {hour:1,tempC:10,isSynthetic:true,precipMm:0}, {hour:5,tempC:9}]}];
  const slots = upcomingForecastHours(days,{isoDate:days[0].isoDate,hour:23});
  assert.deepEqual(slots.map(s => [s.label,s.hour,s.tempC]), [['Сегодня',23,0],['Завтра',1,null]]);
  assert.equal(slots[1].precipMm, 0);
});
