import { Readable } from 'node:stream';
import type { MusicProvider } from '../music/types.js';
import { emptyPlaylistSectionJson, firstCharacterJson, genresJson, libraryItems, libraryItemsJson, playQueueJson, playlistQueueJson, timelineJson } from './protocol.js';
import { albumItem, artistItem, directPlayableFormats, metadataKey as key, parseMetadataKey as parseKey, songItem } from './metadata.js';
import type { PlexItem } from './protocol.js';

interface RouteApp {
  get(path: string, handler: (request: any, reply: any) => unknown): unknown;
  post(path: string, handler: (request: any, reply: any) => unknown): unknown;
}
interface LibraryRouteDependencies {
  music: MusicProvider;
  playQueues: Map<string, { item: PlexItem; sourceUri: string; response?: string }>;
  playlistIds: Map<string, string>;
  loadPlaylistIds: () => Promise<void>;
  preserveSourceFormats: boolean;
}

export function registerLibraryRoutes(app: RouteApp, { music, playQueues, playlistIds, loadPlaylistIds, preserveSourceFormats }: LibraryRouteDependencies): void {
  const xml = (body: string) => ({ body, type: 'application/xml; charset=utf-8' });
  let nextPlayQueueId = 1;
  const playback = new Map<string, { ratingKey: string; maxTimeMs: number; durationMs: number; scrobbled: boolean }>();
  const logPlaybackSignal = (event: string, request: any) => {
    const query = request.query as { state?: string; time?: string; duration?: string; ratingKey?: string; key?: string; playQueueID?: string; playQueueItemID?: string; playQueueVersion?: string };
    console.debug(JSON.stringify({ event, state: query.state ?? '', time: query.time ?? '', duration: query.duration ?? '', ratingKey: query.ratingKey ?? '', key: query.key ?? '', playQueueID: query.playQueueID ?? '', playQueueItemID: query.playQueueItemID ?? '', playQueueVersion: query.playQueueVersion ?? '' }));
  };
  const recordPlayback = async (request: any) => {
    const query = request.query as { state?: string; time?: string; duration?: string; ratingKey?: string };
    const playerKey = String(request.headers['x-plex-client-identifier'] ?? request.headers['x-plex-device-name'] ?? request.headers['user-agent'] ?? 'unknown-player');
    const previous = playback.get(playerKey);
    const ratingKey = query.ratingKey ?? previous?.ratingKey ?? '';
    const timeMs = Number(query.time ?? 0);
    const durationMs = Number(query.duration ?? 0);
    if (!ratingKey.startsWith('s-') || !Number.isFinite(timeMs) || !Number.isFinite(durationMs) || durationMs <= 0)
      return;
    const sameTrack = previous?.ratingKey === ratingKey;
    const current = { ratingKey, maxTimeMs: sameTrack ? Math.max(previous.maxTimeMs, timeMs) : timeMs, durationMs: sameTrack ? Math.max(previous.durationMs, durationMs) : durationMs, scrobbled: sameTrack ? previous.scrobbled : false };
    playback.set(playerKey, current);
    if (current.scrobbled || !['playing', 'stopped'].includes(query.state ?? '') || current.maxTimeMs < current.durationMs / 2)
      return;
    const parsed = parseKey(ratingKey);
    if (!parsed || parsed.kind !== 's')
      return;
    current.scrobbled = true;
    try {
      await music.scrobble(parsed.id);
      console.info(JSON.stringify({ event: 'music_scrobbled', trackId: parsed.id, ratingKey, positionMs: current.maxTimeMs, durationMs: current.durationMs }));
    }
    catch (error) {
      current.scrobbled = false;
      console.warn(JSON.stringify({ event: 'music_scrobble_failed', trackId: parsed.id, error: error instanceof Error ? error.message : 'unknown error' }));
    }
  };
  const artistListing = async (reply: any, json = false, firstCharacter?: string) => { try { const artists = await music.artists(); const filtered = firstCharacter ? artists.filter((artist) => artist.name.trim().toLocaleUpperCase().startsWith(firstCharacter.toLocaleUpperCase())) : artists; const items = filtered.map(artistItem); return json ? reply.type('application/json').send(libraryItemsJson(items, 'artist')) : reply.type(xml('').type).send(libraryItems(items, 'artist')); } catch (error) { console.warn(JSON.stringify({ event: 'music_failed', operation: 'artists', error: error instanceof Error ? error.message : 'unknown error' })); return reply.code(503).send('Navidrome is unavailable\n'); } };
  const albumListing = async (reply: any, json = false) => { try { const items = (await music.albums()).map((album) => albumItem(album)); return json ? reply.type('application/json').send(libraryItemsJson(items, 'album')) : reply.type(xml('').type).send(libraryItems(items, 'album')); } catch (error) { console.warn(JSON.stringify({ event: 'music_failed', operation: 'albums', error: error instanceof Error ? error.message : 'unknown error' })); return reply.code(503).send('Navidrome is unavailable\n'); } };
  const trackListing = async (reply: any, json = false) => { try { const items = (await music.songs()).map((song) => songItem(song)); return json ? reply.type('application/json').send(libraryItemsJson(items, 'track')) : reply.type(xml('').type).send(libraryItems(items, 'track')); } catch (error) { console.warn(JSON.stringify({ event: 'music_failed', operation: 'songs', error: error instanceof Error ? error.message : 'unknown error' })); return reply.code(503).send('Navidrome is unavailable\n'); } };
  app.get('/library/sections/:id/genre', async (request, reply) => { if (request.params.id !== '1')
      return reply.code(404).send('Unknown library section\n'); if (!request.headers.accept?.includes('application/json'))
      return reply.code(406).send('JSON required\n'); try {
      return reply.type('application/json').send(genresJson(await music.genres()));
  }
  catch (error) {
      console.warn(JSON.stringify({ event: 'music_failed', operation: 'genres', error: error instanceof Error ? error.message : 'unknown error' }));
      return reply.code(503).send('Navidrome is unavailable\n');
  } });
  app.get('/library/sections/:id/firstCharacter', async (request, reply) => { if (request.params.id !== '1')
      return reply.code(404).send('Unknown library section\n'); if (!request.headers.accept?.includes('application/json'))
      return reply.code(406).send('JSON required\n'); try {
      const artists = await music.artists();
      const counts = new Map();
      for (const artist of artists) {
          const character = artist.name.trim().charAt(0).toLocaleUpperCase() || '#';
          counts.set(character, (counts.get(character) ?? 0) + 1);
      }
      return reply.type('application/json').send(firstCharacterJson([...counts].sort(([a], [b]) => a.localeCompare(b)).map(([key, size]) => ({ key, size }))));
  }
  catch (error) {
      console.warn(JSON.stringify({ event: 'music_failed', operation: 'first_characters', error: error instanceof Error ? error.message : 'unknown error' }));
      return reply.type('application/json').send(firstCharacterJson());
  } });
  app.get('/library/sections/:id/firstCharacter/:character', async (request, reply) => { if (request.params.id !== '1')
      return reply.code(404).send('Unknown library section\n'); return artistListing(reply, request.headers.accept?.includes('application/json'), decodeURIComponent(request.params.character)); });
  const timeline = async (request: any, reply: any) => {
    logPlaybackSignal('plex_timeline', request);
    await recordPlayback(request);
    return reply.type('application/json').send(timelineJson());
  };
  const scrobble = async (request: any, reply: any) => {
    logPlaybackSignal('plex_scrobble', request);
    return reply.type('application/json').send(timelineJson());
  };
  const unscrobble = async (request: any, reply: any) => {
    logPlaybackSignal('plex_unscrobble', request);
    return reply.type('application/json').send(timelineJson());
  };
  app.get('/:/timeline', timeline);
  app.post('/:/timeline', timeline);
  app.get('/:/scrobble', scrobble);
  app.post('/:/scrobble', scrobble);
  app.get('/:/unscrobble', unscrobble);
  app.post('/:/unscrobble', unscrobble);
  app.post('/playQueues', async (request, reply) => {
      if (!request.headers.accept?.includes('application/json'))
          return reply.code(406).send('JSON required\n');
      const query = request.query;
      if (query.playlistID) {
          try {
              await loadPlaylistIds();
              const playlistId = decodeURIComponent(query.playlistID);
      const result = await music.playlist(playlistIds.get(playlistId) ?? playlistId);
              const items = result.songs.map((song) => songItem(song));
              if (!items.length)
                  return reply.code(404).send('Playlist is empty\n');
              if (query.shuffle === '1')
                  items.sort(() => Math.random() - 0.5);
              const queueId = String(nextPlayQueueId++);
              const sourceUri = query.uri?.startsWith('library://') ? query.uri : `library://plexbridge-music/playlist/${playlistId}`;
              const response = playlistQueueJson(items, queueId, sourceUri, playlistId, result.playlist.name, query.shuffle === '1');
              playQueues.set(queueId, { item: items[0], sourceUri, response });
              return reply.type('application/json').send(response);
          }
          catch {
              return reply.code(503).send('Navidrome playlist unavailable\n');
          }
      }
      const keyValue = query.key ?? query.uri ?? '';
      const match = /(?:^|\/)library\/metadata\/(s-[^/?#]+)/.exec(keyValue);
      if (!match)
          return reply.code(400).send('A track key is required\n');
      const parsed = parseKey(match[1]);
      if (!parsed || parsed.kind !== 's')
          return reply.code(400).send('A track key is required\n');
      try {
          const queueId = String(nextPlayQueueId++);
          const item = songItem(await music.song(parsed.id));
          const sourceUri = query.uri?.startsWith('library://') ? query.uri : `library://plexbridge-music/item/${item.key.replace(/^\/+/, '')}`;
          playQueues.set(queueId, { item, sourceUri });
          console.debug(JSON.stringify({ event: 'play_queue_response', queueId, trackKey: item.key, sourceUri, media: item.media, thumb: item.thumb, art: item.art }));
          return reply.type('application/json').send(playQueueJson(item, queueId, sourceUri));
      }
      catch (error) {
          console.warn(JSON.stringify({ event: 'music_failed', operation: 'play_queue', error: error instanceof Error ? error.message : 'unknown error' }));
          return reply.code(503).send('Navidrome is unavailable\n');
      }
  });
  app.get('/playQueues/:id', async (request, reply) => { const queue = playQueues.get(request.params.id); if (!queue)
      return reply.code(404).send('Unknown play queue\n'); return reply.type('application/json').send(queue.response ?? playQueueJson(queue.item, request.params.id, queue.sourceUri)); });
  app.get('/library/sections/:id/all', async (request, reply) => { if (request.params.id !== '1')
      return reply.code(404).send('Unknown library section\n'); const type = String(request.query.type ?? '8'); const json = request.headers.accept?.includes('application/json'); if (type === '8')
      return artistListing(reply, json); if (type === '9')
      return albumListing(reply, json); if (type === '10')
      return trackListing(reply, json); if (type === '15')
      return json ? reply.type('application/json').send(emptyPlaylistSectionJson()) : reply.code(406).send('JSON required\n'); return reply.code(400).send('Unsupported library type\n'); });
  app.get('/library/metadata', async (request, reply) => artistListing(reply, request.headers.accept?.includes('application/json')));
  app.get('/library/metadata/:id/all', async (request, reply) => { if (request.params.id === '1')
      return artistListing(reply, request.headers.accept?.includes('application/json')); return reply.code(404).send('Unknown library section\n'); });
  app.get('/library/metadata/:id/children', async (request, reply) => {
      const json = request.headers.accept?.includes('application/json');
      if (request.params.id === '1')
          return artistListing(reply, json);
      const parsed = parseKey(request.params.id);
      if (!parsed)
          return reply.code(404).send('Unknown metadata key\n');
      try {
          if (parsed.kind === 'a') {
              const items = (await music.artist(parsed.id)).albums.map((album) => albumItem(album));
              return json ? reply.type('application/json').send(libraryItemsJson(items, 'album')) : reply.type(xml('').type).send(libraryItems(items, 'album'));
          }
          if (parsed.kind === 'l') {
              const result = await music.album(parsed.id);
              const items = result.songs.map((song) => songItem(song, result.album));
              return json ? reply.type('application/json').send(libraryItemsJson(items, 'track')) : reply.type(xml('').type).send(libraryItems(items, 'track'));
          }
          return reply.code(404).send('Tracks do not have children\n');
      }
      catch (error) {
          console.warn(JSON.stringify({ event: 'music_failed', operation: 'children', error: error instanceof Error ? error.message : 'unknown error' }));
          return reply.code(503).send('Navidrome is unavailable\n');
      }
  });
  app.get('/library/metadata/:id', async (request, reply) => {
      const json = request.headers.accept?.includes('application/json');
      const parsed = parseKey(request.params.id);
      if (!parsed)
          return reply.code(404).send('Unknown metadata key\n');
      try {
          if (parsed.kind === 'a') {
              const result = await music.artist(parsed.id);
              const item = artistItem(result.artist);
              return json ? reply.type('application/json').send(libraryItemsJson([item], 'artist')) : reply.type(xml('').type).send(libraryItems([item], 'artist'));
          }
          if (parsed.kind === 'l') {
              const result = await music.album(parsed.id);
              const item = albumItem(result.album);
              return json ? reply.type('application/json').send(libraryItemsJson([item], 'album')) : reply.type(xml('').type).send(libraryItems([item], 'album'));
          }
          const song = await music.song(parsed.id);
          const item = songItem(song);
          return json ? reply.type('application/json').send(libraryItemsJson([item], 'track')) : reply.type(xml('').type).send(libraryItems([item], 'track'));
      }
      catch (error) {
          console.warn(JSON.stringify({ event: 'music_failed', operation: 'metadata', error: error instanceof Error ? error.message : 'unknown error' }));
          return reply.code(503).send('Navidrome is unavailable\n');
      }
  });
  app.get('/library/metadata/:id/stream', async (request, reply) => { const parsed = parseKey(request.params.id); if (!parsed || parsed.kind !== 's')
      return reply.code(404).send('Unknown track\n'); try {
      const source = await music.song(parsed.id);
      const sourceFormat = (source.suffix ?? source.contentType?.split('/')[1] ?? 'mp3').toLowerCase();
      const streamUrl = preserveSourceFormats && directPlayableFormats.has(sourceFormat) ? await music.streamUrl(parsed.id) : await music.streamUrl(parsed.id, { format: 'mp3' });
      const response = await fetch(streamUrl);
      if (!response.ok || !response.body)
          return reply.code(502).send('Navidrome stream unavailable\n');
      reply.header('content-type', response.headers.get('content-type') ?? 'audio/mpeg');
      if (response.headers.get('content-length'))
          reply.header('content-length', response.headers.get('content-length'));
      return reply.send(Readable.fromWeb(response.body as any));
  }
  catch {
      return reply.code(502).send('Navidrome stream unavailable\n');
  } });
  app.get('/audio/:/transcode/universal/decision', async (request, reply) => {
      const match = /(?:^|\/)library\/metadata\/(s-[^/?#]+)/.exec(String(request.query.path ?? ''));
      const parsed = match ? parseKey(match[1]) : undefined;
      if (!parsed || parsed.kind !== 's')
          return reply.code(404).send('Unknown track\n');
      try {
          const source = await music.song(parsed.id);
          const sourceFormat = (source.suffix ?? source.contentType?.split('/')[1] ?? 'mp3').toLowerCase();
          const item = songItem(source);
          const directPlayRequested = request.query.directPlay !== '0';
          const directPlayable = preserveSourceFormats && directPlayableFormats.has(sourceFormat);
          console.debug(JSON.stringify({ event: 'audio_decision', sourceFormat, directPlayRequested, directPlayOverridden: directPlayable && !directPlayRequested, directPlayable, preserveSourceFormats, musicBitrate: request.query.musicBitrate ?? '', clientProfile: request.headers['x-plex-client-profile-extra'] ?? '' }));
          const metadata = JSON.parse(libraryItemsJson([item], 'track')).MediaContainer.Metadata[0] as Record<string, unknown>;
          if (Array.isArray(metadata.Media)) {
              const media = metadata.Media[0] as Record<string, unknown>;
              media.container = directPlayable ? sourceFormat : 'mp3';
              media.audioCodec = directPlayable ? media.audioCodec : 'mp3';
              const part = Array.isArray(media.Part) ? media.Part[0] as Record<string, unknown> : undefined;
              if (part) {
                  part.container = directPlayable ? sourceFormat : 'mp3';
                  part.decision = directPlayable ? 'directplay' : 'transcode';
                  part.selected = true;
              }
          }
          return reply.type('application/json').send({ MediaContainer: {
              allowSync: '1',
              directPlayDecisionCode: directPlayable ? 1000 : 3000,
              directPlayDecisionText: directPlayable ? 'Direct play OK.' : 'Direct play not available; Conversion OK.',
              generalDecisionCode: 1000,
              generalDecisionText: directPlayable ? 'Direct play OK.' : 'Direct play not available; Conversion OK.',
              identifier: 'com.plexapp.plugins.library',
              librarySectionID: '1',
              librarySectionTitle: 'Music',
              size: 1,
              transcodeDecisionCode: 1001,
              transcodeDecisionText: 'Conversion OK.',
              Metadata: [metadata]
          } });
      }
      catch {
          return reply.code(503).send('Navidrome is unavailable\n');
      }
  });
  app.get('/audio/:/transcode/universal/start', async (request, reply) => {
      const query = request.query;
      const match = /(?:^|\/)library\/metadata\/(s-[^/?#]+)/.exec(String(query.path ?? ''));
      const parsed = match ? parseKey(match[1]) : undefined;
      if (!parsed || parsed.kind !== 's')
          return reply.code(404).send('Unknown track\n');
          const directPlay = query.directPlay === '1';
      const requestedBitrate = Number(query.musicBitrate);
      const maxBitRate = Number.isFinite(requestedBitrate) && requestedBitrate > 0 ? Math.min(Math.max(Math.round(requestedBitrate), 32), 320) : undefined;
      try {
          const source = await music.song(parsed.id);
          const sourceFormat = (source.suffix ?? source.contentType?.split('/')[1] ?? 'mp3').toLowerCase();
          const canDirectPlay = preserveSourceFormats && directPlayableFormats.has(sourceFormat);
          console.debug(JSON.stringify({ event: 'audio_stream', sourceFormat, directPlayRequested: directPlay, directPlayOverridden: canDirectPlay && !directPlay, canDirectPlay, preserveSourceFormats, outputFormat: canDirectPlay ? sourceFormat : 'mp3', musicBitrate: query.musicBitrate ?? '', clientProfile: request.headers['x-plex-client-profile-extra'] ?? '' }));
          const streamUrl = await music.streamUrl(parsed.id, canDirectPlay ? {} : { format: 'mp3', maxBitRate });
          const response = await fetch(streamUrl);
          if (!response.ok || !response.body)
              return reply.code(502).send('Navidrome stream unavailable\n');
          reply.header('content-type', response.headers.get('content-type') ?? 'audio/mpeg');
          if (response.headers.get('content-length'))
              reply.header('content-length', response.headers.get('content-length'));
          return reply.send(Readable.fromWeb(response.body as any));
      }
      catch {
          return reply.code(502).send('Navidrome stream unavailable\n');
      }
  });
  app.get('/audio/:/transcode/universal/stop', async (_request, reply) => reply.type('application/json').send({ MediaContainer: { size: 0 } }));
  app.get('/photo/:/transcode', async (request, reply) => {
      const rawUrl = String(request.query.url ?? '');
      let url = rawUrl;
      for (let attempt = 0; attempt < 2; attempt++) {
          try {
              const decoded = decodeURIComponent(url);
              if (decoded === url)
                  break;
              url = decoded;
          }
          catch {
              break;
          }
      }
      const sanitizedUrl = url.replace(/([?&]X-Plex-Token=)[^&]*/i, '$1[REDACTED]');
      const playlistMatch = /(?:^|\/)playlists\/(\d+)\/composite\/[^/?#]+(?:[/?#]|$)/.exec(url);
      if (playlistMatch) {
          try {
              await loadPlaylistIds();
      const result = await music.playlist(playlistIds.get(playlistMatch[1]) ?? playlistMatch[1]);
              const artworkId = result.playlist.coverArt ?? result.songs.find((song) => song.coverArt)?.id;
              if (!artworkId)
                  return reply.code(404).send('Unknown artwork\n');
              const response = await fetch(await music.coverArtUrl(artworkId));
              if (!response.ok || !response.body)
                  return reply.code(404).send('Artwork unavailable\n');
              reply.header('content-type', response.headers.get('content-type') ?? 'image/jpeg');
              return reply.send(Readable.fromWeb(response.body as any));
          }
          catch {
              return reply.code(404).send('Artwork unavailable\n');
          }
      }
      const match = /(?:^|\/)library\/metadata\/((?:a|l|s)-[^/?#]+)(?:\/(?:thumb|art)(?:\/[^/?#]+)?)?(?:[/?#]|$)/.exec(url);
      const parsed = match ? parseKey(match[1]) : undefined;
      if (!parsed) {
          console.warn(JSON.stringify({ event: 'artwork_url_unrecognized', url: sanitizedUrl }));
          return reply.code(404).send('Unknown artwork\n');
      }
      try {
          const artworkId = parsed.kind === 'a' ? (await music.artist(parsed.id)).artist.coverArt ?? parsed.id : parsed.id;
          const response = await fetch(await music.coverArtUrl(artworkId));
          if (!response.ok || !response.body)
              return reply.code(404).send('Artwork unavailable\n');
          reply.header('content-type', response.headers.get('content-type') ?? 'image/jpeg');
          if (response.headers.get('content-length'))
              reply.header('content-length', response.headers.get('content-length'));
          return reply.send(Readable.fromWeb(response.body as any));
      }
      catch {
          return reply.code(502).send('Navidrome artwork unavailable\n');
      }
  });
  app.get('/library/metadata/:id/:artType', async (request, reply) => { const artType = request.params.artType; if (artType !== 'thumb' && artType !== 'art')
      return reply.code(404).send('Unknown artwork\n'); const parsed = parseKey(request.params.id); if (!parsed)
      return reply.code(404).send('Unknown artwork\n'); try {
      const artworkId = parsed.kind === 'a' ? (await music.artist(parsed.id)).artist.coverArt ?? parsed.id : parsed.id;
      const response = await fetch(await music.coverArtUrl(artworkId));
      if (!response.ok || !response.body)
          return reply.code(404).send('Artwork unavailable\n');
      reply.header('content-type', response.headers.get('content-type') ?? 'image/jpeg');
      return reply.send(Readable.fromWeb(response.body as any));
  }
  catch {
      return reply.code(502).send('Navidrome artwork unavailable\n');
  } });
}
