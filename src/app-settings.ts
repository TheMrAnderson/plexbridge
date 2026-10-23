import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Settings } from './config.js';

export interface AppSettings {
  navidromeUrl: string;
  navidromeUsername: string;
  navidromePassword: string;
  syncEnabled: boolean;
  syncTime: string;
}

const defaults: AppSettings = {
  navidromeUrl: '',
  navidromeUsername: '',
  navidromePassword: '',
  syncEnabled: true,
  syncTime: '03:00'
};

function validTime(value: unknown): value is string {
  return typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

export async function loadAppSettings(configDir: string, settings: Settings): Promise<AppSettings> {
  let stored: Partial<AppSettings> = {};
  try {
    stored = JSON.parse(await readFile(join(configDir, 'plexbridge-settings.json'), 'utf8')) as Partial<AppSettings>;
  } catch {
    /* First run or an older installation. */
  }
  return {
    navidromeUrl: settings.navidromeUrl || stored.navidromeUrl || defaults.navidromeUrl,
    navidromeUsername: settings.navidromeUsername || stored.navidromeUsername || defaults.navidromeUsername,
    navidromePassword: settings.navidromePassword || stored.navidromePassword || defaults.navidromePassword,
    syncEnabled: typeof stored.syncEnabled === 'boolean' ? stored.syncEnabled : defaults.syncEnabled,
    syncTime: validTime(stored.syncTime) ? stored.syncTime : defaults.syncTime
  };
}

export async function saveAppSettings(configDir: string, value: AppSettings): Promise<void> {
  await mkdir(configDir, { recursive: true });
  await writeFile(join(configDir, 'plexbridge-settings.json'), `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

export function validateAppSettings(value: Partial<AppSettings>): string | undefined {
  if (value.navidromeUrl !== undefined && value.navidromeUrl !== '' && !/^https?:\/\//i.test(value.navidromeUrl))
    return 'Navidrome URL must start with http:// or https://';
  if (value.syncTime !== undefined && !validTime(value.syncTime)) return 'Sync time must use HH:MM format';
  if (value.navidromeUsername !== undefined && typeof value.navidromeUsername !== 'string')
    return 'Navidrome username must be text';
  if (value.navidromePassword !== undefined && typeof value.navidromePassword !== 'string')
    return 'Navidrome password must be text';
  return undefined;
}
