# Implementation notes

## Plex synthetic IDs

Plex-compatible directory keys are not arbitrary-length identifiers. When PlexBridge creates synthetic IDs, keep them short numeric values. The playlist mapping in `/config/plex-playlist-ids.json` is the precedent: its Plex keys are values such as `10000`, `10001`, and so on.

Genre IDs follow the same rule and are persisted in `/config/plex-genre-ids.json`. Do not put long hashes or nine-digit IDs into Plex directory `key` values; Plexamp may silently omit the resulting entries even when the endpoint returns `200` and the data is otherwise correct.

Mood IDs use the same short numeric strategy and are persisted in `/config/plex-mood-ids.json`. Navidrome supplies mood values as song metadata rather than through the standard Subsonic `getGenres` response, so mood directories must be derived from the full song snapshot.

Playback history separates `active` tracking from completed `plays` in `/config/play-history.json`. Plexamp may send an explicit scrobble-like request when playback begins; that signal must not become a recent play until the normal 75% playback threshold is reached.

Record-label directory keys use the same short numeric strategy and are persisted in `/config/plex-studio-ids.json`. Plexamp calls this Plex dimension `studio`, while Navidrome calls the album metadata field `recordLabel`.

Navidrome's durable `playCount` and `played` fields are passed through as Plex `viewCount` and `lastViewedAt`. Best Of queries can therefore support year/count/sort filters without turning PlexBridge's intentionally limited recent play history into a media-server history database.

Sonic Adventure is optional: Navidrome's OpenSubsonic `findSonicPath` extension is used when available, while missing sonic analysis falls back to the two requested tracks. The Plex `/computePath` request is followed by a `/playQueues` request whose `playlistID` contains comma-separated synthetic `s-...` track IDs.

