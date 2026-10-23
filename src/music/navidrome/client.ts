import { createHash, randomBytes } from 'node:crypto';
import type {
  MusicAlbum,
  MusicArtist,
  MusicGenre,
  MusicPlaylist,
  MusicPlaylistResult,
  MusicProvider,
  MusicSong
} from '../types.js';

export interface NavidromeSettings {
  url: string;
  username: string;
  password: string;
}

interface NavidromeItem {
  id?: string | number;
  name?: string;
  value?: string;
  title?: string;
  artist?: string;
  artistId?: string | number;
  album?: string;
  albumId?: string | number;
  genre?: string;
  mood?: string;
  comment?: string;
  songCount?: string | number;
  albumCount?: string | number;
  coverArt?: string;
  suffix?: string;
  contentType?: string;
  year?: string | number;
  recordLabel?: string;
  recordLabels?: Array<string | { name?: string }>;
  openSubsonicAlbumId3?: { recordLabels?: Array<string | { name?: string }> };
  openSubsonicAlbumID3?: { recordLabels?: Array<string | { name?: string }> };
  track?: string | number;
  duration?: string | number;
  bitRate?: string | number;
  size?: string | number;
  playCount?: string | number;
  played?: string | number;
}

interface NavidromeResponse {
  status?: string;
  artists?: { index?: Array<{ artist?: NavidromeItem[] }> };
  albumList2?: { album?: NavidromeItem[] };
  randomSongs?: { song?: NavidromeItem[] };
  searchResult3?: { song?: NavidromeItem[] };
  genres?: { genre?: NavidromeItem[] };
  playlists?: { playlist?: NavidromeItem[] };
  playlist?: (NavidromeItem & { entry?: NavidromeItem[] }) | undefined;
  artist?: (NavidromeItem & { album?: NavidromeItem[] }) | undefined;
  artistInfo?: { similarArtist?: NavidromeItem[] };
  artistInfo2?: { similarArtist?: NavidromeItem[] };
  album?: (NavidromeItem & { song?: NavidromeItem[] }) | undefined;
  song?: NavidromeItem;
  sonicMatch?: Array<{ entry?: NavidromeItem; similarity?: number }>;
}

interface NavidromeEnvelope {
  'subsonic-response'?: NavidromeResponse;
}

export class NavidromeClient implements MusicProvider {
  private static readonly pageSize = 500;
  private static readonly libraryCacheTtlMs = 60 * 60_000;
  private readonly libraryCache = new Map<string, { value: unknown; expiresAt: number }>();
  private readonly libraryLoads = new Map<string, Promise<unknown>>();

