export type LogLevel = 'ERROR' | 'WARNING' | 'INFO' | 'DEBUG' | 'TRACE';

function booleanValue(name: string, value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (!['true', 'false'].includes(value.toLowerCase())) throw new Error(`${name} must be true or false`);
  return value.toLowerCase() === 'true';
}

export interface Settings {
  host: string;
  port: number;
  publicPort: number;
  webPort?: number;
  serverName: string;
  publicUrl: string;
  discoveryEnabled: boolean;
  preserveSourceFormats: boolean;
  logLevel: LogLevel;
  configDir: string;
  navidromeUrl: string;
  navidromeUsername: string;
  navidromePassword: string;
  webUsername?: string;
  webPassword?: string;
}

export function loadSettings(env = process.env): Settings {
  const port = Number(env.PLEXBRIDGE_PORT ?? 32400);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('PLEXBRIDGE_PORT must be between 1 and 65535');
  const publicPort = Number(env.PLEXBRIDGE_PUBLIC_PORT ?? 32400);
  if (!Number.isInteger(publicPort) || publicPort < 1 || publicPort > 65535)
    throw new Error('PLEXBRIDGE_PUBLIC_PORT must be between 1 and 65535');
  const webPort = env.PLEXBRIDGE_WEB_PORT ? Number(env.PLEXBRIDGE_WEB_PORT) : undefined;
  if (webPort !== undefined && (!Number.isInteger(webPort) || webPort < 1 || webPort > 65535))
    throw new Error('PLEXBRIDGE_WEB_PORT must be between 1 and 65535');
  const logLevel = (env.PLEXBRIDGE_LOG_LEVEL ?? 'INFO').toUpperCase() as LogLevel;
  if (!['ERROR', 'WARNING', 'INFO', 'DEBUG', 'TRACE'].includes(logLevel))
    throw new Error('PLEXBRIDGE_LOG_LEVEL must be ERROR, WARNING, INFO, DEBUG, or TRACE');
  return {
    host: env.PLEXBRIDGE_HOST ?? '0.0.0.0',
    port,
    publicPort,
    webPort,
    serverName: env.PLEXBRIDGE_SERVER_NAME ?? 'PlexBridge',
    publicUrl: env.PLEXBRIDGE_PUBLIC_URL ?? '',
    discoveryEnabled: booleanValue('PLEXBRIDGE_DISCOVERY_ENABLED', env.PLEXBRIDGE_DISCOVERY_ENABLED, true),
    preserveSourceFormats: booleanValue(
      'PLEXBRIDGE_PRESERVE_SOURCE_FORMATS',
      env.PLEXBRIDGE_PRESERVE_SOURCE_FORMATS,
      true
    ),
    logLevel,
    configDir: env.PLEXBRIDGE_CONFIG_DIR ?? './config',
    navidromeUrl: env.NAVIDROME_URL ?? '',
    navidromeUsername: env.NAVIDROME_USERNAME ?? '',
    navidromePassword: env.NAVIDROME_PASSWORD ?? '',
    webUsername: env.PLEXBRIDGE_WEB_USERNAME,
    webPassword: env.PLEXBRIDGE_WEB_PASSWORD
  };
}
