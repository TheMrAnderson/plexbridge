# Architecture

PlexBridge has two deliberately separate sides:

```text
Plex clients (Plexamp, Plex Web, other Plex clients)
        |
        v
src/plex/       Plex identity, registration, TLS, discovery, and protocol responses
        |
        v
src/music/      provider-neutral music library contract
        |
        v
src/music/navidrome/  Navidrome/Subsonic adapter (the current provider)
```

## Boundaries

- `src/plex/` owns the Plex-facing contract. It contains the Plex account and claim flows, server registration and pubsub, certificate enrollment, GDM discovery, Plex headers, and XML/JSON response rendering.
- `src/music/types.ts` defines the provider-neutral music model and operations used by the application: artists, albums, songs, genres, playlists, artwork, streams, and playlist updates.
- `src/music/provider.ts` is the composition point for selecting a music provider. Navidrome is the current implementation.
- `src/music/navidrome/client.ts` translates the provider contract to Navidrome's Subsonic API, including play scrobbles. A future Jellyfin, LMS, or other adapter belongs in a sibling directory and should implement `MusicProvider`; Plex routes should not call that adapter directly.
- `src/app.ts` composes dependencies, installs common hooks, exposes health and claim/admin endpoints, and registers the route groups. It is the application coordinator, not a provider implementation.
- Browser requests to `/` receive the listening dashboard; Plex clients that request the same path with protocol media types continue to receive the Plex server root response. Successful scrobbles are persisted as recent play records under the configured runtime directory and are shown only to an authenticated Plex account on the dashboard.
- `src/plex/library-routes.ts` owns library browsing, metadata, playback, transcoding, artwork, and timeline routes. It tracks playback per Plex player and sends one provider scrobble after effective progress reaches 75% of the reported duration. Plexamp commonly sends only a track-start timeline event, so when the next track starts the route uses elapsed active time to finalize the previous track; a short skip is therefore not scrobbled. When duration is absent, it resolves the track duration from the provider and tracks active playing time. A 110% active-progress timer is retained as a last-ditch fallback for a client that never reports the next track. Paused intervals do not count, while buffering intervals remain active playback time. The route also forwards Plex clients' explicit `/:/scrobble` and `PUT /:/rate` requests immediately.
- `src/plex/playlist-routes.ts` owns Plex playlist discovery, playlist items, composite artwork, queues, and playlist updates.
- `src/plex/admin-page.ts` owns the setup page markup so UI text does not live inside the server composition function.
- `src/cli/` contains the explicit account, claim, and registration commands.

## Request flow

For a library request, Plexamp calls a Plex-shaped route in `app.ts`. The route asks the `MusicProvider` for provider-neutral records, maps those records to Plex metadata, and returns the response expected by the client. Streams and artwork follow the same route but proxy the provider's media URL through PlexBridge so clients never need to understand the provider API.

Identity, Plex credentials, certificate material, the Plex-to-provider playlist ID map, and recent play history are runtime state under the configured config directory. They are not source artifacts and must not be committed or included in a release package.

## Adding another music server

1. Add an adapter under `src/music/<provider>/`.
2. Implement `MusicProvider` using that server's native API.
3. Add provider selection in `src/music/provider.ts` and configuration for the new adapter.
4. Keep Plex response shaping in `src/plex/protocol.ts` and `src/app.ts`.
5. Add adapter tests and update the README/configuration documentation.
