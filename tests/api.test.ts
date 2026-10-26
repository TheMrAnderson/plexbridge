import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createApp } from '../src/app.js';
import { loadSettings } from '../src/config.js';
import { libraryItems, libraryItemsJson, playQueueJson, playlistQueueJson } from '../src/plex/protocol.js';
import type { MusicProvider } from '../src/music/types.js';

async function withApp<T>(
  fn: (app: ReturnType<typeof createApp>, configDir: string) => Promise<T>,
  musicProvider?: MusicProvider,
  now?: () => number,
  timers?: {
    setTimeout: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
    clearTimeout: (timer: ReturnType<typeof setTimeout>) => void;
  }
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'plexbridge-'));
  const app = createApp(
    {
      ...loadSettings({
        PLEXBRIDGE_CONFIG_DIR: dir,
        PLEXBRIDGE_DISCOVERY_ENABLED: 'false',
        PLEXBRIDGE_WEB_USERNAME: 'test',
        PLEXBRIDGE_WEB_PASSWORD: 'test-password'
      }),
      configDir: dir,
      discoveryEnabled: false
    },
    undefined,
    musicProvider,
    now,
    timers
  );
  try {
    await app.ready();
    return await fn(app, dir);
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
}

async function webCookie(app: ReturnType<typeof createApp>): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/web/login',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: 'username=test&password=test-password&returnTo=/'
  });
  assert.equal(response.statusCode, 302);
  const cookie = response.headers['set-cookie'];
  assert.ok(cookie);
  return Array.isArray(cookie) ? cookie[0] : cookie;
}

test('identity persists and is consistent across endpoints', async () =>
  withApp(async (app, configDir) => {
    const first = await app.inject('/identity');
    const second = await app.inject('/');
    assert.match(first.headers['content-type'] ?? '', /^application\/xml/);
    const id = first.body.match(/machineIdentifier="([^"]+)"/)?.[1];
    assert.equal(id, second.body.match(/machineIdentifier="([^"]+)"/)?.[1]);
    assert.match(first.body, /apiVersion="1\.2\.3"/);
    assert.match(first.body, /version="1\.43\.5\.11029-6bf8af3f0"/);
    assert.ok(id);
    const stored = JSON.parse(await readFile(join(configDir, 'identity.json'), 'utf8')) as {
      libraryUuid?: string;
    };
    assert.match(stored.libraryUuid ?? '', /^[0-9a-f-]{36}$/);
    assert.match((await app.inject('/library/sections')).body, new RegExp(`uuid="${stored.libraryUuid}"`));
  }));

test('download queue supports direct-play track downloads', async () =>
  withApp(async (app) => {
    const created = await app.inject({
      method: 'POST',
      url: '/downloadQueue',
      headers: { accept: 'application/json', 'x-plex-client-identifier': 'test-client' }
    });
    assert.equal(created.statusCode, 200);
    const queue = JSON.parse(created.body).MediaContainer.DownloadQueue[0];
    assert.equal(queue.itemCount, 0);

    const reused = await app.inject({
      method: 'POST',
      url: '/downloadQueue',
      headers: { accept: 'application/json', 'x-plex-client-identifier': 'test-client' }
    });
    assert.equal(JSON.parse(reused.body).MediaContainer.DownloadQueue[0].id, queue.id);

    const added = await app.inject({
      method: 'POST',
      url: `/downloadQueue/${queue.id}/add?keys=%2Flibrary%2Fmetadata%2Fs-song-1,%2Flibrary%2Fmetadata%2Fs-song-2`,
      headers: { accept: 'application/json' }
    });
    assert.equal(added.statusCode, 200);
    assert.deepEqual(JSON.parse(added.body).MediaContainer.AddedQueueItems, [
      { key: '/library/metadata/s-song-1', id: 1 },
      { key: '/library/metadata/s-song-2', id: 2 }
    ]);

    const items = await app.inject({
      method: 'GET',
      url: `/downloadQueue/${queue.id}/items`,
      headers: { accept: 'application/json' }
    });
    assert.equal(items.statusCode, 200);
    const item = JSON.parse(items.body).MediaContainer.DownloadQueueItem[0];
    assert.equal(item.status, 'available');
    assert.equal(item.DecisionResult.directPlayDecisionCode, 1000);

    const decision = await app.inject({
      method: 'GET',
      url: `/downloadQueue/${queue.id}/item/${item.id}/decision`,
      headers: { accept: 'application/json' }
    });
    assert.equal(decision.statusCode, 200);
    assert.equal(JSON.parse(decision.body).MediaContainer.generalDecisionCode, 1000);

    const invalid = await app.inject({
      method: 'POST',
      url: `/downloadQueue/${queue.id}/add?keys=%2Flibrary%2Fmetadata%2Fl-album-1`,
      headers: { accept: 'application/json' }
    });
    assert.equal(invalid.statusCode, 400);
  }));

test('download queue media applies the same unsupported-format MP3 fallback as playback', async () => {
  const musicProvider = new Proxy({} as MusicProvider, {
    get: (_target, property) => {
      if (property === 'song') return async () => ({ id: 'song-1', title: 'Song', suffix: 'ogg' });
      if (property === 'streamUrl')
        return async (_id: string, options?: { format?: string }) =>
          options?.format === 'mp3' ? 'data:audio/mpeg;base64,TVAz' : 'data:audio/ogg;base64,T0dH';
      return async () => [];
    }
  }) as MusicProvider;

  await withApp(async (app) => {
    const created = await app.inject({ method: 'POST', url: '/downloadQueue' });
    const queueId = JSON.parse(created.body).MediaContainer.DownloadQueue[0].id;
    const added = await app.inject({
      method: 'POST',
      url: `/downloadQueue/${queueId}/add?keys=%2Flibrary%2Fmetadata%2Fs-song-1`
    });
    const itemId = JSON.parse(added.body).MediaContainer.AddedQueueItems[0].id;
    const media = await app.inject({ method: 'GET', url: `/downloadQueue/${queueId}/item/${itemId}/media` });
    assert.equal(media.statusCode, 200);
    assert.equal(media.headers['content-type'], 'audio/mpeg');
    assert.equal(media.body, 'MP3');
  }, musicProvider);
});

