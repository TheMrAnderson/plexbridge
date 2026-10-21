import { PLEX_SERVER_VERSION } from './profile.js';
import { createHash } from 'node:crypto';

const plexServerVersion = PLEX_SERVER_VERSION;
const plexLibraryUuid = '7b7a8d4e-3e90-4b74-9a2e-4f6c9c2e8d11';
const plexOwnerFeatures = 'adaptive_bitrate,camera_upload,collections,content_filter,download_certificates,dvr,hardware_transcoding,home,item_clusters,loudness,lyrics,music-analysis,music_videos,pass,premium_music_metadata,radio,server-manager,session_bandwidth_restrictions,sync,trailers,tuner-sharing,type-first,unsupportedtuners,webhooks';

function escape(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

const header = '<?xml version="1.0" encoding="UTF-8"?>';

function playlistGuid(id: string): string {
  const hex = createHash('sha256').update(id).digest('hex').slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20)}`;
}

export function serverRoot(name: string, machineIdentifier: string, publicUrl: string, claimed: boolean): string {
  const directoryKeys = ['actions', 'activities', 'butler', 'channels', 'clients', 'devices', 'diagnostics', 'downloadQueue', 'hubs', 'library', 'livetv', 'media', 'neighborhood', 'playQueues', 'playlists', 'resources', 'search', 'server', 'servers', 'service', 'statistics', 'system', 'transcode', 'updater', 'user'];
  const directories = directoryKeys.map((key) => `<Directory count="${['library', 'livetv', 'media'].includes(key) ? '3' : '1'}" key="${key}" title="${key}" />`).join('');
  return `${header}<MediaContainer size="25" allowCameraUpload="1" allowChannelAccess="1" allowMediaDeletion="1" allowSharing="1" allowSync="1" allowTuners="1" apiVersion="1.2.3" backgroundProcessing="1" certificate="1" companionProxy="1" countryCode="usa" diagnostics="logs,databases,streaminglogs" eventStream="1" friendlyName="${escape(name)}" hubSearch="1" itemClusters="1" livetv="7" machineIdentifier="${machineIdentifier}" mediaProviders="1" multiuser="1" musicAnalysis="2" myPlex="${claimed ? '1' : '0'}" myPlexMappingState="mapped" myPlexSigninState="${claimed ? 'ok' : 'unknown'}" myPlexSubscription="1" offlineTranscode="1" platform="Linux" platformVersion="${process.platform}" pluginHost="1" pushNotifications="0" readOnlyLibraries="0" streamingBrainABRVersion="3" streamingBrainVersion="2" sync="1" transcoderActiveVideoSessions="0" transcoderAudio="1" transcoderLyrics="1" transcoderSubtitles="1" transcoderVideo="1" updater="1" version="${plexServerVersion}" voiceSearch="1">${directories}</MediaContainer>`;
}

export function identity(machineIdentifier: string, claimed: boolean): string {
  return `${header}<MediaContainer size="1" apiVersion="1.2.3" claimed="${claimed ? '1' : '0'}" machineIdentifier="${machineIdentifier}" version="${plexServerVersion}">\n</MediaContainer>`;
}

export function librarySections(): string {
  return `${header}<MediaContainer size="1" allowSync="0" identifier="com.plexapp.plugins.library" mediaTagPrefix="/system/bundle/media/flags/" mediaTagVersion="1" title1="Plex Library"><Directory allowSync="1" art="/:/resources/artist-fanart.jpg" thumb="/:/resources/artist.png" key="1" type="artist" title="Music" agent="tv.plex.agents.music" scanner="Plex Music Scanner" language="en" uuid="${plexLibraryUuid}" content="1" directory="1" hidden="0"/></MediaContainer>`;
}

export function libraryHubs(): string {
  return `${header}<MediaContainer size="5" allowSync="1" identifier="com.plexapp.plugins.library" librarySectionID="1" librarySectionTitle="Music" librarySectionUUID="${plexLibraryUuid}"><Hub key="/library/sections/1/all?viewCount&gt;=1&amp;type=8&amp;sort=lastViewedAt:desc" title="Recently Played Music" type="artist" hubIdentifier="music.recent.played.1" context="hub.music.recent.played" size="0" more="0" style="shelf"></Hub><Hub key="/library/sections/1/all?type=9&amp;sort=addedAt:desc" title="Recently Added in Music" type="album" hubIdentifier="music.recent.added.1" context="hub.music.recent.added" size="0" more="0" style="shelf" promoted="1"></Hub><Hub key="/library/sections/1/all?type=8&amp;viewCount&gt;=50&amp;lastViewedAt!=-1&amp;lastViewedAt&lt;=-2mon&amp;sort=random" title="Haven&apos;t played in 2 months" type="artist" hubIdentifier="music.vault.1" context="hub.music.vault" size="0" more="0" random="1" style="shelf"></Hub><Hub key="/library/sections/1/all?type=8&amp;tagType=306" title="Artists on Tour" type="artist" hubIdentifier="music.touring.1" context="hub.music.touring" size="0" more="0" random="1" style="shelf"></Hub><Hub key="/library/sections/1/extras/all?extraType=4&amp;type=10&amp;sourceType=8&amp;extra.sort=addedAt:desc" title="Recently Added Music Videos" type="clip" hubIdentifier="music.videos.new.1" context="hub.music.videos.new" size="0" more="0" style="shelf"></Hub></MediaContainer>`;
}

export function libraryHubsJson(): string {
  const Hub = [
    { key: '/library/sections/1/all?viewCount>=1&type=8&sort=lastViewedAt:desc', title: 'Recently Played Music', type: 'artist', hubIdentifier: 'music.recent.played.1', context: 'hub.music.recent.played', size: 0, more: false, style: 'shelf' },
    { key: '/library/sections/1/all?type=9&sort=addedAt:desc', title: 'Recently Added in Music', type: 'album', hubIdentifier: 'music.recent.added.1', context: 'hub.music.recent.added', size: 0, more: false, style: 'shelf', promoted: true },
    { key: '/library/sections/1/all?type=8&viewCount>=50&lastViewedAt!=-1&lastViewedAt<=-2mon&sort=random', title: "Haven't played in 2 months", type: 'artist', hubIdentifier: 'music.vault.1', context: 'hub.music.vault', size: 0, more: false, random: true, style: 'shelf' },
    { key: '/library/sections/1/all?type=8&tagType=306', title: 'Artists on Tour', type: 'artist', hubIdentifier: 'music.touring.1', context: 'hub.music.touring', size: 0, more: false, random: true, style: 'shelf' },
    { key: '/library/sections/1/extras/all?extraType=4&type=10&sourceType=8&extra.sort=addedAt:desc', title: 'Recently Added Music Videos', type: 'clip', hubIdentifier: 'music.videos.new.1', context: 'hub.music.videos.new', size: 0, more: false, style: 'shelf' },
  ];
  return JSON.stringify({ MediaContainer: { size: 5, allowSync: true, identifier: 'com.plexapp.plugins.library', librarySectionID: 1, librarySectionTitle: 'Music', librarySectionUUID: plexLibraryUuid, Hub } });
}

export function playlistsJson(playlists?: Array<{ id: string; ratingKey?: string; guid?: string; name: string; comment?: string; songCount: number; duration: number; smart?: boolean; icon?: string }>): string {
  const now = Math.floor(Date.now() / 1000);
  const Metadata = (playlists ?? []).map((playlist) => { const ratingKey = playlist.ratingKey ?? playlist.id; const composite = playlist.songCount > 0 ? `/playlists/${encodeURIComponent(ratingKey)}/composite/${now}` : undefined; return { ratingKey, key: `/playlists/${encodeURIComponent(ratingKey)}/items`, guid: `com.plexapp.agents.none://${playlist.guid ?? playlistGuid(playlist.id)}`, type: 'playlist', title: playlist.name, titleSort: playlist.name.replace(/^[^\p{L}\p{N}]*/u, ''), summary: playlist.comment ?? '', smart: playlist.smart ?? false, playlistType: 'audio', ...(playlist.icon ? { icon: playlist.icon } : {}), ...(composite ? { composite, thumb: composite, art: composite } : {}), viewCount: 1, lastViewedAt: now, ...(playlist.duration > 0 ? { duration: playlist.duration * 1000 } : {}), leafCount: playlist.songCount, addedAt: now, updatedAt: now }; });
  return JSON.stringify({ MediaContainer: { size: Metadata.length, totalSize: Metadata.length, offset: 0, Metadata } });
}

