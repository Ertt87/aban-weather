import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregateEnsembleQuantiles, mergeQuantileFallback } from '../js/api.js';
import { buildUnifiedDataset, buildPentadSummary } from '../js/ensemble.js';
import { sanitizeDataset } from '../js/storage.js';

const today = '2026-11-22', far = '2026-12-12';
function members(source, iso, low, high) {
  return { source, payload: { daily: { time: [iso], temperature_2m_max_member01: [low],
    temperature_2m_max_member02: [high], temperature_2m_min_member01: [low - 5],
    temperature_2m_min_member02: [high == null ? null : high - 5] } } };
}
const core = { daily: { time: [today], temperature_2m_max_ecmwf_ifs025: [7], temperature_2m_min_ecmwf_ifs025: [-2] } };
function forecast(ensemble35) {
  return buildUnifiedDataset({ mode: 'hybrid', fetchedAtIso: today + 'T05:00:00Z', openMeteoMulti: core, ensemble35 }, { todayIso: today });
}

test('only real members supply temperature percentiles, with the source for the specific date', () => {
  const short = aggregateEnsembleQuantiles([members('gfs_seamless_ensemble', today, 0, 10)]);
  const seasonal = aggregateEnsembleQuantiles([members('ecmwf_seasonal', far, 10, 20)]);
  const ds = forecast(mergeQuantileFallback(short, seasonal));
  for (const { days } of [ds, sanitizeDataset(ds)]) {
    assert.deepEqual(days.find(d => d.isoDate === today).temperatureRange.sources, ['gfs_seamless_ensemble']);
    assert.equal(days[1].hasForecast, false);
    const d = days.find(d => d.isoDate === far);
    assert.deepEqual(d.temperatureRange, { kind: 'ensemble', sources: ['ecmwf_seasonal'] });
    assert.deepEqual([d.maxP10C, d.maxP25C, d.maxP75C, d.maxP90C], [11, 12.5, 17.5, 19]);
    assert.equal(d.confidencePct, null);
    const [group] = buildPentadSummary([d]);
    assert.deepEqual(group.temperatureRange, d.temperatureRange);
    assert.equal(group.maxP10C, 11);
  }
});

test('deterministic estimates, lone members and old snapshots cannot acquire ensemble attribution', () => {
  const ds = forecast(aggregateEnsembleQuantiles([members('ecmwf_seasonal', far, 10, null)]));
  const covered = ds.days.filter(d => d.hasForecast);
  for (const day of covered) assert.equal(day.temperatureRange.kind, 'estimate');
  const legacy = structuredClone(covered[0]);
  delete legacy.temperatureRange;
  legacy.confidencePct = 91;
  const restored = sanitizeDataset({ days: [legacy] }).days[0];
  assert.equal(restored.confidencePct, null);
  assert.notEqual(buildPentadSummary([restored])[0].temperatureRange.kind, 'ensemble');
});

test('a source that has no temperatures on a date cannot claim its range', () => {
  const air = members('ecmwf_ifs025_ensemble', today, 2, 8);
  const other = members('gfs_seamless_ensemble', far, 5, 15);
  other.payload.daily.time.unshift(today);
  for (const [key, values] of Object.entries(other.payload.daily)) {
    if (key !== 'time') values.unshift(null);
  }
  const { dailyQuantiles } = aggregateEnsembleQuantiles([air, other]);
  assert.deepEqual(dailyQuantiles.map(d => d.sources), [['ecmwf_ifs025_ensemble'], ['gfs_seamless_ensemble']]);
  const ds = forecast({ dailyQuantiles: dailyQuantiles.slice(1) });
  const [pentad] = buildPentadSummary(ds.days.filter(d => d.hasForecast));
  assert.equal(pentad.temperatureRange.kind, 'mixed');
});