test('browser requests to the root serve the listening dashboard', async () =>
  withApp(async (app) => {
    const response = await app.inject({
      method: 'GET',
      url: '/',
      headers: { accept: 'text/html', cookie: await webCookie(app) }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.headers['content-type'] ?? '', /^text\/html/);
    assert.match(response.body, /Recent plays/);
  }));

test('web routes require local authentication while Plex routes remain public', async () =>
  withApp(async (app) => {
    assert.equal((await app.inject({ method: 'GET', url: '/', headers: { accept: 'text/html' } })).statusCode, 302);
    assert.equal((await app.inject('/home/status')).statusCode, 401);
    assert.equal((await app.inject('/admin/status')).statusCode, 401);
    assert.equal((await app.inject('/library/sections')).statusCode, 200);
  }));

test('admin page serves its separate assets', async () =>
  withApp(async (app) => {
    const page = await app.inject({ method: 'GET', url: '/admin', headers: { cookie: await webCookie(app) } });
    assert.equal(page.statusCode, 200);
    assert.match(page.body, /href="\/admin\.css"/);
    assert.match(page.body, /src="\/admin\.js"/);
    assert.equal((await app.inject('/admin.css')).statusCode, 200);
    assert.equal((await app.inject('/admin.js')).statusCode, 200);
  }));

test('admin settings and manual sync require web authentication', async () =>
  withApp(async (app) => {
    assert.equal((await app.inject('/admin/settings')).statusCode, 401);
    const cookie = await webCookie(app);
    const settings = await app.inject({ method: 'GET', url: '/admin/settings', headers: { cookie } });
    assert.equal(settings.statusCode, 200);
    assert.equal(JSON.parse(settings.body).navidromeConfigured, false);
    const saved = await app.inject({
      method: 'PUT',
      url: '/admin/settings',
      headers: { cookie, 'content-type': 'application/json' },
      payload: JSON.stringify({
        navidromeUrl: 'http://navidrome:4533',
        navidromeUsername: 'plexbridge',
        navidromePassword: 'secret',
        syncEnabled: true,
        syncTime: '04:30'
      })
    });
    assert.equal(saved.statusCode, 200);
    const stored = JSON.parse(saved.body);
    assert.equal(stored.navidromeConfigured, true);
    assert.equal(stored.syncTime, '04:30');
  }));

test('library is a single empty music section', async () =>
  withApp(async (app) => {
    const response = await app.inject('/library/sections');
    assert.match(response.body, /size="1"/);
    assert.match(response.body, /title="Music"/);
    assert.match(response.body, /type="artist"/);
  }));

test('library listings expose full totals and return Plexamp-sized pages', async () => {
  const musicProvider = new Proxy({} as MusicProvider, {
    get: (_target, property) => {
      if (property === 'artists')
        return async () =>
          Array.from({ length: 501 }, (_, index) => ({ id: `artist-${index}`, name: `Artist ${index}` })).reverse();
      if (property === 'albums')
        return async () =>
          Array.from({ length: 501 }, (_, index) => ({ id: `album-${index}`, name: `Album ${index}` }));
      if (property === 'songs')
        return async () => Array.from({ length: 501 }, (_, index) => ({ id: `song-${index}`, title: `Song ${index}` }));
      if (property === 'playlists')
        return async () =>
          Array.from({ length: 501 }, (_, index) => ({
            id: `playlist-${index}`,
            name: `Playlist ${index}`,
            songCount: 0,
            duration: 0
          }));
      return async () => [];
    }
  }) as MusicProvider;

  await withApp(async (app) => {
    for (const url of [
      '/library/sections/1/all?type=8&offset=500&size=50',
      '/library/sections/1/all?type=9&offset=500&size=50',
      '/library/sections/1/all?type=10&offset=500&size=50',
      '/playlists?offset=500&size=50'
    ]) {
      const response = await app.inject({ method: 'GET', url, headers: { accept: 'application/json' } });
      assert.equal(response.statusCode, 200, url);
      const container = JSON.parse(response.body).MediaContainer;
      assert.equal(container.size, 1, url);
      assert.equal(container.totalSize, 501, url);
      assert.equal(container.offset, 500, url);
    }

    const headerPage = await app.inject({
      method: 'GET',
      url: '/library/sections/1/all?type=8&sort=titleSort',
      headers: {
        accept: 'application/json',
        'x-plex-container-size': '1',
        'x-plex-container-start': '500'
      }
    });
    const headerPageContainer = JSON.parse(headerPage.body).MediaContainer;
    assert.equal(headerPageContainer.size, 1);
    assert.equal(headerPageContainer.totalSize, 501);
    assert.equal(headerPageContainer.offset, 500);
    assert.equal(headerPageContainer.Metadata[0].ratingKey, 'a-artist-500');

    const albumCharacters = await app.inject({
      method: 'GET',
      url: '/library/sections/1/firstCharacter?type=9',
      headers: { accept: 'application/json' }
    });
    assert.equal(JSON.parse(albumCharacters.body).MediaContainer.Directory[0].size, 501);

    const albumLetter = await app.inject({
      method: 'GET',
      url: '/library/sections/1/firstCharacter/A?type=9',
      headers: { accept: 'application/json' }
    });
    const albumLetterContainer = JSON.parse(albumLetter.body).MediaContainer;
    assert.equal(albumLetterContainer.totalSize, 501);
    assert.equal(albumLetterContainer.Metadata[0].type, 'album');
  }, musicProvider);
});

test('Best Of queries use Navidrome play counts and year filters', async () => {
  const musicProvider = new Proxy({} as MusicProvider, {
    get: (_target, property) => {
      if (property === 'artists')
        return async () => [
          { id: 'artist-1', name: 'Artist One' },
          { id: 'artist-2', name: 'Artist Two' }
        ];
      if (property === 'albums')
        return async () => [
          { id: 'album-old', name: 'Old', year: 2025, playCount: 99, lastPlayedAt: 1790000000 },
          { id: 'album-low', name: 'Low', year: 2026, playCount: 2, lastPlayedAt: 1791000000 },
          { id: 'album-high', name: 'High', year: 2026, playCount: 8, lastPlayedAt: 1792000000 }
        ];
      if (property === 'songs')
        return async () => [
          { id: 'song-1', title: 'Song One', artist: 'Artist One', artistId: 'artist-1', year: 2026, playCount: 4 },
          { id: 'song-2', title: 'Song Two', artist: 'Artist Two', artistId: 'artist-2', year: 2026, playCount: 1 }
        ];
      return async () => [];
    }
  }) as MusicProvider;

  await withApp(async (app) => {
    const albums = await app.inject({
      url: '/library/sections/1/all?type=9&year=2026&viewCount%3E=1&sort=viewCount:desc&limit=1',
      headers: { accept: 'application/json' }
    });
    const albumContainer = JSON.parse(albums.body).MediaContainer;
    assert.equal(albumContainer.totalSize, 2);
    assert.equal(albumContainer.size, 1);
    assert.equal(albumContainer.Metadata[0].title, 'High');
    assert.equal(albumContainer.Metadata[0].viewCount, 8);
    assert.equal(albumContainer.Metadata[0].lastViewedAt, 1792000000);

    const artists = await app.inject({
      url: '/library/sections/1/all?type=8&viewCount%3E=1&sort=viewCount:desc',
      headers: { accept: 'application/json' }
    });
    const artistContainer = JSON.parse(artists.body).MediaContainer;
    assert.equal(artistContainer.Metadata[0].title, 'Artist One');
    assert.equal(artistContainer.Metadata[0].viewCount, 4);
  }, musicProvider);
});

test('artist and album genre routes support XML, counts, and filtering', async () => {
  const musicProvider = new Proxy({} as MusicProvider, {
    get: (_target, property) => {
      if (property === 'artists') return async () => [{ id: 'artist-1', name: 'Artist One' }];
      if (property === 'albums')
        return async () => [{ id: 'album-1', name: 'Album One', artistId: 'artist-1', recordLabel: 'Test Label' }];
      if (property === 'songs')
        return async () => [
          {
            id: 'song-1',
            title: 'Song One',
            artist: 'Artist One',
            artistId: 'artist-1',
            albumId: 'album-1',
            genre: 'Hip-Hop',
            mood: 'Energetic'
          }
        ];
      if (property === 'genres') return async () => [{ name: 'Hip-Hop' }];
      return async () => [];
    }
  }) as MusicProvider;

  await withApp(async (app) => {
    const xml = await app.inject({
      url: '/library/sections/1/genre?type=8',
      headers: { accept: 'application/xml' }
    });
    assert.equal(xml.statusCode, 200);
    assert.match(xml.body, /title="Hip-Hop"/);
    const json = await app.inject({
      url: '/library/sections/1/genre?type=8',
      headers: { accept: 'application/json' }
    });
    assert.equal(json.statusCode, 200);
    const genreDirectory = JSON.parse(json.body).MediaContainer.Directory[0];
    assert.match(genreDirectory.key, /^\d+$/);
    assert.equal(genreDirectory.fastKey, `/library/sections/1/all?type=8&genre=${genreDirectory.key}`);
    const albums = await app.inject({
      url: '/library/sections/1/genre?type=9',
      headers: { accept: 'application/json' }
    });
    assert.equal(JSON.parse(albums.body).MediaContainer.Directory[0].albumCount, 1);
    const filtered = await app.inject({
      url: '/library/sections/1/all?type=8&genre=Hip-Hop',
      headers: { accept: 'application/json' }
    });
    assert.equal(JSON.parse(filtered.body).MediaContainer.totalSize, 1);
    const moods = await app.inject({
      url: '/library/sections/1/mood?type=9',
      headers: { accept: 'application/json' }
    });
    assert.equal(moods.statusCode, 200);
    const moodDirectory = JSON.parse(moods.body).MediaContainer.Directory[0];
    assert.equal(moodDirectory.title, 'Energetic');
    assert.equal(moodDirectory.type, 'mood');
    assert.match(moodDirectory.fastKey, /type=9&mood=\d+$/);
    const moodAlbums = await app.inject({
      url: `/library/sections/1/all?type=9&mood=${moodDirectory.key}`,
      headers: { accept: 'application/json' }
    });
    assert.equal(JSON.parse(moodAlbums.body).MediaContainer.totalSize, 1);
    const studios = await app.inject({
      url: '/library/sections/1/studio?type=9',
      headers: { accept: 'application/json' }
    });
    assert.equal(studios.statusCode, 200);
    const studioDirectory = JSON.parse(studios.body).MediaContainer.Directory[0];
    assert.equal(studioDirectory.title, 'Test Label');
    assert.equal(studioDirectory.type, 'studio');
    assert.match(studioDirectory.fastKey, /type=9&studio=\d+$/);
    const studioAlbums = await app.inject({
      url: `/library/sections/1/all?type=9&studio=${studioDirectory.key}`,
      headers: { accept: 'application/json' }
    });
    assert.equal(JSON.parse(studioAlbums.body).MediaContainer.totalSize, 1);
  }, musicProvider);
});

test('optional library filters return empty PMS-compatible responses', async () =>
  withApp(async (app) => {
    for (const filter of ['style', 'folder']) {
      const response = await app.inject({
        method: 'GET',
        url: `/library/sections/1/${filter}`,
        headers: { accept: 'application/json' }
      });
      assert.equal(response.statusCode, 200, filter);
      assert.equal(JSON.parse(response.body).MediaContainer.size, 0, filter);
    }
  }));

test('media providers discovery exposes the music library provider', async () =>
  withApp(async (app) => {
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

test('Plexamp endpoint contracts preserve the playback and download response shapes', async () => {
  const song = {
    id: 'song-1',
    title: 'Contract Song',
    album: 'Contract Album',
    albumId: 'album-1',
    artist: 'Contract Artist',
    artistId: 'artist-1',
    duration: 120,
    suffix: 'mp3',
    contentType: 'audio/mpeg',
    bitRate: 192,
    size: 2,
    replayGain: { trackGain: -8, albumGain: -7, trackPeak: 0.9, albumPeak: 0.95 }
  };
  const musicProvider = new Proxy({} as MusicProvider, {
    get: (_target, property) => {
      if (property === 'song') return async () => song;
      if (property === 'songs') return async () => [song];
      if (property === 'playlist')
        return async () => ({
          playlist: { id: 'playlist-1', name: 'Contract Playlist', songCount: 1, duration: 120 },
          songs: [song]
        });
      if (property === 'streamUrl') return async () => 'data:audio/mpeg;base64,TUQ=';
      return async () => [];
    }
  }) as MusicProvider;

  await withApp(async (app) => {
    const jsonHeaders = { accept: 'application/json' };
    const metadata = await app.inject({ method: 'GET', url: '/library/metadata/s-song-1', headers: jsonHeaders });
    assert.equal(metadata.statusCode, 200);
    const metadataItem = JSON.parse(metadata.body).MediaContainer.Metadata[0];
    assert.equal(metadataItem.Media[0].Part[0].key, '/library/metadata/s-song-1/stream');
    assert.ok(metadataItem.Media[0].Stream);
    assert.equal(metadataItem.Media[0].Part[0].Stream, undefined);

    const queue = await app.inject({
      method: 'POST',
      url: '/playQueues?key=%2Flibrary%2Fmetadata%2Fs-song-1&type=audio',
      headers: jsonHeaders
    });
    assert.equal(queue.statusCode, 200);
    assert.equal(
      JSON.parse(queue.body).MediaContainer.Metadata[0].Media[0].Part[0].key,
      metadataItem.Media[0].Part[0].key
    );

    const playlist = await app.inject({ method: 'GET', url: '/playlists/10000/items', headers: jsonHeaders });
    assert.equal(playlist.statusCode, 200);
    assert.equal(
      JSON.parse(playlist.body).MediaContainer.Metadata[0].Media[0].Part[0].key,
      metadataItem.Media[0].Part[0].key
    );

    const decision = await app.inject({
      method: 'GET',
      url: `/audio/:/transcode/universal/decision?path=${encodeURIComponent('/library/metadata/s-song-1')}&directPlay=1`,
      headers: jsonHeaders
    });
    assert.equal(decision.statusCode, 200);
    assert.equal(JSON.parse(decision.body).MediaContainer.Metadata[0].Media[0].Part[0].decision, 'directplay');

    const stream = await app.inject({ method: 'GET', url: '/library/metadata/s-song-1/stream?download=1' });
    assert.equal(stream.statusCode, 200);
    assert.match(stream.headers['content-type'] ?? '', /^audio\/mpeg/);
    assert.equal(stream.body, 'MD');
  }, musicProvider);
});

test('playlist discovery is available at the advertised Plex routes', async () =>
  withApp(async (app) => {
    for (const url of ['/playlists', '/playlists?playlistType=audio', '/playlists/all', '/playlists/1/items']) {
      const response = await app.inject({ method: 'GET', url, headers: { accept: 'application/json' } });
      assert.equal(response.statusCode, 200, url);
      assert.equal(JSON.parse(response.body).MediaContainer.size, 0, url);
      if (url === '/playlists/all') assert.ok(!response.body.includes('playlist://image.smart'));
    }
    const libraryPlaylistRoute = await app.inject({
      method: 'GET',
      url: '/library/sections/1/all?type=15&playlistType=audio',
      headers: { accept: 'application/json' }
    });
    assert.equal(libraryPlaylistRoute.statusCode, 200);
    assert.equal(JSON.parse(libraryPlaylistRoute.body).MediaContainer.size, 0);
  }));

test('artist mix queues include tracks credited to each selected artist', async () => {
  const musicProvider = new Proxy({} as MusicProvider, {
    get: (_target, property) => {
      if (property === 'artists')
        return async () => [
          { id: 'artist-1', name: 'Kenny Chesney' },
          { id: 'artist-2', name: 'Tim McGraw' }
        ];
      if (property === 'songs')
        return async () => [
          { id: 'song-1', title: 'Kenny song', artist: 'Kenny Chesney', artistId: 'artist-1', albumId: 'album-1' },
          { id: 'song-2', title: 'Shared song', artist: 'Kenny Chesney, Tim McGraw', artistId: 'artist-1' },
          { id: 'song-3', title: 'Tim song', artist: 'Tim McGraw', artistId: 'artist-2' },
          { id: 'song-4', title: 'Other song', artist: 'Other Artist', artistId: 'artist-3' }
        ];
      if (property === 'albums')
        return async () => [
          { id: 'album-1', name: 'Boats', artist: 'Other Artist' },
          { id: 'album-2', name: 'Sailor', artist: 'Other Artist' }
        ];
      if (property === 'album')
        return async (id: string) => ({
          album: { id, name: id === 'album-1' ? 'Boats' : 'Sailor', artist: 'Other Artist' },
          songs: [{ id: `song-${id}`, title: `${id} song`, artist: 'Other Artist', albumId: id }]
        });
      if (property === 'artist')
        return async (id: string) => ({
          artist: { id, name: id === 'artist-1' ? 'Kenny Chesney' : 'Tim McGraw' },
          albums: []
        });
      return async () => [];
    }
  }) as MusicProvider;

  await withApp(async (app) => {
    const builderStart = await app.inject({
      method: 'GET',
      url: '/library/all/top?type=8&librarySectionID=1&limit=12',
      headers: {
        accept: 'application/json',
        'x-plex-client-identifier': 'artist-mix-test'
      }
    });
    assert.equal(builderStart.statusCode, 200);
    assert.equal(JSON.parse(builderStart.body).MediaContainer.Metadata[0].type, 'artist');
    const search = await app.inject({
      method: 'GET',
      url: '/hubs/search?query=chesney&includeCollections=1&contentDirectoryID=1',
      headers: { accept: 'application/json', 'x-plex-client-identifier': 'artist-mix-test' }
    });
    assert.equal(search.statusCode, 200);
    const searchHub = JSON.parse(search.body).MediaContainer.Hub[0];
    assert.equal(searchHub.hubIdentifier, 'search.artists');
    assert.equal(searchHub.key, '/hubs/search?query=chesney&type=8');
    assert.equal(searchHub.Metadata[0].title, 'Kenny Chesney');
    assert.equal(searchHub.Metadata[0].guid, 'plex://artist/artist-1');
    assert.equal(searchHub.Metadata[0].Image[0].type, 'coverPoster');
    const sonicSearch = await app.inject({
      method: 'GET',
      url: '/hubs/search?query=shared&includeCollections=1&contentDirectoryID=1',
      headers: { accept: 'application/json' }
    });
    const sonicHub = JSON.parse(sonicSearch.body).MediaContainer.Hub[0];
    assert.equal(sonicHub.type, 'track');
    assert.equal(sonicHub.hubIdentifier, 'search.tracks');
    assert.equal(sonicHub.Metadata[0].title, 'Shared song');
    assert.equal(sonicHub.Metadata[0].Media[0].Part[0].key, '/library/metadata/s-song-2/stream');
    const typedTrackSearch = await app.inject({
      method: 'GET',
      url: '/hubs/search?query=shared&type=10',
      headers: { accept: 'application/json' }
    });
    assert.equal(JSON.parse(typedTrackSearch.body).MediaContainer.Hub[0].type, 'track');
    const artistFocusedSearch = await app.inject({
      method: 'GET',
      url: '/hubs/search?query=kenny',
      headers: { accept: 'application/json' }
    });
    assert.equal(JSON.parse(artistFocusedSearch.body).MediaContainer.Hub.length, 1);
    assert.equal(JSON.parse(artistFocusedSearch.body).MediaContainer.Hub[0].type, 'artist');
    const noArtistSearch = await app.inject({
      method: 'GET',
      url: '/hubs/search?query=not-an-artist',
      headers: { accept: 'application/json' }
    });
    assert.equal(JSON.parse(noArtistSearch.body).MediaContainer.Hub.length, 0);
    const albumSearch = await app.inject({
      method: 'GET',
      url: '/hubs/search?query=boats',
      headers: { accept: 'application/json' }
    });
    assert.equal(JSON.parse(albumSearch.body).MediaContainer.Hub[0].type, 'album');
    const albumQueue = await app.inject({
      method: 'POST',
      url: `/playQueues?uri=${encodeURIComponent('library://abc/directory//library/sections/1/all?album.id=l-album-1,l-album-2')}&shuffle=1`,
      headers: { accept: 'application/json' }
    });
    assert.equal(albumQueue.statusCode, 200);
    assert.equal(JSON.parse(albumQueue.body).MediaContainer.playQueueTotalCount, 2);
    const albumSimilar = await app.inject({
      method: 'GET',
      url: '/library/metadata/l-album-1/similar',
      headers: { accept: 'application/json' }
    });
    assert.equal(albumSimilar.statusCode, 200);
    assert.equal(JSON.parse(albumSimilar.body).MediaContainer.size, 0);

    const innerUri = '/library/sections/1/all?artist.id=a-artist-1,a-artist-2';
    const uri = `server://abc/com.plexapp.plugins.library${innerUri}`;
    const response = await app.inject({
      method: 'POST',
      url: `/playQueues?uri=${encodeURIComponent(uri)}&shuffle=1`,
      headers: { accept: 'application/json' }
    });
    assert.equal(response.statusCode, 200);
    const container = JSON.parse(response.body).MediaContainer;
    assert.equal(container.size, 3);
    assert.equal(container.playQueueTotalCount, 3);
    assert.deepEqual(container.Metadata.map((item: { ratingKey: string }) => item.ratingKey).sort(), [
      's-song-1',
      's-song-2',
      's-song-3'
    ]);
    const metadata = await app.inject({
      method: 'GET',
      url: '/library/metadata/a-artist-1,a-artist-2',
      headers: { accept: 'application/json' }
    });
    assert.equal(metadata.statusCode, 200);
    assert.equal(JSON.parse(metadata.body).MediaContainer.size, 2);
    const cleared = await app.inject({
      method: 'DELETE',
      url: '/playQueues/1/items',
      headers: { accept: 'application/json' }
    });
    assert.equal(cleared.statusCode, 200);
    assert.equal(JSON.parse(cleared.body).MediaContainer.playQueueTotalCount, 0);
    const queue = await app.inject({ method: 'GET', url: '/playQueues/1', headers: { accept: 'application/json' } });
    assert.equal(queue.statusCode, 200);
    assert.equal(JSON.parse(queue.body).MediaContainer.size, 0);
    const staleClear = await app.inject({
      method: 'DELETE',
      url: '/playQueues/999/items',
      headers: { accept: 'application/json' }
    });
    assert.equal(staleClear.statusCode, 200);
    assert.equal(JSON.parse(staleClear.body).MediaContainer.playQueueTotalCount, 0);
    const staleQueue = await app.inject({
      method: 'GET',
      url: '/playQueues/999',
      headers: { accept: 'application/json' }
    });
    assert.equal(staleQueue.statusCode, 200);
    assert.equal(JSON.parse(staleQueue.body).MediaContainer.size, 0);
  }, musicProvider);
});

test('Sonic Adventure falls back to the requested track queue without sonic analysis', async () => {
  const songs = new Map([
    ['song-start', { id: 'song-start', title: 'Start', artist: 'Artist', artistId: 'artist-1' }],
    ['song-end', { id: 'song-end', title: 'End', artist: 'Artist', artistId: 'artist-1' }]
  ]);
  const musicProvider = new Proxy({} as MusicProvider, {
    get: (_target, property) => {
      if (property === 'song') return async (id: string) => songs.get(id);
      if (property === 'artists') return async () => [{ id: 'artist-1', name: 'Artist' }];
      if (property === 'songs') return async () => [...songs.values()];
      return async () => [];
    }
  }) as MusicProvider;

  await withApp(async (app) => {
    const path = await app.inject({
      url: '/library/sections/1/computePath?startID=s-song-start&endID=s-song-end',
      headers: { accept: 'application/json' }
    });
    assert.equal(path.statusCode, 200);
    assert.equal(JSON.parse(path.body).MediaContainer.size, 0);

    const queue = await app.inject({
      method: 'POST',
      url: `/playQueues?playlistID=${encodeURIComponent('s-song-start,s-song-end')}&shuffle=0`,
      headers: { accept: 'application/json' }
    });
    assert.equal(queue.statusCode, 200);
    assert.equal(JSON.parse(queue.body).MediaContainer.playQueueTotalCount, 2);
  }, musicProvider);
});

test('playback control endpoints return PMS-compatible success responses', async () =>
  withApp(async (app) => {
    const timeline = await app.inject({
      method: 'GET',
      url: '/:/timeline?state=playing&time=0',
      headers: { accept: 'application/json' }
    });
    assert.equal(timeline.statusCode, 200);
    assert.deepEqual(JSON.parse(timeline.body), { MediaContainer: { size: 0 } });
    assert.equal(
      (await app.inject({ method: 'POST', url: '/:/timeline?state=playing&time=30&duration=121000' })).statusCode,
      200
    );
    assert.equal(
      (await app.inject({ method: 'PUT', url: '/:/timeline?state=playing&time=30&duration=121000' })).statusCode,
      200
    );
    assert.equal((await app.inject({ method: 'GET', url: '/:/scrobble?ratingKey=s-test&time=30' })).statusCode, 200);
    assert.equal((await app.inject({ method: 'POST', url: '/:/scrobble?ratingKey=s-test&time=30' })).statusCode, 200);
    assert.equal((await app.inject({ method: 'GET', url: '/:/unscrobble?ratingKey=s-test' })).statusCode, 200);
    assert.equal((await app.inject({ method: 'POST', url: '/:/unscrobble?ratingKey=s-test' })).statusCode, 200);
    assert.equal((await app.inject({ method: 'PUT', url: '/:/rate?ratingKey=s-test&rating=10' })).statusCode, 200);
    const firstCharacter = await app.inject({
      method: 'GET',
      url: '/library/sections/1/firstCharacter?type=8',
      headers: { accept: 'application/json' }
    });
    assert.equal(firstCharacter.statusCode, 200);
    assert.equal(JSON.parse(firstCharacter.body).MediaContainer.title2, 'By First Letter');
    const transcodeStop = await app.inject({ method: 'GET', url: '/audio/:/transcode/universal/stop?session=test' });
    assert.equal(transcodeStop.statusCode, 200);
    assert.deepEqual(JSON.parse(transcodeStop.body), { MediaContainer: { size: 0 } });
    assert.equal((await app.inject({ method: 'GET', url: '/photo/:/transcode' })).statusCode, 404);
  }));

test('explicit Plex scrobbles are forwarded to the music provider', async () => {
  const scrobbled: string[] = [];
  const musicProvider = new Proxy({} as MusicProvider, {
    get: (_target, property) =>
      property === 'scrobble'
        ? async (id: string) => {
            scrobbled.push(id);
          }
        : async () => []
  }) as MusicProvider;
  await withApp(async (app) => {
    const response = await app.inject({
      method: 'POST',
      url: '/:/scrobble?ratingKey=s-track-42&time=90000&duration=120000',
      headers: { accept: 'application/json' }
    });
    assert.equal(response.statusCode, 200);
  }, musicProvider);
  assert.deepEqual(scrobbled, ['track-42']);
});

test('offline Plexamp play history is forwarded as a completed scrobble', async () => {
  const scrobbled: string[] = [];
  const musicProvider = new Proxy({} as MusicProvider, {
    get: (_target, property) =>
      property === 'scrobble'
        ? async (id: string) => {
            scrobbled.push(id);
          }
        : async () => []
  }) as MusicProvider;
  await withApp(async (app) => {
    const headers = { 'x-plex-client-identifier': 'offline-player', accept: 'application/json' };
    const url = '/:/timeline?offline=1&ratingKey=s-track-offline&state=stopped&viewCount=1&time=0';
    assert.equal((await app.inject({ method: 'GET', url, headers })).statusCode, 200);
    assert.equal((await app.inject({ method: 'GET', url, headers })).statusCode, 200);
  }, musicProvider);
  assert.deepEqual(scrobbled, ['track-offline']);
});

test('Plex rate requests are treated as explicit scrobbles', async () => {
  const scrobbled: string[] = [];
  const musicProvider = new Proxy({} as MusicProvider, {
    get: (_target, property) =>
      property === 'scrobble'
        ? async (id: string) => {
            scrobbled.push(id);
          }
        : async () => []
  }) as MusicProvider;
  await withApp(async (app) => {
    const response = await app.inject({
      method: 'PUT',
      url: '/:/rate?ratingKey=s-track-49&rating=10&time=90000&duration=120000',
      headers: { accept: 'application/json' }
    });
    assert.equal(response.statusCode, 200);
  }, musicProvider);
  assert.deepEqual(scrobbled, ['track-49']);
});

test('explicit and timeline scrobbles do not submit the same track twice', async () => {
  const scrobbled: string[] = [];
  const musicProvider = new Proxy({} as MusicProvider, {
    get: (_target, property) =>
      property === 'scrobble'
        ? async (id: string) => {
            scrobbled.push(id);
          }
        : async () => []
  }) as MusicProvider;
  await withApp(async (app) => {
    const headers = { 'x-plex-client-identifier': 'player-1', accept: 'application/json' };
    await app.inject({ method: 'POST', url: '/:/scrobble?ratingKey=s-track-42&time=90000', headers });
    await app.inject({
      method: 'POST',
      url: '/:/timeline?state=playing&ratingKey=s-track-42&time=100000&duration=120000',
      headers
    });
  }, musicProvider);
  assert.deepEqual(scrobbled, ['track-42']);
});

test('scrobbles accept Plex metadata keys as well as rating keys', async () => {
  const scrobbled: string[] = [];
  const musicProvider = new Proxy({} as MusicProvider, {
    get: (_target, property) =>
      property === 'scrobble'
        ? async (id: string) => {
            scrobbled.push(id);
          }
        : async () => []
  }) as MusicProvider;
  await withApp(async (app) => {
    const headers = { 'x-plex-client-identifier': 'player-2', accept: 'application/json' };
    await app.inject({ method: 'POST', url: '/:/scrobble?key=%2Flibrary%2Fmetadata%2Fs-track-43', headers });
    await app.inject({
      method: 'POST',
      url: '/:/timeline?state=playing&key=%2Flibrary%2Fmetadata%2Fs-track-44&time=60000&duration=120000',
      headers
    });
  }, musicProvider);
  assert.deepEqual(scrobbled, ['track-44']);
});

test('scrobbles accept bare Plex rating keys and metadata paths', async () => {
  const scrobbled: string[] = [];
  const musicProvider = new Proxy({} as MusicProvider, {
    get: (_target, property) =>
      property === 'scrobble'
        ? async (id: string) => {
            scrobbled.push(id);
          }
        : async () => []
  }) as MusicProvider;
  await withApp(async (app) => {
    const headers = { 'x-plex-client-identifier': 'player-bare-key', accept: 'application/json' };
    await app.inject({ method: 'POST', url: '/:/scrobble?ratingKey=track-45&time=90000', headers });
    await app.inject({
      method: 'POST',
      url: '/:/timeline?key=%2Flibrary%2Fmetadata%2Ftrack-46&state=stopped&time=90000&duration=120000',
      headers
    });
  }, musicProvider);
  assert.deepEqual(scrobbled, ['track-46']);
});

test('timeline retains a player track duration when a later update omits it', async () => {
  const scrobbled: string[] = [];
  const musicProvider = new Proxy({} as MusicProvider, {
    get: (_target, property) =>
      property === 'scrobble'
        ? async (id: string) => {
            scrobbled.push(id);
          }
        : async () => []
  }) as MusicProvider;
  await withApp(async (app) => {
    const headers = { 'x-plex-client-identifier': 'player-3', accept: 'application/json' };
    await app.inject({
      method: 'POST',
      url: '/:/timeline?state=playing&ratingKey=s-track-45&time=1000&duration=120000',
      headers
    });
    await app.inject({ method: 'POST', url: '/:/timeline?state=playing&ratingKey=s-track-45&time=90000', headers });
  }, musicProvider);
  assert.deepEqual(scrobbled, ['track-45']);
});

test('a new track finalizes a previous track when Plexamp only reports track starts', async () => {
  const scrobbled: string[] = [];
  let clock = 0;
  const musicProvider = new Proxy({} as MusicProvider, {
    get: (_target, property) =>
      property === 'scrobble'
        ? async (id: string) => {
            scrobbled.push(id);
          }
        : async () => []
  }) as MusicProvider;
  await withApp(
    async (app) => {
      const headers = { 'x-plex-client-identifier': 'player-track-starts', accept: 'application/json' };
      await app.inject({
        method: 'POST',
        url: '/:/timeline?state=playing&ratingKey=s-track-50&time=67&duration=199000',
        headers
      });
      clock = 199000;
      await app.inject({
        method: 'POST',
        url: '/:/timeline?state=playing&ratingKey=s-track-51&time=67&duration=222000',
        headers
      });
    },
    musicProvider,
    () => clock,
    {
      setTimeout: () => ({}) as ReturnType<typeof setTimeout>,
      clearTimeout: () => undefined
    }
  );
  assert.deepEqual(scrobbled, ['track-50']);
});

test('a skipped track is not scrobbled when the next track starts early', async () => {
  const scrobbled: string[] = [];
  let clock = 0;
  const musicProvider = new Proxy({} as MusicProvider, {
    get: (_target, property) =>
      property === 'scrobble'
        ? async (id: string) => {
            scrobbled.push(id);
          }
        : async () => []
  }) as MusicProvider;
  await withApp(
    async (app) => {
      const headers = { 'x-plex-client-identifier': 'player-skips', accept: 'application/json' };
      await app.inject({
        method: 'POST',
        url: '/:/timeline?state=playing&ratingKey=s-track-skip&time=67&duration=199000',
        headers
      });
      clock = 10000;
      await app.inject({
        method: 'POST',
        url: '/:/timeline?state=playing&ratingKey=s-track-next&time=67&duration=222000',
        headers
      });
    },
    musicProvider,
    () => clock,
    {
      setTimeout: () => ({}) as ReturnType<typeof setTimeout>,
      clearTimeout: () => undefined
    }
  );
  assert.deepEqual(scrobbled, []);
});

test('a track started mid-song scrobbles after crossing 75% effective progress', async () => {
  const scrobbled: string[] = [];
  let clock = 0;
  const musicProvider = new Proxy({} as MusicProvider, {
    get: (_target, property) =>
      property === 'scrobble'
        ? async (id: string) => {
            scrobbled.push(id);
          }
        : async () => []
  }) as MusicProvider;
  await withApp(
    async (app) => {
      const headers = { 'x-plex-client-identifier': 'player-mid-song', accept: 'application/json' };
      await app.inject({
        method: 'POST',
        url: '/:/timeline?state=playing&ratingKey=s-track-mid&time=100000&duration=199000',
        headers
      });
      clock = 60000;
      await app.inject({
        method: 'POST',
        url: '/:/timeline?state=playing&ratingKey=s-track-next&time=67&duration=222000',
        headers
      });
    },
    musicProvider,
    () => clock,
    {
      setTimeout: () => ({}) as ReturnType<typeof setTimeout>,
      clearTimeout: () => undefined
    }
  );
  assert.deepEqual(scrobbled, ['track-mid']);
});

test('durationless timelines estimate song duration and scrobble after 110% active time', async () => {
  const scrobbled: string[] = [];
  let clock = 0;
  const musicProvider = new Proxy({} as MusicProvider, {
    get: (_target, property) => {
      if (property === 'song') return async () => ({ id: 'track-46', title: 'Track', duration: 257 });
      if (property === 'scrobble')
        return async (id: string) => {
          scrobbled.push(id);
        };
      return async () => [];
    }
  }) as MusicProvider;
  await withApp(
    async (app) => {
      const headers = { 'x-plex-client-identifier': 'player-4', accept: 'application/json' };
      await app.inject({
        method: 'POST',
        url: '/:/timeline?state=playing&ratingKey=s-track-46&time=0&duration=0',
        headers
      });
      clock = 257000;
      await app.inject({ method: 'POST', url: '/:/timeline?state=playing&ratingKey=s-track-46&time=120000', headers });
      clock = 282700;
      await app.inject({ method: 'POST', url: '/:/timeline?state=playing&ratingKey=s-track-46&time=120000', headers });
    },
    musicProvider,
    () => clock
  );
  assert.deepEqual(scrobbled, ['track-46']);
});

test('the initial start schedules a fallback scrobble without a final timeline report', async () => {
  const scrobbled: string[] = [];
  let fireFallback: (() => void) | undefined;
  const musicProvider = new Proxy({} as MusicProvider, {
    get: (_target, property) => {
      if (property === 'song') return async () => ({ id: 'track-48', title: 'Track', duration: 257 });
      if (property === 'scrobble')
        return async (id: string) => {
          scrobbled.push(id);
        };
      return async () => [];
    }
  }) as MusicProvider;
  await withApp(
    async (app) => {
      const headers = { 'x-plex-client-identifier': 'player-6', accept: 'application/json' };
      await app.inject({
        method: 'POST',
        url: '/:/timeline?state=playing&ratingKey=s-track-48&time=0&duration=0',
        headers
      });
      assert.deepEqual(scrobbled, []);
      assert.ok(fireFallback);
      fireFallback?.();
      await new Promise((resolve) => setImmediate(resolve));
    },
    musicProvider,
    () => 0,
    {
      setTimeout: (callback: () => void) => {
        fireFallback = callback;
        return {} as ReturnType<typeof setTimeout>;
      },
      clearTimeout: () => undefined
    }
  );
  assert.deepEqual(scrobbled, ['track-48']);
});

test('paused time stops the estimate but buffering time advances it', async () => {
  const scrobbled: string[] = [];
  let clock = 0;
  const musicProvider = new Proxy({} as MusicProvider, {
    get: (_target, property) => {
      if (property === 'song') return async () => ({ id: 'track-47', title: 'Track', duration: 100 });
      if (property === 'scrobble')
        return async (id: string) => {
          scrobbled.push(id);
        };
      return async () => [];
    }
  }) as MusicProvider;
  await withApp(
    async (app) => {
      const headers = { 'x-plex-client-identifier': 'player-5', accept: 'application/json' };
      await app.inject({
        method: 'POST',
        url: '/:/timeline?state=playing&ratingKey=s-track-47&time=0&duration=0',
        headers
      });
      clock = 50000;
      await app.inject({ method: 'POST', url: '/:/timeline?state=paused&ratingKey=s-track-47&time=10000', headers });
      clock = 150000;
      await app.inject({ method: 'POST', url: '/:/timeline?state=buffering&ratingKey=s-track-47&time=10000', headers });
      clock = 260000;
      await app.inject({ method: 'POST', url: '/:/timeline?state=playing&ratingKey=s-track-47&time=10000', headers });
    },
    musicProvider,
    () => clock
  );
  assert.deepEqual(scrobbled, ['track-47']);
});

test('loudness streams stay beside Part in every PMS metadata response', () => {
  const item = {
    ratingKey: 's-demo',
    key: '/library/metadata/s-demo',
    type: 'track' as const,
    title: 'Demo',
    thumb: '/library/metadata/l-album/thumb',
    art: '/library/metadata/l-album/art',
    media: {
      partKey: '/library/metadata/s-demo/stream',
      duration: 120,
      container: 'mp3',
      audioCodec: 'mp3',
      replayGain: { trackGain: -8.25, albumGain: -7.5, trackPeak: 0.98, albumPeak: 0.99 }
    }
  };
  const queueMetadata = JSON.parse(playQueueJson(item, '1', 'library://plexbridge-music/item//library/metadata/s-demo'))
    .MediaContainer.Metadata[0];
  const playlistMetadata = JSON.parse(
    playlistQueueJson([item], '1', 'library://plexbridge-music/playlist/10000', '10000', 'Playlist', false)
  ).MediaContainer.Metadata[0];
  const libraryMetadata = JSON.parse(libraryItemsJson([item], 'track')).MediaContainer.Metadata[0];
  for (const metadata of [queueMetadata, playlistMetadata, libraryMetadata]) {
    assert.equal(metadata.thumb, item.thumb);
    assert.equal(metadata.art, item.art);
    assert.deepEqual(metadata.Image, [
      { alt: 'Demo', type: 'coverPoster', url: item.thumb },
      { alt: 'Demo', type: 'background', url: item.art }
    ]);
    assert.deepEqual(metadata.Media[0].Stream[0], {
      id: 1,
      streamType: 2,
      selected: 1,
      gain: -8.25,
      albumGain: -8.25,
      peak: 0.98,
      albumPeak: 0.98
    });
    assert.equal(metadata.Media[0].Part[0].Stream, undefined);
  }

  const xml = libraryItems([item], 'track');
  assert.match(xml, /<Media [^>]*><Stream [^>]*><Part /);
  assert.doesNotMatch(xml, /<Part [^>]*><Stream /);
});

test('loudness levels endpoint returns an empty sample set for synthetic streams', async () =>
  withApp(async (app) => {
    const response = await app.inject({
      method: 'GET',
      url: '/library/streams/1/levels?subsample=128',
      headers: { accept: 'application/json' }
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(JSON.parse(response.body), {
      MediaContainer: { size: 0, totalSamples: '0', Level: [] }
    });
  }));

test('unknown endpoints return 404 and do not echo token', async () =>
  withApp(async (app) => {
    const response = await app.inject({
      method: 'GET',
      url: '/not-implemented',
      headers: { 'x-plex-token': 'secret' }
    });
    assert.equal(response.statusCode, 404);
    assert.ok(!response.body.includes('secret'));
  }));

test('claim endpoint requires a token and does not claim implicitly', async () =>
  withApp(async (app) => {
    const response = await app.inject({ method: 'POST', url: '/myplex/claim' });
    assert.equal(response.statusCode, 400);
    const identity = await app.inject('/identity');
    assert.match(identity.body, /claimed="0"/);
  }));