export function emptyPlaylistSectionJson(): string {
  return JSON.stringify({ MediaContainer: { size: 0, allowSync: true, art: '/:/resources/artist-fanart.jpg', identifier: 'com.plexapp.plugins.library', librarySectionID: 1, librarySectionTitle: 'Music', librarySectionUUID: plexLibraryUuid, mediaTagPrefix: '/system/bundle/media/flags/', mediaTagVersion: 1, nocache: true, thumb: '/:/resources/artist.png', title1: 'Music', title2: 'Playlists', viewGroup: 'playlist', viewMode: 65592, Metadata: [] } });
}

export function genresJson(genres: Array<{ name: string; songCount?: number; albumCount?: number }> = []): string {
  const Directory = genres.map((genre, index) => { const key = String(index + 1); return { fastKey: `/library/sections/1/all?genre=${key}`, key, title: genre.name, type: 'genre' }; });
  return JSON.stringify({ MediaContainer: { size: Directory.length, allowSync: false, art: '/:/resources/artist-fanart.jpg', content: 'secondary', identifier: 'com.plexapp.plugins.library', mediaTagPrefix: '/system/bundle/media/flags/', mediaTagVersion: 1, nocache: true, thumb: '/:/resources/artist.png', title1: 'Music', title2: 'By Genre', viewGroup: 'secondary', viewMode: 65592, Directory } });
}

