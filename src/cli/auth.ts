import { loadSettings } from '../config.js';
import { loadOrCreateIdentity } from '../identity.js';
import { authenticate } from '../plex/auth.js';

const settings = loadSettings();
await authenticate(await loadOrCreateIdentity(settings.configDir), settings.configDir);
