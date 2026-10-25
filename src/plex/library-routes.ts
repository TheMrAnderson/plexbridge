import { Readable } from 'node:stream';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ReadableStream } from 'node:stream/web';
import type { MusicProvider } from '../music/types.js';
import {
  emptyLibraryFilterJson,
  emptyPlaylistSectionJson,
  emptyPlayQueueJson,
  firstCharacterJson,
  genresJson,
  genresXml,
  libraryItems,
  libraryItemsJson,
  playQueueJson,
  playlistQueueJson,
  searchJson,
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
  delete(path: string, handler: (request: RouteRequest, reply: RouteReply) => unknown): unknown;
}
export interface PlayRecord {
  trackId: string;
  title?: string;
  artist?: string;
  album?: string;
  playedAt: number;
  player: string;
  source: 'timeline' | 'estimated' | 'plex_scrobble' | 'plex_offline';
  externalId?: string;
}
export interface ActivePlayRecord {
  trackId: string;
  positionMs: number;
  durationMs: number;
  state: string;
  player: string;
  startedAt: number;
}
interface LibraryRouteDependencies {
  configDir: string;
  music: MusicProvider;
  playQueues: Map<string, { item: PlexItem; sourceUri: string; response?: string }>;
  savePlayQueues: () => Promise<void>;
  playlistIds: Map<string, string>;
  loadPlaylistIds: () => Promise<void>;
  preserveSourceFormats: boolean;
  now?: () => number;
  setTimeout?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimeout?: (timer: ReturnType<typeof setTimeout>) => void;
  onPlay?: (play: PlayRecord) => Promise<void> | void;
  hasPlayHistory?: (externalId: string) => Promise<boolean> | boolean;
  onPlaybackState?: (play: ActivePlayRecord | undefined) => Promise<void> | void;
}

interface TagBucket {
  name: string;
  key: string;
  artistIds: Set<string>;
  albumIds: Set<string>;
  songIds: Set<string>;
}

interface PlaybackState {
  ratingKey: string;
  maxTimeMs: number;
  durationMs: number;
  scrobbled: boolean;
  activeMs: number;
  lastSignalMs: number;
  lastState: string;
  externalId?: string;
  fallbackTimer?: ReturnType<typeof setTimeout>;
}

const SCROBBLE_THRESHOLD = 0.75;
const FALLBACK_THRESHOLD = 1.1;
const MAX_LIBRARY_PAGE_SIZE = 500;
const BUILDER_CONTEXT_TTL_MS = 45_000;

function transcodeTarget(request: RouteRequest): { format: string; container: string; audioCodec: string } {
  const profile = String(
    request.query['X-Plex-Client-Profile-Extra'] ?? request.headers['x-plex-client-profile-extra'] ?? ''
  );
  const container = /container=([^&)]+)/.exec(profile)?.[1]?.toLowerCase();
  const audioCodec = /audioCodec=([^&)]+)/.exec(profile)?.[1]?.toLowerCase();
  if (container === 'ogg' && audioCodec === 'opus') return { format: 'opus', container: 'ogg', audioCodec: 'opus' };
  return { format: 'mp3', container: 'mp3', audioCodec: 'mp3' };
}

function libraryPage<T>(
  items: T[],
  query: Record<string, string | undefined>,
  headers?: Record<string, string | string[] | undefined>
): { items: T[]; totalSize: number; offset: number } {
  const headerValue = (name: string) => {
    const value = headers?.[name];
    return Array.isArray(value) ? value[0] : value;
  };
  const parsedOffset = Number(headerValue('x-plex-container-start') ?? query.offset ?? 0);
  const parsedSize = Number(headerValue('x-plex-container-size') ?? query.size ?? query.limit ?? MAX_LIBRARY_PAGE_SIZE);
  const offset = Number.isInteger(parsedOffset) && parsedOffset > 0 ? parsedOffset : 0;
  const size =
    Number.isInteger(parsedSize) && parsedSize > 0
      ? Math.min(parsedSize, MAX_LIBRARY_PAGE_SIZE)
      : MAX_LIBRARY_PAGE_SIZE;
  return { items: items.slice(offset, offset + size), totalSize: items.length, offset };
}

function sortByTitle<T>(items: T[], query: Record<string, string | undefined>, getTitle: (item: T) => string): T[] {
  const [field, direction = 'asc'] = (query.sort?.split(',')[0] ?? '').split(':');
  if (field !== 'titleSort') return items;
  const multiplier = direction.toLowerCase() === 'desc' ? -1 : 1;
  return items
    .map((item, index) => ({ item, index }))
    .sort(
      (left, right) =>
        getTitle(left.item).localeCompare(getTitle(right.item), undefined, { numeric: true, sensitivity: 'base' }) *
          multiplier || left.index - right.index
    )
    .map(({ item }) => item);
}

function playCountFilter<T>(
  items: T[],
  query: Record<string, string | undefined>,
  getYear: (item: T) => number | undefined,
  getPlayCount: (item: T) => number | undefined,
  getLastPlayedAt: (item: T) => number | undefined
): T[] {
  const year = query.year === undefined ? undefined : Number(query.year);
  const minimum = query['viewCount>'] === undefined ? undefined : Number(query['viewCount>']);
  const maximum = query['viewCount<'] === undefined ? undefined : Number(query['viewCount<']);
  let filtered = items.filter((item) => {
    const itemYear = getYear(item);
    const count = getPlayCount(item) ?? 0;
    return (
      (year === undefined || (Number.isFinite(year) && itemYear === year)) &&
      (minimum === undefined || (Number.isFinite(minimum) && count >= minimum)) &&
      (maximum === undefined || (Number.isFinite(maximum) && count <= maximum))
    );
  });
  const sort = query.sort?.split(',')[0] ?? '';
  const [field, direction = 'asc'] = sort.split(':');
  if (field === 'viewCount' || field === 'lastViewedAt') {
    const multiplier = direction.toLowerCase() === 'desc' ? -1 : 1;
    filtered = filtered
      .map((item, index) => ({ item, index }))
      .sort((left, right) => {
        const leftValue = field === 'viewCount' ? (getPlayCount(left.item) ?? 0) : (getLastPlayedAt(left.item) ?? 0);
        const rightValue = field === 'viewCount' ? (getPlayCount(right.item) ?? 0) : (getLastPlayedAt(right.item) ?? 0);
        return (leftValue - rightValue) * multiplier || left.index - right.index;
      })
      .map(({ item }) => item);
  }
  return filtered;
}