export function timelineJson(): string {
  return JSON.stringify({ MediaContainer: { size: 0 } });
}

export function firstCharacterJson(groups: Array<{ key: string; size: number }> = []): string {
  const Directory = groups.map((group) => ({ size: group.size, key: group.key, title: group.key }));
  return JSON.stringify({ MediaContainer: { size: Directory.length, allowSync: false, art: '/:/resources/artist-fanart.jpg', content: 'secondary', identifier: 'com.plexapp.plugins.library', mediaTagPrefix: '/system/bundle/media/flags/', mediaTagVersion: 1, nocache: true, thumb: '/:/resources/artist.png', title1: 'Music', title2: 'By First Letter', viewGroup: 'secondary', viewMode: 65592, Directory } });
}

export function playQueueJson(item: PlexItem, queueId: string, sourceUri: string): string {
  const metadata: Record<string, unknown> = { ratingKey: item.ratingKey, key: item.key, guid: `com.plexapp.agents.none://plexbridge-${item.ratingKey}`, type: item.type, title: item.title, librarySectionID: 1, librarySectionKey: '/library/sections/1', librarySectionTitle: 'Music', librarySectionUUID: plexLibraryUuid };
  const queueItemId = Number(queueId) * 1000 + 1;
  metadata.playQueueItemID = queueItemId;
  for (const [name, field] of [['parentKey', item.parentKey], ['parentTitle', item.parentTitle], ['grandparentKey', item.grandparentKey], ['grandparentTitle', item.grandparentTitle], ['parentThumb', item.parentThumb], ['grandparentThumb', item.grandparentThumb], ['thumb', item.thumb], ['art', item.art]] as const) if (field !== undefined) metadata[name] = field;
  if (item.thumb) metadata.Image = [{ alt: item.title, type: 'coverPoster', url: item.thumb }, ...(item.art && item.art !== item.thumb ? [{ alt: item.title, type: 'background', url: item.art }] : [])];
  if (item.duration !== undefined) metadata.duration = item.duration * 1000;
  if (item.index !== undefined) metadata.index = item.index;
  if (item.media) metadata.Media = [{ id: 1, duration: (item.media.duration ?? item.duration ?? 0) * 1000, protocol: 'http', optimizedForStreaming: true, audioChannels: 2, container: item.media.container ?? 'mp3', audioCodec: item.media.audioCodec ?? 'mp3', bitrate: item.media.bitrate ?? 0, Part: [{ id: 1, key: item.media.partKey, duration: (item.media.duration ?? item.duration ?? 0) * 1000, size: item.media.size ?? 0, protocol: 'http', container: item.media.container ?? 'mp3' }] }];
  return JSON.stringify({ MediaContainer: { size: 1, identifier: 'com.plexapp.plugins.library', mediaTagPrefix: '/system/bundle/media/flags/', mediaTagVersion: 1, playQueueID: Number(queueId), playQueueSelectedItemID: queueItemId, playQueueSelectedItemOffset: 0, playQueueSelectedMetadataItemID: item.ratingKey, playQueueShuffled: false, playQueueSourceURI: sourceUri, playQueueTotalCount: 1, playQueueVersion: 1, Metadata: [metadata] } });
}

