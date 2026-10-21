export type LogLevel = 'ERROR' | 'WARNING' | 'INFO' | 'DEBUG' | 'TRACE';

function booleanValue(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (!['true', 'false'].includes(value.toLowerCase())) throw new Error('PLEXBRIDGE_DISCOVERY_ENABLED must be true or false');
  return value.toLowerCase() === 'true';
}

export interface Settings {
  host: string;
  port: number;
  serverName: string;
  publicUrl: string;
  discoveryEnabled: boolean;
  logLevel: LogLevel;
  configDir: string;
  navidromeUrl: string;
  navidromeUsername: string;
  navidromePassword: string;
}

export function loadSettings(env = process.env): Settings {
  const port = Number(env.PLEXBRIDGE_PORT ?? 32400);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PLEXBRIDGE_PORT must be between 1 and 65535');
  const logLevel = (env.PLEXBRIDGE_LOG_LEVEL ?? 'INFO').toUpperCase() as LogLevel;
  if (!['ERROR', 'WARNING', 'INFO', 'DEBUG', 'TRACE'].includes(logLevel)) throw new Error('PLEXBRIDGE_LOG_LEVEL must be ERROR, WARNING, INFO, DEBUG, or TRACE');
  return {
    host: env.PLEXBRIDGE_HOST ?? '0.0.0.0',
    port,
    serverName: env.PLEXBRIDGE_SERVER_NAME ?? 'PlexBridge',
    publicUrl: env.PLEXBRIDGE_PUBLIC_URL ?? '',
    discoveryEnabled: booleanValue(env.PLEXBRIDGE_DISCOVERY_ENABLED, true),
    logLevel,
    configDir: env.PLEXBRIDGE_CONFIG_DIR ?? './config',
    navidromeUrl: env.NAVIDROME_URL ?? '',
    navidromeUsername: env.NAVIDROME_USERNAME ?? '',
    navidromePassword: env.NAVIDROME_PASSWORD ?? ''
  };
}

