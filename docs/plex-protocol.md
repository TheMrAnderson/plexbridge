# Plex protocol research

This document records the Phase 1 starting point. Observations are deliberately separated from hypotheses; a successful local HTTP response is not evidence that Plexamp will accept or register the server.

## Verified from references

- Plex's current developer documentation describes the Plex Media Server API and uses `/library/sections` as a library endpoint.
- The community-maintained OpenAPI description models `/` and `/identity` as XML-capable `MediaContainer` responses and identifies `machineIdentifier` as the persistent server identity field.
- Plex Support documents GDM local discovery and lists UDP 32410, 32412, 32413, and 32414 as current discovery ports.
- Plex Support describes `X-Plex-Token` as the token used for authenticated server access.

References: [Plex Media Server API](https://developer.plex.tv/pms/), [Plex API OpenAPI description](https://github.com/LukasParke/plexapi-dev-docs/blob/main/spec/plex-media-server.openapi.json), [Plex network guidance](https://support.plex.tv/articles/200430283-network/), [Plex port guidance](https://support.plex.tv/articles/201543147-what-network-ports-do-i-need-to-allow-through-my-firewall/), [X-Plex-Token guidance](https://support.plex.tv/articles/204059436-finding-an-authentication-token-x-plex-token/).

## Verified Plexamp playback and scrobbling behavior

The following behavior was verified against Plexamp using PlexBridge and Navidrome. Playback times and durations in Plex timeline requests are milliseconds.

- Plexamp sends `/:/timeline` requests with `state=playing`, a track `ratingKey` such as `s-<provider-id>`, a metadata `key`, and the reported duration. In the observed client flow, it sends a start event for each track rather than periodic progress events.
- A pause/resume sequence can produce `state=paused&time=0` followed by `state=playing&time=400`; a brief skip is not enough to scrobble the track.
- When the next track starts, PlexBridge finalizes the previous track using elapsed active time between the two start events. It sends one Navidrome `scrobble` call when effective progress reaches 75% of the track duration. Effective progress is the reported position plus elapsed active time, so a track resumed in the middle can still cross the threshold correctly.
- Paused time does not count toward effective progress. Buffering time counts as active playback time because Plexamp is still progressing through the playback transition.
- If Plexamp never sends the next track event, PlexBridge retains a 110% active-progress timer as a last-ditch fallback. This is not the normal completion path for Plexamp's observed start-only reporting pattern.
- Plexamp may send `PUT /:/rate` when it explicitly marks a track played. PlexBridge treats that request as an immediate explicit scrobble. It also accepts `GET`, `POST`, and `PUT` timeline requests.

Successful provider scrobbles are logged as `music_scrobbled` and are written to the recent play history shown by the browser dashboard. Provider failures are logged as `music_scrobble_failed` and do not create play-history entries.

### Known reporting limitation

If Plexamp resumes a paused, already-buffered track without sending a timeline, rate, or stream request, PlexBridge receives no new playback signal. It cannot reliably distinguish resumed listening from a track that remains paused, so it does not invent a scrobble for that silent transition.

## Not established yet

Plex's public documentation does not establish that an independently implemented server can complete the official server claim, account resource registration, connection advertisement, or Plexamp trust flow. The claim token exchange and the server appearing in an authenticated account's resources must be tested independently. This project therefore does not send claim tokens anywhere yet and does not claim registration success.

The first account experiment uses Plex's documented client PIN/device flow, then calls `/api/v2/user` and `/api/v2/resources` with the returned account token. A successful result proves account authentication and resource visibility only; it is not proof that PlexBridge has been registered as a server.

The first server-claim experiment is recorded in [`docs/experiments/2026-10-20-claim.md`](experiments/2026-10-20-claim.md). The claim exchange returned HTTP 200 and a server token, but Plex did not publish PlexBridge in the account resource list. The result is therefore not a successful registration.

The official Plex Docker bootstrap derives `ProcessedMachineIdentifier` as the SHA-1 of `<MachineIdentifier>- Plex Media Server` and persists `customConnections` before/around claim. PlexBridge follows that identifier derivation and advertises `PLEXBRIDGE_PUBLIC_URL` as its custom connection when configured. The proprietary PMS process then publishes to `POST https://plex.tv/servers.xml`, updates `PUT https://servers.plex.tv/devices/{ProcessedMachineIdentifier}`, and performs a later reachability transition. PlexBridge mirrors those calls, records HTTP statuses, retries only transient failures, and exposes separate claim/publication/resource/presence/access-token health states.

The live registration exercise on 2026-10-20 reached the same backend state observed in PMS reports: publish returned HTTP 422, device update returned HTTP 200, and the connectivity route returned HTTP 404. Plex resources still reported `owned=true`, the Caddy connection URL, `presence=false`, and an empty `accessToken`; PlexBridge was present as an account resource but absent from `servers.xml`. This is not registration success and likely requires Plex-side repair of the server registration/mapping record. No Plex devices were deleted or reset.

The exact GDM datagram request/response behavior expected by Plexamp also needs packet-level validation against a real client. The listener is intentionally minimal and experimental.

Playlist compatibility is based on live PMS responses: PlexBridge advertises `/playlists/all`, returns PMS-shaped playlist containers and playlist-item metadata, and serves the advertised `/playlists/{id}/composite/{timestamp}` artwork route from the playlist's first track artwork.

## Experiment record

Record each manual attempt in `docs/experiments/` with date, client version, sanitized request/response details, and outcome. Never include `X-Plex-Token`, claim tokens, credentials, authorization headers, or raw sensitive payloads.

## Fallback

Only after standalone experiments are complete should a legitimate Plex Media Server reverse-proxy fallback be investigated. It is not part of this implementation.
