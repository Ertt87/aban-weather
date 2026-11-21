import test from 'node:test';
import assert from 'node:assert/strict';
import { getAbanNowParts } from '../js/config.js';
import { buildUnifiedDataset } from '../js/ensemble.js';
import { abanTimeText, calendarDaysAt, fallbackSnapshot, snapshotTimeText } from '../js/snapshot.js';

const before = '2026-11-21T16:59:00Z';
const after = '2026-11-21T17:05:00Z';
const snapshot = {
  sourceType: 'live_multi_ensemble', receivedAtIso: before,
  days: [
    { id: 'day_2026-11-21', isoDate: '2026-11-21', label: 'Сегодня', offsetFromToday: 0, isArchive: false, maxC: -3 },
    { id: 'day_2026-11-22', isoDate: '2026-11-22', label: 'Завтра', offsetFromToday: 1, isArchive: false, maxC: 7 },
  ],
};

test('Aban midnight is 17:00 UTC, including at the ISO year boundary', () => {
  assert.deepEqual(getAbanNowParts(Date.parse(before)), { isoDate: '2026-11-21', hour: 23 });
  assert.deepEqual(getAbanNowParts(Date.parse(after)), { isoDate: '2026-11-22', hour: 0 });
  assert.deepEqual(getAbanNowParts(Date.parse('2026-12-31T17:00:00Z')), { isoDate: '2027-01-01', hour: 0 });
  assert.equal(abanTimeText(Date.parse(after)), '22.11.2026 00:05');
});

test('a saved forecast is relabelled for the viewing date without changing its model data or original labels', () => {
  const [yesterday, today] = calendarDaysAt(snapshot, '2026-11-22');
  assert.equal(yesterday.label, 'Вчера');
  assert.equal(yesterday.isArchive, false);
  assert.equal(yesterday.offsetFromToday, -1);
  assert.equal(today.label, 'Сегодня');
  assert.equal(today.offsetFromToday, 0);
  assert.equal(today.maxC, 7);
  assert.match(today.fullDateLabel, /Сегодня/);
  assert.equal(snapshot.days[0].label, 'Сегодня');
});

test('missing current date gets a dated empty entry for both past-only and future-only snapshots', () => {
  for (const iso of ['2026-11-20', '2026-11-23']) {
    const days = calendarDaysAt(snapshot, iso);
    const today = days.find(d => d.isoDate === iso);
    assert.equal(today.label, 'Сегодня');
    assert.equal(today.hasForecast, false);
    assert.equal(today.maxC, null);
    assert.deepEqual(today.hours, []);
    assert.equal(days.filter(d => d.label === 'Сегодня').length, 1);
  }
  assert.equal(snapshot.days.length, 2);
});

test('refresh failure keeps the displayed forecast and distinguishes a saved copy, memory, and the example', () => {
  const disk = structuredClone(snapshot);
  assert.equal(fallbackSnapshot(snapshot, 'live', disk).origin, 'saved');
  assert.equal(fallbackSnapshot(disk, 'disk', disk).origin, 'disk');
  assert.deepEqual(fallbackSnapshot(snapshot, 'live', null), { dataset: snapshot, origin: 'memory' });
  assert.equal(fallbackSnapshot(snapshot, 'live', { ...disk, receivedAtIso: after }).origin, 'memory');
  const example = { ...snapshot, sourceType: 'reference_wn3' };
  assert.equal(fallbackSnapshot(example, 'reference', null).origin, 'reference');
  assert.equal(fallbackSnapshot(example, 'reference', example).origin, 'reference');
  assert.deepEqual(fallbackSnapshot(example, 'reference', disk), { dataset: disk, origin: 'disk' });
});

test('age uses the original receipt time after re-saving and labels the save time for legacy snapshots', () => {
  const ds = buildUnifiedDataset({ fetchedAtIso: before });
  assert.equal(Date.parse(ds.receivedAtIso), Date.parse(before));
  const now = Date.parse(after);
  assert.match(snapshotTimeText({ ...ds, cacheSavedAtIso: after }, now), /Получено 21\.11\.2026 23:59 · 6 мин назад/);
  assert.match(snapshotTimeText({ cacheSavedAtIso: before }, now), /Сохранено .*6 мин назад/);
  assert.equal(snapshotTimeText({ syncedAt: '21 ноя, 23:59' }, now), '21 ноя, 23:59');
});

test('a late provider observation keeps its own timestamp and cannot move today or the upcoming shift backwards', () => {
  const ds = buildUnifiedDataset({ fetchedAtIso: after, openMeteoMulti: {
    current: { time: '2026-11-21T23:45', temperature_2m: -2 },
    daily: { time: ['2026-11-21', '2026-11-22'], temperature_2m_max: [1, 6], temperature_2m_min: [-3, 0] },
  } });
  assert.equal(ds.days.find(d => d.offsetFromToday === 0).isoDate, '2026-11-22');
  assert.match(ds.current.obsTimeLabel, /21 ноя, 23:45/);
  assert.equal(abanTimeText(Date.parse(ds.receivedAtIso)), '22.11.2026 00:05');
  assert.match(ds.controlPoint.next3hLabel, /03:00/);
});
