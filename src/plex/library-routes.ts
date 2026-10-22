import { Readable } from 'node:stream';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ReadableStream } from 'node:stream/web';
import type { MusicProvider } from '../music/types.js';
import {
  emptyLibraryFilterJson,
  emptyPlaylistSectionJson,
  firstCharacterJson,
  genresJson,
  libraryItems,
  libraryItemsJson,
  playQueueJson,
  playlistQueueJson,
  timelineJson
} from './protocol.js';
import { albumItem, artistItem, directPlayableFormats, parseMetadataKey as parseKey, songItem } from './metadata.js';
import type { PlexItem } from './protocol.js';

type RouteRequest = FastifyRequest<{
  Querystring: Record<string, string | undefined>;
  Params: Record<string, string>;
}>;
type RouteReply = FastifyReply;
interface RouteApp {
  get(path: string, handler: (request: RouteRequest, reply: RouteReply) => unknown): unknown;
  post(path: string, handler: (request: RouteRequest, reply: RouteReply) => unknown): unknown;
  put(path: string, handler: (request: RouteRequest, reply: RouteReply) => unknown): unknown;
}
export interface PlayRecord {
  trackId: string;
  title?: string;
  artist?: string;
  album?: string;
  playedAt: number;
  player: string;
  source: 'timeline' | 'estimated' | 'plex_scrobble';
}
interface LibraryRouteDependencies {
  music: MusicProvider;
  playQueues: Map<string, { item: PlexItem; sourceUri: string; response?: string }>;
  playlistIds: Map<string, string>;
  loadPlaylistIds: () => Promise<void>;
  preserveSourceFormats: boolean;
  now?: () => number;
  setTimeout?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimeout?: (timer: ReturnType<typeof setTimeout>) => void;
  onPlay?: (play: PlayRecord) => Promise<void> | void;
}

interface PlaybackState {
  ratingKey: string;
  maxTimeMs: number;
  durationMs: number;
  scrobbled: boolean;
  activeMs: number;
  lastSignalMs: number;
  lastState: string;
  fallbackTimer?: ReturnType<typeof setTimeout>;
}

const SCROBBLE_THRESHOLD = 0.75;
const FALLBACK_THRESHOLD = 1.1;

