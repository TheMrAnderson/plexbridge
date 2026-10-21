import { createApp } from './app.js';
import { loadSettings } from './config.js';
import { startDiscovery } from './plex/discovery.js';
import { loadOrCreateIdentity } from './identity.js';
import { loadPlexCertificate, plexDirectUrl } from './plex/certificate.js';
import { startRegisteredPubSub } from './plex/registration.js';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import net from 'node:net';
import tls from 'node:tls';
import { version } from './version.js';

const settings = loadSettings();
const certificate = await loadPlexCertificate(settings.configDir);
const app = createApp(settings);
await app.ready();
const httpServer = app.server;
const secureContext = certificate ? tls.createSecureContext(certificate) : undefined;
const listener = net.createServer((socket) => {
  socket.once('data', (firstChunk) => {
    socket.pause();
    socket.unshift(firstChunk);
    if (!secureContext || firstChunk[0] !== 0x16) {
      httpServer.emit('connection', socket);
      socket.resume();
      return;
    }
    const secureSocket = new tls.TLSSocket(socket, { isServer: true, secureContext });
    secureSocket.once('secure', () => httpServer.emit('connection', secureSocket));
    secureSocket.once('error', () => secureSocket.destroy());
    secureSocket.resume();
  });
});
await new Promise<void>((resolve, reject) => { listener.once('error', reject); listener.listen(settings.port, settings.host, resolve); });
const identity = await loadOrCreateIdentity(settings.configDir);
const sockets = settings.discoveryEnabled ? startDiscovery(settings.serverName, settings.port, identity.machineIdentifier) : [];
console.info(JSON.stringify({ event: 'startup', version, host: settings.host, port: settings.port, tls: Boolean(certificate), discovery: settings.discoveryEnabled ? 'configured' : 'disabled' }));
void (async () => {
  try {
    const credentials = JSON.parse(await readFile(join(settings.configDir, 'plex-credentials.json'), 'utf8')) as { authToken?: string; serverToken?: string };
    if (!credentials.serverToken || !credentials.authToken) {
      console.info(JSON.stringify({ event: 'pubsub_startup_skipped', reason: !credentials.serverToken ? 'server_not_claimed' : 'account_not_authenticated' }));
      return;
    }
    console.info(JSON.stringify({ event: 'pubsub_startup_restore' }));
    await startRegisteredPubSub(identity, settings.serverName, await plexDirectUrl(settings.configDir, settings.publicUrl), credentials.serverToken, credentials.authToken);
  } catch (error) {
    console.warn(JSON.stringify({ event: 'pubsub_startup_failed', error: error instanceof Error ? error.message : 'unknown error' }));
  }
})();
const shutdown = async () => { sockets.forEach((socket) => socket.close()); listener.close(); await app.close(); process.exit(0); };
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

