import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchAllWeatherSources, fetchCustomArchiveRange } from '../js/api.js';
import { loadArchiveSlice, loadDatasetCache, readDatasetJsonFile, saveDatasetCache } from '../js/storage.js';

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test('reading an import does not write the selected snapshot before the caller accepts it', async () => {
  const snapshot = maxC => ({ days: [{ isoDate: '2026-11-22', minC: 0, maxC }] });
  saveDatasetCache(snapshot(7));
  const file = deferred();
  const pending = readDatasetJsonFile({ text: () => file.promise });
  saveDatasetCache(snapshot(19));
  file.resolve(JSON.stringify({ dataset: snapshot(17) }));
  assert.equal((await pending).days[0].maxC, 17);
  assert.equal(loadDatasetCache().days[0].maxC, 19);
});

test('cancelled forecast discards late data even when the transport completes after abort', async t => {
  const started = deferred();
  const body = deferred();
  t.mock.method(globalThis, 'fetch', async (input, { signal }) => {
    const url = new URL(input);
    if (url.hostname === 'api.open-meteo.com' && url.searchParams.get('models')?.includes(',')) {
      return { ok: true, json() { started.resolve(signal); return body.promise; } };
    }
    return new Response(null, { status: 503 });
  });
  const controller = new AbortController();
  const partials = [];
  const forecast = fetchAllWeatherSources({
    signal: controller.signal, onPartial: bundle => partials.push(bundle), partialGraceMs: 0,
  });
  const transport = await started.promise;
  controller.abort();
  body.resolve({ daily: { time: ['2026-11-22'], temperature_2m_max_ecmwf_ifs025: [-3.7] } });
  await assert.rejects(forecast, { name: 'AbortError' });
  assert.equal(transport.aborted, true);
  assert.deepEqual(partials, []);
});

test('a superseded archive range cannot write into the archive cache', async t => {
  const first = '2001-01-01', second = '2001-02-01';
  const started = deferred();
  const release = deferred();
  t.mock.method(globalThis, 'fetch', async input => {
    const iso = new URL(input).searchParams.get('start_date');
    if (iso === first) {
      started.resolve();
      await release.promise;
    }
    return Response.json({ daily: { time: [iso], temperature_2m_max: [7], temperature_2m_min: [1] } });
  });
  const controller = new AbortController();
  const pending = fetchCustomArchiveRange(first, first, { signal: controller.signal });
  await started.promise;
  controller.abort();
  const accepted = await fetchCustomArchiveRange(second, second);
  release.resolve();
  await assert.rejects(pending, { name: 'AbortError' });
  const cached = iso => loadArchiveSlice('interval-start:' + iso + '__' + iso);
  assert.equal(cached(first), null);
  assert.equal(cached(second).days[0].isoDate, accepted.days[0].isoDate);
});
