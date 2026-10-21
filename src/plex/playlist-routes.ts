import type { FastifyInstance } from 'fastify';
import { Readable } from 'node:stream';
import type { MusicProvider } from '../music/types.js';
import { libraryItemsJson, playlistsJson } from './protocol.js';
import { songItem } from './metadata.js';

export interface PlaylistRouteDependencies {
  music: MusicProvider;
  playlistIds: Map<string, string>;
  loadPlaylistIds: () => Promise<void>;
  savePlaylistIds: () => Promise<void>;
}

export function registerPlaylistRoutes(app: FastifyInstance, { music, playlistIds, loadPlaylistIds, savePlaylistIds }: PlaylistRouteDependencies): void {
const playlistsResponse = async (request: any, reply: any) => {
  if (!request.headers.accept?.includes('application/json')) return reply.code(406).send('JSON required\n');
  try {
    await loadPlaylistIds();
    const playlists = await music.playlists();
    const usedKeys = new Set([...playlistIds.keys()].filter((key) => /^\d{1,6}$/.test(key)));
    let nextPlaylistKey = 10000;
    const plexPlaylists = [
      { id: 'builtin-2', ratingKey: '2', guid: 'f147d4ee-5177-4e56-b290-b527f7a75d2b', name: '❤️ Tracks', comment: 'All your highly rated tracks, in one convenient place.', songCount: 0, duration: 0, smart: true, icon: 'playlist://image.smart' },
      { id: 'builtin-1', ratingKey: '1', guid: 'b53ec259-9a4f-43fe-a393-19d94ad4e9d4', name: 'All Music', comment: 'The easiest way to play or shuffle your entire collection.', songCount: 0, duration: 0, smart: true, icon: 'playlist://image.smart' },
      { id: 'builtin-5', ratingKey: '5', guid: 'ca04a18f-1107-4a3d-bc96-1487c9257e29', name: 'Fresh ❤️', comment: "Tracks you love but haven't heard lately.", songCount: 0, duration: 0, smart: true, icon: 'playlist://image.smart' },
      { id: 'builtin-3', ratingKey: '3', guid: 'e9bc9986-03b4-4b70-a858-4066c23ba3e1', name: 'Recently Added', comment: 'Music added to your library recently.', songCount: 0, duration: 0, smart: true, icon: 'playlist://image.smart' },
      { id: 'builtin-4', ratingKey: '4', guid: '3ff4893e-b10b-4853-a80e-347c948c1a75', name: 'Recently Played', comment: "Tracks you've listened to lately.", songCount: 0, duration: 0, smart: true, icon: 'playlist://image.smart' },
      ...playlists.map((playlist) => {
      const existingKey = [...playlistIds.entries()].find(([key, id]) => id === playlist.id && /^\d{1,6}$/.test(key))?.[0];
      while (!existingKey && usedKeys.has(String(nextPlaylistKey))) nextPlaylistKey += 1;
      const ratingKey = existingKey ?? String(nextPlaylistKey++);
      usedKeys.add(ratingKey);
      playlistIds.set(ratingKey, playlist.id);
      return { ...playlist, ratingKey };
      }),
    ];
    await savePlaylistIds();
    console.debug(JSON.stringify({ event: 'playlist_response', count: plexPlaylists.length }));
    return reply.type('application/json').send(playlistsJson(plexPlaylists));
  } catch (error) {
    console.warn(JSON.stringify({ event: 'music_failed', operation: 'playlists', error: error instanceof Error ? error.message : 'unknown error' }));
    return reply.type('application/json').send(playlistsJson());
  }
};
app.get('/playlists', playlistsResponse);
app.get('/playlists/all', playlistsResponse);
app.get('/playlists/:id', async (request: any, reply: any) => {
  if (!request.headers.accept?.includes('application/json')) return reply.code(406).send('JSON required\n');
  try {
    await loadPlaylistIds();
    const requestedId = decodeURIComponent(request.params.id);
    const result = await music.playlist(playlistIds.get(requestedId) ?? requestedId);
    return reply.type('application/json').send(playlistsJson([{ id: requestedId, ratingKey: requestedId, name: result.playlist.name, comment: result.playlist.comment, songCount: result.playlist.songCount, duration: result.playlist.duration, smart: false }]));
  } catch { return reply.type('application/json').send(JSON.stringify({ MediaContainer: { size: 0, totalSize: 0, offset: 0, Metadata: [] } })); }
});
app.get('/playlists/:id/composite/:timestamp', async (request: any, reply: any) => {
  try {
    await loadPlaylistIds();
    const requestedId = decodeURIComponent(request.params.id);
    const musicId = playlistIds.get(requestedId) ?? requestedId;
    const result = await music.playlist(musicId);
    const firstSong = result.songs.find((song) => song.coverArt);
    if (!firstSong) return reply.code(404).send('Playlist artwork unavailable\n');
    const response = await fetch(await music.coverArtUrl(firstSong.id));
    if (!response.ok || !response.body) return reply.code(404).send('Playlist artwork unavailable\n');
    reply.header('content-type', response.headers.get('content-type') ?? 'image/jpeg');
    if (response.headers.get('content-length')) reply.header('content-length', response.headers.get('content-length')!);
    return reply.send(Readable.fromWeb(response.body as any));
  } catch {
    return reply.code(404).send('Playlist artwork unavailable\n');
  }
});
app.get('/playlists/:id/items', async (request: any, reply: any) => {
  if (!request.headers.accept?.includes('application/json')) return reply.code(406).send('JSON required\n');
  try { await loadPlaylistIds(); const requestedId = decodeURIComponent(request.params.id); const musicId = playlistIds.get(requestedId) ?? requestedId; const result = await music.playlist(musicId); const body = JSON.parse(libraryItemsJson(result.songs.map((song) => songItem(song)), 'track')); const now = Math.floor(Date.now() / 1000); const metadata = body.MediaContainer.Metadata.map((item: Record<string, unknown>, index: number) => ({ ...item, playlistItemID: index + 1, addedAt: now, updatedAt: now })); return reply.type('application/json').send(JSON.stringify({ MediaContainer: { size: result.songs.length, totalSize: result.songs.length, offset: 0, composite: `/playlists/${encodeURIComponent(requestedId)}/composite/${now}`, duration: result.playlist.duration * 1000, leafCount: result.playlist.songCount, playlistType: 'audio', ratingKey: requestedId, smart: false, title: result.playlist.name, Metadata: metadata } })); } catch { return reply.type('application/json').send(JSON.stringify({ MediaContainer: { size: 0, totalSize: 0, offset: 0, composite: `/playlists/${encodeURIComponent(request.params.id)}/composite/${Math.floor(Date.now() / 1000)}`, duration: 0, leafCount: 0, playlistType: 'audio', ratingKey: request.params.id, smart: false, title: '', Metadata: [] } })); }
});
app.put('/playlists/:id/items', async (request: any, reply: any) => {
  if (!request.headers.accept?.includes('application/json')) return reply.code(406).send('JSON required\n');
  try {
    await loadPlaylistIds();
    const requestedId = decodeURIComponent(request.params.id);
    const uri = String((request.query as { uri?: string }).uri ?? '');
    const ids = [...uri.matchAll(/(?:^|\/)library\/metadata\/s-([^/?#]+)/g)].map((match) => decodeURIComponent(match[1]));
    if (!ids.length) return reply.code(400).send('A track URI is required\n');
    const musicId = playlistIds.get(requestedId) ?? requestedId;
    const before = await music.playlist(musicId);
    console.debug(JSON.stringify({ event: 'playlist_update', plexPlaylistId: requestedId, musicPlaylistId: musicId, uri: uri.replace(/X-Plex-Token=[^&]*/gi, 'X-Plex-Token=[REDACTED]'), trackIds: ids, beforeCount: before.songs.length }));
    await music.addToPlaylist(musicId, ids);
    const result = await music.playlist(musicId);
    const present = ids.every((id) => result.songs.some((song) => song.id === id));
    console.debug(JSON.stringify({ event: 'playlist_update_result', plexPlaylistId: requestedId, musicPlaylistId: musicId, afterCount: result.songs.length, requestedTracksPresent: present }));
    if (!present) return reply.code(502).send('Navidrome did not add the requested track\n');
    const now = Math.floor(Date.now() / 1000);
    return reply.type('application/json').send(JSON.stringify({ MediaContainer: { size: 1, totalSize: 1, offset: 0, Metadata: [{ ratingKey: requestedId, key: `/playlists/${requestedId}/items`, type: 'playlist', title: result.playlist.name, playlistType: 'audio', updatedAt: now }] } }));
  } catch (error) { console.warn(JSON.stringify({ event: 'playlist_update_failed', error: error instanceof Error ? error.message : 'unknown error' })); return reply.code(502).send('Unable to update playlist\n'); }
});
}

