export interface MusicArtist {
  id: string;
  name: string;
  coverArt?: string;
  playCount?: number;
  lastPlayedAt?: number;
}
export interface MusicAlbum {
  id: string;
  name: string;
  artist?: string;
  artistId?: string;
  year?: number;
  recordLabel?: string;
  coverArt?: string;
  playCount?: number;
  lastPlayedAt?: number;
}
export interface MusicSong {
  id: string;
  title: string;
  album?: string;
  albumId?: string;
  artist?: string;
  artistId?: string;
  genre?: string;
  mood?: string;
  track?: number;
  year?: number;
  duration?: number;
  coverArt?: string;
  suffix?: string;
  contentType?: string;
  bitRate?: number;
  size?: number;
  playCount?: number;
  lastPlayedAt?: number;
  replayGain?: {
    trackGain?: number;
    albumGain?: number;
    trackPeak?: number;
    albumPeak?: number;
  };
}
export interface MusicGenre {
  name: string;
  songCount?: number;
  albumCount?: number;
}
export interface MusicPlaylist {
  id: string;
  name: string;
  comment?: string;
  songCount: number;
  duration: number;
  coverArt?: string;
}
export interface MusicPlaylistResult {
  playlist: MusicPlaylist;
  songs: MusicSong[];
}

export interface MusicProvider {
  refreshLibrary?(): Promise<{ artists: number; albums: number; songs: number; playlists: number }>;
  updateSettings?(settings: { url: string; username: string; password: string }): void;
  artists(): Promise<MusicArtist[]>;
  albums(): Promise<MusicAlbum[]>;
  songs(): Promise<MusicSong[]>;
  genres(): Promise<MusicGenre[]>;
  playlists(): Promise<MusicPlaylist[]>;
  playlist(id: string): Promise<MusicPlaylistResult>;
  addToPlaylist(id: string, songIds: string[]): Promise<void>;
  artist(id: string): Promise<{ artist: MusicArtist; albums: MusicAlbum[] }>;
  relatedArtists?(id: string): Promise<MusicArtist[]>;
  findSonicPath?(startId: string, endId: string): Promise<MusicSong[]>;
  album(id: string): Promise<{ album: MusicAlbum; songs: MusicSong[] }>;
  song(id: string): Promise<MusicSong>;
  scrobble(id: string): Promise<void>;
  streamUrl(id: string, options?: { format?: string; maxBitRate?: number }): Promise<string>;
  coverArtUrl(id: string): Promise<string>;
}
