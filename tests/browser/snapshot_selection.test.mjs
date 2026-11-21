import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { extname } from 'node:path';

const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch (err) {
  if (err.code !== 'MODULE_NOT_FOUND') throw err;
}

const origin = 'http://127.0.0.1:18768';
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const today = '2026-11-22';
const cacheKey = 'aban_weather_cache_v4';

// A provider can finish decoding a response even after cancellation. Resolve that body
// explicitly, then let all promise continuations run before checking the UI and disk.
function installProviders(iso) {
  const nativeFetch = window.fetch.bind(window);
  const fixture = window.providers = { max: 7, hold: null, pending: null };
  window.fetch = async (input, init) => {
    const url = new URL(input, location.href);
    if (url.origin === location.origin) return nativeFetch(input, init);
    if (sessionStorage.providersDown) return new Response(null, { status: 503 });
    let kind, payload;
    if (url.hostname === 'api.open-meteo.com' && url.searchParams.get('models')?.includes(',')) {
      if (fixture.coreDown) return new Response(null, { status: 503 });
      kind = 'forecast';
      payload = { hourly: fixture.hourly, daily: fixture.daily ?? { time: [iso], temperature_2m_max_ecmwf_ifs025: [fixture.max],
        temperature_2m_min_ecmwf_ifs025: [-8], precipitation_sum_ecmwf_ifs025: [0] } };
    } else if (url.hostname === 'seasonal-api.open-meteo.com' && fixture.seasonal) {
      kind = 'seasonal';
      payload = { daily: { time: ['2026-12-12'], temperature_2m_max_member01: [10],
        temperature_2m_max_member02: [20], temperature_2m_min_member01: [5], temperature_2m_min_member02: [15] } };
    } else if (url.hostname === 'air-quality-api.open-meteo.com') {
      kind = 'air';
      payload = { current: fixture.air ?? { pm2_5: 1 } };
    } else if (url.hostname === 'archive-api.open-meteo.com') {
      kind = 'archive';
      payload = { daily: { time: [url.searchParams.get('start_date')], temperature_2m_max: [5], temperature_2m_min: [2] } };
    } else {
      return new Response(null, { status: 503 });
    }
    const response = Response.json(payload);
    if (fixture.hold === kind) {
      fixture.hold = null;
      response.json = () => new Promise(resolve => {
        fixture.pending = { signal: init.signal, release: () => resolve(payload) };
      });
    }
    return response;
  };
  const readText = File.prototype.text;
  File.prototype.text = function () {
    if (this.name !== 'slow.json') return readText.call(this);
    const gate = new Promise(resolve => { fixture.finishReading = resolve; });
    fixture.fileRead = gate.then(() => readText.call(this));
    return fixture.fileRead;
  };
}

const stored = page => page.evaluate(key => localStorage.getItem(key), cacheKey);
const status = (page, label) => page.waitForFunction(expected =>
  !document.querySelector('#refreshDataBtn').disabled && document.querySelector('#liveStatusText').textContent === expected, label);

async function startRefresh(page, hold) {
  await page.evaluate(kind => Object.assign(window.providers, { hold: kind, max: -3.7, pending: null }), hold);
  await page.locator('#refreshDataBtn').click();
  await page.waitForFunction(() => window.providers.pending !== null);
}

async function deliverLateReply(page) {
  const aborted = await page.evaluate(async () => {
    const { signal, release } = window.providers.pending;
    release();
    await new Promise(resolve => setTimeout(resolve, 0));
    return signal.aborted;
  });
  assert.equal(aborted, true, 'the superseded transport was cancelled');
}

async function chooseFile(page, name, max) {
  const { dataset } = JSON.parse(await stored(page));
  dataset.days = dataset.days.filter(d => d.isoDate === today);
  Object.assign(dataset.days[0], { maxC: max, maxF: max * 9 / 5 + 32 });
  dataset.sourceLabel = 'Импортированный прогноз';
  await importJson(page, { dataset }, name);
}

async function importJson(page, payload, name = 'forecast.json') {
  await page.locator('#btnOpenSettings').click();
  await page.locator('#inputImportJson').setInputFiles({
    name, mimeType: 'application/json', buffer: Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload)),
  });
  await page.locator('#btnCloseSettings').click();
}

