import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadSettings } from '../config.js';
import { loadOrCreateIdentity } from '../identity.js';
import { exchangeClaimToken, requestClaimToken } from '../plex/claim.js';
import { publishServer } from '../plex/registration.js';
import { ensurePlexCertificate, plexDirectUrl } from '../plex/certificate.js';

const settings = loadSettings();
const identity = await loadOrCreateIdentity(settings.configDir);
const credentialsPath = join(settings.configDir, 'plex-credentials.json');
const credentials = JSON.parse(await readFile(credentialsPath, 'utf8')) as { authToken?: string };
if (!credentials.authToken) throw new Error('No Plex account token found. Run npm run plex:login first.');
const claimToken = await requestClaimToken(identity, settings.serverName, credentials.authToken ?? '');

const serverToken = await exchangeClaimToken(
  identity,
  settings.configDir,
  claimToken,
  settings.serverName,
  '',
  'direct-cloud-experiment'
);
await ensurePlexCertificate(identity, settings.configDir, serverToken);
const registration = await publishServer(
  identity,
  settings.serverName,
  await plexDirectUrl(settings.configDir, settings.publicUrl, settings.publicPort),
  serverToken,
  credentials.authToken,
  undefined,
  undefined,
  settings.port
);
console.log(
  JSON.stringify({ claimExchangeHttpStatus: 200, serverTokenReceived: Boolean(serverToken), ...registration }, null, 2)
);