export function playlistQueueJson(items: PlexItem[], queueId: string, sourceUri: string, playlistId: string, playlistTitle: string, shuffled: boolean): string {
  const Metadata = items.map((item, index) => {
    const metadata: Record<string, unknown> = { ratingKey: item.ratingKey, key: item.key, guid: item.guid ?? `plex://track/${item.ratingKey}`, type: item.type, title: item.title, librarySectionID: 1, librarySectionKey: '/library/sections/1', librarySectionTitle: 'Music', librarySectionUUID: plexLibraryUuid, playQueueItemID: index + 1 };
    for (const [name, field] of [['parentRatingKey', item.parentRatingKey], ['grandparentRatingKey', item.grandparentRatingKey], ['parentGuid', item.parentGuid], ['grandparentGuid', item.grandparentGuid], ['parentKey', item.parentKey], ['parentTitle', item.parentTitle], ['grandparentKey', item.grandparentKey], ['grandparentTitle', item.grandparentTitle], ['parentThumb', item.parentThumb], ['grandparentThumb', item.grandparentThumb], ['thumb', item.thumb], ['art', item.art]] as const) if (field !== undefined) metadata[name] = field;
    if (item.thumb) metadata.Image = [{ alt: item.title, type: 'coverPoster', url: item.thumb }, ...(item.art && item.art !== item.thumb ? [{ alt: item.title, type: 'background', url: item.art }] : [])];
    if (item.duration !== undefined) metadata.duration = item.duration * 1000;
    if (item.index !== undefined) metadata.index = item.index;
    if (item.media) metadata.Media = [{ id: index + 1, duration: (item.media.duration ?? item.duration ?? 0) * 1000, protocol: 'http', optimizedForStreaming: true, audioChannels: 2, container: item.media.container ?? 'mp3', audioCodec: item.media.audioCodec ?? 'mp3', bitrate: item.media.bitrate ?? 0, Part: [{ id: index + 1, key: item.media.partKey, duration: (item.media.duration ?? item.duration ?? 0) * 1000, size: item.media.size ?? 0, protocol: 'http', container: item.media.container ?? 'mp3' }] }];
    return metadata;
  });
  return JSON.stringify({ MediaContainer: { size: Metadata.length, totalSize: Metadata.length, offset: 0, identifier: 'com.plexapp.plugins.library', mediaTagPrefix: '/system/bundle/media/flags/', mediaTagVersion: 1, playQueueID: Number(queueId), playQueuePlaylistID: Number(playlistId), playQueuePlaylistTitle: playlistTitle, playQueueSelectedItemID: 1, playQueueSelectedItemOffset: 0, playQueueSelectedMetadataItemID: items[0]?.ratingKey, playQueueShuffled: shuffled, playQueueSourceURI: sourceUri, playQueueTotalCount: Metadata.length, playQueueVersion: 1, Metadata } });
}