async function verifySelected(page, label, max) {
  await status(page, label);
  assert.equal(await page.locator('#todayMaxBadge').textContent(), '+' + max.toFixed(1) + '°C');
  assert.equal(await page.locator('#inputStartDate').inputValue(), today);
  const { dataset } = JSON.parse(await stored(page));
  assert.equal(dataset.days.find(d => d.isoDate === today).maxC, max);
  if (label === 'СНИМОК') {
    assert.equal(dataset.sourceLabel, 'Импортированный прогноз');
    assert.equal(await page.locator('#inputEndDate').inputValue(), today);
  }
}

const scenarios = {
  async 'partial weather fields, zero air quality, keyboard controls and the seasonal label'(page) {
    const text = id => page.locator('#' + id).textContent();
    await page.evaluate(iso => Object.assign(window.providers, {
      daily: { time: [iso], precipitation_sum_ecmwf_ifs025: [4] }, air: { pm2_5: 0 },
    }), today);
    await page.locator('#refreshDataBtn').click();
    await status(page, 'АНСАМБЛЬ');
    assert.match(await text('currentAqiBadge'), /AQI — • PM2.5 0 мкг\/м³/);
    assert.equal(await text('todayMaxBadge'), '—');
    assert.equal(await text('periodSumAvgDay'), '—');
    assert.equal(await text('inspectorDailyPrecip'), '4.0 мм');
    assert.match(await text('periodSumMaxWind'), /—/);
    assert.match(await text('toggleClimatologyBtn'), /Сезонная оценка/);
    await page.locator('#btnOpenSettings').click();
    const units = page.locator('#modalUnitImperial');
    await units.focus();
    await units.press('Space');
    assert.equal(await page.getByRole('button', { name: '°F, mph', pressed: true }).count(), 1);
    assert.equal(await units.getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('#btnUnitMetric').getAttribute('aria-pressed'), 'false');
    assert.equal(await page.locator('#btnUnitImperial').getAttribute('aria-pressed'), 'true');
    await page.locator('#btnCloseSettings').click();
    const preset = page.locator('#presetBtn-3d');
    if (!await preset.isVisible()) await page.locator('#drawerToggleTrigger').click();
    await preset.focus();
    await preset.press('Enter');
    assert.equal(await preset.getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('#presetBtn-10d').getAttribute('aria-pressed'), 'false');
    await page.evaluate(() => { window.providers.air = { european_aqi: 0 }; });
    await page.locator('#refreshDataBtn').click();
    await status(page, 'АНСАМБЛЬ');
    assert.match(await text('currentAqiBadge'), /AQI 0 • PM2.5 —/);
    await page.evaluate(() => { sessionStorage.providersDown = '1'; });
    await page.reload();
    await status(page, 'КЭШ');
    assert.equal(await text('inspectorDailyPrecip'), '4.0 мм');
    assert.equal(await text('todayMinBadge'), '—');
  },
  async 'two dry readings do not qualify a day and five missing daily amounts remain unknown'(page) {
    await page.evaluate(iso => {
      const dates = Array.from({length:16}, (_,i) => new Date(Date.parse(iso)+i*86400000).toISOString().slice(0,10));
      window.providers.daily = { time: dates, temperature_2m_max_ecmwf_ifs025: dates.map(() => 6),
        temperature_2m_min_ecmwf_ifs025: dates.map(() => 0), precipitation_sum_ecmwf_ifs025: dates.map(() => null) };
      window.providers.daily.precipitation_sum_ecmwf_ifs025[0] = 0.3;
      window.providers.hourly = { time: [iso+'T08:00',iso+'T22:00'], precipitation_probability_ecmwf_ifs025: [4,3] };
    },today);
    await page.locator('#refreshDataBtn').click();
    await status(page,'АНСАМБЛЬ');
    assert.match(await page.locator('#filterBtn-clear').textContent(), /\(0\)/);
    const preset = page.locator('#presetBtn-16d');
    if (!await preset.isVisible()) await page.locator('#drawerToggleTrigger').click();
    await preset.click();
    if (!await page.locator('#forecastStripContainer').evaluate(el => el.classList.contains('forecast-strip--pentad'))) {
      await page.locator('#btnGroupByPentad').click();
    }
    const group = page.locator('#forecastStripContainer [data-day-id]').nth(1);
    await group.click();
    await page.locator('#tabBtn-precip').click();
    assert.match(await page.locator('#activeChartSummaryText').textContent(), /осадки —/);
    assert.match(await page.locator('#precipChartWrapper g[data-day-id]').nth(1).getAttribute('aria-label'), /осадки неизвестны/);
    assert.doesNotMatch(await group.textContent(), /0\.0\s*мм|0%/);
  },
  async 'upcoming real hours across midnight open the matching chart hour'(page) {
    await page.clock.setFixedTime(new Date('2026-11-22T15:00:00Z'));
    await page.evaluate(() => {
      const dates = ['2026-11-22', '2026-11-23'];
      Object.assign(window.providers, {
        daily: { time: dates, temperature_2m_max_ecmwf_ifs025: [6, 3], temperature_2m_min_ecmwf_ifs025: [-4, -2] },
        hourly: { time: [dates[0]+'T22:00', dates[0]+'T23:00', dates[1]+'T00:00', dates[1]+'T02:00'],
          temperature_2m_ecmwf_ifs025: [1, 2, 0, -1] },
      });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.locator('#refreshDataBtn').click();
    await status(page, 'АНСАМБЛЬ');
    const hours = page.locator('#upcomingHours button');
    assert.deepEqual(await hours.evaluateAll(items => items.map(i => i.dataset.forecastHour)), ['22','23','0','2']);
    const selectedInView = async hour => page.locator('#diurnalChartContainer').evaluate((chart, h) => {
      const wrap = chart.closest('.chart-scroll-wrap').getBoundingClientRect();
      const rect = chart.querySelector('g[tabindex][data-hour="'+h+'"]').getBoundingClientRect();
      return rect.left >= wrap.left - 2 && rect.right <= wrap.right + 2;
    }, hour);
    assert.equal(await selectedInView(22), true);
    const midnight = hours.nth(2);
    assert.match(await midnight.textContent(), /Завтра 00:00/);
    if (page.viewportSize().width < 500) await midnight.tap();
    else { await midnight.focus(); await midnight.press('Enter'); }
    assert.match(await page.locator('#inspectorDateBadge').textContent(), /23 ноя/);
    assert.match(await page.locator('#selectedHourTitle').textContent(), /00:00/);
    assert.equal(await selectedInView(0), true);
    if (page.viewportSize().width < 500) {
      await page.setViewportSize({ width: 320, height: 800 });
      await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
      const geometry = await page.evaluate(() => ({
        width: document.documentElement.scrollWidth,
        offenders: [...document.querySelectorAll('body *')].filter(el => {
          if (el.namespaceURI.endsWith('svg')) return false;
          const r = el.getBoundingClientRect();
          if (r.right < 322 || !r.width) return false;
          for (let p = el.parentElement; p && p !== document.body; p=p.parentElement) {
            if (['auto','scroll','hidden','clip'].includes(getComputedStyle(p).overflowX)) return false;
          }
          return true;
        }).slice(0,15).map(e => [e.tagName,e.id,e.className,Math.round(e.getBoundingClientRect().right)]),
      }));
      assert.ok(geometry.width <= 320, JSON.stringify(geometry));
      await page.locator('#btnOpenSettings').click();
      assert.equal(await page.locator('#modalUnitMetric').isVisible(), true);
      for (const id of ['modalUnitMetric','modalUnitImperial','modalUnitDual','btnCloseSettings']) {
        const rect = await page.locator('#'+id).boundingBox();
        assert.ok(rect && rect.x >= -1 && rect.x + rect.width <= 321, id + ' ' + JSON.stringify(rect));
      }
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= 320));
    }
  },
  async 'forecast coverage and ensemble temperature range survive reopening from cache'(page) {
    const text = id => page.locator('#' + id).textContent();
    assert.doesNotMatch(await text('inspectorZoneBadge'), /%|Точный/);
    assert.match(await text('activeChartSummaryText'), /Расчётный диапазон/);
    assert.doesNotMatch(await text('activeChartSummaryText'), /P10/);
    await page.evaluate(() => { window.providers.seasonal = true; });
    await page.locator('#refreshDataBtn').click();
    await status(page, 'АНСАМБЛЬ');
    const preset = page.locator('#presetBtn-35d');
    if (!await preset.isVisible()) await page.locator('#drawerToggleTrigger').click();
    await preset.click();
    const day = iso => page.locator('#forecastStripContainer [data-day-id="day_' + iso + '"]');
    await day('2026-11-23').click();
    assert.equal(await text('inspectorTitle'), 'Нет прогноза');
    assert.doesNotMatch(await day('2026-11-23').textContent(), /%|P10/);
    const checkRange = async () => {
      await day('2026-12-12').click();
      const summary = await text('activeChartSummaryText');
      assert.match(summary, /ECMWF Seasonal/);
      assert.match(summary, /P10–P90[^•]*\+11\.0°.*\+19\.0°/);
      assert.doesNotMatch(await text('inspectorZoneBadge'), /%/);
      assert.doesNotMatch(await page.locator('[data-timeline-iso="2026-12-12"]').getAttribute('title'), /%/);
      assert.equal(await page.locator('#tempChartWrapper [data-fan-band="max"]').count(), 1);
    };
    await checkRange();
    await page.evaluate(() => { window.providers.coreDown = true; });
    await page.locator('#refreshDataBtn').click();
    await status(page, 'АНСАМБЛЬ');
    assert.match(await text('activeSourceBadge'), /Ансамбль Open-Meteo/);
    assert.equal(await text('todayMaxBadge'), '—');
    await checkRange();
    await page.evaluate(() => { sessionStorage.providersDown = '1'; });
    await page.reload();
    await status(page, 'КЭШ');
    await checkRange();
    await page.evaluate(key => {
      const record = JSON.parse(localStorage.getItem(key));
      for (const day of record.dataset.days) {
        delete day.temperatureRange;
        day.confidencePct = 91;
      }
      localStorage.setItem(key, JSON.stringify(record));
    }, cacheKey);
    await page.reload();
    await status(page, 'КЭШ');
    await day('2026-12-12').click();
    assert.match(await text('activeChartSummaryText'), /Источник диапазона не указан/);
    assert.doesNotMatch(await text('activeChartSummaryText'), /P10|Seasonal/);
    assert.doesNotMatch(await text('inspectorZoneBadge'), /91%/);
  },
  async 'days-only JSON remains usable after navigation, sharing and an offline reload'(page) {
    const day = { isoDate: today, minC: 0, maxC: 17 };
    await importJson(page, { days: [day] });
    await status(page, 'СНИМОК');
    const checkDay = async () => {
      assert.equal(await page.locator('#todayMaxBadge').textContent(), '+17.0°C');
      assert.equal(await page.locator('#inspectorDayTemp').textContent(), '+17.0°C');
      assert.equal(await page.locator('#todayMinBadge').textContent(), '0.0°C');
      assert.equal(await page.locator('#currentSummaryBody').isVisible(), false);
      assert.match(await page.locator('#currentObsTimeBadge').textContent(), /Нет данных/);
      assert.match(await page.locator('#currentAqiBadge').textContent(), /Нет данных/);
      assert.equal(await page.locator('#controlTemp').textContent(), '—');
      assert.match(await page.locator('#selectedHourWetBulb').textContent(), /Без почасовой сетки/);
      assert.match(await page.locator('#diurnalChartContainer').textContent(), /Нет почасовых данных/);
    };
    await checkDay();
    for (const tab of ['precip', 'wind', 'ops', 'temp']) await page.locator('#tabBtn-' + tab).click();
    await page.evaluate(() => Object.defineProperty(navigator, 'share', {
      value: async ({ text }) => { window.sharedForecast = text; },
    }));
    await page.locator('#btnShareSummary').click();
    await page.waitForFunction(() => !!window.sharedForecast);
    const summary = await page.evaluate(() => window.sharedForecast);
    assert.match(summary, /\+17\.0°C/);
    assert.doesNotMatch(summary, /undefined|NaN|Сейчас: \*[^—]/);
    await page.evaluate(() => { sessionStorage.providersDown = '1'; });
    await page.reload();
    await status(page, 'КЭШ');
    await checkDay();
  },
  async 'invalid JSON snapshot preserves the previous forecast and cache'(page) {
    const original = await stored(page);
    await page.locator('#tabBtn-ops').click();
    const previous = await page.locator('#inspectorDateBadge').textContent();
    for (const file of [
      '{"days":[',
      { days: [{ isoDate: today, minC: 1 }] },
      { version: 99, dataset: { days: [{ isoDate: today, minC: 0, maxC: 31 }] } },
    ]) {
      await importJson(page, file);
      assert.match(await page.locator('#toastContainer .toast-item').last().textContent(), /JSON|версия/i);
      assert.ok(await stored(page) === original, 'original cache record is unchanged');
      await verifySelected(page, 'АНСАМБЛЬ', 7);
      assert.equal(await page.locator('#inspectorDateBadge').textContent(), previous);
      assert.equal(await page.locator('#tabBtn-ops').getAttribute('aria-selected'), 'true');
    }
    await page.evaluate(() => { sessionStorage.providersDown = '1'; });
    await page.reload();
    await verifySelected(page, 'КЭШ', 7);
  },
  async 'partial measurements keep real zeroes and expose missing fields'(page) {
    await importJson(page, { version: 4, dataset: {
      days: [{ isoDate: today, maxC: 17, minC: 0, hours: [{ hour: 12, tempC: 0 }] }],
      current: { tempC: 0 }, airQuality: { aqi: 0, pm25: 0 },
      mos: { models: { unavailable: null } },
    } });
    await status(page, 'СНИМОК');
    assert.equal(await page.locator('#currentSummaryBody').isVisible(), true);
    assert.equal(await page.locator('#currentTempDisplay').textContent(), '0.0°C');
    assert.equal(await page.locator('#currentHumidityDisplay').textContent(), '—');
    assert.match(await page.locator('#currentAqiBadge').textContent(), /AQI 0 • PM2.5 0/);
    assert.match(await page.locator('#selectedHourTitle').textContent(), /12:00/);
    await page.locator('#btnOpenSettings').click();
    assert.match(await page.locator('#mosLeaderboardBody').textContent(), /Калибровка MOS/);
  },
  async 'failed cache write restores the previous screen and stored forecast'(page) {
    const original = await stored(page);
    const range = await page.locator('#inputEndDate').inputValue();
    await page.evaluate(key => {
      const write = Storage.prototype.setItem;
      Storage.prototype.setItem = function (name, value) {
        if (name === key) throw new DOMException('Storage full', 'QuotaExceededError');
        return write.call(this, name, value);
      };
    }, cacheKey);
    await importJson(page, { days: [{ isoDate: today, maxC: 31, minC: 0 }] });
    await verifySelected(page, 'АНСАМБЛЬ', 7);
    assert.match(await page.locator('#toastContainer .toast-item').last().textContent(), /Не удалось сохранить.*в кэш/i);
    assert.equal(await page.locator('#inputEndDate').inputValue(), range);
    assert.ok(await stored(page) === original, 'failed import did not change the stored forecast');
    await page.evaluate(() => { sessionStorage.providersDown = '1'; });
    await page.reload();
    await verifySelected(page, 'КЭШ', 7);
  },
  async 'offline cache after a partial forecast'(page) {
    const original = await stored(page);
    await startRefresh(page, 'air');
    await page.waitForFunction(() => document.querySelector('#todayMaxBadge').textContent.includes('3.7'));
    const offline = page.locator('#srcBtn-offline_cache');
    if (!await offline.isVisible()) await page.locator('#drawerToggleTrigger').click();
    await offline.click();
    await verifySelected(page, 'КЭШ', 7);
    await deliverLateReply(page);
    await verifySelected(page, 'КЭШ', 7);
    assert.equal(await stored(page), original);
    assert.equal(await page.locator('#refreshErrorText').isVisible(), false);
    await page.reload();
    await verifySelected(page, 'КЭШ', 7);
  },
  async 'JSON import before the core forecast arrives'(page) {
    await startRefresh(page, 'forecast');
    await chooseFile(page, 'snapshot.json', 17);
    await verifySelected(page, 'СНИМОК', 17);
    const imported = await stored(page);
    await deliverLateReply(page);
    await page.clock.setFixedTime(new Date('2026-11-22T06:10:00Z'));
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await verifySelected(page, 'СНИМОК', 17);
    assert.equal(await stored(page), imported);
    assert.equal(await page.locator('#refreshErrorText').isVisible(), false);
    await page.evaluate(() => { sessionStorage.providersDown = '1'; });
    await page.reload();
    await verifySelected(page, 'КЭШ', 17);
    await page.evaluate(() => { delete sessionStorage.providersDown; });
    await page.locator('#refreshDataBtn').click();
    await verifySelected(page, 'АНСАМБЛЬ', 7);
  },
  async 'late forecast while the selected JSON file is still being read'(page) {
    const original = await stored(page);
    await startRefresh(page, 'forecast');
    await chooseFile(page, 'slow.json', 17);
    await page.waitForFunction(() => !!window.providers.finishReading);
    await deliverLateReply(page);
    assert.equal(await stored(page), original);
    assert.equal(await page.locator('#todayMaxBadge').textContent(), '+7.0°C');
    await page.evaluate(() => window.providers.finishReading());
    await verifySelected(page, 'СНИМОК', 17);
    await page.evaluate(() => { window.providers.max = 7; });
    await page.locator('#refreshDataBtn').click();
    await verifySelected(page, 'АНСАМБЛЬ', 7);
  },
  async 'browser goes offline during a refresh'(page) {
    const original = await stored(page);
    await startRefresh(page, 'forecast');
    await page.context().setOffline(true);
    await verifySelected(page, 'КЭШ', 7);
    await deliverLateReply(page);
    await verifySelected(page, 'КЭШ', 7);
    assert.equal(await stored(page), original);
    assert.match(await page.locator('#refreshErrorText').textContent(), /Нет подключения к сети/);
  },
  async 'slower JSON file cannot replace a later import'(page) {
    await chooseFile(page, 'slow.json', 17);
    await page.waitForFunction(() => !!window.providers.finishReading);
    await chooseFile(page, 'newer.json', 19);
    await verifySelected(page, 'СНИМОК', 19);
    const accepted = await stored(page);
    await page.evaluate(async () => {
      window.providers.finishReading();
      await window.providers.fileRead;
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    await verifySelected(page, 'СНИМОК', 19);
    assert.equal(await stored(page), accepted);
  },
  async 'newer archive range wins'(page) {
    const first = '2001-01-01', second = '2001-02-01';
    const changeStart = iso => page.locator('#inputStartDate').evaluate((input, date) => {
      input.value = date;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }, iso);
    await page.evaluate(() => { window.providers.hold = 'archive'; });
    await changeStart(first);
    await page.waitForFunction(() => !!window.providers.pending);
    await changeStart(second);
    await page.waitForFunction(() => document.querySelector('#archiveLoadHint').textContent.includes('Загружено'));
    const selected = await page.locator('#inspectorDateBadge').textContent();
    await deliverLateReply(page);
    assert.equal(await page.locator('#inputStartDate').inputValue(), second);
    assert.equal(await page.locator('#inputEndDate').inputValue(), second);
    assert.match(selected, /1 фев/);
    assert.equal(await page.locator('#inspectorDateBadge').textContent(), selected);
  },
};

test('snapshot selection in root v4', { skip: !chromium && 'Playwright is not installed' }, async t => {
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE });
  try {
    for (const [width, height] of [[390, 844], [1440, 900]]) {
      for (const [name, run] of Object.entries(scenarios)) {
        await t.test(width + '×' + height + ' ' + name, async () => {
          const context = await browser.newContext({ viewport: { width, height }, isMobile: width < 500,
            hasTouch: width < 500, serviceWorkers: 'block', timezoneId: 'Asia/Krasnoyarsk' });
          try {
            await context.route(/.*/, async route => {
              const url = new URL(route.request().url());
              if (url.origin !== origin) return route.fulfill({ status: 503 });
              const path = url.pathname.slice(1) || 'index.html';
              try {
                const body = await readFile(new URL('../../' + path, import.meta.url));
                return route.fulfill({ body, contentType: types[extname(path)] || 'application/json' });
              } catch { return route.fulfill({ status: 404 }); }
            });
            const page = await context.newPage();
            const errors = [];
            page.on('pageerror', err => errors.push(err.message));
            page.setDefaultTimeout(6500);
            await page.addInitScript(installProviders, today);
            await page.clock.setFixedTime(new Date('2026-11-22T05:00:00Z'));
            await page.goto(origin);
            await verifySelected(page, 'АНСАМБЛЬ', 7);
            await run(page);
            assert.deepEqual(errors, []);
          } finally { await context.close(); }
        });
      }
    }
  } finally { await browser.close(); }
});
