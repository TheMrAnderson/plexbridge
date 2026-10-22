# Manual Phase 1 test procedure

1. Start with `docker compose up --build` and confirm `/health`, `/identity`, and `/library/sections` return successfully.
2. Stop and recreate the container without deleting `./config`; confirm the `machineIdentifier` in `/identity` is unchanged.
3. From the LAN, test GDM visibility with discovery enabled. Record whether the device is observed; discovery alone does not prove Plexamp connectivity.
4. In Plexamp, check whether PlexBridge is visible and attempt a connection. Capture only sanitized request paths, methods, status codes, and Plex client metadata.
5. Confirm whether Plexamp requests `/`, `/identity`, `/library/sections`, or additional endpoints. Unsupported paths should remain visible as 404 diagnostics.
6. Record the outcome in an experiment note. Do not attempt claim or registration requests until the relevant protocol is documented and the user explicitly authorizes a real-account test.

For the emulated server-side claim experiment, obtain a fresh short-lived claim token and send it to `POST /myplex/claim?token=...` while PlexBridge is running. The endpoint performs the cloud exchange without requiring a real Plex Media Server. Verify `/identity` reports `claimed="1"`, then verify the server appears in Plex account resources.

Success requires Plexamp to connect and request the synthetic library. A running container, a valid XML response, or a claim-token response alone is not success.