export function mediaProviders(): string {
  return `${header}<MediaContainer size="1" allowCameraUpload="1" allowChannelAccess="1" allowMediaDeletion="1" allowSharing="1" allowSync="1" allowTuners="1" apiVersion="1.2.3" backgroundProcessing="1" certificate="1" companionProxy="1" eventStream="1" friendlyName="PlexBridge" musicAnalysis="2" myPlex="1" myPlexMappingState="unknown" myPlexSigninState="ok" myPlexSubscription="1" offlineTranscode="1" platform="Linux" pluginHost="1" pushNotifications="0" readOnlyLibraries="0" streamingBrainABRVersion="3" streamingBrainVersion="2" sync="1" transcoderActiveVideoSessions="0" transcoderAudio="1" transcoderLyrics="1" transcoderSubtitles="1" transcoderVideo="1" transcoderVideoBitrates="64,96,208,320,720,1500,2000,3000,4000,8000,10000,12000,20000" transcoderVideoQualities="0,1,2,3,4,5,6,7,8,9,10,11,12" transcoderVideoResolutions="128,128,160,240,320,480,768,720,720,1080,1080,1080,1080" updater="1" version="${plexServerVersion}" voiceSearch="1">
<MediaProvider identifier="com.plexapp.plugins.library" title="Library" types="video,audio,photo" protocols="stream,download">
<Feature key="/library/sections" type="content"><Directory hubKey="/hubs" title="Home"></Directory></Feature>
<Feature key="/hubs/search" type="search"></Feature>
<Feature key="/library/matches" type="match"></Feature>
<Feature key="/library/metadata" type="metadata"></Feature>
<Feature key="/:/rate" type="rate"></Feature>
<Feature key="/photo/:/transcode" type="imagetranscoder"></Feature>
<Feature key="/hubs/promoted" type="promoted"></Feature>
<Feature key="/hubs/continueWatching" type="continuewatching"></Feature>
<Feature key="/actions" type="actions"><Action id="removeFromContinueWatching" key="/actions/removeFromContinueWatching" /></Feature>
<Feature flavor="universal" key="/playlists" type="playlist"></Feature>
<Feature flavor="universal" key="/playQueues" type="playqueue"></Feature>
<Feature key="/library/collections" type="collection"></Feature>
<Feature scrobbleKey="/:/scrobble" unscrobbleKey="/:/unscrobble" key="/:/timeline" type="timeline"></Feature>
<Feature type="manage"></Feature>
<Feature type="queryParser"></Feature>
<Feature flavor="download" type="subscribe"></Feature>
<Feature key="/library/search" type="universalsearch"></Feature>
</MediaProvider>
</MediaContainer>`;
}

const providerFeatures = (section: Record<string, unknown>) => [
  { key: '/library/sections', type: 'content', Directory: [{ hubKey: '/hubs', title: 'Home' }, section, { id: 'playlists', key: '/playlists', type: 'playlist', title: 'Playlists', Pivot: [{ id: 'playlists.audio', key: '/playlists?playlistType=audio', type: 'list', title: 'Music', context: 'content.playlists.music', symbol: 'playlist' }] }] },
  { key: '/hubs/search', type: 'search' }, { key: '/library/matches', type: 'match' }, { key: '/library/metadata', type: 'metadata' },
  { key: '/:/rate', type: 'rate' }, { key: '/photo/:/transcode', type: 'imagetranscoder' }, { key: '/hubs/promoted', type: 'promoted' },
  { key: '/hubs/continueWatching', type: 'continuewatching' }, { key: '/actions', type: 'actions', Action: [{ id: 'removeFromContinueWatching', key: '/actions/removeFromContinueWatching' }] },
  { flavor: 'universal', key: '/playlists', type: 'playlist' }, { flavor: 'universal', key: '/playQueues', type: 'playqueue' },
  { key: '/library/collections', type: 'collection' }, { scrobbleKey: '/:/scrobble', unscrobbleKey: '/:/unscrobble', key: '/:/timeline', type: 'timeline' },
  { type: 'manage' }, { type: 'queryParser' }, { flavor: 'download', type: 'subscribe' }, { key: '/library/search', type: 'universalsearch' },
];

export function serverRootJson(name: string, machineIdentifier: string, claimed: boolean): string {
  const keys = ['actions', 'activities', 'butler', 'channels', 'clients', 'devices', 'diagnostics', 'downloadQueue', 'hubs', 'library', 'livetv', 'media', 'neighborhood', 'playQueues', 'playlists', 'resources', 'search', 'server', 'servers', 'service', 'statistics', 'system', 'transcode', 'updater', 'user'];
  const Directory = keys.map((key) => ({ count: ['library', 'livetv', 'media'].includes(key) ? 3 : 1, key, title: key }));
  return JSON.stringify({ MediaContainer: { size: 25, allowCameraUpload: true, allowChannelAccess: true, allowMediaDeletion: true, allowSharing: true, allowSync: true, allowTuners: true, apiVersion: '1.2.3', backgroundProcessing: true, certificate: true, companionProxy: true, countryCode: 'usa', diagnostics: 'logs,databases,streaminglogs', eventStream: true, friendlyName: name, hubSearch: true, itemClusters: true, livetv: 7, machineIdentifier, mediaProviders: true, multiuser: true, musicAnalysis: 2, myPlex: claimed, myPlexMappingState: 'mapped', myPlexSigninState: claimed ? 'ok' : 'unknown', myPlexSubscription: true, offlineTranscode: 1, platform: 'Linux', platformVersion: process.platform, pluginHost: true, pushNotifications: false, readOnlyLibraries: false, streamingBrainABRVersion: 3, streamingBrainVersion: 2, sync: true, transcoderActiveVideoSessions: 0, transcoderAudio: true, transcoderLyrics: true, transcoderSubtitles: true, transcoderVideo: true, updater: true, version: plexServerVersion, voiceSearch: true, Directory } });
}

