# PlexBridge

PlexBridge is a Dockerized HTTP service that presents a persistent Plex-shaped identity and exposes a Plex-compatible music library backed by Navidrome.

PlexBridge is released under the [GNU Affero General Public License v3.0](LICENSE).

## Current status

The prototype is usable with Plexamp and has been tested end to end with Navidrome. It supports library browsing, playlists, artwork, queues, downloads, format-aware playback, and timeline-based Navidrome scrobbling. See [`ARCHITECTURE.md`](ARCHITECTURE.md) for current behavior and boundaries.

## Run

```sh
cp .env.example .env
docker compose up -d
curl http://127.0.0.1:32400/identity
curl http://127.0.0.1:32400/health
```

Deployment, Docker/macvlan setup, Plex onboarding, configuration, and troubleshooting are documented in [`docs/deployment.md`](docs/deployment.md).

## Development

```sh
npm install
npm test
```

`npm run check` runs linting and formatting checks. Use `npm run format` to apply the repository formatter. Local development requires Node.js 22 or newer. `npm run dev` stores identity data in `./config`.

The source is organized by responsibility: Plex-facing behavior is under `src/plex`, the provider-neutral music contract is under `src/music`, and the Navidrome adapter is under `src/music/navidrome`.

## Documentation

Read [`DOCUMENTATION.md`](DOCUMENTATION.md) for the documentation map, [`ARCHITECTURE.md`](ARCHITECTURE.md) for system structure, and [`docs/plex-protocol.md`](docs/plex-protocol.md) for implemented Plex protocol behavior.
