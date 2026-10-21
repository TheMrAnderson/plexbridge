import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createApp } from '../src/app.js';
import { loadSettings } from '../src/config.js';
import { libraryItemsJson, playQueueJson } from '../src/plex/protocol.js';

async function withApp<T>(fn: (app: ReturnType<typeof createApp>) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'plexbridge-'));
  const app = createApp({ ...loadSettings({ PLEXBRIDGE_CONFIG_DIR: dir, PLEXBRIDGE_DISCOVERY_ENABLED: 'false' }), configDir: dir, discoveryEnabled: false });
  try { await app.ready(); return await fn(app); } finally { await app.close(); await rm(dir, { recursive: true, force: true }); }
}

test('identity persists and is consistent across endpoints', async () => withApp(async (app) => {
  const first = await app.inject('/identity');
  const second = await app.inject('/');
  assert.match(first.headers['content-type'] ?? '', /^application\/xml/);
  const id = first.body.match(/machineIdentifier="([^"]+)"/)?.[1];
  assert.equal(id, second.body.match(/machineIdentifier="([^"]+)"/)?.[1]);
  assert.match(first.body, /apiVersion="1\.2\.3"/);
  assert.match(first.body, /version="1\.43\.5\.11029-6bf8af3f0"/);
  assert.ok(id);
}));

test('admin page serves its separate assets', async () => withApp(async (app) => {
  const page = await app.inject('/admin');
  assert.equal(page.statusCode, 200);
  assert.match(page.body, /href="\/admin\.css"/);
  assert.match(page.body, /src="\/admin\.js"/);
  assert.equal((await app.inject('/admin.css')).statusCode, 200);
  assert.equal((await app.inject('/admin.js')).statusCode, 200);
}));

test('library is a single empty music section', async () => withApp(async (app) => {
  const response = await app.inject('/library/sections');
  assert.match(response.body, /size="1"/);
  assert.match(response.body, /title="Music"/);
  assert.match(response.body, /type="artist"/);
}));

test('optional library filters return empty PMS-compatible responses', async () => withApp(async (app) => {
  for (const filter of ['style', 'mood', 'studio', 'folder']) {
    const response = await app.inject({ method: 'GET', url: `/library/sections/1/${filter}`, headers: { accept: 'application/json' } });
    assert.equal(response.statusCode, 200, filter);
    assert.equal(JSON.parse(response.body).MediaContainer.size, 0, filter);
  }
}));

test('media providers discovery exposes the music library provider', async () => withApp(async (app) => {
  const response = await app.inject('/media/providers');
  assert.equal(response.statusCode, 200);
  assert.match(response.headers['content-type'] ?? '', /application\/xml/);
  assert.match(response.body, /<MediaContainer size="1"/);
  assert.match(response.body, /<MediaProvider identifier="com\.plexapp\.plugins\.library"/);
  assert.match(response.body, /<Feature key="\/library\/sections" type="content">/);
  assert.match(response.body, /<Directory hubKey="\/hubs" title="Home"><\/Directory>/);
  assert.match(response.body, /<Feature key="\/library\/metadata" type="metadata">/);
  assert.match(response.body, /<Feature key="\/library\/search" type="universalsearch">/);
}));

test('playlist discovery is available at the advertised Plex routes', async () => withApp(async (app) => {
  for (const url of ['/playlists', '/playlists?playlistType=audio', '/playlists/all', '/playlists/1/items']) {
    const response = await app.inject({ method: 'GET', url, headers: { accept: 'application/json' } });
    assert.equal(response.statusCode, 200, url);
    assert.equal(JSON.parse(response.body).MediaContainer.size, 0, url);
    if (url === '/playlists/all') assert.ok(!response.body.includes('playlist://image.smart'));
  }
  const libraryPlaylistRoute = await app.inject({ method: 'GET', url: '/library/sections/1/all?type=15&playlistType=audio', headers: { accept: 'application/json' } });
  assert.equal(libraryPlaylistRoute.statusCode, 200);
  assert.equal(JSON.parse(libraryPlaylistRoute.body).MediaContainer.size, 0);
}));

test('playback control endpoints return PMS-compatible success responses', async () => withApp(async (app) => {
  const timeline = await app.inject({ method: 'GET', url: '/:/timeline?state=playing&time=0', headers: { accept: 'application/json' } });
  assert.equal(timeline.statusCode, 200);
  assert.deepEqual(JSON.parse(timeline.body), { MediaContainer: { size: 0 } });
  assert.equal((await app.inject({ method: 'POST', url: '/:/timeline?state=playing&time=30&duration=121000' })).statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url: '/:/scrobble?ratingKey=s-test&time=30' })).statusCode, 200);
  assert.equal((await app.inject({ method: 'POST', url: '/:/scrobble?ratingKey=s-test&time=30' })).statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url: '/:/unscrobble?ratingKey=s-test' })).statusCode, 200);
  assert.equal((await app.inject({ method: 'POST', url: '/:/unscrobble?ratingKey=s-test' })).statusCode, 200);
  const firstCharacter = await app.inject({ method: 'GET', url: '/library/sections/1/firstCharacter?type=8', headers: { accept: 'application/json' } });
  assert.equal(firstCharacter.statusCode, 200);
  assert.equal(JSON.parse(firstCharacter.body).MediaContainer.title2, 'By First Letter');
  const transcodeStop = await app.inject({ method: 'GET', url: '/audio/:/transcode/universal/stop?session=test' });
  assert.equal(transcodeStop.statusCode, 200);
  assert.deepEqual(JSON.parse(transcodeStop.body), { MediaContainer: { size: 0 } });
  assert.equal((await app.inject({ method: 'GET', url: '/photo/:/transcode' })).statusCode, 404);
}));

test('track metadata advertises PMS-compatible artwork in queues and library responses', () => {
  const item = { ratingKey: 's-demo', key: '/library/metadata/s-demo', type: 'track' as const, title: 'Demo', thumb: '/library/metadata/l-album/thumb', art: '/library/metadata/l-album/art', media: { partKey: '/library/metadata/s-demo/stream', duration: 120, container: 'mp3', audioCodec: 'mp3' } };
  const queueMetadata = JSON.parse(playQueueJson(item, '1', 'library://plexbridge-music/item//library/metadata/s-demo')).MediaContainer.Metadata[0];
  const libraryMetadata = JSON.parse(libraryItemsJson([item], 'track')).MediaContainer.Metadata[0];
  for (const metadata of [queueMetadata, libraryMetadata]) {
    assert.equal(metadata.thumb, item.thumb);
    assert.equal(metadata.art, item.art);
    assert.deepEqual(metadata.Image, [{ alt: 'Demo', type: 'coverPoster', url: item.thumb }, { alt: 'Demo', type: 'background', url: item.art }]);
  }
});

test('unknown endpoints return 404 and do not echo token', async () => withApp(async (app) => {
  const response = await app.inject({ method: 'GET', url: '/not-implemented', headers: { 'x-plex-token': 'secret' } });
  assert.equal(response.statusCode, 404);
  assert.ok(!response.body.includes('secret'));
}));

test('claim endpoint requires a token and does not claim implicitly', async () => withApp(async (app) => {
  const response = await app.inject({ method: 'POST', url: '/myplex/claim' });
  assert.equal(response.statusCode, 400);
  const identity = await app.inject('/identity');
  assert.match(identity.body, /claimed="0"/);
}));

