import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ReadableStream } from 'node:stream/web';
import { Readable } from 'node:stream';
import type { MusicProvider } from '../music/types.js';
import { libraryItemsJson, playlistsJson, type PlexItem } from './protocol.js';
import { songItem } from './metadata.js';

const MAX_LIBRARY_PAGE_SIZE = 500;

function playlistPage<T>(items: T[], query: Record<string, string | undefined>) {
  const parsedOffset = Number(query.offset ?? 0);
  const parsedSize = Number(query.size ?? MAX_LIBRARY_PAGE_SIZE);
  const offset = Number.isInteger(parsedOffset) && parsedOffset > 0 ? parsedOffset : 0;
  const size =
    Number.isInteger(parsedSize) && parsedSize > 0
      ? Math.min(parsedSize, MAX_LIBRARY_PAGE_SIZE)
      : MAX_LIBRARY_PAGE_SIZE;
  return { items: items.slice(offset, offset + size), totalSize: items.length, offset };
}

export interface PlaylistRouteDependencies {
  music: MusicProvider;
  playQueues: Map<string, { item: PlexItem; sourceUri: string; response?: string }>;
  playlistIds: Map<string, string>;
  loadPlaylistIds: () => Promise<void>;
  savePlaylistIds: () => Promise<void>;
}

type RouteRequest = FastifyRequest<{
  Querystring: Record<string, string | undefined>;
  Params: Record<string, string>;
}>;
type RouteReply = FastifyReply;
interface RouteApp {
  get(path: string, handler: (request: RouteRequest, reply: RouteReply) => unknown): unknown;
  put(path: string, handler: (request: RouteRequest, reply: RouteReply) => unknown): unknown;
}

