# Deployment and operations

## Docker Compose

The intended deployment is a persistent Docker container. Keep the `./config:/config` volume so the Plex identity and per-installation music-library UUID, account/server credentials, playlist mappings, play history, and Plex-direct certificate survive container recreation.

Images are published to `ghcr.io/themranderson/plexbridge` from the `main` branch and version tags. The included `compose.yaml` runs the published `latest` image. To build from local source instead, run `docker build` directly or create a local Compose override with `build: .`.

The browser dashboard is available at `http://<host>/`; setup is at `http://<host>/admin`. The dashboard is protected by PlexBridge's local web login, while Plex remains available on port 32400 without that browser session. The dashboard host port is controlled by `PLEXBRIDGE_WEB_HOST_PORT` and defaults to 80.

## Direct Docker

Configure `.env` and run:

```sh
bash scripts/docker-run.sh
```

The launcher passes `.env` into the container, publishes Plex on `32400`, publishes the dashboard on `PLEXBRIDGE_WEB_HOST_PORT`, mounts `./config`, and preserves the GDM UDP ports. Override the image, environment file, or config directory with `PLEXBRIDGE_IMAGE`, `PLEXBRIDGE_ENV_FILE`, or `PLEXBRIDGE_CONFIG_DIR_HOST`.

## Macvlan

Macvlan bypasses Docker host-port mappings. Set the web listener inside the container instead:

```env
PLEXBRIDGE_WEB_PORT=80
```

Then access the dashboard at `http://<container-ip>/`. The Compose file and direct Docker launcher grant `NET_BIND_SERVICE` so the non-root process can bind port 80. The Plex listener remains on 32400.

## Plex onboarding

1. Paste a short-lived token from `https://www.plex.tv/claim` into `/admin` and choose **Claim this server**.
2. Restart the container once after the first Plex-direct certificate enrollment so port 32400 starts with the persisted HTTPS certificate.
3. Choose **Sign in to Plex** and approve the PIN. PlexBridge resumes registration automatically.

Once registered, Plexamp should discover the server through the advertised Plex-direct connection. Do not delete `./config` unless intentionally creating a new Plex server identity.

`GET /health` reports claim and live Plex registration separately, including `claimed`, `published`, `present`, `presence`, `accessTokenReady`, and `connectionUrl`.

## Configuration

Set `PLEXBRIDGE_PUBLIC_URL` to an HTTPS hostname that resolves to the public IP of the host running PlexBridge. `PLEXBRIDGE_PUBLIC_PORT` controls the external host port exposed by Compose and advertised to Plex; the container continues listening on its internal port 32400. If multiple instances share one public IP, give each instance a distinct public port and forward it to that instance's host port. `PLEXBRIDGE_HOST_PORT` remains a legacy fallback when `PLEXBRIDGE_PUBLIC_PORT` is not set. For macvlan, use `PLEXBRIDGE_WEB_PORT` for the dashboard listener. GDM discovery uses UDP ports 32410, 32412, 32413, and 32414, and can be disabled with `PLEXBRIDGE_DISCOVERY_ENABLED=false`.

Set `NAVIDROME_URL`, `NAVIDROME_USERNAME`, and `NAVIDROME_PASSWORD`. In Docker, `NAVIDROME_URL` must be reachable from the PlexBridge container, typically by using the Navidrome service name on a shared Docker network.

Set `PLEXBRIDGE_LOG_LEVEL=DEBUG` for request summaries. Set `PLEXBRIDGE_LOG_LEVEL=TRACE` to also log incoming request URLs, query parameters, relevant Plex headers, remote addresses, and response content types. Authentication tokens and password-like values are redacted. Repetitive `GET /playQueues/:id` polling is omitted from DEBUG/TRACE request logs; queue creation and mutation requests remain visible. PubSub keepalive/SSE transport chunks are omitted from registration logs; meaningful PubSub events remain visible.

The web login uses `PLEXBRIDGE_WEB_USERNAME` and `PLEXBRIDGE_WEB_PASSWORD` when they are provided. If they are omitted on first startup, PlexBridge generates an administrator username and one-time password and logs them once. The generated credentials and session signing secret are stored in `/config/web-auth.json`; keep the config volume private. The first-run setup path may also be used from localhost. PlexBridge performs a full Navidrome library sync during startup, then can repeat it daily according to the authenticated `/admin` sync settings. Those settings are stored in `/config/plexbridge-settings.json`; environment-provided Navidrome values take precedence over website values.

The sync keeps the small `/config/navidrome-library.json` manifest plus separate `navidrome-artists.json`, `navidrome-albums.json`, `navidrome-songs.json`, `navidrome-playlists.json`, `navidrome-genres.json`, `navidrome-moods.json`, and `navidrome-record-labels.json` snapshots. Moods are derived from the `Mood` tags on Navidrome songs. Record labels are derived from album metadata. Plex-compatible mood and record-label IDs are persisted in `/config/plex-mood-ids.json` and `/config/plex-studio-ids.json`.

The album and song snapshots also retain Navidrome's per-user play counts and last-played timestamps. These values support Plexamp Best Of queries without expanding PlexBridge's own 100-play recent history.

Active Plexamp play queues are persisted in `/config/play-queues.json`, so queue IDs and their contents survive a restart. Clearing a known queue removes it from persistent storage; the immediate follow-up GET returns a temporary empty queue response so Plexamp can discard its local queue. Clearing an unknown or stale queue also returns an empty HTTP 200 response without creating persistent state. `/config/play-history.json` keeps completed recent plays in `plays` and in-progress playback signals in `active`; an active item is promoted to recent history only after the normal scrobble threshold is reached.

## CLI authentication experiments

`npm run plex:login` authenticates PlexBridge as a Plex client and stores the account token in `./config/plex-credentials.json`. Never commit or share that file. After login, `npm run plex:claim` performs the claim flow; if the server is already claimed, use `npm run plex:register` to republish its connection.