export function registerLibraryRoutes(
  app: RouteApp,
  {
    music,
    playQueues,
    playlistIds,
    loadPlaylistIds,
    preserveSourceFormats,
    now = Date.now,
    setTimeout: setTimeoutFn = setTimeout,
    clearTimeout: clearTimeoutFn = clearTimeout,
    onPlay
  }: LibraryRouteDependencies
): void {
  const xml = (body: string) => ({ body, type: 'application/xml; charset=utf-8' });
  let nextPlayQueueId = 1;
  const playback = new Map<string, PlaybackState>();
  const playbackPlayerKey = (request: RouteRequest) =>
    String(
      request.headers['x-plex-client-identifier'] ??
        request.headers['x-plex-device-name'] ??
        request.headers['user-agent'] ??
        'unknown-player'
    );
  const trackRatingKey = (query: { ratingKey?: string; key?: string }) => {
    const value = query.ratingKey ?? query.key?.match(/\/library\/metadata\/([^/?#]+)/)?.[1] ?? '';
    if (!value) return '';
    // Plex clients commonly send the numeric/source ID without the type prefix,
    // even though PlexBridge advertises track rating keys as `s-<id>`.
    return value.startsWith('s-') ? value : `s-${value}`;
  };
  const isActiveState = (state: string) => state === 'playing' || state === 'buffering';
  const clearFallbackTimer = (state: PlaybackState | undefined) => {
    if (state?.fallbackTimer !== undefined) clearTimeoutFn(state.fallbackTimer);
    if (state) state.fallbackTimer = undefined;
  };
  const logPlaybackSignal = (event: string, request: RouteRequest) => {
    const query = request.query as {
      state?: string;
      time?: string;
      duration?: string;
      ratingKey?: string;
      key?: string;
      playQueueID?: string;
      playQueueItemID?: string;
      playQueueVersion?: string;
    };
    console.debug(
      JSON.stringify({
        event,
        state: query.state ?? '',
        time: query.time ?? '',
        duration: query.duration ?? '',
        ratingKey: query.ratingKey ?? '',
        key: query.key ?? '',
        playQueueID: query.playQueueID ?? '',
        playQueueItemID: query.playQueueItemID ?? '',
        playQueueVersion: query.playQueueVersion ?? ''
      })
    );
  };
  const scrobblePlayback = async (playerKey: string, current: PlaybackState, source: PlayRecord['source']) => {
    if (current.scrobbled) return;
    const parsed = parseKey(current.ratingKey);
    if (parsed?.kind !== 's') return;
    clearFallbackTimer(current);
    current.scrobbled = true;
    try {
      await music.scrobble(parsed.id);
      console.info(
        JSON.stringify({
          event: 'music_scrobbled',
          trackId: parsed.id,
          ratingKey: current.ratingKey,
          positionMs: current.maxTimeMs,
          durationMs: current.durationMs,
          source
        })
      );
    } catch (error) {
      current.scrobbled = false;
      console.warn(
        JSON.stringify({
          event: 'music_scrobble_failed',
          trackId: parsed.id,
          error: error instanceof Error ? error.message : 'unknown error'
        })
      );
      if (source === 'estimated' && playback.get(playerKey) === current) scheduleFallbackTimer(playerKey, current);
      return;
    }
    try {
      const song = await music.song(parsed.id);
      await onPlay?.({
        trackId: parsed.id,
        title: song.title,
        artist: song.artist,
        album: song.album,
        playedAt: now(),
        player: playerKey,
        source
      });
    } catch (error) {
      console.warn(
        JSON.stringify({
          event: 'play_history_record_failed',
          trackId: parsed.id,
          error: error instanceof Error ? error.message : 'unknown error'
        })
      );
    }
  };
  const scheduleFallbackTimer = (playerKey: string, current: PlaybackState) => {
    clearFallbackTimer(current);
    if (current.scrobbled || current.durationMs <= 0 || !isActiveState(current.lastState)) return;
    const remainingMs = Math.max(0, current.durationMs * FALLBACK_THRESHOLD - (current.maxTimeMs + current.activeMs));
    current.fallbackTimer = setTimeoutFn(() => {
      const live = playback.get(playerKey);
      if (live !== current || live.scrobbled || !isActiveState(live.lastState)) return;
      const signalMs = now();
      live.activeMs += Math.max(0, signalMs - live.lastSignalMs);
      live.lastSignalMs = signalMs;
      void scrobblePlayback(playerKey, live, 'estimated');
    }, remainingMs);
  };
  const recordPlayback = async (request: RouteRequest) => {
    const query = request.query as {
      state?: string;
      time?: string;
      duration?: string;
      ratingKey?: string;
      key?: string;
    };
    const playerKey = playbackPlayerKey(request);
    const previous = playback.get(playerKey);
    const ratingKey = trackRatingKey(query) || previous?.ratingKey || '';
    const timeMs = Number(query.time ?? 0);
    const reportedDurationMs = Number(query.duration ?? 0);
    const state = query.state ?? '';
    const signalMs = now();
    if (
      !ratingKey.startsWith('s-') ||
      !Number.isFinite(timeMs) ||
      !Number.isFinite(reportedDurationMs) ||
      reportedDurationMs < 0
    )
      return;
    const sameTrack = previous?.ratingKey === ratingKey;
    if (previous && !sameTrack) {
      if (isActiveState(previous.lastState)) {
        previous.activeMs += Math.max(0, signalMs - previous.lastSignalMs);
        previous.lastSignalMs = signalMs;
      }
      const previousProgressMs = previous.maxTimeMs + previous.activeMs;
      const previousReachedThreshold = previousProgressMs >= previous.durationMs * SCROBBLE_THRESHOLD;
      if (!previous.scrobbled && previous.durationMs > 0 && previousReachedThreshold)
        await scrobblePlayback(playerKey, previous, 'timeline');
    }
    clearFallbackTimer(previous);
    const activeSinceLastSignal =
      sameTrack && ['playing', 'buffering'].includes(previous.lastState)
        ? Math.max(0, signalMs - previous.lastSignalMs)
        : 0;
    const current: PlaybackState = {
      ratingKey,
      maxTimeMs: sameTrack ? Math.max(previous.maxTimeMs, timeMs) : timeMs,
      durationMs: sameTrack ? Math.max(previous.durationMs, reportedDurationMs) : reportedDurationMs,
      scrobbled: sameTrack ? previous.scrobbled : false,
      activeMs: (sameTrack ? previous.activeMs : 0) + activeSinceLastSignal,
      lastSignalMs: signalMs,
      lastState: state
    };
    playback.set(playerKey, current);
    const parsed = parseKey(ratingKey);
    if (parsed?.kind !== 's') return;
    if (current.durationMs <= 0) {
      try {
        const song = await music.song(parsed.id);
        if (song.duration && Number.isFinite(song.duration) && song.duration > 0)
          current.durationMs = song.duration * 1000;
      } catch (error) {
        console.debug(
          JSON.stringify({
            event: 'music_duration_lookup_failed',
            trackId: parsed.id,
            error: error instanceof Error ? error.message : 'unknown error'
          })
        );
      }
    }
    playback.set(playerKey, current);
    const activeMs = current.activeMs;
    const reachedScrobbleThreshold = current.maxTimeMs >= current.durationMs * SCROBBLE_THRESHOLD;
    const effectiveProgressMs = current.maxTimeMs + activeMs;
    const estimatedComplete = effectiveProgressMs >= current.durationMs * FALLBACK_THRESHOLD;
    if (
      current.scrobbled ||
      current.durationMs <= 0 ||
      !['playing', 'buffering', 'stopped'].includes(state) ||
      (!reachedScrobbleThreshold && !estimatedComplete)
    )
      return scheduleFallbackTimer(playerKey, current);
    await scrobblePlayback(playerKey, current, 'timeline');
  };
  const recordExplicitScrobble = async (request: RouteRequest) => {
    const query = request.query as { ratingKey?: string; key?: string; time?: string; duration?: string };
    const ratingKey = trackRatingKey(query);
    const parsed = parseKey(ratingKey);
    if (parsed?.kind !== 's') return;
    const playerKey = playbackPlayerKey(request);
    const previous = playback.get(playerKey);
    if (previous?.ratingKey === ratingKey && previous.scrobbled) return;
    clearFallbackTimer(previous);
    const current: PlaybackState = {
      ratingKey,
      maxTimeMs: Math.max(previous?.ratingKey === ratingKey ? previous.maxTimeMs : 0, Number(query.time ?? 0)),
      durationMs: Math.max(previous?.ratingKey === ratingKey ? previous.durationMs : 0, Number(query.duration ?? 0)),
      scrobbled: false,
      activeMs: previous?.ratingKey === ratingKey ? previous.activeMs : 0,
      lastSignalMs: now(),
      lastState: 'stopped'
    };
    playback.set(playerKey, current);
    await scrobblePlayback(playerKey, current, 'plex_scrobble');
  };
  const artistListing = async (reply: RouteReply, json = false, firstCharacter?: string) => {
    try {
      const artists = await music.artists();
      const filtered = firstCharacter
        ? artists.filter((artist) =>
            artist.name.trim().toLocaleUpperCase().startsWith(firstCharacter.toLocaleUpperCase())
          )
        : artists;
      const items = filtered.map(artistItem);
      return json
        ? reply.type('application/json').send(libraryItemsJson(items, 'artist'))
        : reply.type(xml('').type).send(libraryItems(items, 'artist'));
    } catch (error) {
      console.warn(
        JSON.stringify({
          event: 'music_failed',
          operation: 'artists',
          error: error instanceof Error ? error.message : 'unknown error'
        })
      );
      return reply.code(503).send('Navidrome is unavailable\n');
    }
  };
  const albumListing = async (reply: RouteReply, json = false) => {
    try {
      const items = (await music.albums()).map((album) => albumItem(album));
      return json
        ? reply.type('application/json').send(libraryItemsJson(items, 'album'))
        : reply.type(xml('').type).send(libraryItems(items, 'album'));
    } catch (error) {
      console.warn(
        JSON.stringify({
          event: 'music_failed',
          operation: 'albums',
          error: error instanceof Error ? error.message : 'unknown error'
        })
      );
      return reply.code(503).send('Navidrome is unavailable\n');
    }
  };
  const trackListing = async (reply: RouteReply, json = false) => {
    try {
      const items = (await music.songs()).map((song) => songItem(song));
      return json
        ? reply.type('application/json').send(libraryItemsJson(items, 'track'))
        : reply.type(xml('').type).send(libraryItems(items, 'track'));
    } catch (error) {
      console.warn(
        JSON.stringify({
          event: 'music_failed',
          operation: 'songs',
          error: error instanceof Error ? error.message : 'unknown error'
        })
      );
      return reply.code(503).send('Navidrome is unavailable\n');
    }
  };
  app.get('/library/sections/:id/genre', async (request, reply) => {
    if (request.params.id !== '1') return reply.code(404).send('Unknown library section\n');
    if (!request.headers.accept?.includes('application/json')) return reply.code(406).send('JSON required\n');
    try {
      return reply.type('application/json').send(genresJson(await music.genres()));
    } catch (error) {
      console.warn(
        JSON.stringify({
          event: 'music_failed',
          operation: 'genres',
          error: error instanceof Error ? error.message : 'unknown error'
        })
      );
      return reply.code(503).send('Navidrome is unavailable\n');
    }
  });
  for (const [filter, title] of [
    ['style', 'By Style'],
    ['mood', 'By Mood'],
    ['studio', 'By Studio'],
    ['folder', 'By Folder']
  ] as const) {
    app.get(`/library/sections/:id/${filter}`, async (request, reply) => {
      if (request.params.id !== '1') return reply.code(404).send('Unknown library section\n');
      return reply.type('application/json').send(emptyLibraryFilterJson(title));
    });
  }
  app.get('/library/sections/:id/firstCharacter', async (request, reply) => {
    if (request.params.id !== '1') return reply.code(404).send('Unknown library section\n');
    if (!request.headers.accept?.includes('application/json')) return reply.code(406).send('JSON required\n');
    try {
      const artists = await music.artists();
      const counts = new Map();
      for (const artist of artists) {
        const character = artist.name.trim().charAt(0).toLocaleUpperCase() || '#';
        counts.set(character, (counts.get(character) ?? 0) + 1);
      }
      return reply
        .type('application/json')
        .send(
          firstCharacterJson([...counts].sort(([a], [b]) => a.localeCompare(b)).map(([key, size]) => ({ key, size })))
        );
    } catch (error) {
      console.warn(
        JSON.stringify({
          event: 'music_failed',
          operation: 'first_characters',
          error: error instanceof Error ? error.message : 'unknown error'
        })
      );
      return reply.type('application/json').send(firstCharacterJson());
    }
  });
  app.get('/library/sections/:id/firstCharacter/:character', async (request, reply) => {
    if (request.params.id !== '1') return reply.code(404).send('Unknown library section\n');
    return artistListing(
      reply,
      request.headers.accept?.includes('application/json'),
      decodeURIComponent(request.params.character)
    );
  });
  const timeline = async (request: RouteRequest, reply: RouteReply) => {
    logPlaybackSignal('plex_timeline', request);
    await recordPlayback(request);
    return reply.type('application/json').send(timelineJson());
  };
  const scrobble = async (request: RouteRequest, reply: RouteReply) => {
    logPlaybackSignal('plex_scrobble', request);
    await recordExplicitScrobble(request);
    return reply.type('application/json').send(timelineJson());
  };
  const unscrobble = async (request: RouteRequest, reply: RouteReply) => {
    logPlaybackSignal('plex_unscrobble', request);
    return reply.type('application/json').send(timelineJson());
  };
  app.get('/:/timeline', timeline);
  app.post('/:/timeline', timeline);
  app.put('/:/timeline', timeline);
  app.get('/:/scrobble', scrobble);
  app.post('/:/scrobble', scrobble);
  app.put('/:/rate', async (request, reply) => {
    logPlaybackSignal('plex_rate', request);
    await recordExplicitScrobble(request);
    return reply.type('application/json').send(timelineJson());
  });
  app.get('/:/unscrobble', unscrobble);
  app.post('/:/unscrobble', unscrobble);
  app.post('/playQueues', async (request, reply) => {
    if (!request.headers.accept?.includes('application/json')) return reply.code(406).send('JSON required\n');
    const query = request.query;
    if (query.playlistID) {
      try {
        await loadPlaylistIds();
        const playlistId = decodeURIComponent(query.playlistID);
        const result = await music.playlist(playlistIds.get(playlistId) ?? playlistId);
        const items = result.songs.map((song) => songItem(song));
        if (!items.length) return reply.code(404).send('Playlist is empty\n');
        if (query.shuffle === '1') items.sort(() => Math.random() - 0.5);
        const queueId = String(nextPlayQueueId++);
        const sourceUri = query.uri?.startsWith('library://')
          ? query.uri
          : `library://plexbridge-music/playlist/${playlistId}`;
        const response = playlistQueueJson(
          items,
          queueId,
          sourceUri,
          playlistId,
          result.playlist.name,
          query.shuffle === '1'
        );
        playQueues.set(queueId, { item: items[0], sourceUri, response });
        return reply.type('application/json').send(response);
      } catch {
        return reply.code(503).send('Navidrome playlist unavailable\n');
      }
    }
    const keyValue = query.key ?? query.uri ?? '';
    const match = /(?:^|\/)library\/metadata\/(s-[^/?#]+)/.exec(keyValue);
    if (!match) return reply.code(400).send('A track key is required\n');
    const parsed = parseKey(match[1]);
    if (parsed?.kind !== 's') return reply.code(400).send('A track key is required\n');
    try {
      const queueId = String(nextPlayQueueId++);
      const item = songItem(await music.song(parsed.id));
      const sourceUri = query.uri?.startsWith('library://')
        ? query.uri
        : `library://plexbridge-music/item/${item.key.replace(/^\/+/, '')}`;
      playQueues.set(queueId, { item, sourceUri });
      console.debug(
        JSON.stringify({
          event: 'play_queue_response',
          queueId,
          trackKey: item.key,
          sourceUri,
          media: item.media,
          thumb: item.thumb,
          art: item.art
        })
      );
      return reply.type('application/json').send(playQueueJson(item, queueId, sourceUri));
    } catch (error) {
      console.warn(
        JSON.stringify({
          event: 'music_failed',
          operation: 'play_queue',
          error: error instanceof Error ? error.message : 'unknown error'
        })
      );
      return reply.code(503).send('Navidrome is unavailable\n');
    }
  });
  app.get('/playQueues/:id', async (request, reply) => {
    const queue = playQueues.get(request.params.id);
    if (!queue) return reply.code(404).send('Unknown play queue\n');
    return reply
      .type('application/json')
      .send(queue.response ?? playQueueJson(queue.item, request.params.id, queue.sourceUri));
  });
  app.get('/library/sections/:id/all', async (request, reply) => {
    if (request.params.id !== '1') return reply.code(404).send('Unknown library section\n');
    const type = String(request.query.type ?? '8');
    const json = request.headers.accept?.includes('application/json');
    if (type === '8') return artistListing(reply, json);
    if (type === '9') return albumListing(reply, json);
    if (type === '10') return trackListing(reply, json);
    if (type === '15')
      return json
        ? reply.type('application/json').send(emptyPlaylistSectionJson())
        : reply.code(406).send('JSON required\n');
    return reply.code(400).send('Unsupported library type\n');
  });
  app.get('/library/metadata', async (request, reply) =>
    artistListing(reply, request.headers.accept?.includes('application/json'))
  );
  app.get('/library/metadata/:id/all', async (request, reply) => {
    if (request.params.id === '1') return artistListing(reply, request.headers.accept?.includes('application/json'));
    return reply.code(404).send('Unknown library section\n');
  });
  app.get('/library/metadata/:id/children', async (request, reply) => {
    const json = request.headers.accept?.includes('application/json');
    if (request.params.id === '1') return artistListing(reply, json);
    const parsed = parseKey(request.params.id);
    if (!parsed) return reply.code(404).send('Unknown metadata key\n');
    try {
      if (parsed.kind === 'a') {
        const items = (await music.artist(parsed.id)).albums.map((album) => albumItem(album));
        return json
          ? reply.type('application/json').send(libraryItemsJson(items, 'album'))
          : reply.type(xml('').type).send(libraryItems(items, 'album'));
      }
      if (parsed.kind === 'l') {
        const result = await music.album(parsed.id);
        const items = result.songs.map((song) => songItem(song, result.album));
        return json
          ? reply.type('application/json').send(libraryItemsJson(items, 'track'))
          : reply.type(xml('').type).send(libraryItems(items, 'track'));
      }
      return reply.code(404).send('Tracks do not have children\n');
    } catch (error) {
      console.warn(
        JSON.stringify({
          event: 'music_failed',
          operation: 'children',
          error: error instanceof Error ? error.message : 'unknown error'
        })
      );
      return reply.code(503).send('Navidrome is unavailable\n');
    }
  });
  app.get('/library/metadata/:id', async (request, reply) => {
    const json = request.headers.accept?.includes('application/json');
    const parsed = parseKey(request.params.id);
    if (!parsed) return reply.code(404).send('Unknown metadata key\n');
    try {
      if (parsed.kind === 'a') {
        const result = await music.artist(parsed.id);
        const item = artistItem(result.artist);
        return json
          ? reply.type('application/json').send(libraryItemsJson([item], 'artist'))
          : reply.type(xml('').type).send(libraryItems([item], 'artist'));
      }
      if (parsed.kind === 'l') {
        const result = await music.album(parsed.id);
        const item = albumItem(result.album);
        return json
          ? reply.type('application/json').send(libraryItemsJson([item], 'album'))
          : reply.type(xml('').type).send(libraryItems([item], 'album'));
      }
      const song = await music.song(parsed.id);
      const item = songItem(song);
      return json
        ? reply.type('application/json').send(libraryItemsJson([item], 'track'))
        : reply.type(xml('').type).send(libraryItems([item], 'track'));
    } catch (error) {
      console.warn(
        JSON.stringify({
          event: 'music_failed',
          operation: 'metadata',
          error: error instanceof Error ? error.message : 'unknown error'
        })
      );
      return reply.code(503).send('Navidrome is unavailable\n');
    }
  });
  app.get('/library/metadata/:id/stream', async (request, reply) => {
    const parsed = parseKey(request.params.id);
    if (parsed?.kind !== 's') return reply.code(404).send('Unknown track\n');
    try {
      const source = await music.song(parsed.id);
      const sourceFormat = (source.suffix ?? source.contentType?.split('/')[1] ?? 'mp3').toLowerCase();
      const streamUrl =
        preserveSourceFormats && directPlayableFormats.has(sourceFormat)
          ? await music.streamUrl(parsed.id)
          : await music.streamUrl(parsed.id, { format: 'mp3' });
      const range = request.headers.range;
      const response = await fetch(streamUrl, range ? { headers: { range } } : undefined);
      if (!response.ok || !response.body) return reply.code(502).send('Navidrome stream unavailable\n');
      if (response.status === 206) reply.code(206);
      reply.header('content-type', response.headers.get('content-type') ?? 'audio/mpeg');
      for (const header of ['content-range', 'accept-ranges']) {
        const value = response.headers.get(header);
        if (value) reply.header(header, value);
      }
      if (response.headers.get('content-length'))
        reply.header('content-length', response.headers.get('content-length'));
      return reply.send(Readable.fromWeb(response.body as unknown as ReadableStream));
    } catch {
      return reply.code(502).send('Navidrome stream unavailable\n');
    }
  });
  app.get('/audio/:/transcode/universal/decision', async (request, reply) => {
    const match = /(?:^|\/)library\/metadata\/(s-[^/?#]+)/.exec(String(request.query.path ?? ''));
    const parsed = match ? parseKey(match[1]) : undefined;
    if (parsed?.kind !== 's') return reply.code(404).send('Unknown track\n');
    try {
      const source = await music.song(parsed.id);
      const sourceFormat = (source.suffix ?? source.contentType?.split('/')[1] ?? 'mp3').toLowerCase();
      const item = songItem(source);
      const directPlayRequested = request.query.directPlay !== '0';
      const directPlayable = preserveSourceFormats && directPlayableFormats.has(sourceFormat);
      console.debug(
        JSON.stringify({
          event: 'audio_decision',
          sourceFormat,
          directPlayRequested,
          directPlayOverridden: directPlayable && !directPlayRequested,
          directPlayable,
          preserveSourceFormats,
          musicBitrate: request.query.musicBitrate ?? '',
          clientProfile: request.headers['x-plex-client-profile-extra'] ?? ''
        })
      );
      const metadata = JSON.parse(libraryItemsJson([item], 'track')).MediaContainer.Metadata[0] as Record<
        string,
        unknown
      >;
      if (Array.isArray(metadata.Media)) {
        const media = metadata.Media[0] as Record<string, unknown>;
        media.container = directPlayable ? sourceFormat : 'mp3';
        media.audioCodec = directPlayable ? media.audioCodec : 'mp3';
        const part = Array.isArray(media.Part) ? (media.Part[0] as Record<string, unknown>) : undefined;
        if (part) {
          part.container = directPlayable ? sourceFormat : 'mp3';
          part.decision = directPlayable ? 'directplay' : 'transcode';
          part.selected = true;
        }
      }
      return reply.type('application/json').send({
        MediaContainer: {
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
        }
      });
    } catch {
      return reply.code(503).send('Navidrome is unavailable\n');
    }
  });
  app.get('/audio/:/transcode/universal/start', async (request, reply) => {
    const query = request.query;
    const match = /(?:^|\/)library\/metadata\/(s-[^/?#]+)/.exec(String(query.path ?? ''));
    const parsed = match ? parseKey(match[1]) : undefined;
    if (parsed?.kind !== 's') return reply.code(404).send('Unknown track\n');
    const directPlay = query.directPlay === '1';
    const requestedBitrate = Number(query.musicBitrate);
    const maxBitRate =
      Number.isFinite(requestedBitrate) && requestedBitrate > 0
        ? Math.min(Math.max(Math.round(requestedBitrate), 32), 320)
        : undefined;
    try {
      const source = await music.song(parsed.id);
      const sourceFormat = (source.suffix ?? source.contentType?.split('/')[1] ?? 'mp3').toLowerCase();
      const canDirectPlay = preserveSourceFormats && directPlayableFormats.has(sourceFormat);
      console.debug(
        JSON.stringify({
          event: 'audio_stream',
          sourceFormat,
          directPlayRequested: directPlay,
          directPlayOverridden: canDirectPlay && !directPlay,
          canDirectPlay,
          preserveSourceFormats,
          outputFormat: canDirectPlay ? sourceFormat : 'mp3',
          musicBitrate: query.musicBitrate ?? '',
          range: request.headers.range ?? '',
          clientProfile: request.headers['x-plex-client-profile-extra'] ?? ''
        })
      );
      const streamUrl = await music.streamUrl(parsed.id, canDirectPlay ? {} : { format: 'mp3', maxBitRate });
      const range = request.headers.range;
      const response = await fetch(streamUrl, range ? { headers: { range } } : undefined);
      if (!response.ok || !response.body) return reply.code(502).send('Navidrome stream unavailable\n');
      if (response.status === 206) reply.code(206);
      reply.header('content-type', response.headers.get('content-type') ?? 'audio/mpeg');
      for (const header of ['content-range', 'accept-ranges']) {
        const value = response.headers.get(header);
        if (value) reply.header(header, value);
      }
      if (response.headers.get('content-length'))
        reply.header('content-length', response.headers.get('content-length'));
      return reply.send(Readable.fromWeb(response.body as unknown as ReadableStream));
    } catch {
      return reply.code(502).send('Navidrome stream unavailable\n');
    }
  });
  app.get('/audio/:/transcode/universal/stop', async (_request, reply) =>
    reply.type('application/json').send({ MediaContainer: { size: 0 } })
  );
  app.get('/photo/:/transcode', async (request, reply) => {
    const rawUrl = String(request.query.url ?? '');
    let url = rawUrl;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const decoded = decodeURIComponent(url);
        if (decoded === url) break;
        url = decoded;
      } catch {
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
        if (!artworkId) return reply.code(404).send('Unknown artwork\n');
        const response = await fetch(await music.coverArtUrl(artworkId));
        if (!response.ok || !response.body) return reply.code(404).send('Artwork unavailable\n');
        reply.header('content-type', response.headers.get('content-type') ?? 'image/jpeg');
        return reply.send(Readable.fromWeb(response.body as unknown as ReadableStream));
      } catch {
        return reply.code(404).send('Artwork unavailable\n');
      }
    }
    const match = /(?:^|\/)library\/metadata\/((?:a|l|s)-[^/?#]+)(?:\/(?:thumb|art)(?:\/[^/?#]+)?)?(?:[/?#]|$)/.exec(
      url
    );
    const parsed = match ? parseKey(match[1]) : undefined;
    if (!parsed) {
      console.warn(JSON.stringify({ event: 'artwork_url_unrecognized', url: sanitizedUrl }));
      return reply.code(404).send('Unknown artwork\n');
    }
    try {
      const artworkId =
        parsed.kind === 'a' ? ((await music.artist(parsed.id)).artist.coverArt ?? parsed.id) : parsed.id;
      const response = await fetch(await music.coverArtUrl(artworkId));
      if (!response.ok || !response.body) return reply.code(404).send('Artwork unavailable\n');
      reply.header('content-type', response.headers.get('content-type') ?? 'image/jpeg');
      if (response.headers.get('content-length'))
        reply.header('content-length', response.headers.get('content-length'));
      return reply.send(Readable.fromWeb(response.body as unknown as ReadableStream));
    } catch {
      return reply.code(502).send('Navidrome artwork unavailable\n');
    }
  });
  app.get('/library/metadata/:id/:artType', async (request, reply) => {
    const artType = request.params.artType;
    if (artType !== 'thumb' && artType !== 'art') return reply.code(404).send('Unknown artwork\n');
    const parsed = parseKey(request.params.id);
    if (!parsed) return reply.code(404).send('Unknown artwork\n');
    try {
      const artworkId =
        parsed.kind === 'a' ? ((await music.artist(parsed.id)).artist.coverArt ?? parsed.id) : parsed.id;
      const response = await fetch(await music.coverArtUrl(artworkId));
      if (!response.ok || !response.body) return reply.code(404).send('Artwork unavailable\n');
      reply.header('content-type', response.headers.get('content-type') ?? 'image/jpeg');
      return reply.send(Readable.fromWeb(response.body as unknown as ReadableStream));
    } catch {
      return reply.code(502).send('Navidrome artwork unavailable\n');
    }
  });
}
