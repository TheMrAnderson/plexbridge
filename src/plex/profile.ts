import type { Identity } from '../identity.js';

// The PMS-compatible identity is defined once and reused by every Plex API
// flow. Endpoint-specific client identifiers remain explicit at the call site.
export const PLEX_SERVER_PRODUCT = 'Plex Media Server';
export const PLEX_AUTH_PRODUCT = 'PlexBridge';
export const PLEX_SERVER_VERSION = '1.43.5.11029-6bf8af3f0';
export const PLEX_SERVER_PLATFORM = 'Linux';
export const PLEX_SERVER_PLATFORM_VERSION = process.env.PLEX_PLATFORM_VERSION ?? process.platform;
export const PLEX_SERVER_DEVICE = 'Docker Container';
export const PLEX_SERVER_MODEL = 'x86_64';
export const PLEX_SERVER_VENDOR = 'Docker';

export function plexAuthClientIdentifier(identity: Identity): string {
  return `${identity.machineIdentifier}-auth`;
}

export function plexServerHeaders(identity: Identity, serverName: string, token?: string, clientIdentifier = identity.machineIdentifier): Record<string, string> {
  return {
    Accept: '*/*',
    'User-Agent': `PlexMediaServer/${PLEX_SERVER_VERSION}`,
    'X-Plex-Product': PLEX_SERVER_PRODUCT,
    'X-Plex-Version': PLEX_SERVER_VERSION,
    'X-Plex-Provides': 'server',
    'X-Plex-Platform': PLEX_SERVER_PLATFORM,
    'X-Plex-Platform-Version': PLEX_SERVER_PLATFORM_VERSION,
    'X-Plex-Device': PLEX_SERVER_DEVICE,
    'X-Plex-Device-Name': serverName,
    'X-Plex-Model': PLEX_SERVER_MODEL,
    'X-Plex-Device-Vendor': PLEX_SERVER_VENDOR,
    'X-Plex-Client-Identifier': clientIdentifier,
    ...(token ? { 'X-Plex-Token': token } : {}),
  };
}
