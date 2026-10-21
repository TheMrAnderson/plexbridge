import { createHash, randomBytes } from 'node:crypto';
import type { MusicAlbum, MusicArtist, MusicGenre, MusicPlaylist, MusicPlaylistResult, MusicProvider, MusicSong } from '../types.js';

export interface NavidromeSettings {
  url: string;
  username: string;
  password: string;
}

type JsonObject = Record<string, any>;

export class NavidromeClient implements MusicProvider {
  constructor(private readonly settings: NavidromeSettings, private readonly fetchImpl: typeof fetch = fetch) {}

  private async call(method: string, params: Record<string, string | number | string[] | undefined> = {}): Promise<JsonObject> {
    if (!this.settings.url || !this.settings.username || !this.settings.password) throw new Error('Navidrome is not configured');
    const salt = randomBytes(8).toString('hex');
    const token = createHash('md5').update(`${this.settings.password}${salt}`).digest('hex');
    const query = new URLSearchParams({ u: this.settings.username, t: token, s: salt, v: '1.16.1', c: 'PlexBridge', f: 'json' });
    for (const [key, value] of Object.entries(params)) { if (Array.isArray(value)) for (const item of value) query.append(key, item); else if (value !== undefined) query.set(key, String(value)); }
    const response = await this.fetchImpl(`${this.settings.url.replace(/\/$/, '')}/rest/${method}.view?${query}`);
    if (!response.ok) throw new Error(`Navidrome ${method} returned HTTP ${response.status}`);
    const body = await response.json() as JsonObject;
    const result = body['subsonic-response'];
    if (!result || result.status !== 'ok') throw new Error(`Navidrome ${method} returned an error`);
    return result;
  }

  async artists(): Promise<MusicArtist[]> {
    const result = await this.call('getArtists');
    return (result.artists?.index ?? []).flatMap((index: JsonObject) => index.artist ?? []).map((artist: JsonObject) => ({ id: String(artist.id), name: artist.name ?? 'Unknown Artist' }));
  }

  async albums(): Promise<MusicAlbum[]> {
    const result = await this.call('getAlbumList2', { type: 'alphabeticalByName', size: 500 });
    return (result.albumList2?.album ?? []).map((album: JsonObject) => this.normalizeAlbum(album));
  }

  async songs(): Promise<MusicSong[]> {
    const result = await this.call('getRandomSongs', { size: 500 });
    return (result.randomSongs?.song ?? []).map((song: JsonObject) => this.normalizeSong(song));
  }

  async genres(): Promise<MusicGenre[]> {
    const result = await this.call('getGenres');
    return (result.genres?.genre ?? []).map((genre: JsonObject) => ({ name: genre.value ?? 'Unknown Genre', songCount: genre.songCount ? Number(genre.songCount) : undefined, albumCount: genre.albumCount ? Number(genre.albumCount) : undefined }));
  }

  async playlists(): Promise<MusicPlaylist[]> {
    const result = await this.call('getPlaylists');
    return (result.playlists?.playlist ?? []).map((playlist: JsonObject) => ({ id: String(playlist.id), name: playlist.name ?? 'Untitled Playlist', comment: playlist.comment, songCount: Number(playlist.songCount ?? 0), duration: Number(playlist.duration ?? 0) }));
  }

  async playlist(id: string): Promise<MusicPlaylistResult> {
    const result = await this.call('getPlaylist', { id });
    const playlist = result.playlist ?? {};
    return { playlist: { id: String(playlist.id), name: playlist.name ?? 'Untitled Playlist', comment: playlist.comment, songCount: Number(playlist.songCount ?? 0), duration: Number(playlist.duration ?? 0) }, songs: (playlist.entry ?? []).map((song: JsonObject) => this.normalizeSong(song)) };
  }

  async addToPlaylist(id: string, songIds: string[]): Promise<void> {
    await this.call('updatePlaylist', { playlistId: id, songIdToAdd: songIds });
  }

  async artist(id: string): Promise<{ artist: MusicArtist; albums: MusicAlbum[] }> {
    const result = await this.call('getArtist', { id });
    const artist = result.artist ?? {};
    return { artist: { id: String(artist.id), name: artist.name ?? 'Unknown Artist' }, albums: (artist.album ?? []).map((album: JsonObject) => this.normalizeAlbum(album)) };
  }

  async album(id: string): Promise<{ album: MusicAlbum; songs: MusicSong[] }> {
    const result = await this.call('getAlbum', { id });
    const album = result.album ?? {};
    return { album: this.normalizeAlbum(album), songs: (album.song ?? []).map((song: JsonObject) => this.normalizeSong(song)) };
  }

  async song(id: string): Promise<MusicSong> {
    const result = await this.call('getSong', { id });
    return this.normalizeSong(result.song ?? {});
  }

  async scrobble(id: string): Promise<void> {
    await this.call('scrobble', { id, submission: 'true' });
  }

  async streamUrl(id: string, options: { format?: string; maxBitRate?: number } = {}): Promise<string> {
    const salt = randomBytes(8).toString('hex');
    const token = createHash('md5').update(`${this.settings.password}${salt}`).digest('hex');
    const query = new URLSearchParams({ u: this.settings.username, t: token, s: salt, v: '1.16.1', c: 'PlexBridge', id });
    if (options.format) query.set('format', options.format);
    if (options.maxBitRate !== undefined) query.set('maxBitRate', String(options.maxBitRate));
    return `${this.settings.url.replace(/\/$/, '')}/rest/stream.view?${query}`;
  }

  async coverArtUrl(id: string): Promise<string> {
    const salt = randomBytes(8).toString('hex');
    const token = createHash('md5').update(`${this.settings.password}${salt}`).digest('hex');
    const query = new URLSearchParams({ u: this.settings.username, t: token, s: salt, v: '1.16.1', c: 'PlexBridge', id, size: '1200' });
    return `${this.settings.url.replace(/\/$/, '')}/rest/getCoverArt.view?${query}`;
  }

  private normalizeAlbum(value: JsonObject): MusicAlbum { return { id: String(value.id), name: value.name ?? 'Unknown Album', artist: value.artist, artistId: value.artistId ? String(value.artistId) : undefined, year: value.year ? Number(value.year) : undefined, coverArt: value.coverArt }; }
  private normalizeSong(value: JsonObject): MusicSong { return { id: String(value.id), title: value.title ?? 'Unknown Track', album: value.album, albumId: value.albumId ? String(value.albumId) : undefined, artist: value.artist, artistId: value.artistId ? String(value.artistId) : undefined, genre: value.genre, track: value.track ? Number(value.track) : undefined, year: value.year ? Number(value.year) : undefined, duration: value.duration ? Number(value.duration) : undefined, coverArt: value.coverArt, suffix: value.suffix, contentType: value.contentType, bitRate: value.bitRate ? Number(value.bitRate) : undefined, size: value.size ? Number(value.size) : undefined }; }
}
