# Deployment and operations

## Docker Compose

The intended deployment is a persistent Docker container. Keep the
`./config:/config` volume so the Plex identity, account/server credentials,
playlist mappings, play history, and Plex-direct certificate survive container
recreation.

Images are published to `ghcr.io/themranderson/plexbridge` from the `main`
branch and version tags. The included `compose.yaml` runs the published
`latest` image. To build from local source instead, run `docker build` directly
or create a local Compose override with `build: .`.

The browser dashboard is available at `http://<host>/`; setup is at
`http://<host>/admin`. Plex remains available on port 32400. The dashboard host
port is controlled by `PLEXBRIDGE_WEB_HOST_PORT` and defaults to 80.

## Direct Docker

Configure `.env` and run:

```sh
bash scripts/docker-run.sh
```

The launcher passes `.env` into the container, publishes Plex on `32400`,
publishes the dashboard on `PLEXBRIDGE_WEB_HOST_PORT`, mounts `./config`, and
preserves the GDM UDP ports. Override the image, environment file, or config
directory with `PLEXBRIDGE_IMAGE`, `PLEXBRIDGE_ENV_FILE`, or
`PLEXBRIDGE_CONFIG_DIR_HOST`.

## Macvlan

Macvlan bypasses Docker host-port mappings. Set the web listener inside the
container instead:

```env
PLEXBRIDGE_WEB_PORT=80
```

Then access the dashboard at `http://<container-ip>/`. The Compose file and
direct Docker launcher grant `NET_BIND_SERVICE` so the non-root process can bind
port 80. The Plex listener remains on 32400.

## Plex onboarding

1. Paste a short-lived token from `https://www.plex.tv/claim` into `/admin` and
   choose **Claim this server**.
2. Restart the container once after the first Plex-direct certificate
   enrollment so port 32400 starts with the persisted HTTPS certificate.
3. Choose **Sign in to Plex** and approve the PIN. PlexBridge resumes
   registration automatically.

Once registered, Plexamp should discover the server through the advertised
Plex-direct connection. Do not delete `./config` unless intentionally creating
a new Plex server identity.

`GET /health` reports claim and live Plex registration separately, including
`claimed`, `published`, `present`, `presence`, `accessTokenReady`, and
`connectionUrl`.

## Configuration

Set `PLEXBRIDGE_PUBLIC_URL` to an HTTPS hostname that resolves to the public IP
of the host running PlexBridge. The host Plex port is controlled by
`PLEXBRIDGE_HOST_PORT`; for macvlan, use `PLEXBRIDGE_WEB_PORT` for the dashboard
listener. GDM discovery uses UDP ports 32410, 32412, 32413, and 32414, and can
be disabled with `PLEXBRIDGE_DISCOVERY_ENABLED=false`.

Set `NAVIDROME_URL`, `NAVIDROME_USERNAME`, and `NAVIDROME_PASSWORD`. In Docker,
`NAVIDROME_URL` must be reachable from the PlexBridge container, typically by
using the Navidrome service name on a shared Docker network.

## CLI authentication experiments

`npm run plex:login` authenticates PlexBridge as a Plex client and stores the
account token in `./config/plex-credentials.json`. Never commit or share that
file. After login, `npm run plex:claim` performs the claim flow; if the server
is already claimed, use `npm run plex:register` to republish its connection.
