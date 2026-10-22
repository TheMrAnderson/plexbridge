import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createApp } from '../src/app.js';
import { loadSettings } from '../src/config.js';
import { libraryItemsJson, playQueueJson } from '../src/plex/protocol.js';
import type { MusicProvider } from '../src/music/types.js';

async function withApp<T>(
  fn: (app: ReturnType<typeof createApp>) => Promise<T>,
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
      ...loadSettings({ PLEXBRIDGE_CONFIG_DIR: dir, PLEXBRIDGE_DISCOVERY_ENABLED: 'false' }),
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
    return await fn(app);
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test('identity persists and is consistent across endpoints', async () =>
  withApp(async (app) => {
    const first = await app.inject('/identity');
    const second = await app.inject('/');
    assert.match(first.headers['content-type'] ?? '', /^application\/xml/);
    const id = first.body.match(/machineIdentifier="([^"]+)"/)?.[1];
    assert.equal(id, second.body.match(/machineIdentifier="([^"]+)"/)?.[1]);
    assert.match(first.body, /apiVersion="1\.2\.3"/);
    assert.match(first.body, /version="1\.43\.5\.11029-6bf8af3f0"/);
    assert.ok(id);
  }));

test('browser requests to the root serve the listening dashboard', async () =>
  withApp(async (app) => {
    const response = await app.inject({ method: 'GET', url: '/', headers: { accept: 'text/html' } });
    assert.equal(response.statusCode, 200);
    assert.match(response.headers['content-type'] ?? '', /^text\/html/);
    assert.match(response.body, /Recent plays/);
  }));

test('admin page serves its separate assets', async () =>
  withApp(async (app) => {
    const page = await app.inject('/admin');
    assert.equal(page.statusCode, 200);
    assert.match(page.body, /href="\/admin\.css"/);
    assert.match(page.body, /src="\/admin\.js"/);
    assert.equal((await app.inject('/admin.css')).statusCode, 200);
    assert.equal((await app.inject('/admin.js')).statusCode, 200);
  }));

test('library is a single empty music section', async () =>
  withApp(async (app) => {
    const response = await app.inject('/library/sections');
    assert.match(response.body, /size="1"/);
    assert.match(response.body, /title="Music"/);
    assert.match(response.body, /type="artist"/);
  }));

test('optional library filters return empty PMS-compatible responses', async () =>
  withApp(async (app) => {
    for (const filter of ['style', 'mood', 'studio', 'folder']) {
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
      url: '/:/scrobble?ratingKey=s-track-42&time=90000',
      headers: { accept: 'application/json' }
    });
    assert.equal(response.statusCode, 200);
  }, musicProvider);
  assert.deepEqual(scrobbled, ['track-42']);
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
      url: '/:/rate?ratingKey=s-track-49&rating=10',
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
  assert.deepEqual(scrobbled, ['track-43', 'track-44']);
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
  assert.deepEqual(scrobbled, ['track-45', 'track-46']);
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

test('track metadata advertises PMS-compatible artwork in queues and library responses', () => {
  const item = {
    ratingKey: 's-demo',
    key: '/library/metadata/s-demo',
    type: 'track' as const,
    title: 'Demo',
    thumb: '/library/metadata/l-album/thumb',
    art: '/library/metadata/l-album/art',
    media: { partKey: '/library/metadata/s-demo/stream', duration: 120, container: 'mp3', audioCodec: 'mp3' }
  };
  const queueMetadata = JSON.parse(playQueueJson(item, '1', 'library://plexbridge-music/item//library/metadata/s-demo'))
    .MediaContainer.Metadata[0];
  const libraryMetadata = JSON.parse(libraryItemsJson([item], 'track')).MediaContainer.Metadata[0];
  for (const metadata of [queueMetadata, libraryMetadata]) {
    assert.equal(metadata.thumb, item.thumb);
    assert.equal(metadata.art, item.art);
    assert.deepEqual(metadata.Image, [
      { alt: 'Demo', type: 'coverPoster', url: item.thumb },
      { alt: 'Demo', type: 'background', url: item.art }
    ]);
  }
});

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
