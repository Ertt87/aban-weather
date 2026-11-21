import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { once } from 'node:events';

let chromium;
try { ({ chromium } = createRequire(import.meta.url)('playwright')); }
catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }

test('service worker activation preserves neighbouring installations and serves its own offline shell', {
  skip: !chromium && 'Playwright is not installed', timeout: 30000,
}, async t => {
  const worker = await readFile(new URL('../../sw.js', import.meta.url));
  // A loopback origin gives Chromium real service-worker and CacheStorage behaviour.
  // The shell fixture is intentionally inert so it makes no external provider requests.
  const server = createServer((req, res) => {
    const path = req.url.split('?')[0];
    const script = path.endsWith('.js');
    res.writeHead(200, { 'Content-Type': script ? 'text/javascript' : 'text/html; charset=utf-8' });
    res.end(path.endsWith('/sw.js') ? worker : script ? '' : '<title>Абан офлайн</title>');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const origin = 'http://127.0.0.1:' + server.address().port;
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE });
  t.after(() => browser.close());
  for (const width of [390,1440]) {
    await t.test(width + 'px isolates cache updates by registration scope', async () => {
      const context = await browser.newContext({ viewport: {width,height:850} });
      try {
        const page = await context.newPage();
        await page.goto(origin + '/aban/');
        const { keys, prefix, other } = await page.evaluate(async () => {
          const scope = location.href;
          const prefix = 'aban-weather-v4-shell:' + encodeURIComponent(scope) + ':v';
          const other = 'aban-weather-v4-shell:' + encodeURIComponent(new URL('/nearby/', scope).href) + ':v1';
          for (const name of [prefix+'1', prefix+'999', other, 'neighbour-app', 'aban-weather-v4-shell-v13', 'aban-weather-v4-shell-v12']) {
            const cache = await caches.open(name);
            await cache.put(scope+'index.html', new Response('fixture'));
            if (name.endsWith('-v12')) await cache.put(new URL('/nearby/index.html',scope), new Response('neighbour'));
          }
          const controlled = new Promise(resolve => navigator.serviceWorker.addEventListener('controllerchange',resolve,{once:true}));
          await navigator.serviceWorker.register('./sw.js');
          await navigator.serviceWorker.ready;
          await controlled;
          return {keys: await caches.keys(), prefix, other};
        });
        assert.ok(!keys.includes(prefix+'1'));
        assert.ok(!keys.includes('aban-weather-v4-shell-v13'));
        for (const name of [other,'neighbour-app','aban-weather-v4-shell-v12',prefix+'999']) assert.ok(keys.includes(name), name);
        assert.equal(keys.filter(key => key.startsWith(prefix)).length, 2);
        await context.setOffline(true);
        await page.goto(origin+'/aban/offline');
        assert.equal(await page.title(), 'Абан офлайн');
      } finally { await context.close(); }
    });
  }
});