export function mediaProvidersJson(name: string, machineIdentifier: string, claimed: boolean): string {
  const now = Math.floor(Date.now() / 1000);
  const section = { agent: 'tv.plex.agents.music', language: 'en-US', refreshing: false, scanner: 'Plex Music', uuid: plexLibraryUuid, id: '1', key: '/library/sections/1', hubKey: '/hubs/sections/1', type: 'artist', title: 'Music', updatedAt: now, scannedAt: now, Pivot: [{ id: 'recommended', key: '/hubs/sections/1', type: 'hub', title: 'Recommended', context: 'content.discover', symbol: 'star' }, { id: 'library', key: '/library/sections/1/all?type=8', type: 'list', title: 'Library', context: 'content.library', symbol: 'library' }, { id: 'playlists', key: '/playlists?type=15&sectionID=1&playlistType=audio', type: 'list', title: 'Playlists', context: 'content.playlists', symbol: 'playlist' }] };
  const mediaContainer = { size: 1, allowCameraUpload: true, allowChannelAccess: true, allowMediaDeletion: true, allowSharing: true, allowSync: true, allowTuners: true, apiVersion: '1.2.3', backgroundProcessing: true, certificate: true, companionProxy: true, countryCode: 'usa', diagnostics: 'logs,databases,streaminglogs', eventStream: true, friendlyName: name, livetv: 7, machineIdentifier, musicAnalysis: 2, myPlex: claimed, myPlexMappingState: 'mapped', myPlexSigninState: claimed ? 'ok' : 'unknown', myPlexSubscription: true, offlineTranscode: 1, ownerFeatures: plexOwnerFeatures, platform: 'Linux', pluginHost: true, pushNotifications: false, readOnlyLibraries: false, streamingBrainABRVersion: 3, streamingBrainVersion: 2, sync: true, transcoderActiveVideoSessions: 0, transcoderAudio: true, transcoderLyrics: true, transcoderSubtitles: true, transcoderVideo: true, transcoderVideoBitrates: '64,96,208,320,720,1500,2000,3000,4000,8000,10000,12000,20000', transcoderVideoQualities: '0,1,2,3,4,5,6,7,8,9,10,11,12', transcoderVideoResolutions: '128,128,160,240,320,480,768,720,720,1080,1080,1080,1080', updatedAt: now, updater: true, version: plexServerVersion, voiceSearch: true, MediaProvider: [{ identifier: 'com.plexapp.plugins.library', title: 'Library', types: 'video,audio,photo', protocols: 'stream,download', Feature: providerFeatures(section) }] };
  return JSON.stringify({ MediaContainer: mediaContainer });
}

export interface PlexItem { key: string; title: string; type: 'artist' | 'album' | 'track'; parentKey?: string; parentTitle?: string; grandparentKey?: string; grandparentTitle?: string; parentRatingKey?: string; grandparentRatingKey?: string; guid?: string; parentGuid?: string; grandparentGuid?: string; parentStudio?: string; parentThumb?: string; grandparentThumb?: string; grandparentArt?: string; index?: number; parentIndex?: number; duration?: number; year?: number; parentYear?: number; summary?: string; genre?: string; thumb?: string; art?: string; ratingKey: string; media?: { partKey: string; duration?: number; size?: number; container?: string; audioCodec?: string; bitrate?: number } }

