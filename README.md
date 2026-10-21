# PlexBridge

PlexBridge is a small Dockerized HTTP service that presents a persistent, Plex-shaped identity and exposes a Plex-compatible music library backed by an external music server. Navidrome is the first supported provider and Plex is the client-facing protocol endpoint.

## Current status

The current prototype is usable with Plexamp and has been tested end to end with
Navidrome:

- Plex account claim, registration, Plex-direct TLS, and external reachability work.
- Plexamp can discover PlexBridge and browse a real music library.
- Artists, albums, tracks, genres, playlists, artwork, queues, downloads, and
  playlist continuation work.
- FLAC can play directly; formats Plexamp does not accept are served as MP3
  through Navidrome transcoding.
- Timeline updates are tracked per Plex player. After a track reaches half its
  reported duration, PlexBridge sends one Navidrome scrobble.

The project is still an early Plex protocol implementation. Directly starting
an individual track creates a one-track queue by design; start from an album or
playlist for online continuation. Plexamp sends sparse timeline updates, so
scrobble timing depends on the progress information it reports.

## Run

```sh
cp .env.example .env
docker compose up -d
curl http://127.0.0.1:32400/identity
curl http://127.0.0.1:32400/health
```

Images are published to `ghcr.io/themranderson/plexbridge` from the `main`
branch and version tags. The included `compose.yaml` runs the published
`latest` image. To build from local source instead, run `docker build` directly
or create a local Compose override with `build: .`.

The package must be public, or Docker must be logged in to GHCR before startup:

```sh
echo "$GH_PACKAGES_READ_TOKEN" | docker login ghcr.io -u TheMrAnderson --password-stdin
```

The intended deployment is a persistent Docker container. Keep the `./config:/config`
volume so the Plex identity, account/server credentials, playlist mappings, and
Plex-direct certificate survive container recreation.

After the container starts, open `http://<host>:32400/admin` in a browser. The
normal onboarding flow is:

1. Use **Login to Plex** if account authentication is needed.
2. Paste a short-lived token from `https://www.plex.tv/claim` and choose
   **Claim and register**, or choose **Register existing claim** for a server
   that already has a Plex claim.
3. Keep the container running while Plex confirms the account resource and
   external connection.
4. Restart the container after the first Plex-direct certificate enrollment so
   port 32400 starts with the persisted HTTPS certificate.

Once registered, Plexamp should discover the server through the advertised
Plex-direct connection. Do not delete `./config` unless you intentionally want
to create a new Plex server identity and repeat onboarding.

After enrollment, the local admin page remains available at
`http://<host>:32400/admin`. The trusted HTTPS form uses the generated
Plex-direct hostname, for example
`https://<public-ip-with-dashes>.<certificate-id>.plex.direct:32400/admin`;
do not substitute the raw IP for that hostname because the certificate does
not cover the IP address directly.

`GET /health` reports claim and live Plex registration separately: `claimed`,
`published`, `present`, `presence`, `accessTokenReady`, and `connectionUrl`.
Registration is only access-token-ready when Plex has issued a non-empty server token.

Open `http://127.0.0.1:32400/admin` for the basic Plex setup page. Paste a short-lived
token from `https://www.plex.tv/claim` and use **Claim and register** to avoid creating
a separate Plex client device. The optional login button starts the PIN-based account
flow. The page displays only non-secret registration status. Keep it behind trusted
access; claim performs account-affecting Plex operations.

Set `PLEXBRIDGE_PUBLIC_URL` in `.env` to an HTTPS hostname that resolves to the
public IP of the host running PlexBridge, for example
`https://plexbridge.example.com`. A dedicated subdomain is recommended; the
root domain is also valid if it resolves to the same host. This value is used
to determine the public address, while PlexBridge advertises the generated
trusted `plex.direct` hostname to Plex. Compose passes it into the container;
registration cannot publish PlexBridge without it. The host HTTP port can be
changed with `PLEXBRIDGE_HOST_PORT`. Identity data is stored in `./config`; do
not commit that directory. GDM discovery uses UDP ports 32410, 32412, 32413,
and 32414. Discovery is disabled with
`PLEXBRIDGE_DISCOVERY_ENABLED=false`.

Set `NAVIDROME_URL`, `NAVIDROME_USERNAME`, and `NAVIDROME_PASSWORD` in `.env`. Navidrome is the current music-provider adapter; PlexBridge talks to it through a provider-neutral interface so additional music servers can be added later. In Docker, `NAVIDROME_URL` must be reachable from the PlexBridge container, typically by using the Navidrome service name on a shared Docker network.

## Tests

```sh
npm install
npm test
```

Local development requires Node.js 22 or newer.

`npm run dev` stores identity data in `./config`. Docker Compose overrides this to `/config` inside the container, backed by the same host directory.

The source is organized by responsibility: Plex-facing behavior is under
`src/plex`, the provider-neutral music contract is under `src/music`, and the
Navidrome adapter is under `src/music/navidrome`. See
[`ARCHITECTURE.md`](ARCHITECTURE.md) before adding another provider.

## Plex account authentication experiment

Run `npm run plex:login`, open the displayed Plex authorization URL, and approve PlexBridge. The command polls Plex, then stores the resulting account token in `./config/plex-credentials.json` with restrictive permissions and prints a sanitized account/resource summary. Never commit or share that file.

This authenticates PlexBridge as a Plex client and queries the account's resource list. It is useful when repairing or re-establishing an existing Plex account association; it is not a substitute for the server claim flow.

## Plex server claim experiment

After `npm run plex:login` succeeds, `npm run plex:claim` obtains a short-lived claim token, exchanges it for a server token, publishes the configured `PLEXBRIDGE_PUBLIC_URL`, and verifies the authenticated account resource list. The emulated server-side flow is `POST /myplex/claim?token=<short-lived-token>`; it performs the same exchange and publication. Tokens are never printed. A matching account resource is required before claiming registration success.

If the server has already been claimed, run `npm run plex:register` to republish its configured public connection and recheck Plex account registration without requesting another claim token.

Registration enrolls a Plex-issued `plex.direct` certificate when one is not already present. The first enrollment stores `config/plex-tls-key.pem` and `config/plex-tls-cert.pem`; restart PlexBridge afterward so port 32400 serves the trusted Plex-direct HTTPS connection used by Plexamp.

The browser setup page is available at `/admin`. It disables Plex login and claim once a server token exists to prevent duplicate Plex devices, and provides a separate `Register existing claim` action for republishing an already-claimed server.

## Scope and next work

Implemented: persistent machine identity, Plex account registration, Plex-direct
TLS, XML and JSON Plex responses, provider-backed music browsing, playlists,
artwork, queues, downloads, playlist updates, format-aware streaming,
timeline-based scrobbling, registration health diagnostics, redacted request
logging, explicit unsupported-endpoint responses, and configurable GDM
listeners.

Not yet implemented: full Plex metadata management, search, and general-purpose
transcoding. Additional music providers such as Jellyfin are future work. See
[`ARCHITECTURE.md`](ARCHITECTURE.md), [`docs/plex-protocol.md`](docs/plex-protocol.md),
and [`docs/manual-test.md`](docs/manual-test.md).

