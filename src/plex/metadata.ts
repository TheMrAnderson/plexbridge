import type { MusicAlbum, MusicArtist, MusicSong } from '../music/types.js';
import type { PlexItem } from './protocol.js';

// Formats Plexamp can consume without asking PlexBridge to convert them.
// Opus and other formats stay on the MP3 fallback until their client support
// is verified against a real Plexamp playback/download request.
export const directPlayableFormats = new Set(['flac', 'mp3', 'aac', 'm4a', 'mp4']);

export interface AudioTarget {
  format: string;
  container: string;
  audioCodec: string;
}

export function transcodeTarget(clientProfile: string): AudioTarget {
  const container = /container=([^&)]+)/.exec(clientProfile)?.[1]?.toLowerCase();
  const audioCodec = /audioCodec=([^&)]+)/.exec(clientProfile)?.[1]?.toLowerCase();
  if (container === 'ogg' && audioCodec === 'opus') return { format: 'opus', container: 'ogg', audioCodec: 'opus' };
  return { format: 'mp3', container: 'mp3', audioCodec: 'mp3' };
}

export function audioDecision(
  song: MusicSong,
  preserveSourceFormats: boolean,
  directPlayRequested: boolean,
  clientProfile: string
): { sourceFormat: string; sourceDirectPlayable: boolean; directPlayable: boolean; target: AudioTarget } {
  const sourceFormat = (song.suffix ?? song.contentType?.split('/')[1] ?? 'mp3').toLowerCase();
  const sourceDirectPlayable = preserveSourceFormats && directPlayableFormats.has(sourceFormat);
  const directPlayable = directPlayRequested && sourceDirectPlayable;
  return {
    sourceFormat,
    sourceDirectPlayable,
    directPlayable,
    target: directPlayable
      ? { format: sourceFormat, container: sourceFormat, audioCodec: sourceFormat }
      : transcodeTarget(clientProfile)
  };
}

export function audioStreamOptions(
  song: MusicSong,
  preserveSourceFormats: boolean,
  directPlayRequested: boolean,
  clientProfile: string,
  maxBitRate?: number
): { format?: string; maxBitRate?: number } {
  const { directPlayable, target } = audioDecision(song, preserveSourceFormats, directPlayRequested, clientProfile);
  return directPlayable ? {} : { format: target.format, ...(maxBitRate === undefined ? {} : { maxBitRate }) };
}

export function streamOptions(song: MusicSong, preserveSourceFormats: boolean): { format?: string } {
  return audioStreamOptions(song, preserveSourceFormats, true, '');
}

export function plexAudioCodec(format: string, contentType?: string): string {
  if (format === 'mp3' || contentType === 'audio/mpeg') return 'mp3';
  if (format === 'm4a' || format === 'mp4' || contentType === 'audio/mp4') return 'aac';
  if (format === 'aac' || contentType === 'audio/aac') return 'aac';
  if (format === 'flac' || contentType === 'audio/flac') return 'flac';
  return format;
}

export function metadataKey(kind: 'a' | 'l' | 's', id: string): string {
  return `/library/metadata/${kind}-${encodeURIComponent(id)}`;
}

export function parseMetadataKey(value: string): { kind: 'a' | 'l' | 's'; id: string } | undefined {
  const match = /^(a|l|s)-(.+)$/.exec(decodeURIComponent(value));
  return match ? { kind: match[1] as 'a' | 'l' | 's', id: match[2] } : undefined;
}

export function artistItem(artist: MusicArtist): PlexItem {
  const artwork = `${metadataKey('a', artist.id)}/thumb`;
  return {
    key: metadataKey('a', artist.id),
    ratingKey: `a-${artist.id}`,
    guid: `plex://artist/${artist.id}`,
    title: artist.name,
    type: 'artist',
    viewCount: artist.playCount,
    lastViewedAt: artist.lastPlayedAt,
    thumb: artwork,
    art: artwork
  };
}

export function albumArtwork(id: string): string {
  return `${metadataKey('l', id)}/thumb`;
}

export function albumItem(album: MusicAlbum, parent?: MusicArtist): PlexItem {
  const thumb = albumArtwork(album.id);
  return {
    key: metadataKey('l', album.id),
    ratingKey: `l-${album.id}`,
    guid: `plex://album/${album.id}`,
    title: album.name,
    type: 'album',
    parentKey: parent ? metadataKey('a', parent.id) : album.artistId ? metadataKey('a', album.artistId) : undefined,
    parentTitle: parent?.name ?? album.artist,
    year: album.year,
    viewCount: album.playCount,
    lastViewedAt: album.lastPlayedAt,
    thumb,
    art: thumb
  };
}

export function songItem(song: MusicSong, album?: MusicAlbum): PlexItem {
  const sourceFormat = (song.suffix ?? song.contentType?.split('/')[1] ?? 'mp3').toLowerCase();
  const playable = directPlayableFormats.has(sourceFormat);
  const albumId = album?.id ?? song.albumId;
  const artistId = album?.artistId ?? song.artistId;
  const thumb = album
    ? albumArtwork(album.id)
    : song.albumId
      ? albumArtwork(song.albumId)
      : `${metadataKey('s', song.id)}/thumb`;
  return {
    key: metadataKey('s', song.id),
    ratingKey: `s-${song.id}`,
    guid: `plex://track/${song.id}`,
    title: song.title,
    type: 'track',
    parentRatingKey: albumId ? `l-${albumId}` : undefined,
    grandparentRatingKey: artistId ? `a-${artistId}` : undefined,
    parentGuid: albumId ? `plex://album/${albumId}` : undefined,
    grandparentGuid: artistId ? `plex://artist/${artistId}` : undefined,
    parentKey: albumId ? metadataKey('l', albumId) : undefined,
    parentTitle: album?.name ?? song.album,
    grandparentKey: artistId ? metadataKey('a', artistId) : undefined,
    grandparentTitle: album?.artist ?? song.artist,
    parentThumb: thumb,
    grandparentThumb: artistId ? `${metadataKey('a', artistId)}/thumb` : undefined,
    grandparentArt: artistId ? `${metadataKey('a', artistId)}/art` : undefined,
    index: song.track,
    year: song.year,
    viewCount: song.playCount,
    lastViewedAt: song.lastPlayedAt,
    parentYear: album?.id ? undefined : song.year,
    summary: '',
    genre: song.genre,
    duration: song.duration,
    thumb,
    art: thumb,
    media: {
      partKey: `${metadataKey('s', song.id)}/stream`,
      duration: song.duration,
      size: song.size,
      container: playable ? sourceFormat : 'mp3',
      audioCodec: playable ? plexAudioCodec(sourceFormat, song.contentType) : 'mp3',
      bitrate: song.bitRate,
      replayGain: song.replayGain
    }
  };
}