export function registerPlaylistRoutes(
  app: RouteApp,
  { music, playQueues, playlistIds, loadPlaylistIds, savePlaylistIds }: PlaylistRouteDependencies
): void {
  const playlistsResponse = async (request: RouteRequest, reply: RouteReply) => {
    if (!request.headers.accept?.includes('application/json')) return reply.code(406).send('JSON required\n');
    try {
      await loadPlaylistIds();
      const playlists = await music.playlists();
      const usedKeys = new Set([...playlistIds.keys()].filter((key) => /^\d{1,6}$/.test(key)));
      let nextPlaylistKey = 10000;
      const plexPlaylists = playlists.map((playlist) => {
        const existingKey = [...playlistIds.entries()].find(
          ([key, id]) => id === playlist.id && /^\d{1,6}$/.test(key)
        )?.[0];
        while (!existingKey && usedKeys.has(String(nextPlaylistKey))) nextPlaylistKey += 1;
        const ratingKey = existingKey ?? String(nextPlaylistKey++);
        usedKeys.add(ratingKey);
        playlistIds.set(ratingKey, playlist.id);
        return { ...playlist, ratingKey };
      });
      const page = playlistPage(plexPlaylists, request.query);
      await savePlaylistIds();
      console.debug(JSON.stringify({ event: 'playlist_response', count: plexPlaylists.length }));
      return reply.type('application/json').send(playlistsJson(page.items, page.totalSize, page.offset));
    } catch (error) {
      console.warn(
        JSON.stringify({
          event: 'music_failed',
          operation: 'playlists',
          error: error instanceof Error ? error.message : 'unknown error'
        })
      );
      return reply.type('application/json').send(playlistsJson());
    }
  };
  app.get('/playlists', playlistsResponse);
  app.get('/playlists/all', playlistsResponse);
  app.get('/playlists/:id', async (request: RouteRequest, reply: RouteReply) => {
    if (!request.headers.accept?.includes('application/json')) return reply.code(406).send('JSON required\n');
    try {
      await loadPlaylistIds();
      const requestedId = decodeURIComponent(request.params.id);
      const result = await music.playlist(playlistIds.get(requestedId) ?? requestedId);
      return reply.type('application/json').send(
        playlistsJson([
          {
            id: requestedId,
            ratingKey: requestedId,
            name: result.playlist.name,
            comment: result.playlist.comment,
            songCount: result.playlist.songCount,
            duration: result.playlist.duration,
            smart: false
          }
        ])
      );
    } catch {
      return reply
        .type('application/json')
        .send(JSON.stringify({ MediaContainer: { size: 0, totalSize: 0, offset: 0, Metadata: [] } }));
    }
  });
  app.get('/playlists/:id/composite/:timestamp', async (request: RouteRequest, reply: RouteReply) => {
    try {
      await loadPlaylistIds();
      const requestedId = decodeURIComponent(request.params.id);
      const musicId = playlistIds.get(requestedId) ?? requestedId;
      const result = await music.playlist(musicId);
      const artworkId = result.playlist.coverArt ?? result.songs.find((song) => song.coverArt)?.id;
      if (!artworkId) return reply.code(404).send('Playlist artwork unavailable\n');
      const response = await fetch(await music.coverArtUrl(artworkId));
      if (!response.ok || !response.body) return reply.code(404).send('Playlist artwork unavailable\n');
      reply.header('content-type', response.headers.get('content-type') ?? 'image/jpeg');
      if (response.headers.get('content-length'))
        reply.header('content-length', response.headers.get('content-length'));
      return reply.send(Readable.fromWeb(response.body as unknown as ReadableStream));
    } catch {
      return reply.code(404).send('Playlist artwork unavailable\n');
    }
  });
  app.get('/playlists/:id/items', async (request: RouteRequest, reply: RouteReply) => {
    if (!request.headers.accept?.includes('application/json')) return reply.code(406).send('JSON required\n');
    try {
      await loadPlaylistIds();
      const requestedId = decodeURIComponent(request.params.id);
      const musicId = playlistIds.get(requestedId) ?? requestedId;
      const result = await music.playlist(musicId);
      const body = JSON.parse(
        libraryItemsJson(
          result.songs.map((song) => songItem(song)),
          'track'
        )
      );
      const now = Math.floor(Date.now() / 1000);
      const metadata = body.MediaContainer.Metadata.map((item: Record<string, unknown>, index: number) => ({
        ...item,
        playlistItemID: index + 1,
        addedAt: now,
        updatedAt: now
      }));
      return reply.type('application/json').send(
        JSON.stringify({
          MediaContainer: {
            size: result.songs.length,
            totalSize: result.songs.length,
            offset: 0,
            composite: `/playlists/${encodeURIComponent(requestedId)}/composite/${now}`,
            duration: result.playlist.duration * 1000,
            leafCount: result.playlist.songCount,
            playlistType: 'audio',
            ratingKey: requestedId,
            smart: false,
            title: result.playlist.name,
            Metadata: metadata
          }
        })
      );
    } catch {
      return reply.type('application/json').send(
        JSON.stringify({
          MediaContainer: {
            size: 0,
            totalSize: 0,
            offset: 0,
            composite: `/playlists/${encodeURIComponent(request.params.id)}/composite/${Math.floor(Date.now() / 1000)}`,
            duration: 0,
            leafCount: 0,
            playlistType: 'audio',
            ratingKey: request.params.id,
            smart: false,
            title: '',
            Metadata: []
          }
        })
      );
    }
  });
  app.put('/playlists/:id/items', async (request: RouteRequest, reply: RouteReply) => {
    if (!request.headers.accept?.includes('application/json')) return reply.code(406).send('JSON required\n');
    try {
      await loadPlaylistIds();
      const requestedId = decodeURIComponent(request.params.id);
      const query = request.query as { uri?: string; playQueueID?: string };
      let uri = String(query.uri ?? '');
      let ids = [...uri.matchAll(/(?:^|\/)library\/metadata\/s-([^/?#]+)/g)].map((match) =>
        decodeURIComponent(match[1])
      );
      if (!ids.length && query.playQueueID) {
        const queue = playQueues.get(query.playQueueID);
        if (queue?.response) {
          const response = JSON.parse(queue.response) as {
            MediaContainer?: { Metadata?: Array<{ ratingKey?: string; key?: string }> };
          };
          const metadata = response.MediaContainer?.Metadata ?? [];
          ids = metadata
            .map((item) => item.ratingKey ?? item.key?.match(/\/library\/metadata\/(s-[^/?#]+)/)?.[1] ?? '')
            .filter((value) => value.startsWith('s-'))
            .map((value) => decodeURIComponent(value.slice(2)));
          uri = `playQueue:${query.playQueueID}`;
        }
      }
      if (!ids.length) return reply.code(400).send('A track URI is required\n');
      const musicId = playlistIds.get(requestedId) ?? requestedId;
      const before = await music.playlist(musicId);
      console.debug(
        JSON.stringify({
          event: 'playlist_update',
          plexPlaylistId: requestedId,
          musicPlaylistId: musicId,
          uri: uri.replace(/X-Plex-Token=[^&]*/gi, 'X-Plex-Token=[REDACTED]'),
          trackIds: ids,
          beforeCount: before.songs.length
        })
      );
      await music.addToPlaylist(musicId, ids);
      const result = await music.playlist(musicId);
      const present = ids.every((id) => result.songs.some((song) => song.id === id));
      console.debug(
        JSON.stringify({
          event: 'playlist_update_result',
          plexPlaylistId: requestedId,
          musicPlaylistId: musicId,
          afterCount: result.songs.length,
          requestedTracksPresent: present
        })
      );
      if (!present) return reply.code(502).send('Navidrome did not add the requested track\n');
      const now = Math.floor(Date.now() / 1000);
      return reply.type('application/json').send(
        JSON.stringify({
          MediaContainer: {
            size: 1,
            totalSize: 1,
            offset: 0,
            Metadata: [
              {
                ratingKey: requestedId,
                key: `/playlists/${requestedId}/items`,
                type: 'playlist',
                title: result.playlist.name,
                playlistType: 'audio',
                composite: `/playlists/${encodeURIComponent(requestedId)}/composite/${now}`,
                duration: result.playlist.duration * 1000,
                leafCount: result.playlist.songCount,
                updatedAt: now
              }
            ]
          }
        })
      );
    } catch (error) {
      console.warn(
        JSON.stringify({
          event: 'playlist_update_failed',
          error: error instanceof Error ? error.message : 'unknown error'
        })
      );
      return reply.code(502).send('Unable to update playlist\n');
    }
  });
}