  constructor(
    private readonly settings: NavidromeSettings,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  async refreshLibrary(): Promise<{ artists: number; albums: number; songs: number; playlists: number }> {
    this.libraryCache.clear();
    const [artists, albums, songs, playlists] = await Promise.all([
      this.artists(),
      this.albums(),
      this.songs(),
      this.playlists()
    ]);
    return { artists: artists.length, albums: albums.length, songs: songs.length, playlists: playlists.length };
  }

  updateSettings(settings: NavidromeSettings): void {
    Object.assign(this.settings, settings);
    this.libraryCache.clear();
  }

  private cached<T>(key: string, load: () => Promise<T>): Promise<T> {
    const now = Date.now();
    const cached = this.libraryCache.get(key);
    if (cached && cached.expiresAt > now) return Promise.resolve(cached.value as T);
    const existing = this.libraryLoads.get(key);
    if (existing) return existing as Promise<T>;
    const pending = load()
      .then((value) => {
        this.libraryCache.set(key, { value, expiresAt: Date.now() + NavidromeClient.libraryCacheTtlMs });
        return value;
      })
      .finally(() => this.libraryLoads.delete(key));
    this.libraryLoads.set(key, pending);
    return pending;
  }

  private invalidateCached(key: string): void {
    this.libraryCache.delete(key);
  }

  private async call(
    method: string,
    params: Record<string, string | number | string[] | undefined> = {}
  ): Promise<NavidromeResponse> {
    if (!this.settings.url || !this.settings.username || !this.settings.password)
      throw new Error('Navidrome is not configured');
    const salt = randomBytes(8).toString('hex');
    const token = createHash('md5').update(`${this.settings.password}${salt}`).digest('hex');
    const query = new URLSearchParams({
      u: this.settings.username,
      t: token,
      s: salt,
      v: '1.16.1',
      c: 'PlexBridge',
      f: 'json'
    });
    for (const [key, value] of Object.entries(params)) {
      if (Array.isArray(value)) for (const item of value) query.append(key, item);
      else if (value !== undefined) query.set(key, String(value));
    }
    const response = await this.fetchImpl(`${this.settings.url.replace(/\/$/, '')}/rest/${method}.view?${query}`);
    if (!response.ok) throw new Error(`Navidrome ${method} returned HTTP ${response.status}`);
    const body = (await response.json()) as NavidromeEnvelope;
    const result = body['subsonic-response'];
    if (result?.status !== 'ok') throw new Error(`Navidrome ${method} returned an error`);
    return result;
  }

  async artists(): Promise<MusicArtist[]> {
    return this.cached('artists', async () => {
      const result = await this.call('getArtists');
      return (result.artists?.index ?? [])
        .flatMap((index) => index.artist ?? [])
        .map((artist) => ({
          id: String(artist.id),
          name: artist.name ?? 'Unknown Artist',
          coverArt: artist.coverArt
        }));
    });
  }

  async albums(): Promise<MusicAlbum[]> {
    return this.cached('albums', async () => {
      const albums: MusicAlbum[] = [];
      for (let offset = 0; ; offset += NavidromeClient.pageSize) {
        const result = await this.call('getAlbumList2', {
          type: 'alphabeticalByName',
          size: NavidromeClient.pageSize,
          offset
        });
        const page = result.albumList2?.album ?? [];
        albums.push(...page.map((album) => this.normalizeAlbum(album)));
        if (page.length < NavidromeClient.pageSize) return albums;
      }
    });
  }

  async songs(): Promise<MusicSong[]> {
    return this.cached('songs', async () => {
      const songs: MusicSong[] = [];
      for (let offset = 0; ; offset += NavidromeClient.pageSize) {
        const result = await this.call('search3', {
          query: '',
          songCount: NavidromeClient.pageSize,
          songOffset: offset,
          artistCount: 0,
          albumCount: 0
        });
        const page = result.searchResult3?.song ?? [];
        songs.push(...page.map((song) => this.normalizeSong(song)));
        if (page.length < NavidromeClient.pageSize) return songs;
      }
    });
  }

  async genres(): Promise<MusicGenre[]> {
    const result = await this.call('getGenres');
    return (result.genres?.genre ?? []).map((genre) => ({
      name: genre.value ?? 'Unknown Genre',
      songCount: genre.songCount ? Number(genre.songCount) : undefined,
      albumCount: genre.albumCount ? Number(genre.albumCount) : undefined
    }));
  }

  async playlists(): Promise<MusicPlaylist[]> {
    return this.cached('playlists', async () => {
      const result = await this.call('getPlaylists');
      return (result.playlists?.playlist ?? []).map((playlist) => ({
        id: String(playlist.id),
        name: playlist.name ?? 'Untitled Playlist',
        comment: playlist.comment,
        songCount: Number(playlist.songCount ?? 0),
        duration: Number(playlist.duration ?? 0),
        coverArt: playlist.coverArt
      }));
    });
  }

  async playlist(id: string): Promise<MusicPlaylistResult> {
    const result = await this.call('getPlaylist', { id });
    const playlist = result.playlist ?? {};
    return {
      playlist: {
        id: String(playlist.id),
        name: playlist.name ?? 'Untitled Playlist',
        comment: playlist.comment,
        songCount: Number(playlist.songCount ?? 0),
        duration: Number(playlist.duration ?? 0),
        coverArt: playlist.coverArt
      },
      songs: (playlist.entry ?? []).map((song) => this.normalizeSong(song))
    };
  }

  async addToPlaylist(id: string, songIds: string[]): Promise<void> {
    await this.call('updatePlaylist', { playlistId: id, songIdToAdd: songIds });
    this.invalidateCached('playlists');
  }

  async artist(id: string): Promise<{ artist: MusicArtist; albums: MusicAlbum[] }> {
    const result = await this.call('getArtist', { id });
    const artist = result.artist ?? {};
    return {
      artist: { id: String(artist.id), name: artist.name ?? 'Unknown Artist', coverArt: artist.coverArt },
      albums: (artist.album ?? []).map((album) => this.normalizeAlbum(album))
    };
  }

  async relatedArtists(id: string): Promise<MusicArtist[]> {
    try {
      const result = await this.call('getArtistInfo2', { id });
      return (result.artistInfo2?.similarArtist ?? [])
        .filter((artist) => artist.name)
        .map((artist) => ({ id: artist.id ? String(artist.id) : '', name: artist.name as string }));
    } catch {
      try {
        const result = await this.call('getArtistInfo', { id });
        return (result.artistInfo?.similarArtist ?? [])
          .filter((artist) => artist.name)
          .map((artist) => ({ id: artist.id ? String(artist.id) : '', name: artist.name as string }));
      } catch {
        return [];
      }
    }
  }

  async findSonicPath(startId: string, endId: string): Promise<MusicSong[]> {
    const result = await this.call('findSonicPath', { startSongId: startId, endSongId: endId, count: 50 });
    return (result.sonicMatch ?? [])
      .map((match) => match.entry)
      .filter((entry): entry is NavidromeItem => Boolean(entry?.id))
      .map((song) => this.normalizeSong(song));
  }

  async album(id: string): Promise<{ album: MusicAlbum; songs: MusicSong[] }> {
    const result = await this.call('getAlbum', { id });
    const album = result.album ?? {};
    return {
      album: this.normalizeAlbum(album),
      songs: (album.song ?? []).map((song) => this.normalizeSong(song))
    };
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
    const query = new URLSearchParams({
      u: this.settings.username,
      t: token,
      s: salt,
      v: '1.16.1',
      c: 'PlexBridge',
      id
    });
    if (options.format) query.set('format', options.format);
    if (options.maxBitRate !== undefined) query.set('maxBitRate', String(options.maxBitRate));
    return `${this.settings.url.replace(/\/$/, '')}/rest/stream.view?${query}`;
  }

  async coverArtUrl(id: string): Promise<string> {
    const salt = randomBytes(8).toString('hex');
    const token = createHash('md5').update(`${this.settings.password}${salt}`).digest('hex');
    const query = new URLSearchParams({
      u: this.settings.username,
      t: token,
      s: salt,
      v: '1.16.1',
      c: 'PlexBridge',
      id,
      size: '1200'
    });
    return `${this.settings.url.replace(/\/$/, '')}/rest/getCoverArt.view?${query}`;
  }

  private normalizeAlbum(value: NavidromeItem): MusicAlbum {
    const recordLabels =
      value.recordLabels ?? value.openSubsonicAlbumId3?.recordLabels ?? value.openSubsonicAlbumID3?.recordLabels ?? [];
    return {
      id: String(value.id),
      name: value.name ?? 'Unknown Album',
      artist: value.artist,
      artistId: value.artistId ? String(value.artistId) : undefined,
      year: value.year ? Number(value.year) : undefined,
      recordLabel:
        value.recordLabel ??
        recordLabels
          .map((label) => (typeof label === 'string' ? label : (label.name ?? '')))
          .filter(Boolean)
          .join(', '),
      coverArt: value.coverArt,
      playCount: value.playCount !== undefined ? Number(value.playCount) : undefined,
      lastPlayedAt: parsePlayedAt(value.played)
    };
  }
  private normalizeSong(value: NavidromeItem): MusicSong {
    return {
      id: String(value.id),
      title: value.title ?? 'Unknown Track',
      album: value.album,
      albumId: value.albumId ? String(value.albumId) : undefined,
      artist: value.artist,
      artistId: value.artistId ? String(value.artistId) : undefined,
      genre: value.genre,
      mood: value.mood,
      track: value.track ? Number(value.track) : undefined,
      year: value.year ? Number(value.year) : undefined,
      duration: value.duration ? Number(value.duration) : undefined,
      coverArt: value.coverArt,
      suffix: value.suffix,
      contentType: value.contentType,
      bitRate: value.bitRate ? Number(value.bitRate) : undefined,
      size: value.size ? Number(value.size) : undefined,
      playCount: value.playCount !== undefined ? Number(value.playCount) : undefined,
      lastPlayedAt: parsePlayedAt(value.played)
    };
  }
}

function parsePlayedAt(value: string | number | undefined): number | undefined {
  if (value === undefined || value === '') return undefined;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric > 10_000_000_000 ? Math.floor(numeric / 1000) : numeric;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : undefined;
}