export function registerLibraryRoutes(
  app: RouteApp,
  {
    music,
    configDir,
    playQueues,
    savePlayQueues,
    playlistIds,
    loadPlaylistIds,
    preserveSourceFormats,
    now = Date.now,
    setTimeout: setTimeoutFn = setTimeout,
    clearTimeout: clearTimeoutFn = clearTimeout,
    onPlay,
    hasPlayHistory,
    onPlaybackState
  }: LibraryRouteDependencies
): { invalidateLibraryCaches: () => void } {
  const xml = (body: string) => ({ body, type: 'application/xml; charset=utf-8' });
  const builderContexts = new Map<string, { type: 'artist' | 'album'; expiresAt: number }>();
  const plexClientId = (request: RouteRequest): string | undefined => {
    const value = request.headers['x-plex-client-identifier'];
    return Array.isArray(value) ? value[0] : value;
  };
  const builderContext = (request: RouteRequest): 'artist' | 'album' | undefined => {
    const clientId = plexClientId(request);
    if (!clientId) return undefined;
    const context = builderContexts.get(clientId);
    if (!context || context.expiresAt <= now()) {
      builderContexts.delete(clientId);
      return undefined;
    }
    return context.type;
  };
  let genreIndexCache: Promise<Map<string, TagBucket>> | undefined;
  let moodIndexCache: Promise<Map<string, TagBucket>> | undefined;
  let studioIndexCache: Promise<Map<string, TagBucket>> | undefined;
  let genreIdsCache: Promise<Map<string, string>> | undefined;
  let moodIdsCache: Promise<Map<string, string>> | undefined;
  let studioIdsCache: Promise<Map<string, string>> | undefined;
  const tagIds = async (fileName: string, names: string[], cache: 'genre' | 'mood' | 'studio') => {
    const existing = cache === 'genre' ? genreIdsCache : cache === 'mood' ? moodIdsCache : studioIdsCache;
    if (existing) return existing;
    const pending = (async () => {
      const file = join(configDir, fileName);
      let stored: Record<string, string> = {};
      try {
        const parsed = JSON.parse(await readFile(file, 'utf8')) as {
          genres?: Record<string, string>;
          moods?: Record<string, string>;
          studios?: Record<string, string>;
        };
        stored =
          cache === 'genre' ? (parsed.genres ?? {}) : cache === 'mood' ? (parsed.moods ?? {}) : (parsed.studios ?? {});
      } catch {
        // The mapping is created on the first directory request.
      }
      const ids = new Map(Object.entries(stored));
      const used = new Set<string>();
      let changed = false;
      let nextId = cache === 'genre' ? 20000 : cache === 'mood' ? 30000 : 40000;
      for (const [name, value] of ids) {
        if (/^\d{1,6}$/.test(value) && !used.has(value)) {
          used.add(value);
          continue;
        }
        while (used.has(String(nextId))) nextId += 1;
        ids.set(name, String(nextId));
        used.add(String(nextId));
        nextId += 1;
        changed = true;
      }
      for (const name of names) {
        const normalized = name.toLocaleLowerCase();
        if (ids.has(normalized)) continue;
        while (used.has(String(nextId))) nextId += 1;
        ids.set(normalized, String(nextId));
        used.add(String(nextId));
        nextId += 1;
        changed = true;
      }
      if (changed)
        await writeFile(
          file,
          `${JSON.stringify({ version: 1, [cache === 'genre' ? 'genres' : cache === 'mood' ? 'moods' : 'studios']: Object.fromEntries(ids) }, null, 2)}\n`
        );
      return ids;
    })();
    if (cache === 'genre') genreIdsCache = pending;
    else if (cache === 'mood') moodIdsCache = pending;
    else studioIdsCache = pending;
    return pending;
  };
  const genreIds = async (names: string[]) => {
    return tagIds('plex-genre-ids.json', names, 'genre');
  };
  const moodIds = async (names: string[]) => {
    return tagIds('plex-mood-ids.json', names, 'mood');
  };
  const studioIds = async (names: string[]) => {
    return tagIds('plex-studio-ids.json', names, 'studio');
  };
  const splitValues = (value?: string) =>
    (value ?? '')
      .split(/[,;|]/)
      .map((part) => part.trim())
      .filter(Boolean);
  const buildTagIndex = async (tag: 'genre' | 'mood') => {
    const [artists, songs, names] = await Promise.all([
      music.artists(),
      music.songs(),
      tag === 'genre' ? music.genres() : Promise.resolve([])
    ]);
    const tagNames =
      tag === 'genre' ? names.map((item) => item.name) : [...new Set(songs.flatMap((song) => splitValues(song.mood)))];
    const ids = await (tag === 'genre' ? genreIds(tagNames) : moodIds(tagNames));
    const buckets = new Map<string, TagBucket>();
    for (const name of tagNames) {
      const normalized = name.toLocaleLowerCase();
      const key = ids.get(normalized);
      if (!key) continue;
      buckets.set(normalized, { name, key, artistIds: new Set(), albumIds: new Set(), songIds: new Set() });
    }
    const artistIdsByName = new Map(artists.map((artist) => [artist.name.toLocaleLowerCase(), artist.id]));
    for (const song of songs)
      for (const value of splitValues(tag === 'genre' ? song.genre : song.mood)) {
        const bucket = buckets.get(value.toLocaleLowerCase());
        if (!bucket) continue;
        bucket.songIds.add(song.id);
        if (song.albumId) bucket.albumIds.add(song.albumId);
        for (const artistName of splitValues(song.artist)) {
          const artistId = artistIdsByName.get(artistName.toLocaleLowerCase());
          if (artistId) bucket.artistIds.add(artistId);
        }
        if (song.artistId) bucket.artistIds.add(song.artistId);
      }
    return buckets;
  };
  const genreIndex = async () => {
    if (genreIndexCache) return genreIndexCache;
    genreIndexCache = buildTagIndex('genre');
    return genreIndexCache;
  };
  const moodIndex = async () => {
    if (moodIndexCache) return moodIndexCache;
    moodIndexCache = buildTagIndex('mood');
    return moodIndexCache;
  };
  const studioIndex = async () => {
    if (studioIndexCache) return studioIndexCache;
    studioIndexCache = (async () => {
      const [artists, albums, songs] = await Promise.all([music.artists(), music.albums(), music.songs()]);
      const labelNames = [...new Set(albums.flatMap((album) => splitValues(album.recordLabel)))];
      const ids = await studioIds(labelNames);
      const buckets = new Map<string, TagBucket>();
      for (const name of labelNames) {
        const normalized = name.toLocaleLowerCase();
        const key = ids.get(normalized);
        if (key) buckets.set(normalized, { name, key, artistIds: new Set(), albumIds: new Set(), songIds: new Set() });
      }
      const artistIdsByName = new Map(artists.map((artist) => [artist.name.toLocaleLowerCase(), artist.id]));
      for (const album of albums)
        for (const label of splitValues(album.recordLabel)) {
          const bucket = buckets.get(label.toLocaleLowerCase());
          if (!bucket) continue;
          bucket.albumIds.add(album.id);
          if (album.artistId) bucket.artistIds.add(album.artistId);
          for (const artistName of splitValues(album.artist)) {
            const artistId = artistIdsByName.get(artistName.toLocaleLowerCase());
            if (artistId) bucket.artistIds.add(artistId);
          }
        }
      for (const song of songs)
        for (const bucket of buckets.values())
          if (song.albumId && bucket.albumIds.has(song.albumId)) bucket.songIds.add(song.id);
      return buckets;
    })();
    return studioIndexCache;
  };
  const genreQuery = (query: Record<string, string | undefined>) => {
    if (!query.genre) return undefined;
    try {
      return decodeURIComponent(query.genre).toLocaleLowerCase();
    } catch {
      return query.genre.toLocaleLowerCase();
    }
  };
  const moodQuery = (query: Record<string, string | undefined>) => {
    if (!query.mood) return undefined;
    try {
      return decodeURIComponent(query.mood).toLocaleLowerCase();
    } catch {
      return query.mood.toLocaleLowerCase();
    }
  };
  const studioQuery = (query: Record<string, string | undefined>) => {
    if (!query.studio) return undefined;
    try {
      return decodeURIComponent(query.studio).toLocaleLowerCase();
    } catch {
      return query.studio.toLocaleLowerCase();
    }
  };
  const findTagBucket = (buckets: Map<string, TagBucket>, value: string | undefined) => {
    if (!value) return undefined;
    return buckets.get(value) ?? [...buckets.values()].find((bucket) => bucket.key === value);
  };
  let nextPlayQueueId = 1;
  const clearedPlayQueues = new Map<string, string>();
  const nextQueueId = () => {
    while (playQueues.has(String(nextPlayQueueId))) nextPlayQueueId += 1;
    return String(nextPlayQueueId++);
  };
  const decodeQueueUri = (value: string): string => {
    let decoded = value;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const next = decodeURIComponent(decoded);
        if (next === decoded) break;
        decoded = next;
      } catch {
        break;
      }
    }
    return decoded;
  };
  const artistMixIds = (uri: string): string[] => {
    const directory = decodeQueueUri(uri).match(/\/library\/sections\/1\/all(?:\?[^#]*)?/u)?.[0];
    if (!directory) return [];
    try {
      const parsed = new URL(directory, 'http://plexbridge.local');
      return (parsed.searchParams.get('artist.id') ?? '')
        .split(',')
        .map((value) => decodeURIComponent(value).trim())
        .filter((value) => value.startsWith('a-'))
        .map((value) => value.slice(2))
        .filter(Boolean);
    } catch {
      return [];
    }
  };
  const albumMixIds = (uri: string): string[] => {
    const directory = decodeQueueUri(uri).match(/\/library\/sections\/1\/all(?:\?[^#]*)?/u)?.[0];
    if (!directory) return [];
    try {
      const parsed = new URL(directory, 'http://plexbridge.local');
      return (parsed.searchParams.get('album.id') ?? '')
        .split(',')
        .map((value) => decodeURIComponent(value).trim())
        .filter((value) => value.startsWith('l-'))
        .map((value) => value.slice(2))
        .filter(Boolean);
    } catch {
      return [];
    }
  };
  const providerRelatedArtistIds = async (
    artists: Awaited<ReturnType<MusicProvider['artists']>>,
    seedIds: string[]
  ) => {
    if (!music.relatedArtists) return [];
    const artistsByName = new Map(artists.map((artist) => [artist.name.toLocaleLowerCase(), artist.id]));
    const recommendations = await Promise.all(seedIds.map((id) => music.relatedArtists?.(id) ?? Promise.resolve([])));
    return [
      ...new Set(
        recommendations
          .flat()
          .map((artist) =>
            artist.id && artists.some((candidate) => candidate.id === artist.id)
              ? artist.id
              : artistsByName.get(artist.name.toLocaleLowerCase())
          )
          .filter((id): id is string => Boolean(id))
          .filter((id) => !seedIds.includes(id))
      )
    ];
  };
  const artistMixQueue = async (
    uri: string
  ): Promise<
    { items: PlexItem[]; queueId: string; response: string; sourceUri: string; relatedArtistIds: string[] } | undefined
  > => {
    const ids = artistMixIds(uri);
    if (!ids.length) return undefined;
    const [artists, songs] = await Promise.all([music.artists(), music.songs()]);
    const relatedIds = await providerRelatedArtistIds(artists, ids);
    const requestedIds = new Set([...ids, ...relatedIds]);
    const requestedNames = new Set(
      artists.filter((artist) => requestedIds.has(artist.id)).map((artist) => artist.name.toLocaleLowerCase())
    );
    const items = songs
      .filter(
        (song) =>
          (song.artistId !== undefined && requestedIds.has(song.artistId)) ||
          splitValues(song.artist).some((name) => requestedNames.has(name.toLocaleLowerCase()))
      )
      .map((song) => songItem(song));
    if (!items.length) return undefined;
    items.sort(() => Math.random() - 0.5);
    const queueId = nextQueueId();
    return {
      items,
      queueId,
      sourceUri: uri,
      relatedArtistIds: relatedIds,
      response: playlistQueueJson(items, queueId, uri, queueId, 'Artist Mix', true)
    };
  };
  const albumMixQueue = async (
    uri: string
  ): Promise<{ items: PlexItem[]; queueId: string; response: string; sourceUri: string } | undefined> => {
    const ids = albumMixIds(uri);
    if (!ids.length) return undefined;
    const results = await Promise.all(ids.map((id) => music.album(id)));
    const items = results.flatMap((result) => result.songs.map((song) => songItem(song, result.album)));
    if (!items.length) return undefined;
    items.sort(() => Math.random() - 0.5);
    const queueId = nextQueueId();
    return {
      items,
      queueId,
      sourceUri: uri,
      response: playlistQueueJson(items, queueId, uri, queueId, 'Album Mix', true)
    };
  };
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
      offline?: string;
      viewCount?: string;
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
        offline: query.offline ?? '',
        viewCount: query.viewCount ?? '',
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
    if (current.externalId && (await hasPlayHistory?.(current.externalId))) {
      current.scrobbled = true;
      return;
    }
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
        source,
        ...(current.externalId ? { externalId: current.externalId } : {})
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
      offline?: string;
      viewCount?: string;
      updatedAt?: string;
    };
    if (query.offline === '1' && query.state === 'stopped' && Number(query.viewCount ?? 0) > 0) {
      const playerKey = playbackPlayerKey(request);
      const ratingKey = trackRatingKey(query);
      const updatedAt = Number(query.updatedAt ?? 0);
      const externalId =
        Number.isFinite(updatedAt) && updatedAt > 0 ? `plex-offline:${playerKey}:${ratingKey}:${updatedAt}` : undefined;
      await recordExplicitScrobble(request, true, 'plex_offline', externalId);
      return;
    }
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
    await onPlaybackState?.({
      trackId: parsed.id,
      positionMs: current.maxTimeMs + current.activeMs,
      durationMs: current.durationMs,
      state: current.lastState,
      player: playerKey,
      startedAt: current.lastSignalMs
    });
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
  const recordExplicitScrobble = async (
    request: RouteRequest,
    force = false,
    source: PlayRecord['source'] = 'plex_scrobble',
    externalId?: string
  ) => {
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
      lastState: 'stopped',
      externalId
    };
    playback.set(playerKey, current);
    const durationMs = current.durationMs;
    if (durationMs <= 0) {
      try {
        const song = await music.song(parsed.id);
        if (song.duration && Number.isFinite(song.duration) && song.duration > 0)
          current.durationMs = song.duration * 1000;
      } catch {
        // The next timeline signal can provide the duration.
      }
    }
    const reachedThreshold = current.durationMs > 0 && current.maxTimeMs >= current.durationMs * SCROBBLE_THRESHOLD;
    if (force || reachedThreshold) await scrobblePlayback(playerKey, current, source);
    else {
      current.lastState = 'playing';
      await onPlaybackState?.({
        trackId: parsed.id,
        positionMs: current.maxTimeMs + current.activeMs,
        durationMs: current.durationMs,
        state: current.lastState,
        player: playerKey,
        startedAt: current.lastSignalMs
      });
      scheduleFallbackTimer(playerKey, current);
    }
  };
  const artistListing = async (
    reply: RouteReply,
    json = false,
    firstCharacter?: string,
    genre?: string,
    mood?: string,
    studio?: string
  ) => {
    try {
      const artists = await music.artists();
      const query = (reply.request as RouteRequest).query;
      const needsPlayCounts =
        query.sort?.startsWith('viewCount') ||
        query.sort?.startsWith('lastViewedAt') ||
        query['viewCount>'] !== undefined ||
        query['viewCount<'] !== undefined;
      const playCounts = new Map<string, { count: number; lastPlayedAt?: number }>();
      if (needsPlayCounts) {
        const artistsByName = new Map(artists.map((artist) => [artist.name.toLocaleLowerCase(), artist.id]));
        for (const song of await music.songs()) {
          const count = song.playCount ?? 0;
          const creditedIds = new Set<string>();
          if (song.artistId) creditedIds.add(song.artistId);
          for (const name of splitValues(song.artist)) {
            const id = artistsByName.get(name.toLocaleLowerCase());
            if (id) creditedIds.add(id);
          }
          for (const id of creditedIds) {
            const previous = playCounts.get(id);
            playCounts.set(id, {
              count: (previous?.count ?? 0) + count,
              lastPlayedAt: Math.max(previous?.lastPlayedAt ?? 0, song.lastPlayedAt ?? 0) || undefined
            });
          }
        }
      }
      const bucket = genre
        ? findTagBucket(await genreIndex(), genre)
        : mood
          ? findTagBucket(await moodIndex(), mood)
          : studio
            ? findTagBucket(await studioIndex(), studio)
            : undefined;
      const filtered = playCountFilter(
        artists.map((artist) => ({
          artist,
          playCount: playCounts.get(artist.id)?.count,
          lastPlayedAt: playCounts.get(artist.id)?.lastPlayedAt
        })),
        query,
        () => undefined,
        (item) => item.playCount,
        (item) => item.lastPlayedAt
      )
        .filter(
          ({ artist }) =>
            ((!genre && !mood && !studio) || bucket?.artistIds.has(artist.id)) &&
            (!firstCharacter || artist.name.trim().toLocaleUpperCase().startsWith(firstCharacter.toLocaleUpperCase()))
        )
        .map(({ artist, playCount, lastPlayedAt }) => ({ ...artist, playCount, lastPlayedAt }));
      const page = libraryPage(
        sortByTitle(filtered.map(artistItem), query, (item) => item.title),
        (reply.request as RouteRequest).query,
        (reply.request as RouteRequest).headers
      );
      return json
        ? reply.type('application/json').send(libraryItemsJson(page.items, 'artist', page.totalSize, page.offset))
        : reply.type(xml('').type).send(libraryItems(page.items, 'artist', page.totalSize, page.offset));
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
  const albumListing = async (
    reply: RouteReply,
    json = false,
    firstCharacter?: string,
    genre?: string,
    mood?: string,
    studio?: string
  ) => {
    try {
      const albums = await music.albums();
      const bucket = genre
        ? findTagBucket(await genreIndex(), genre)
        : mood
          ? findTagBucket(await moodIndex(), mood)
          : studio
            ? findTagBucket(await studioIndex(), studio)
            : undefined;
      const filtered = playCountFilter(
        albums.filter(
          (album) =>
            ((!genre && !mood && !studio) || bucket?.albumIds.has(album.id)) &&
            (!firstCharacter || album.name.trim().toLocaleUpperCase().startsWith(firstCharacter.toLocaleUpperCase()))
        ),
        (reply.request as RouteRequest).query,
        (album) => album.year,
        (album) => album.playCount,
        (album) => album.lastPlayedAt
      );
      const page = libraryPage(
        sortByTitle(
          filtered.map((album) => albumItem(album)),
          (reply.request as RouteRequest).query,
          (item) => item.title
        ),
        (reply.request as RouteRequest).query,
        (reply.request as RouteRequest).headers
      );
      return json
        ? reply.type('application/json').send(libraryItemsJson(page.items, 'album', page.totalSize, page.offset))
        : reply.type(xml('').type).send(libraryItems(page.items, 'album', page.totalSize, page.offset));
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
  const trackListing = async (
    reply: RouteReply,
    json = false,
    firstCharacter?: string,
    genre?: string,
    mood?: string,
    studio?: string
  ) => {
    try {
      const songs = await music.songs();
      const bucket = genre
        ? findTagBucket(await genreIndex(), genre)
        : mood
          ? findTagBucket(await moodIndex(), mood)
          : studio
            ? findTagBucket(await studioIndex(), studio)
            : undefined;
      const filtered = playCountFilter(
        songs.filter(
          (song) =>
            ((!genre && !mood && !studio) || bucket?.songIds.has(song.id)) &&
            (!firstCharacter || song.title.trim().toLocaleUpperCase().startsWith(firstCharacter.toLocaleUpperCase()))
        ),
        (reply.request as RouteRequest).query,
        (song) => song.year,
        (song) => song.playCount,
        (song) => song.lastPlayedAt
      );
      const page = libraryPage(
        sortByTitle(
          filtered.map((song) => songItem(song)),
          (reply.request as RouteRequest).query,
          (item) => item.title
        ),
        (reply.request as RouteRequest).query,
        (reply.request as RouteRequest).headers
      );
      return json
        ? reply.type('application/json').send(libraryItemsJson(page.items, 'track', page.totalSize, page.offset))
        : reply.type(xml('').type).send(libraryItems(page.items, 'track', page.totalSize, page.offset));
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
    try {
      const buckets = await genreIndex();
      const type = String(request.query.type ?? '10');
      const genres = [...buckets.values()].map((bucket) => ({
        name: bucket.name,
        key: bucket.key,
        songCount: bucket.songIds.size,
        albumCount: type === '8' ? bucket.artistIds.size : bucket.albumIds.size
      }));
      const requestedSize = Number(request.headers['x-plex-container-size'] ?? 500);
      const requestedOffset = Number(request.headers['x-plex-container-start'] ?? 0);
      const pageSize = Number.isInteger(requestedSize) && requestedSize > 0 ? Math.min(requestedSize, 500) : 500;
      const offset = Number.isInteger(requestedOffset) && requestedOffset > 0 ? requestedOffset : 0;
      const page = genres.slice(offset, offset + pageSize);
      console.debug(
        JSON.stringify({
          event: 'genre_directory',
          type,
          genreCount: page.length,
          totalGenreCount: genres.length,
          populatedCount: genres.filter((genre) => genre.albumCount > 0).length,
          firstGenre: genres[0]?.name ?? ''
        })
      );
      return request.headers.accept?.includes('application/json')
        ? reply.type('application/json').send(genresJson(page, type, genres.length, offset))
        : reply.type(xml('').type).send(genresXml(page, type, genres.length, offset));
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
  app.get('/library/sections/:id/mood', async (request, reply) => {
    if (request.params.id !== '1') return reply.code(404).send('Unknown library section\n');
    try {
      const type = String(request.query.type ?? '9');
      const buckets = await moodIndex();
      const moods = [...buckets.values()].map((bucket) => ({
        name: bucket.name,
        key: bucket.key,
        songCount: bucket.songIds.size,
        albumCount: bucket.albumIds.size
      }));
      const requestedSize = Number(request.headers['x-plex-container-size'] ?? 500);
      const requestedOffset = Number(request.headers['x-plex-container-start'] ?? 0);
      const pageSize = Number.isInteger(requestedSize) && requestedSize > 0 ? Math.min(requestedSize, 500) : 500;
      const offset = Number.isInteger(requestedOffset) && requestedOffset > 0 ? requestedOffset : 0;
      const page = moods.slice(offset, offset + pageSize);
      return request.headers.accept?.includes('application/json')
        ? reply.type('application/json').send(genresJson(page, type, moods.length, offset, 'mood'))
        : reply.type(xml('').type).send(genresXml(page, type, moods.length, offset, 'mood'));
    } catch (error) {
      console.warn(
        JSON.stringify({
          event: 'music_failed',
          operation: 'moods',
          error: error instanceof Error ? error.message : 'unknown error'
        })
      );
      return reply.code(503).send('Navidrome is unavailable\n');
    }
  });
  app.get('/library/sections/:id/studio', async (request, reply) => {
    if (request.params.id !== '1') return reply.code(404).send('Unknown library section\n');
    try {
      const type = String(request.query.type ?? '9');
      const buckets = await studioIndex();
      const studios = [...buckets.values()].map((bucket) => ({
        name: bucket.name,
        key: bucket.key,
        songCount: bucket.songIds.size,
        albumCount: bucket.albumIds.size
      }));
      const requestedSize = Number(request.headers['x-plex-container-size'] ?? 500);
      const requestedOffset = Number(request.headers['x-plex-container-start'] ?? 0);
      const pageSize = Number.isInteger(requestedSize) && requestedSize > 0 ? Math.min(requestedSize, 500) : 500;
      const offset = Number.isInteger(requestedOffset) && requestedOffset > 0 ? requestedOffset : 0;
      const page = studios.slice(offset, offset + pageSize);
      return request.headers.accept?.includes('application/json')
        ? reply.type('application/json').send(genresJson(page, type, studios.length, offset, 'studio'))
        : reply.type(xml('').type).send(genresXml(page, type, studios.length, offset, 'studio'));
    } catch (error) {
      console.warn(
        JSON.stringify({
          event: 'music_failed',
          operation: 'record_labels',
          error: error instanceof Error ? error.message : 'unknown error'
        })
      );
      return reply.code(503).send('Navidrome is unavailable\n');
    }
  });
  for (const [filter, title] of [
    ['style', 'By Style'],
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
      const type = String(request.query.type ?? '8');
      const genre = genreQuery(request.query);
      const mood = moodQuery(request.query);
      const studio = studioQuery(request.query);
      const bucket = genre
        ? findTagBucket(await genreIndex(), genre)
        : mood
          ? findTagBucket(await moodIndex(), mood)
          : studio
            ? findTagBucket(await studioIndex(), studio)
            : undefined;
      const names =
        type === '9'
          ? (await music.albums())
              .filter((album) => (!genre && !mood && !studio) || bucket?.albumIds.has(album.id))
              .map((album) => album.name)
          : type === '10'
            ? (await music.songs())
                .filter((song) => (!genre && !mood && !studio) || bucket?.songIds.has(song.id))
                .map((song) => song.title)
            : (await music.artists())
                .filter((artist) => (!genre && !mood && !studio) || bucket?.artistIds.has(artist.id))
                .map((artist) => artist.name);
      const counts = new Map<string, number>();
      for (const name of names) {
        const character = name.trim().charAt(0).toLocaleUpperCase() || '#';
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
    const json = request.headers.accept?.includes('application/json');
    const character = decodeURIComponent(request.params.character);
    const type = String(request.query.type ?? '8');
    const genre = genreQuery(request.query);
    const mood = moodQuery(request.query);
    const studio = studioQuery(request.query);
    if (type === '9') return albumListing(reply, json, character, genre, mood, studio);
    if (type === '10') return trackListing(reply, json, character, genre, mood, studio);
    return artistListing(reply, json, character, genre, mood, studio);
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
        const playlistId = decodeURIComponent(query.playlistID);
        const trackIds = playlistId
          .split(',')
          .map((value) => value.trim())
          .filter((value) => value.startsWith('s-'))
          .map((value) => value.slice(2))
          .filter(Boolean);
        if (trackIds.length > 0 && trackIds.length === playlistId.split(',').length) {
          const items = (await Promise.all(trackIds.map((id) => music.song(id)))).map((song) => songItem(song));
          if (!items.length) return reply.code(404).send('Track queue is empty\n');
          if (query.shuffle === '1') items.sort(() => Math.random() - 0.5);
          const queueId = nextQueueId();
          const sourceUri = query.uri ?? `library://plexbridge-music/tracks/${playlistId}`;
          const response = playlistQueueJson(items, queueId, sourceUri, playlistId, 'Sonic Adventure', false);
          playQueues.set(queueId, { item: items[0], sourceUri, response });
          await savePlayQueues();
          console.debug(
            JSON.stringify({ event: 'sonic_adventure_queue_response', queueId, trackIds, trackCount: items.length })
          );
          return reply.type('application/json').send(response);
        }
        await loadPlaylistIds();
        const result = await music.playlist(playlistIds.get(playlistId) ?? playlistId);
        const items = result.songs.map((song) => songItem(song));
        if (!items.length) return reply.code(404).send('Playlist is empty\n');
        if (query.shuffle === '1') items.sort(() => Math.random() - 0.5);
        const queueId = nextQueueId();
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
        await savePlayQueues();
        return reply.type('application/json').send(response);
      } catch {
        return reply.code(503).send('Navidrome playlist unavailable\n');
      }
    }
    if (query.uri && artistMixIds(query.uri).length > 0) {
      try {
        const mix = await artistMixQueue(query.uri);
        if (mix) {
          playQueues.set(mix.queueId, { item: mix.items[0], sourceUri: mix.sourceUri, response: mix.response });
          await savePlayQueues();
          console.debug(
            JSON.stringify({
              event: 'artist_mix_queue_response',
              queueId: mix.queueId,
              artistIds: artistMixIds(query.uri),
              relatedArtistIds: mix.relatedArtistIds,
              trackCount: mix.items.length,
              sourceUri: mix.sourceUri
            })
          );
          return reply.type('application/json').send(mix.response);
        }
      } catch (error) {
        console.warn(
          JSON.stringify({
            event: 'music_failed',
            operation: 'artist_mix_queue',
            error: error instanceof Error ? error.message : 'unknown error'
          })
        );
        return reply.code(503).send('Navidrome is unavailable\n');
      }
    }
    if (query.uri && albumMixIds(query.uri).length > 0) {
      try {
        const mix = await albumMixQueue(query.uri);
        if (mix) {
          playQueues.set(mix.queueId, { item: mix.items[0], sourceUri: mix.sourceUri, response: mix.response });
          await savePlayQueues();
          console.debug(
            JSON.stringify({
              event: 'album_mix_queue_response',
              queueId: mix.queueId,
              albumIds: albumMixIds(query.uri),
              trackCount: mix.items.length,
              sourceUri: mix.sourceUri
            })
          );
          return reply.type('application/json').send(mix.response);
        }
      } catch (error) {
        console.warn(
          JSON.stringify({
            event: 'music_failed',
            operation: 'album_mix_queue',
            error: error instanceof Error ? error.message : 'unknown error'
          })
        );
        return reply.code(503).send('Navidrome is unavailable\n');
      }
    }
    const keyValue = query.key ?? query.uri ?? '';
    const match = /(?:^|\/)library\/metadata\/(s-[^/?#]+)/.exec(keyValue);
    if (!match) return reply.code(400).send('A track key is required\n');
    const parsed = parseKey(match[1]);
    if (parsed?.kind !== 's') return reply.code(400).send('A track key is required\n');
    try {
      const queueId = nextQueueId();
      const item = songItem(await music.song(parsed.id));
      const sourceUri = query.uri?.startsWith('library://')
        ? query.uri
        : `library://plexbridge-music/item/${item.key.replace(/^\/+/, '')}`;
      playQueues.set(queueId, { item, sourceUri });
      await savePlayQueues();
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
    if (!queue) {
      const sourceUri = clearedPlayQueues.get(request.params.id);
      if (sourceUri) return reply.type('application/json').send(emptyPlayQueueJson(request.params.id, sourceUri));
      return reply.code(404).send('Unknown play queue\n');
    }
    return reply
      .type('application/json')
      .send(queue.response ?? playQueueJson(queue.item, request.params.id, queue.sourceUri));
  });
  app.delete('/playQueues/:id/items', async (request, reply) => {
    const queue = playQueues.get(request.params.id);
    const sourceUri = queue?.sourceUri ?? `library://plexbridge-music/queue/${request.params.id}`;
    const clearedResponse = emptyPlayQueueJson(request.params.id, sourceUri);
    clearedPlayQueues.set(request.params.id, sourceUri);
    if (queue) {
      playQueues.delete(request.params.id);
      await savePlayQueues();
    }
    console.debug(JSON.stringify({ event: 'play_queue_cleared', queueId: request.params.id }));
    return reply.type('application/json').send(clearedResponse);
  });
  app.get('/library/sections/:id/all', async (request, reply) => {
    if (request.params.id !== '1') return reply.code(404).send('Unknown library section\n');
    const type = String(request.query.type ?? '8');
    const json = request.headers.accept?.includes('application/json');
    const genre = genreQuery(request.query);
    const mood = moodQuery(request.query);
    const studio = studioQuery(request.query);
    if (type === '8') return artistListing(reply, json, undefined, genre, mood, studio);
    if (type === '9') return albumListing(reply, json, undefined, genre, mood, studio);
    if (type === '10') return trackListing(reply, json, undefined, genre, mood, studio);
    if (type === '15')
      return json
        ? reply.type('application/json').send(emptyPlaylistSectionJson())
        : reply.code(406).send('JSON required\n');
    return reply.code(400).send('Unsupported library type\n');
  });
  app.get('/library/all/top', async (request, reply) => {
    const type = String(request.query.type ?? '');
    const clientId = plexClientId(request);
    if (clientId && (type === '8' || type === '9')) {
      builderContexts.set(clientId, {
        type: type === '8' ? 'artist' : 'album',
        expiresAt: now() + BUILDER_CONTEXT_TTL_MS
      });
    }
    const json = request.headers.accept?.includes('application/json');
    if (type === '8') return artistListing(reply, json);
    if (type === '9') return albumListing(reply, json);
    return reply.code(400).send('Unsupported library type\n');
  });
  app.get('/library/sections/:id/computePath', async (request, reply) => {
    if (request.params.id !== '1') return reply.code(404).send('Unknown library section\n');
    const parseTrackId = (value?: string) => {
      const parsed = value ? parseKey(value) : undefined;
      return parsed?.kind === 's' ? parsed.id : undefined;
    };
    const startId = parseTrackId(request.query.startID);
    const endId = parseTrackId(request.query.endID);
    if (!startId || !endId) return reply.code(400).send('Track startID and endID are required\n');
    try {
      const path = music.findSonicPath ? await music.findSonicPath(startId, endId) : [];
      if (path.length) {
        console.debug(JSON.stringify({ event: 'sonic_path_response', startId, endId, trackCount: path.length }));
        return reply.type('application/json').send(
          libraryItemsJson(
            path.map((song) => songItem(song)),
            'track',
            path.length,
            0
          )
        );
      }
    } catch (error) {
      console.debug(
        JSON.stringify({
          event: 'sonic_path_unavailable',
          startId,
          endId,
          error: error instanceof Error ? error.message : 'Navidrome sonic similarity unavailable'
        })
      );
    }
    return reply.type('application/json').send(libraryItemsJson([], 'track', 0, 0));
  });
  app.get('/hubs/search', async (request, reply) => {
    const query = String(request.query.query ?? '')
      .trim()
      .toLocaleLowerCase();
    if (!query) return reply.type('application/json').send(searchJson([]));
    try {
      const limitValue = Number(request.query.limit ?? 11);
      const limit = Number.isInteger(limitValue) && limitValue > 0 ? Math.min(limitValue, 50) : 11;
      const artists = await music.artists();
      const matches = <T extends { name?: string; title?: string }>(items: T[]) =>
        items.filter((item) => (item.name ?? item.title ?? '').toLocaleLowerCase().includes(query)).slice(0, limit);
      const matchingArtists = matches(artists);
      const context = builderContext(request);
      const sonicAdventureSearch =
        !context &&
        (request.query.type === '10' ||
          (request.query.includeCollections === '1' && request.query.contentDirectoryID === '1'));
      const matchingTracks = sonicAdventureSearch ? matches(await music.songs()) : [];
      const matchingAlbums = context === 'artist' ? [] : matches(await music.albums());
      const hubs = sonicAdventureSearch
        ? matchingTracks.length
          ? [{ title: 'Tracks', type: 'track', items: matchingTracks.map((song) => songItem(song)) }]
          : []
        : context === 'artist'
          ? matchingArtists.length
            ? [{ title: 'Artists', type: 'artist', items: matchingArtists.map(artistItem) }]
            : []
          : context === 'album'
            ? matchingAlbums.length
              ? [{ title: 'Albums', type: 'album', items: matchingAlbums.map((album) => albumItem(album)) }]
              : []
            : matchingArtists.length
              ? [{ title: 'Artists', type: 'artist', items: matchingArtists.map(artistItem) }]
              : matchingAlbums.length
                ? [{ title: 'Albums', type: 'album', items: matchingAlbums.map((album) => albumItem(album)) }]
                : [];
      console.debug(
        JSON.stringify({
          event: 'search_results',
          query,
          artistCount: matchingArtists.length,
          albumCount: matchingAlbums.length,
          trackCount: matchingTracks.length,
          sonicAdventureSearch,
          builderContext: context ?? 'unknown',
          artists: matchingArtists.map((artist) => artist.name),
          returnedHub: hubs[0]?.type ?? 'none'
        })
      );
      return reply.type('application/json').send(searchJson(hubs, query));
    } catch (error) {
      console.warn(
        JSON.stringify({
          event: 'music_failed',
          operation: 'search',
          error: error instanceof Error ? error.message : 'unknown error'
        })
      );
      return reply.code(503).send('Navidrome is unavailable\n');
    }
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
        const page = libraryPage(
          (await music.artist(parsed.id)).albums.map((album) => albumItem(album)),
          request.query
        );
        return json
          ? reply.type('application/json').send(libraryItemsJson(page.items, 'album', page.totalSize, page.offset))
          : reply.type(xml('').type).send(libraryItems(page.items, 'album', page.totalSize, page.offset));
      }
      if (parsed.kind === 'l') {
        const result = await music.album(parsed.id);
        const page = libraryPage(
          result.songs.map((song) => songItem(song, result.album)),
          request.query
        );
        return json
          ? reply.type('application/json').send(libraryItemsJson(page.items, 'track', page.totalSize, page.offset))
          : reply.type(xml('').type).send(libraryItems(page.items, 'track', page.totalSize, page.offset));
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
  const relatedArtists = async (request: RouteRequest, reply: RouteReply) => {
    const parsed = parseKey(request.params.id);
    if (parsed?.kind === 'l') {
      return request.headers.accept?.includes('application/json')
        ? reply.type('application/json').send(libraryItemsJson([], 'album', 0, 0))
        : reply.type(xml('').type).send(libraryItems([], 'album', 0, 0));
    }
    if (parsed?.kind !== 'a') return reply.code(404).send('Unknown artist\n');
    try {
      const artists = await music.artists();
      const limitValue = Number(request.query.limit ?? 12);
      const limit = Number.isInteger(limitValue) && limitValue > 0 ? Math.min(limitValue, 50) : 12;
      const providerIds = await providerRelatedArtistIds(artists, [parsed.id]);
      const ids = providerIds.slice(0, limit);
      const items = ids
        .map((id) => artists.find((artist) => artist.id === id))
        .filter((artist): artist is (typeof artists)[number] => artist !== undefined)
        .map(artistItem);
      return request.headers.accept?.includes('application/json')
        ? reply.type('application/json').send(libraryItemsJson(items, 'artist', items.length, 0))
        : reply.type(xml('').type).send(libraryItems(items, 'artist', items.length, 0));
    } catch (error) {
      console.warn(
        JSON.stringify({
          event: 'music_failed',
          operation: 'related_artists',
          error: error instanceof Error ? error.message : 'unknown error'
        })
      );
      return reply.code(503).send('Navidrome is unavailable\n');
    }
  };
  app.get('/library/metadata/:id/nearest', relatedArtists);
  app.get('/library/metadata/:id/similar', relatedArtists);
  app.get('/library/metadata/:id', async (request, reply) => {
    const json = request.headers.accept?.includes('application/json');
    const combinedArtists = request.params.id
      .split(',')
      .map((value) => parseKey(value))
      .filter((value): value is { kind: 'a'; id: string } => value?.kind === 'a');
    if (combinedArtists.length > 1 && combinedArtists.length === request.params.id.split(',').length) {
      try {
        const items = (await Promise.all(combinedArtists.map((artist) => music.artist(artist.id)))).map((result) =>
          artistItem(result.artist)
        );
        return json
          ? reply.type('application/json').send(libraryItemsJson(items, 'artist'))
          : reply.type(xml('').type).send(libraryItems(items, 'artist'));
      } catch (error) {
        console.warn(
          JSON.stringify({
            event: 'music_failed',
            operation: 'combined_artist_metadata',
            error: error instanceof Error ? error.message : 'unknown error'
          })
        );
        return reply.code(503).send('Navidrome is unavailable\n');
      }
    }
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
      console.debug(
        JSON.stringify({
          event: 'navidrome_stream_response',
          trackId: parsed.id,
          endpoint: 'library_stream',
          requestRange: range ?? '',
          status: response.status,
          contentType: response.headers.get('content-type') ?? '',
          contentLength: response.headers.get('content-length') ?? '',
          contentRange: response.headers.get('content-range') ?? '',
          acceptRanges: response.headers.get('accept-ranges') ?? '',
          hasBody: Boolean(response.body)
        })
      );
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
    } catch (error) {
      console.warn(
        JSON.stringify({
          event: 'navidrome_stream_failed',
          trackId: parsed.id,
          endpoint: 'library_stream',
          requestRange: request.headers.range ?? '',
          error: error instanceof Error ? error.message : 'unknown error'
        })
      );
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
      const sourceDirectPlayable = preserveSourceFormats && directPlayableFormats.has(sourceFormat);
      const directPlayable = directPlayRequested && sourceDirectPlayable;
      const target = directPlayable
        ? { format: sourceFormat, container: sourceFormat, audioCodec: sourceFormat }
        : transcodeTarget(request);
      console.debug(
        JSON.stringify({
          event: 'audio_decision',
          sourceFormat,
          directPlayRequested,
          directPlayable,
          directPlayOverridden: sourceDirectPlayable && !directPlayRequested,
          preserveSourceFormats,
          musicBitrate: request.query.musicBitrate ?? '',
          outputFormat: target.format,
          outputContainer: target.container,
          outputAudioCodec: target.audioCodec,
          clientProfile:
            request.query['X-Plex-Client-Profile-Extra'] ?? request.headers['x-plex-client-profile-extra'] ?? ''
        })
      );
      const metadata = JSON.parse(libraryItemsJson([item], 'track')).MediaContainer.Metadata[0] as Record<
        string,
        unknown
      >;
      if (Array.isArray(metadata.Media)) {
        const media = metadata.Media[0] as Record<string, unknown>;
        media.container = target.container;
        media.audioCodec = directPlayable ? media.audioCodec : target.audioCodec;
        const part = Array.isArray(media.Part) ? (media.Part[0] as Record<string, unknown>) : undefined;
        if (part) {
          part.container = target.container;
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
      const sourceDirectPlayable = preserveSourceFormats && directPlayableFormats.has(sourceFormat);
      const canDirectPlay = directPlay && sourceDirectPlayable;
      const target = canDirectPlay
        ? { format: sourceFormat, container: sourceFormat, audioCodec: sourceFormat }
        : transcodeTarget(request);
      console.debug(
        JSON.stringify({
          event: 'audio_stream',
          sourceFormat,
          directPlayRequested: directPlay,
          directPlayOverridden: sourceDirectPlayable && !directPlay,
          canDirectPlay,
          preserveSourceFormats,
          outputFormat: target.format,
          outputContainer: target.container,
          outputAudioCodec: target.audioCodec,
          musicBitrate: query.musicBitrate ?? '',
          range: request.headers.range ?? '',
          clientProfile:
            request.query['X-Plex-Client-Profile-Extra'] ?? request.headers['x-plex-client-profile-extra'] ?? ''
        })
      );
      const streamUrl = await music.streamUrl(parsed.id, canDirectPlay ? {} : { format: target.format, maxBitRate });
      const range = request.headers.range;
      const response = await fetch(streamUrl, range ? { headers: { range } } : undefined);
      console.debug(
        JSON.stringify({
          event: 'navidrome_stream_response',
          trackId: parsed.id,
          endpoint: 'universal_start',
          requestRange: range ?? '',
          status: response.status,
          contentType: response.headers.get('content-type') ?? '',
          contentLength: response.headers.get('content-length') ?? '',
          contentRange: response.headers.get('content-range') ?? '',
          acceptRanges: response.headers.get('accept-ranges') ?? '',
          hasBody: Boolean(response.body)
        })
      );
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
    } catch (error) {
      console.warn(
        JSON.stringify({
          event: 'navidrome_stream_failed',
          trackId: parsed.id,
          endpoint: 'universal_start',
          requestRange: request.headers.range ?? '',
          error: error instanceof Error ? error.message : 'unknown error'
        })
      );
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
  return {
    invalidateLibraryCaches: () => {
      genreIndexCache = undefined;
      moodIndexCache = undefined;
      genreIdsCache = undefined;
      moodIdsCache = undefined;
    }
  };
}
