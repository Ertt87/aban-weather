import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function readText(relPath) {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

function makeMockContainer() {
  return {
    innerHTML: '',
    style: {},
    dataset: {},
    classList: {
      add() {},
      remove() {},
      toggle() {},
      contains() {
        return false;
      },
    },
    addEventListener() {},
    removeEventListener() {},
    setAttribute() {},
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
    getBoundingClientRect() {
      return { left: 0, top: 0, width: 800, height: 320 };
    },
  };
}

function makeMockDay(offsetFromToday, isoDate) {
  const zone =
    offsetFromToday < 0
      ? 'archive'
      : offsetFromToday <= 9
        ? 'deterministic'
        : offsetFromToday <= 15
          ? 'extended_ensemble'
          : 'subseasonal';

  const maxC = 2 - offsetFromToday * 0.3;
  const minC = -8 - offsetFromToday * 0.3;
  const hours =
    zone === 'subseasonal'
      ? []
      : Array.from({ length: 24 }, (_, hour) => {
          const tempC = Number((minC + ((maxC - minC) * (1 - Math.cos(((hour - 4) / 24) * 2 * Math.PI))) / 2).toFixed(1));
          return {
            hour,
            hourStr: `${String(hour).padStart(2, '0')}:00`,
            tempC,
            tempF: Math.round((tempC * 9) / 5 + 32),
            feelsC: tempC - 3,
            wetBulbC: tempC - 1.2,
            dewPointC: tempC - 2.5,
            humidity: 76,
            precipMm: hour === 14 ? 0.6 : 0,
            precipProb: hour === 14 ? 45 : 10,
            precipPhase: tempC < 0 ? 'snow' : 'rain',
            windMs: 3.5 + (hour % 4) * 0.5,
            windMph: 8,
            gustMs: 7.2,
            windDirShort: 'ЮЗ',
            pressureStationMm: 744,
            pressureMslMm: 766,
            cloudCoverPct: 55,
            soil0C: -0.8,
            iconType: tempC < 0 ? 'snow' : 'partly-sunny',
          };
        });

  return {
    id: `day_${isoDate}`,
    isoDate,
    offsetFromToday,
    dayShort: 'Пн',
    dateStr: isoDate.slice(5),
    fullDateLabel: isoDate,
    zone,
    confidencePct: zone === 'archive' ? 99 : zone === 'deterministic' ? 88 : zone === 'extended_ensemble' ? 65 : 44,
    maxC,
    maxF: Math.round((maxC * 9) / 5 + 32),
    minC,
    minF: Math.round((minC * 9) / 5 + 32),
    maxP10C: maxC - 4,
    maxP25C: maxC - 2,
    maxP75C: maxC + 2,
    maxP90C: maxC + 4,
    minP10C: minC - 5,
    minP25C: minC - 2.5,
    minP75C: minC + 2.5,
    minP90C: minC + 5,
    climMaxC: -3,
    climMinC: -11,
    humidity: 78,
    precipDay: 30,
    precipNight: 20,
    precipDayType: 'снег',
    precipNightType: 'снег',
    precipMm: offsetFromToday % 3 === 0 ? 2.4 : 0.2,
    precipP75Mm: offsetFromToday % 3 === 0 ? 4.1 : 0.8,
    precipPhase: maxC < 0 ? 'snow' : 'sleet',
    snowDepthCm: 18 + Math.max(0, offsetFromToday * 0.4),
    windMs: 4.5,
    windMph: 10,
    gustMs: 11.2,
    gustMph: 25,
    windDirShort: 'ЮЗ',
    soil0C: -1.2,
    soil6C: -0.4,
    soil18C: 0.6,
    soil54C: 2.3,
    dewPointC: minC - 1.5,
    pressureStationMm: 742 + (offsetFromToday % 5) - 2,
    pressureMslMm: 764 + (offsetFromToday % 5) - 2,
    deltaP24hMm: offsetFromToday % 4 === 0 ? -7.2 : 1.5,
    astronomy: { sunriseHour: 8.3, sunsetHour: 16.5, daylightHours: 8.2 },
    modelBreakdown: {
      ecmwf_ifs025: { maxC: maxC + 0.5, minC: minC - 0.5, precipMm: 1.1, windMs: 4.2 },
      ecmwf_aifs025: { maxC: maxC - 0.3, minC: minC + 0.4, precipMm: 0.8, windMs: 4.0 },
      icon_seamless: { maxC: maxC + 0.2, minC: minC - 0.2, precipMm: 1.3, windMs: 4.8 },
      gfs_seamless: { maxC: maxC - 0.8, minC: minC - 1.0, precipMm: 1.5, windMs: 5.0 },
    },
    hours,
  };
}

function makeMockDays(count) {
  const base = Date.UTC(2026, 10, 17);
  return Array.from({ length: count }, (_, i) => {
    const iso = new Date(base + i * 86400000).toISOString().slice(0, 10);
    return makeMockDay(i, iso);
  });
}

test('all core ES modules import cleanly in Node and expose required named exports', async () => {
  const config = await import('../js/config.js');
  for (const name of [
    'ABAN_COORDS',
    'STORAGE_KEYS',
    'MODEL_META',
    'TIME_WINDOWS',
    'getAbanClimatology',
    'REFERENCE_DATASET',
  ]) {
    assert.ok(name in config, `config.js missing export ${name}`);
  }
  assert.equal(config.ABAN_COORDS.wmoId, '29485');
  assert.equal(config.ABAN_COORDS.lat, 56.68);
  assert.equal(config.ABAN_COORDS.lon, 96.07);
  assert.equal(config.ABAN_COORDS.elev, 246);
  for (const key of ['CACHE_V4', 'GOOGLE_API_KEY', 'LEGACY_API_KEY', 'PREFS', 'MOS_CACHE', 'ARCHIVE_LRU']) {
    assert.ok(config.STORAGE_KEYS[key], `STORAGE_KEYS missing ${key}`);
  }
  for (const modelKey of ['google_wn3', 'ecmwf_aifs025', 'ecmwf_ifs025', 'icon_seamless', 'met_no', 'gfs_seamless']) {
    assert.ok(config.MODEL_META[modelKey], `MODEL_META missing ${modelKey}`);
  }
  for (const winKey of ['full', 'day_shift', 'daylight', 'night']) {
    assert.equal(typeof config.TIME_WINDOWS[winKey]?.isHourActive, 'function');
  }
  const winterDay = { astronomy: { sunriseHour: 9.0, sunsetHour: 16.0 } };
  const summerDay = { astronomy: { sunriseHour: 4.0, sunsetHour: 21.5 } };
  assert.equal(config.TIME_WINDOWS.daylight.isHourActive(6, winterDay), false);
  assert.equal(config.TIME_WINDOWS.daylight.isHourActive(6, summerDay), true);

  const janClim = config.getAbanClimatology('2026-01-15');
  const julClim = config.getAbanClimatology('2026-07-15');
  assert.ok(janClim.climMaxC < -10 && janClim.climMinC < -18, `Jan climatology unexpected: ${JSON.stringify(janClim)}`);
  assert.ok(julClim.climMaxC > 22 && julClim.climMinC > 9, `Jul climatology unexpected: ${JSON.stringify(julClim)}`);

  const physics = await import('../js/physics.js');
  for (const name of [
    'cToF',
    'msToMph',
    'hpaToMmHg',
    'degToCompass',
    'formatSignedC',
    'computeWetBulbC',
    'classifyPrecipPhase',
    'blendWindVectors',
    'computeApparentTempC',
    'convertPressure',
    'computeAstronomy',
    'detectBasinInversion',
    'computeFieldOpsMetrics',
  ]) {
    assert.equal(typeof physics[name], 'function', `physics.js missing function ${name}`);
  }

  const ensemble = await import('../js/ensemble.js');
  for (const name of [
    'computeRollingMos',
    'buildUnifiedDataset',
    'mergeArchiveDaysIntoDataset',
    'computeDayWindowStats',
    'buildPentadSummary',
  ]) {
    assert.equal(typeof ensemble[name], 'function', `ensemble.js missing function ${name}`);
  }

  const storage = await import('../js/storage.js');
  for (const name of [
    'loadPrefs',
    'savePrefs',
    'getApiKey',
    'setApiKey',
    'saveDatasetCache',
    'loadDatasetCache',
    'clearDatasetCache',
    'getCacheStats',
    'exportDatasetJson',
    'importDatasetJsonFile',
    'saveArchiveSlice',
    'loadArchiveSlice',
  ]) {
    assert.equal(typeof storage[name], 'function', `storage.js missing function ${name}`);
  }

  const api = await import('../js/api.js');
  for (const name of ['fetchAllWeatherSources', 'fetchCustomArchiveRange', 'testGoogleApiKey']) {
    assert.equal(typeof api[name], 'function', `api.js missing function ${name}`);
  }

  const charts = await import('../js/charts.js');
  for (const name of [
    'getWeatherSvg',
    'renderDiurnalChart',
    'renderTempEnsembleChart',
    'renderPrecipSnowChart',
    'renderWindPressureChart',
    'renderSoilProfileChart',
  ]) {
    assert.equal(typeof charts[name], 'function', `charts.js missing function ${name}`);
  }
});

test('static security, offline-first, single-location, and relative-path audit', () => {
  const requiredFiles = [
    'index.html',
    'css/styles.css',
    'js/app.js',
    'js/config.js',
    'js/physics.js',
    'js/ensemble.js',
    'js/api.js',
    'js/storage.js',
    'js/charts.js',
    'sw.js',
    'manifest.webmanifest',
    'assets/icon.svg',
    '.gitignore',
    'README.md',
  ];
  for (const file of requiredFiles) {
    assert.ok(fs.existsSync(path.join(ROOT, file)), `missing required file: ${file}`);
  }

  const indexHtml = readText('index.html');
  const stylesCss = readText('css/styles.css');
  const swJs = readText('sw.js');
  const manifestRaw = readText('manifest.webmanifest');
  const appJs = readText('js/app.js');

  const jsFiles = fs
    .readdirSync(path.join(ROOT, 'js'))
    .filter((f) => f.endsWith('.js'))
    .map((f) => `js/${f}`);

  // 1. ZERO external Tailwind CDN or Google Fonts
  for (const [name, content] of [
    ['index.html', indexHtml],
    ['css/styles.css', stylesCss],
    ['sw.js', swJs],
    ...jsFiles.map((f) => [f, readText(f)]),
  ]) {
    assert.equal(
      /cdn\.tailwindcss\.com/i.test(content),
      false,
      `${name} must NOT reference cdn.tailwindcss.com`,
    );
    assert.equal(
      /fonts\.googleapis\.com|fonts\.gstatic\.com/i.test(content),
      false,
      `${name} must NOT reference fonts.googleapis.com / fonts.gstatic.com`,
    );
    assert.equal(
      /AIzaSy[0-9A-Za-z_-]{10,}/.test(content),
      false,
      `${name} must NOT contain any hardcoded Google API key (AIzaSy...)`,
    );
  }

  // Also check manifest.webmanifest and README.md for leaked API keys
  for (const name of ['manifest.webmanifest', 'README.md']) {
    assert.equal(
      /AIzaSy[0-9A-Za-z_-]{10,}/.test(readText(name)),
      false,
      `${name} must NOT contain any hardcoded Google API key`,
    );
  }

  // 2. ZERO district/multi-location selector
  for (const [name, content] of [
    ['index.html', indexHtml],
    ['js/app.js', appJs],
  ]) {
    assert.equal(
      /Точки района/i.test(content),
      false,
      `${name} must NOT include district/multi-location selector ("Точки района")`,
    );
  }

  // 3. Relative ./ paths in index.html, manifest.webmanifest, sw.js (no root-leading /js/ etc.)
  assert.equal(
    /(?:href|src)=["']\/(?!\/)/i.test(indexHtml),
    false,
    'index.html must not use root-leading local paths (use ./ for GitHub Pages subpath hosting)',
  );
  assert.match(indexHtml, /href=["']\.\/manifest\.webmanifest["']/);
  assert.match(indexHtml, /href=["']\.\/css\/styles\.css["']/);
  assert.match(indexHtml, /src=["']\.\/js\/app\.js["']/);

  const manifest = JSON.parse(manifestRaw);
  assert.equal(manifest.start_url, './');
  assert.equal(manifest.scope, './');
  assert.ok(Array.isArray(manifest.icons) && manifest.icons.length > 0);
  for (const icon of manifest.icons) {
    assert.ok(icon.src.startsWith('./'), `manifest icon src must start with ./, got ${icon.src}`);
    assert.ok(fs.existsSync(path.join(ROOT, icon.src.slice(2))), `manifest icon missing on disk: ${icon.src}`);
  }

  // Verify sw.js precache paths use ./ and all exist on disk
  assert.equal(/['"]\/(?:js|css|assets|index\.html|sw\.js|manifest\.webmanifest)/i.test(swJs), false);
  const precacheMatches = [...swJs.matchAll(/['"](\.\/[^'"]*)['"]/g)].map((m) => m[1]);
  assert.ok(precacheMatches.length >= 10, `expected sw.js to precache local ./ files, found ${precacheMatches.length}`);
  for (const rel of precacheMatches) {
    if (rel === './') continue;
    const target = path.join(ROOT, rel.slice(2));
    assert.ok(fs.existsSync(target), `sw.js precached asset missing on disk: ${rel}`);
  }

  // 4. Syntax check every JS file and SW with node --check
  for (const file of [...jsFiles, 'sw.js']) {
    execFileSync(process.execPath, ['--check', path.join(ROOT, file)], { stdio: 'pipe' });
  }

  // 5. DOM ID integrity between js/app.js and index.html + lazy Windy iframe audit
  const htmlIds = new Set([...indexHtml.matchAll(/\bid=["']([^"']+)["']/g)].map((m) => m[1]));
  const staticAppIds = [
    ...new Set([
      ...[...appJs.matchAll(/\$\(\s*['"]([A-Za-z0-9_-]+)['"]\s*\)/g)].map((m) => m[1]),
      ...[...appJs.matchAll(/document\.getElementById\(\s*['"]([A-Za-z0-9_-]+)['"]\s*\)/g)].map((m) => m[1]),
    ]),
  ];
  const missingDomIds = staticAppIds.filter((id) => !htmlIds.has(id));
  assert.deepEqual(missingDomIds, [], `index.html missing DOM IDs referenced by js/app.js: ${missingDomIds.join(', ')}`);

  assert.equal(/<iframe\b/i.test(indexHtml), false, 'index.html must NOT mount Windy iframe eagerly');
  assert.match(appJs, /embed\.windy\.com\/embed2\.html/);
  assert.match(appJs, /navigator\.serviceWorker\.register\(\s*['"]\.\/sw\.js['"]/);
  assert.match(appJs, /updatefound/);
  assert.match(appJs, /controllerchange/);
  assert.match(appJs, /renderApiChannelsPanel/);
  assert.match(appJs, /dirtyTabs/);
});

test('buildDynamicReferenceDataset generates seasonal offline data anchored on today', async () => {
  const { buildDynamicReferenceDataset } = await import('../js/config.js');
  const dsJan = buildDynamicReferenceDataset('2026-01-15');
  const dsJul = buildDynamicReferenceDataset('2026-07-15');
  assert.equal(dsJan.days[1].isoDate, '2026-01-15');
  assert.ok(dsJan.days[1].maxC < -10, `January maxC should be winter cold, got ${dsJan.days[1].maxC}`);
  assert.equal(dsJul.days[1].isoDate, '2026-07-15');
  assert.ok(dsJul.days[1].maxC > 20, `July maxC should be summer warm, got ${dsJul.days[1].maxC}`);
});

test('storage.js roundtrips prefs, API keys, cache, and 5-slot archive LRU; api.js aggregates ensemble quantiles', async () => {
  const storage = await import('../js/storage.js');
  const api = await import('../js/api.js');

  storage.clearDatasetCache({ includeArchive: true, includeMos: true });
  const prefs = storage.savePrefs({ unit: 'dual', pressureMode: 'msl', showModelLines: true });
  assert.equal(prefs.unit, 'dual');
  assert.equal(storage.loadPrefs().pressureMode, 'msl');
  assert.equal(storage.loadPrefs().showModelLines, true);

  storage.setApiKey('test-key-1234567890');
  assert.equal(storage.getApiKey(), 'test-key-1234567890');
  storage.setApiKey('');
  assert.equal(storage.getApiKey(), '');

  const fakeDataset = { version: 4, sourceLabel: 'Test', days: [{ isoDate: '2026-11-17', maxC: -2, minC: -10 }] };
  const saveRes = storage.saveDatasetCache(fakeDataset);
  assert.equal(saveRes.ok, true);
  assert.equal(storage.loadDatasetCache().days[0].isoDate, '2026-11-17');
  assert.equal(storage.getCacheStats().hasCache, true);

  // 5-slot LRU eviction check
  for (let i = 1; i <= 7; i++) {
    storage.saveArchiveSlice(`slice_${i}`, { id: i });
  }
  assert.equal(storage.loadArchiveSlice('slice_1'), null, 'oldest slice_1 should be evicted');
  assert.equal(storage.loadArchiveSlice('slice_2'), null, 'oldest slice_2 should be evicted');
  assert.deepEqual(storage.loadArchiveSlice('slice_7'), { id: 7 });
  assert.equal(storage.getCacheStats().archiveSlicesCount, 5);
  storage.clearDatasetCache({ includeArchive: true, includeMos: true });

  // Ensemble quantile aggregation check
  const agg = api.aggregateEnsembleQuantiles([
    {
      source: 'ecmwf_ifs025_ensemble',
      payload: {
        daily: {
          time: ['2026-12-05'],
          temperature_2m_max_member01: [-12, ],
          temperature_2m_max_member02: [-10, ],
          temperature_2m_max_member03: [-8, ],
          temperature_2m_max_member04: [-6, ],
          temperature_2m_max_member05: [-4, ],
          temperature_2m_min_member01: [-24, ],
          temperature_2m_min_member02: [-21, ],
          temperature_2m_min_member03: [-18, ],
          temperature_2m_min_member04: [-16, ],
          temperature_2m_min_member05: [-14, ],
          precipitation_sum_member01: [0, ],
          precipitation_sum_member02: [1, ],
          precipitation_sum_member03: [2, ],
          precipitation_sum_member04: [4, ],
          precipitation_sum_member05: [6, ],
          wind_speed_10m_max_member01: [3, ],
          wind_speed_10m_max_member05: [9, ],
        },
      },
    },
  ]);
  assert.equal(agg.dailyQuantiles.length, 1);
  const q = agg.dailyQuantiles[0];
  assert.ok(q.maxP10C <= q.maxP25C && q.maxP25C <= q.maxP50C && q.maxP50C <= q.maxP75C && q.maxP75C <= q.maxP90C);
  assert.ok(q.minP10C <= q.minP25C && q.minP25C <= q.minP50C && q.minP50C <= q.minP75C && q.minP75C <= q.minP90C);
});

test('charts.js renders valid SVG outputs across 1-day, 10-day, 35-day, and pentad modes', async () => {
  const {
    getWeatherSvg,
    renderDiurnalChart,
    renderTempEnsembleChart,
    renderPrecipSnowChart,
    renderWindPressureChart,
    renderSoilProfileChart,
  } = await import('../js/charts.js');

  const iconTypes = [
    'sunny',
    'mostly-sunny',
    'partly-sunny',
    'cloudy',
    'rain-cloudy',
    'sleet',
    'freezing-rain',
    'snow',
    'cloudy-snow',
    'clear-night',
    'partly-cloudy-night',
    'fog',
  ];
  for (const icon of iconTypes) {
    const svg = getWeatherSvg(icon, 'w-10 h-10');
    assert.match(svg, /<svg[\s\S]*<\/svg>/i, `getWeatherSvg(${icon}) invalid`);
    assert.equal(/\bNaN\b|undefined/.test(svg), false, `getWeatherSvg(${icon}) contains NaN/undefined`);
  }

  const baseUiState = {
    unit: 'metric',
    pressureMode: 'station',
    timeWindow: 'full',
    selectedDayId: 'day_2026-11-17',
    selectedHourSlot: 12,
    showClimatology: true,
    showModelLines: true,
    groupByPentad: false,
  };

  // Diurnal chart for deterministic day (24h) and subseasonal day (no hours)
  const dayDet = makeMockDay(0, '2026-11-17');
  const daySub = makeMockDay(24, '2026-12-11');
  for (const d of [dayDet, daySub]) {
    const el = makeMockContainer();
    renderDiurnalChart(el, d, baseUiState, () => {});
    assert.ok(el.innerHTML.length > 50, `renderDiurnalChart empty for zone=${d.zone}`);
    assert.equal(/\bNaN\b|undefined/.test(el.innerHTML), false, `renderDiurnalChart NaN/undefined for zone=${d.zone}`);
    if (d.zone !== 'subseasonal') {
      assert.match(el.innerHTML, /<svg[\s\S]*<\/svg>/i);
    }
  }

  // Multi-day charts across 1-day, 10-day, 35-day, and 35-day pentad
  const scenarios = [
    { label: '1d', days: makeMockDays(1), ui: { ...baseUiState, groupByPentad: false } },
    { label: '10d', days: makeMockDays(10), ui: { ...baseUiState, groupByPentad: false } },
    { label: '35d', days: makeMockDays(35), ui: { ...baseUiState, groupByPentad: false } },
    { label: '35d-pentad', days: makeMockDays(35), ui: { ...baseUiState, groupByPentad: true } },
  ];

  for (const { label, days, ui } of scenarios) {
    for (const [fnName, fn] of [
      ['renderTempEnsembleChart', renderTempEnsembleChart],
      ['renderPrecipSnowChart', renderPrecipSnowChart],
      ['renderWindPressureChart', renderWindPressureChart],
      ['renderSoilProfileChart', renderSoilProfileChart],
    ]) {
      const el = makeMockContainer();
      fn(el, days, ui, () => {});
      assert.match(el.innerHTML, /<svg[\s\S]*<\/svg>/i, `${fnName} (${label}) must output valid <svg>`);
      assert.equal(/\bNaN\b|undefined/.test(el.innerHTML), false, `${fnName} (${label}) has NaN or undefined`);
    }
  }
});

test('HTTP server smoke check serves all entrypoints and modules with HTTP 200', async () => {
  const mimeTypes = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.mjs': 'application/javascript; charset=utf-8',
    '.webmanifest': 'application/manifest+json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.json': 'application/json; charset=utf-8',
  };

  const server = http.createServer((req, res) => {
    const reqPath = (req.url || '/').split('?')[0];
    const relPath = reqPath === '/' ? 'index.html' : reqPath.replace(/^\/+/, '');
    const fullPath = path.resolve(ROOT, relPath);
    if (!fullPath.startsWith(ROOT) || !fs.existsSync(fullPath) || fs.statSync(fullPath).isDirectory()) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }
    const ext = path.extname(fullPath).toLowerCase();
    res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' });
    fs.createReadStream(fullPath).pipe(res);
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const addr = server.address();
    const baseUrl = `http://127.0.0.1:${addr.port}`;
    const pathsToCheck = [
      '/',
      '/index.html',
      '/css/styles.css',
      '/js/app.js',
      '/js/config.js',
      '/js/physics.js',
      '/js/ensemble.js',
      '/js/storage.js',
      '/js/api.js',
      '/js/charts.js',
      '/sw.js',
      '/manifest.webmanifest',
      '/assets/icon.svg',
    ];
    for (const p of pathsToCheck) {
      const resp = await fetch(`${baseUrl}${p}`);
      assert.equal(resp.status, 200, `GET ${p} expected 200, got ${resp.status}`);
      const text = await resp.text();
      assert.ok(text.length > 0, `GET ${p} returned empty body`);
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
