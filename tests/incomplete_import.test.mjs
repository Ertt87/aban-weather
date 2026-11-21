import test from 'node:test';
import assert from 'node:assert/strict';
import { computeDayWindowStats } from '../js/ensemble.js';
import { exportDatasetJson, importDatasetJsonFile, loadDatasetCache, readDatasetJsonFile, saveDatasetCache } from '../js/storage.js';

const day = { isoDate: '2026-11-22', maxC: 17, minC: 0 };

test('daily-only v4 and compatible legacy snapshots round-trip without inventing missing sections', async () => {
  for (const record of [
    { days: [day] }, { version: 4, dataset: { version: 4, days: [day] } },
    { version: 3, payload: { days: [day] } },
  ]) {
    const imported = await importDatasetJsonFile(JSON.stringify(record));
    const reopened = await readDatasetJsonFile(exportDatasetJson(imported).json);
    for (const ds of [imported, loadDatasetCache(), reopened]) {
      assert.equal(ds.days[0].minC, 0);
      assert.equal(ds.days[0].maxC, 17);
      assert.equal(ds.current, undefined);
      assert.equal(ds.controlPoint, undefined);
      assert.equal(ds.airQuality, undefined);
      assert.deepEqual(computeDayWindowStats(ds.days[0]).hours, []);
      assert.equal(computeDayWindowStats(ds.days[0]).avgC, null);
    }
  }
});

test('unreadable or incompatible snapshots leave the previous cached forecast intact', async () => {
  saveDatasetCache({ days: [{ ...day, maxC: 7 }] });
  const previous = loadDatasetCache();
  for (const file of [
    '{', '{}', '{"days":[]}', { days: [{ isoDate: day.isoDate, minC: 0 }] },
    { days: [{ ...day, maxC: false }] }, { days: [{ ...day, isoDate: '2026-02-30' }] },
    { days: [{ isoDate: day.isoDate, hasForecast: false }] },
    { version: 4, dataset: { version: 5, days: [day] } }, { version: 99, payload: { days: [day] } },
    { days: [day], current: [] }, { days: [day], mos: { models: 'bad' } },
  ]) {
    await assert.rejects(importDatasetJsonFile(typeof file === 'string' ? file : JSON.stringify(file)), /JSON/);
    assert.deepEqual(loadDatasetCache(), previous);
  }
});

test('incomplete hourly rows retain real zeroes and never borrow readings from another time window', async () => {
  const ds = await readDatasetJsonFile(JSON.stringify({
    current: { tempC: 0 }, airQuality: { aqi: 0 }, mos: { models: { unavailable: null } },
    days: [{ ...day, hours: [null, { hour: null }, { hour: 24 }, { hour: '12', tempC: 0 }, { hour: 15, windMs: 0 }] }],
  }));
  assert.deepEqual(ds.mos.models, {});
  assert.equal(ds.current.tempC, 0);
  assert.equal(ds.airQuality.aqi, 0);
  assert.deepEqual(ds.days[0].hours.map(h => h.hourStr), ['12:00', '15:00']);
  const stats = computeDayWindowStats(ds.days[0], 'day_shift');
  assert.equal(stats.avgC, 0);
  assert.equal(stats.avgWindMs, 0);
  assert.equal(stats.maxGustMs, null);
  assert.equal(computeDayWindowStats(ds.days[0], 'night').avgC, null);
});
