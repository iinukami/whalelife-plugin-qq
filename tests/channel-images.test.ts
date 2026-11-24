/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import sharp from 'sharp';
import type { Context } from 'whalelife';
import { defaults } from '../src/config.ts';
import { MediaReader } from '../src/media.ts';
import type { OneBot } from '../src/onebot.ts';
import type { PrivateEvent } from '../src/messages.ts';

function event(parts: PrivateEvent['segments']): PrivateEvent {
  return { messageId: '42', peer: 'direct:200002', sender: '200002', fingerprint: 'synthetic', segments: parts };
}
const picture = (bytes: Buffer) => ({ type: 'image', data: { file: 'base64://' + bytes.toString('base64') } });

test('models get oriented pixels without source metadata or trailing data; gallery gets the original', async t => {
  const metadataMarker = 'WL_PRIVATE_CAMERA_MARKER';
  const tail = Buffer.from('WL_SYNTHETIC_PRIVATE_TRAILER');
  const jpeg = await sharp({ create: { width: 12, height: 8, channels: 3, background: '#2773aa' } })
    .withMetadata({ orientation: 6 }).withExifMerge({ IFD0: { ImageDescription: metadataMarker } }).jpeg().toBuffer();
  const original = Buffer.concat([jpeg, tail]);
  assert.ok(original.includes(Buffer.from(metadataMarker)), 'the original must actually carry the fixture metadata');
  const reader = new MediaReader({} as Context, defaults, {} as OneBot, new AbortController().signal);
  t.after(() => reader.dispose());
  let offers = 0;
  const result = await reader.normalizeNative(event([picture(original)]), async bytes => {
    offers++; assert.deepEqual(bytes, original); return '';
  });
  assert.equal(offers, 1);
  assert.equal(result.text, '');
  assert.equal(result.images.length, 1);
  const clean = Buffer.from(result.images[0].data);
  assert.equal(clean.includes(tail), false);
  assert.equal(clean.includes(Buffer.from(metadataMarker)), false);
  const metadata = await sharp(clean).metadata();
  assert.deepEqual([metadata.width, metadata.height], [8, 12]);
  assert.equal(metadata.exif, undefined);
  assert.equal(metadata.orientation, undefined);
});

test('a static image in quoted material identifies its attachment separately from the current image', async t => {
  const make = (width: number) => sharp({ create: { width, height: 4, channels: 3, background: '#246' } }).png().toBuffer();
  const current = picture(await make(12)), quoted = picture(await make(6));
  const protocol = { request: async (action: string) => {
    assert.equal(action, 'get_msg');
    return { message_type: 'private', sender: { user_id: 200002 }, message: [quoted] };
  } };
  const reader = new MediaReader({} as Context, defaults, protocol as unknown as OneBot, new AbortController().signal);
  t.after(() => reader.dispose());
  const result = await reader.normalizeNative(event([current, { type: 'reply', data: { id: '41' } }]));
  assert.equal(result.text, '[引用内容（背景资料）：[引用附图 2]]');
  assert.deepEqual(await Promise.all(result.images.map(async img => (await sharp(img.data).metadata()).width)), [12, 6]);
});
