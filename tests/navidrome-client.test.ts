import assert from 'node:assert/strict';
import test from 'node:test';
import { NavidromeClient } from '../src/music/navidrome/client.js';

const settings = { url: 'http://navidrome', username: 'user', password: 'password' };

function response(body: unknown): Response {
  return new Response(JSON.stringify({ 'subsonic-response': { status: 'ok', ...(body as Record<string, unknown>) } }), {
    status: 200
  });
}

test('albums are fetched across all paginated pages', async () => {
  const requests: URL[] = [];
  const client = new NavidromeClient(settings, async (input) => {
    const url = new URL(String(input));
    requests.push(url);
    const offset = Number(url.searchParams.get('offset'));
    const albums =
      offset === 0
        ? Array.from({ length: 500 }, (_, index) => ({ id: `album-${index}`, name: `Album ${index}` }))
        : [{ id: 'album-500', name: 'Album 500' }];
    return response({ albumList2: { album: albums } });
  });

  const albums = await client.albums();

  assert.equal(albums.length, 501);
  assert.deepEqual(
    requests.map((request) => request.searchParams.get('offset')),
    ['0', '500']
  );
});

test('library collections are cached across page requests', async () => {
  let requestCount = 0;
  const client = new NavidromeClient(settings, async () => {
    requestCount += 1;
    return response({ albumList2: { album: [{ id: 'album-1', name: 'Album 1' }] } });
  });

  await client.albums();
  await client.albums();

  assert.equal(requestCount, 1);
});

test('albums preserve Navidrome OpenSubsonic record labels', async () => {
  const client = new NavidromeClient(settings, async () =>
    response({
      albumList2: {
        album: [
          {
            id: 'album-1',
            name: 'Album 1',
            openSubsonicAlbumId3: { recordLabels: [{ name: 'Test Label' }] }
          }
        ]
      }
    })
  );

  assert.equal((await client.albums())[0]?.recordLabel, 'Test Label');
});

test('albums and songs preserve Navidrome play counts and last-played dates', async () => {
  const client = new NavidromeClient(settings, async (input) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith('/getAlbumList2.view'))
      return response({
        albumList2: { album: [{ id: 'album-1', name: 'Album 1', playCount: 7, played: '2026-10-20T12:34:56Z' }] }
      });
    return response({
      searchResult3: { song: [{ id: 'song-1', title: 'Song 1', playCount: '3', played: '2026-10-21T01:02:03Z' }] }
    });
  });

  const album = (await client.albums())[0];
  assert.equal(album?.playCount, 7);
  assert.equal(album?.lastPlayedAt, 1792499696);
  const song = (await client.songs())[0];
  assert.equal(song?.playCount, 3);
  assert.equal(song?.lastPlayedAt, 1792544523);
});

test('songs preserve Navidrome OpenSubsonic moods', async () => {
  const client = new NavidromeClient(settings, async () =>
    response({ searchResult3: { song: [{ id: 'song-1', title: 'Song 1', moods: ['Energetic', 'Driving'] }] } })
  );

  assert.equal((await client.songs())[0]?.mood, 'Energetic, Driving');
});

test('songs use deterministic paginated search instead of the 500-song random limit', async () => {
  const requests: URL[] = [];
  const client = new NavidromeClient(settings, async (input) => {
    const url = new URL(String(input));
    requests.push(url);
    const offset = Number(url.searchParams.get('songOffset'));
    const songs =
      offset === 0
        ? Array.from({ length: 500 }, (_, index) => ({ id: `song-${index}`, title: `Song ${index}` }))
        : [{ id: 'song-500', title: 'Song 500' }];
    return response({ searchResult3: { song: songs } });
  });

  const songs = await client.songs();

  assert.equal(songs.length, 501);
  assert.deepEqual(
    requests.map((request) => request.pathname),
    ['/rest/search3.view', '/rest/search3.view']
  );
  assert.deepEqual(
    requests.map((request) => request.searchParams.get('songOffset')),
    ['0', '500']
  );
  assert.equal(requests[0]?.searchParams.get('artistCount'), '0');
  assert.equal(requests[0]?.searchParams.get('albumCount'), '0');
  assert.equal(requests[0]?.searchParams.get('query'), '');
});

test('sonic paths use the OpenSubsonic findSonicPath extension', async () => {
  let requested: URL | undefined;
  const client = new NavidromeClient(settings, async (input) => {
    requested = new URL(String(input));
    return response({
      sonicMatch: [
        { entry: { id: 'song-start', title: 'Start' }, similarity: 1 },
        { entry: { id: 'song-end', title: 'End' }, similarity: 0.4 }
      ]
    });
  });

  assert.deepEqual(
    (await client.findSonicPath('song-start', 'song-end')).map((song) => song.id),
    ['song-start', 'song-end']
  );
  assert.equal(requested?.pathname, '/rest/findSonicPath.view');
  assert.equal(requested?.searchParams.get('startSongId'), 'song-start');
  assert.equal(requested?.searchParams.get('endSongId'), 'song-end');
});
