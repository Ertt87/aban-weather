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

const origin = 'http://127.0.0.1:18767/';
const dates = ['2026-11-21', '2026-11-22', '2026-11-23'];
const response = { daily: {
  time: dates, temperature_2m_max_ecmwf_ifs025: [-3, 7, 8],
  temperature_2m_min_ecmwf_ifs025: [-8, 2, 3], precipitation_sum_ecmwf_ifs025: [0, 0, 0],
} };
const types = { '.js': 'text/javascript', '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.svg': 'image/svg+xml' };

test('cache rollover and network failure through the v4 UI', { skip: !chromium && 'Playwright is not installed' }, async t => {
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE });
  try {
    for (const [width, height] of [[390, 844], [1440, 900]]) {
      await t.test(`${width}×${height}`, async () => {
        // Deliberately different from Aban. Both local midnights below are still the afternoon here.
        const context = await browser.newContext({ viewport: { width, height }, timezoneId: 'Europe/London',
          isMobile: width < 500, hasTouch: width < 500, serviceWorkers: 'block' });
        try {
          const page = await context.newPage();
          page.setDefaultTimeout(8000);
          const errors = [];
          page.on('pageerror', e => errors.push(e.message));
          let available = true;
          await context.route(/.*/, async route => {
            const url = new URL(route.request().url());
            if (url.origin === new URL(origin).origin) {
              const name = url.pathname.slice(1) || 'index.html';
              try {
                const body = await readFile(new URL('../../' + name, import.meta.url));
                return route.fulfill({ body, contentType: types[extname(name)] || 'application/json' });
              } catch { return route.fulfill({ status: 404 }); }
            }
            if (available && url.hostname === 'api.open-meteo.com' && url.pathname === '/v1/forecast' &&
                url.searchParams.get('models')?.includes(',')) return route.fulfill({ json: response });
            return route.fulfill({ status: 503, json: { reason: 'HTTP 503' } });
          });
          const text = id => page.locator('#' + id).textContent();
          const status = label => page.waitForFunction(expected =>
            !document.querySelector('#refreshDataBtn').disabled && document.querySelector('#liveStatusText').textContent === expected, label);
          const refresh = async label => { await page.locator('#refreshDataBtn').click(); await status(label); };
          const selectTime = iso => page.clock.setFixedTime(new Date(iso));
          await selectTime('2026-11-21T16:59:00Z');
          await page.goto(origin);
          await status('АНСАМБЛЬ');
          assert.match(await text('inspectorDateBadge'), /21 ноя.*Сегодня/);
          assert.match(await text('selectedHourTitle'), /23:00/);

          available = false;
          await refresh('КЭШ');
          assert.match(await text('refreshErrorText'), /HTTP 503.*сохранённый прогноз/);
          available = true;
          await refresh('АНСАМБЛЬ');
          assert.equal(await page.locator('#refreshErrorText').isVisible(), false);

          // Resume across midnight without reloading or waiting for the network refresh interval.
          available = false;
          await selectTime('2026-11-21T17:05:00Z');
          await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
          assert.match(await text('inspectorDateBadge'), /22 ноя.*Сегодня/);
          assert.match(await text('selectedHourTitle'), /00:00/);

          // Cold open from the same snapshot, with the providers unavailable.
          await page.reload();
          await status('КЭШ');
          assert.match(await text('inspectorDateBadge'), /22 ноя.*Сегодня/);
          assert.match(await text('selectedHourTitle'), /00:00/);
          assert.equal(await page.locator('#inputStartDate').inputValue(), dates[1]);
          assert.equal(await text('todayMaxBadge'), '+7.0°C');
          assert.match(await text('currentSummaryTitle'), /из снимка/);
          assert.match(await text('currentObsTimeBadge'), /21 ноя, 23:59/);
          assert.match(await text('syncTimestampText'), /21\.11\.2026 23:59 · 6 мин назад/);
          assert.match(await text('refreshErrorText'), /22\.11\.2026 00:05.*HTTP 503.*локальный кэш/);
          assert.equal(await page.locator('#refreshErrorText').isVisible(), true);
          const syncBox = await page.locator('#syncTimestampText').boundingBox();
          assert.ok(syncBox.width > 60 && syncBox.x + syncBox.width <= width + 1);

          // Explicit offline mode also reconciles the clock when the PWA resumes.
          const offlineButton = page.locator('#srcBtn-offline_cache');
          if (!await offlineButton.isVisible()) await page.locator('#drawerToggleTrigger').click();
          await offlineButton.click();
          await status('КЭШ');
          assert.equal(await page.locator('#refreshErrorText').isVisible(), false);
          await selectTime('2026-11-21T18:05:00Z');
          await page.evaluate(() => window.dispatchEvent(new Event('pageshow')));
          assert.match(await text('selectedHourTitle'), /01:00/);
          await page.locator('#srcBtn-hybrid').click();
          await status('КЭШ');

          // The cache has no row for the new day. Do not relabel the previous day to fill it.
          await page.evaluate(() => {
            const key = 'aban_weather_cache_v4';
            const record = JSON.parse(localStorage.getItem(key));
            record.dataset.days = record.dataset.days.filter(d => d.isoDate === '2026-11-21');
            localStorage.setItem(key, JSON.stringify(record));
          });
          await page.reload();
          await status('КЭШ');
          assert.match(await text('inspectorDateBadge'), /22 ноя.*Сегодня/);
          assert.equal(await text('inspectorTitle'), 'Нет прогноза');
          assert.match(await text('todayExtremesLabel'), /нет прогноза/);
          assert.equal(await text('todayMaxBadge'), '—');

          await page.evaluate(() => localStorage.removeItem('aban_weather_cache_v4'));
          await refresh('ИЗ ПАМЯТИ');
          assert.match(await text('refreshErrorText'), /из памяти/);
          await page.reload();
          await status('ЭТАЛОН');
          await refresh('ЭТАЛОН');
          assert.match(await text('refreshErrorText'), /сезонный пример/);
          assert.doesNotMatch(await text('refreshErrorText'), /кэш/i);
          assert.deepEqual(errors, []);
        } finally { await context.close(); }
      });
    }
  } finally { await browser.close(); }
});
