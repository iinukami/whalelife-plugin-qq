import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaults, parseConfig, publicConfig, validateSelections } from '../src/config.ts';
import { privateEvent, segments, splitText } from '../src/messages.ts';
const config = parseConfig({ ...defaults, accountId: '100001', allowedUsers: ['200002'] });
const event = { post_type: 'message', message_type: 'private', sub_type: 'friend', self_id: 100001, user_id: 200002, message_id: -12, message: [{ type: 'text', data: { text: '你好🙂' } }] };

test('configuration is offline by default, validates credentials/identity and migrates v0', () => {
  assert.equal(parseConfig({}).enabled, false);
  assert.throws(() => parseConfig({ enabled: true }), /连接前/);
  assert.throws(() => parseConfig({ wsUrl: 'ws://example.com/' }), /wss/);
  assert.throws(() => parseConfig({ wsUrl: 'wss://example.com/?access_token=secret' }), /令牌/);
  assert.throws(() => parseConfig({ schemaVersion: 4 }), /较新/);
  const migrated = parseConfig({ schemaVersion: 0, url: 'ws://localhost:3001/', token: 'SECRET', selfId: '100001', allowUsers: ['200002'], persona: 'a' });
  assert.equal(migrated.schemaVersion, 3); assert.equal(migrated.connectionMode, 'external'); assert.equal(migrated.accountId, '100001'); assert.equal(migrated.accessToken, 'SECRET');
  assert.ok(!JSON.stringify(publicConfig(migrated)).includes('SECRET'));
  assert.equal('persona' in migrated || 'personaId' in migrated, false);
});
test('QQ drops the old persona setting and requires active-persona support only when enabled', () => {
  const base = { enabled: true, connectionMode: 'desktop', accountId: '100001', allowedUsers: ['200002'] };
  const ctx = (supported?: boolean) => ({ channels: supported === undefined ? {} : { supportsActivePersona: supported } }) as Parameters<typeof validateSelections>[0];
  for (const schemaVersion of [0, 1, 2, 3]) {
    const parsed = parseConfig({ ...base, schemaVersion, persona: 'old', personaId: 'retired' });
    for (const config of [parsed, publicConfig(parsed)]) {
      assert.equal('persona' in config || 'personaId' in config, false);
      assert.deepEqual(config.allowedUsers, base.allowedUsers);
    }
    assert.doesNotThrow(() => validateSelections(ctx(true), parsed));
    assert.throws(() => validateSelections(ctx(), parsed), /升级/);
    assert.throws(() => validateSelections(ctx(false), parsed), /升级/);
  }
  assert.doesNotThrow(() => validateSelections(ctx(), parseConfig({})));
});
test('video share format defaults to cards for old configs and accepts only explicit supported formats', () => {
  assert.equal(defaults.videoShareFormat, 'card');
  for (const raw of [{}, { schemaVersion: 0 }, { schemaVersion: 1 }, { schemaVersion: 2 }, { schemaVersion: 3 }])
    assert.equal(parseConfig(raw).videoShareFormat, 'card');
  for (const videoShareFormat of ['card', 'miniapp'] as const) {
    const parsed = parseConfig({ videoShareFormat, unknownSetting: 'ignored', accessToken: 'SECRET' });
    assert.equal(parsed.videoShareFormat, videoShareFormat);
    assert.equal(publicConfig(parsed).videoShareFormat, videoShareFormat);
    assert.equal('unknownSetting' in parsed, false);
    assert.equal('accessToken' in publicConfig(parsed), false);
  }
  for (const videoShareFormat of [undefined, null, '', 'CARD', ' miniapp', 'auto', true, 1, [], {}])
    assert.throws(() => parseConfig({ videoShareFormat }), /视频分享方式无效/);
});

test('only explicit trusted routing fields survive; groups/temp/self/wrong accounts are ignored', () => {
  const parsed = privateEvent({ ...event, persona: 'evil', permission: 'full', sessionId: 'victim', origin: { plugin: 'core' } }, config)!;
  assert.equal(parsed.peer, 'direct:200002'); assert.equal(parsed.messageId, '-12');
  assert.deepEqual(Object.keys(parsed).sort(), ['fingerprint','messageId','peer','segments','sender']);
  for (const patch of [{ message_type: 'group' }, { sub_type: 'group' }, { post_type: 'message_sent' }, { user_id: 100001 }, { user_id: 999999 }, { self_id: 999999 }])
    assert.equal(privateEvent({ ...event, ...patch }, config), null);
});
test('CQ decoding preserves emoji and does not execute escaped CQ text; fingerprints tolerate media URL refresh', () => {
  assert.deepEqual(segments('A🙂&#91;CQ:face,id=14&#93;[CQ:face,id=14]'), [
    { type: 'text', data: { text: 'A🙂[CQ:face,id=14]' } }, { type: 'face', data: Object.assign(Object.create(null), { id: '14' }) },
  ]);
  const a = privateEvent({ ...event, message: [{ type: 'image', data: { file: 'stable', url: 'https://a.qq.com/old' } }] }, config)!;
  const b = privateEvent({ ...event, message: [{ type: 'image', data: { file: 'stable', url: 'https://a.qq.com/new' } }] }, config)!;
  assert.equal(a.fingerprint, b.fingerprint);
  assert.equal(splitText('🙂'.repeat(3001)).map(x => Array.from(x).length).join(','), '1500,1500,1');
});
