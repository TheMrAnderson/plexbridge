# Manual Phase 1 test procedure

1. Start with `docker compose up --build` and confirm `/health`, `/identity`, and `/library/sections` return successfully.
2. Stop and recreate the container without deleting `./config`; confirm the `machineIdentifier` in `/identity` is unchanged.
3. From the LAN, test GDM visibility with discovery enabled. Record whether the device is observed; discovery alone does not prove Plexamp connectivity.
4. In Plexamp, check whether PlexBridge is visible and attempt a connection. Capture only sanitized request paths, methods, status codes, and Plex client metadata.
5. Confirm whether Plexamp requests `/`, `/identity`, `/library/sections`, or additional endpoints. Unsupported paths should remain visible as 404 diagnostics.
6. Record the outcome in an experiment note. Do not attempt claim or registration requests until the relevant protocol is documented and the user explicitly authorizes a real-account test.

For the emulated server-side claim experiment, obtain a fresh short-lived claim token and send it to `POST /myplex/claim?token=...` while PlexBridge is running. The endpoint performs the cloud exchange without requiring a real Plex Media Server. Verify `/identity` reports `claimed="1"`, then verify the server appears in Plex account resources.

Success requires Plexamp to connect and request the synthetic library. A running container, a valid XML response, or a claim-token response alone is not success.

# Mix builders

Plexamp's Artist Mix Builder and Album Mix Builder share the same search request, so the builder must be entered from the appropriate Plexamp screen before searching. Artist Mix Builder searches artists; Album Mix Builder searches albums. Plexamp signals the active builder with a preceding `/library/all/top` request: `type=8` for artists and `type=9` for albums. PlexBridge remembers that context for 45 seconds per Plex client.

Artist mixes may expand through related artists when Navidrome's related-artist provider is available. Album mixes currently use only the albums selected by the user because similar-album data is not available.

# Moods

After a full sync, request `/library/sections/1/mood?type=9` and confirm the response contains the moods found in Navidrome song `Mood` tags. Select a mood and verify Plexamp follows its numeric key to albums. The same mood key should filter artists, albums, and tracks through `/library/sections/1/all?...&mood=<key>`. The sync writes the raw mood list to `/config/navidrome-moods.json` and the Plex key mapping to `/config/plex-mood-ids.json`.

For Best Of, request `/library/sections/1/all?type=9&year=<year>&viewCount%3E=1&sort=viewCount:desc`. Confirm only albums from that year with Navidrome play counts are returned, in descending play-count order, with `viewCount` and `lastViewedAt` present. Repeat with `type=10` for tracks and `type=8` to verify artist counts aggregated from credited songs.

For Sonic Adventure, search from the Sonic Adventure screen and confirm `/hubs/search` returns a `Tracks` hub. Select two tracks and confirm `/library/sections/1/computePath` is requested. Without an AudioMuse-AI/Navidrome sonic-similarity plugin, PlexBridge should still return a playable two-track queue. With the plugin installed and analyzed, the path should contain the returned intermediate tracks.

# Record labels

After a full sync, request `/library/sections/1/studio?type=9` and confirm the response contains album record labels. Select a label and verify Plexamp follows its numeric key to albums through `/library/sections/1/all?type=9&studio=<key>`. The sync writes the label list to `/config/navidrome-record-labels.json` and the Plex key mapping to `/config/plex-studio-ids.json`.
