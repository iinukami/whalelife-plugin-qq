import { test } from 'node:test';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { fixture } from './fixture.ts';

// Explicit, manually closed UI preview. It only uses the fake account/model fixture.
test('temporary QQ settings preview', { skip: process.env.QQ_PLUGIN_PREVIEW !== '1' }, async t => {
  const f = await fixture(t, { config: { enabled: false, connectionMode: 'managed' } });
  let finish!: () => void;
  const done = new Promise<void>(r => { finish = r; });
  const token = randomUUID();
  const control = createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/' + token) { res.writeHead(404); res.end(); return; }
    res.end('closing'); finish();
  });
  t.after(async () => { control.closeAllConnections(); await new Promise<void>(r => control.close(() => r())); });
  control.listen(0, '127.0.0.1'); await once(control, 'listening');
  console.log(JSON.stringify({ preview: f.url, close: `http://127.0.0.1:${(control.address() as { port: number }).port}/${token}` }));
  await done;
});