export function libraryItems(items: PlexItem[], viewGroup: 'artist' | 'album' | 'track'): string {
  const entries = items.map((item) => {
    const attrs = [`ratingKey="${escape(item.ratingKey)}"`, `key="${escape(item.key)}"`, `type="${item.type}"`, `title="${escape(item.title)}"`];
    for (const [name, value] of [['parentKey', item.parentKey], ['parentTitle', item.parentTitle], ['grandparentKey', item.grandparentKey], ['grandparentTitle', item.grandparentTitle], ['thumb', item.thumb], ['art', item.art]] as const) if (value) attrs.push(`${name}="${escape(value)}"`);
    if (item.index !== undefined) attrs.push(`index="${item.index}"`);
    if (item.year !== undefined) attrs.push(`year="${item.year}"`);
    if (item.duration !== undefined) attrs.push(`duration="${item.duration * 1000}"`);
    if (item.type !== 'track') return `<Directory ${attrs.join(' ')}/>`;
    const media = item.media ? `<Media duration="${(item.media.duration ?? item.duration ?? 0) * 1000}" container="${escape(item.media.container ?? 'mp3')}" audioCodec="${escape(item.media.audioCodec ?? 'mp3')}" bitrate="${item.media.bitrate ?? 0}"><Part key="${escape(item.media.partKey)}" duration="${(item.media.duration ?? item.duration ?? 0) * 1000}" size="${item.media.size ?? 0}"/></Media>` : '';
    return `<Track ${attrs.join(' ')}>${media}</Track>`;
  });
  return `${header}<MediaContainer size="${items.length}" viewGroup="${viewGroup}" allowSync="0">${entries.join('')}</MediaContainer>`;
}

export function libraryItemsJson(items: PlexItem[], viewGroup: 'artist' | 'album' | 'track'): string {
  const entries = items.map((item) => {
    const value: Record<string, unknown> = { ratingKey: item.ratingKey, key: item.key, type: item.type, title: item.title };
    for (const [name, field] of [['parentRatingKey', item.parentRatingKey], ['grandparentRatingKey', item.grandparentRatingKey], ['guid', item.guid], ['parentGuid', item.parentGuid], ['grandparentGuid', item.grandparentGuid], ['parentStudio', item.parentStudio], ['parentKey', item.parentKey], ['parentTitle', item.parentTitle], ['grandparentKey', item.grandparentKey], ['grandparentTitle', item.grandparentTitle], ['parentThumb', item.parentThumb], ['grandparentThumb', item.grandparentThumb], ['grandparentArt', item.grandparentArt], ['thumb', item.thumb], ['art', item.art]] as const) if (field !== undefined) value[name] = field;
    if (item.type === 'track') { value.librarySectionTitle = 'Music'; value.librarySectionID = 1; value.librarySectionKey = '/library/sections/1'; value.summary = item.summary ?? ''; }
    if (item.thumb) value.Image = [{ alt: item.title, type: 'coverPoster', url: item.thumb }, ...(item.art && item.art !== item.thumb ? [{ alt: item.title, type: 'background', url: item.art }] : [])];
    if (item.index !== undefined) value.index = item.index;
    if (item.parentIndex !== undefined) value.parentIndex = item.parentIndex;
    if (item.year !== undefined) value.year = item.year;
    if (item.parentYear !== undefined) value.parentYear = item.parentYear;
    if (item.duration !== undefined) value.duration = item.duration * 1000;
    if (item.genre) value.Genre = [{ tag: item.genre }];
    if (item.type === 'track' && item.media) value.Media = [{ id: 1, duration: (item.media.duration ?? item.duration ?? 0) * 1000, protocol: 'http', optimizedForStreaming: true, audioChannels: 2, container: item.media.container ?? 'mp3', audioCodec: item.media.audioCodec ?? 'mp3', bitrate: item.media.bitrate ?? 0, Part: [{ id: 1, key: item.media.partKey, duration: (item.media.duration ?? item.duration ?? 0) * 1000, size: item.media.size ?? 0, protocol: 'http', container: item.media.container ?? 'mp3' }] }];
    return value;
  });
  return JSON.stringify({ MediaContainer: { size: entries.length, totalSize: entries.length, offset: 0, allowSync: true, art: '/:/resources/artist-fanart.jpg', identifier: 'com.plexapp.plugins.library', librarySectionID: 1, librarySectionTitle: 'Music', librarySectionUUID: plexLibraryUuid, mediaTagPrefix: '/system/bundle/media/flags/', mediaTagVersion: 1, nocache: true, thumb: '/:/resources/artist.png', title1: 'Music', title2: viewGroup === 'artist' ? 'All Artists' : viewGroup === 'album' ? 'All Albums' : 'All Tracks', viewGroup, viewMode: 65592, Metadata: entries } });
}

