import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadSettings } from '../config.js';
import { loadOrCreateIdentity } from '../identity.js';
import { publishServer } from '../plex/registration.js';
import { ensurePlexCertificate, plexDirectUrl } from '../plex/certificate.js';

const settings = loadSettings();
const identity = await loadOrCreateIdentity(settings.configDir);
const credentials = JSON.parse(await readFile(join(settings.configDir, 'plex-credentials.json'), 'utf8')) as {
  authToken?: string;
  serverToken?: string;
};
if (!credentials.serverToken) throw new Error('No server token found. Run the claim flow first.');
await ensurePlexCertificate(identity, settings.configDir, credentials.serverToken);
const registration = await publishServer(
  identity,
  settings.serverName,
  await plexDirectUrl(settings.configDir, settings.publicUrl),
  credentials.serverToken,
  credentials.authToken ?? ''
);
console.log(JSON.stringify(registration, null, 2));
