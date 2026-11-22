/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { setImmediate } from 'node:timers/promises';
import { parse } from 'parse5';
import { parseConfig, publicConfig } from '../src/config.ts';
import { page, script } from '../src/page.ts';

type HtmlNode = { nodeName: string; value?: string; attrs?: { name: string; value: string }[]; childNodes?: HtmlNode[] };
const nodes = (node: HtmlNode): HtmlNode[] => [node, ...(node.childNodes ?? []).flatMap(nodes)];
const attr = (node: HtmlNode, name: string) => node.attrs?.find(a => a.name === name)?.value;
const text = (node: HtmlNode): string => node.value ?? (node.childNodes ?? []).map(text).join('');
const html = nodes(parse(page) as unknown as HtmlNode);

test('video share selector exposes the two choices and explains the playback limitation', () => {
  const select = html.find(n => attr(n, 'id') === 'videoShareFormat')!;
  assert.equal(select.nodeName, 'select');
  assert.deepEqual(select.childNodes!.filter(n => n.nodeName === 'option').map(n => [attr(n, 'value'), text(n)]), [
    ['card', '图文卡（封面＋标题＋链接）'], ['miniapp', '小程序'],
  ]);
  const label = html.find(n => n.nodeName === 'label' && n.childNodes?.includes(select))!;
  assert.match(text(label), /^视频分享方式/);
  assert.match(text(label), /部分视频可能无法播放.*切换为图文卡/);
});

test('settings round-trip the share format without showing or saving the old persona override', async () => {
  type Control = { value: string; type: string; checked: boolean; onsubmit?: (event: { preventDefault(): void }) => Promise<void>; [key: string]: unknown };
  const control = (type = ''): Control => ({ value: '', type, checked: false, closest: () => ({ style: {} }),
    replaceChildren() {}, add() {}, removeAttribute() {} });
  assert.equal(html.some(n => attr(n, 'id') === 'personaId'), false);
  const controls = new Map(html.filter(n => attr(n, 'id')).map(n => [attr(n, 'id')!, control(attr(n, 'type'))]));
  const byId = (id: string) => { const node = controls.get(id); assert.ok(node, id); return node; };
  let config = publicConfig(parseConfig({ videoShareFormat: 'miniapp', personaId: 'retired', mergeIncoming: false, galleryEnabled: false }));
  const saved: Record<string, unknown>[] = [];
  runInNewContext(script, {
    document: { getElementById: byId, createElement: () => control() },
    Option: function (text: string, value: string) { return { text, value }; },
    setInterval: () => 1, clearInterval() {}, window: { addEventListener() {} },
    fetch: async (url: string, init: { method: string; body?: string }) => {
      assert.equal(url, '/plugins/qq/config');
      if (init.method === 'POST') {
        const payload = JSON.parse(init.body!);
        assert.equal(payload.revision, 'test-revision');
        assert.equal('hasAccessToken' in payload.config, false);
        saved.push(payload.config);
        config = publicConfig(parseConfig(payload.config));
      }
      return { ok: true, json: async () => ({ config, revision: 'test-revision', models: [], status: { state: 'disabled' } }) };
    },
  });
  await setImmediate();
  assert.equal(byId('videoShareFormat').value, 'miniapp');
  for (const choice of ['card', 'miniapp']) {
    byId('videoShareFormat').value = choice;
    await byId('form').onsubmit!({ preventDefault() {} });
    assert.equal(saved.at(-1)?.videoShareFormat, choice);
    assert.equal(config.videoShareFormat, choice);
    assert.equal('personaId' in saved.at(-1)!, false);
    assert.equal(byId('videoShareFormat').value, choice);
    assert.equal(saved.at(-1)?.mergeIncoming, false);
    assert.equal(saved.at(-1)?.galleryEnabled, false);
    assert.equal(byId('notice').textContent, '设置已保存。');
  }
  assert.equal(saved.length, 2);
});
