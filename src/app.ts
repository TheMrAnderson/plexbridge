import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { loadOrCreateIdentity, type Identity } from './identity.js';
import { type Settings } from './config.js';
import { identity, libraryHubs, libraryHubsJson, librarySections, mediaProviders, mediaProvidersJson, serverRoot, serverRootJson, type PlexItem } from './plex/protocol.js';
import { version } from './version.js';
import { exchangeClaimToken } from './plex/claim.js';
import { requestClaimToken } from './plex/claim.js';
import { getRegistrationHealth, publishServer, type RegistrationHealth } from './plex/registration.js';
import { authenticate } from './plex/auth.js';
import { access, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createMusicProvider } from './music/provider.js';
import type { MusicProvider } from './music/types.js';
import { ensurePlexCertificate, hasPlexCertificate, plexDirectUrl } from './plex/certificate.js';
import { adminPage, adminScript, adminStyles } from './plex/admin-page.js';
import { registerPlaylistRoutes } from './plex/playlist-routes.js';
import { registerLibraryRoutes } from './plex/library-routes.js';

export function createApp(settings: Settings, certificate?: { key: Buffer; cert: Buffer }): FastifyInstance {
  let storedIdentity: Identity | undefined;
  const getIdentity = async () => storedIdentity ??= await loadOrCreateIdentity(settings.configDir);
  const navidrome: MusicProvider = createMusicProvider({ url: settings.navidromeUrl, username: settings.navidromeUsername, password: settings.navidromePassword });
  const credentials = async () => { try { return JSON.parse(await readFile(join(settings.configDir, 'plex-credentials.json'), 'utf8')) as { authToken?: string; serverToken?: string }; } catch { return {}; } };
  let adminOperation: { state: 'idle' | 'login_waiting' | 'login_complete' | 'claim_running' | 'register_running' | 'claim_complete' | 'register_complete' | 'error'; loginUrl?: string; message?: string; registration?: unknown } = { state: 'idle' };
  const playQueues = new Map<string, { item: PlexItem; sourceUri: string; response?: string }>();
  const plexPlaylistIds = new Map<string, string>();
  let playlistIdsLoaded = false;
  const playlistIdsFile = join(settings.configDir, 'plex-playlist-ids.json');
  const loadPlaylistIds = async () => {
    if (playlistIdsLoaded) return;
    playlistIdsLoaded = true;
    try {
      const stored = JSON.parse(await readFile(playlistIdsFile, 'utf8')) as { playlists?: Record<string, string> };
      for (const [plexId, navidromeId] of Object.entries(stored.playlists ?? {})) plexPlaylistIds.set(plexId, navidromeId);
    } catch { /* The mapping is created on the first playlist response. */ }
  };
  const savePlaylistIds = async () => {
    try {
      await writeFile(playlistIdsFile, `${JSON.stringify({ version: 1, playlists: Object.fromEntries(plexPlaylistIds) }, null, 2)}\n`, { mode: 0o600 });
    } catch (error) {
      console.warn(JSON.stringify({ event: 'playlist_id_persist_failed', error: error instanceof Error ? error.message : 'unknown error' }));
    }
  };
  const isClaimed = async () => { try {
      await access(join(settings.configDir, 'plex-credentials.json'));
      const credentials = JSON.parse(await readFile(join(settings.configDir, 'plex-credentials.json'), 'utf8'));
      return Boolean(credentials.serverToken);
  }
  catch {
      return false;
  } };
  const finishRegistration = async () => {
    const stored = await credentials();
    if (!stored.serverToken || !stored.authToken) return;
    const id = await getIdentity();
    const hadCertificate = await hasPlexCertificate(settings.configDir);
    await ensurePlexCertificate(id, settings.configDir, stored.serverToken);
    if (!hadCertificate) {
      adminOperation = { state: 'register_complete', message: 'HTTPS certificate enrolled. Restart PlexBridge to finish setup.' };
      return;
    }
    const registration = await publishServer(id, settings.serverName, await plexDirectUrl(settings.configDir, settings.publicUrl), stored.serverToken, stored.authToken);
    const successful = registration.health.owned && registration.health.presence && registration.health.accessTokenReady && registration.health.connectionUrl;
    adminOperation = { state: 'register_complete', message: successful ? 'PlexBridge is ready for Plexamp.' : 'Plex is still confirming this server. Keep PlexBridge running and refresh shortly.', registration };
  };
  const app = Fastify({ logger: false, ...(certificate ? { https: certificate } : {}) });
  app.addContentTypeParser(['application/x-www-form-urlencoded', 'text/plain', 'application/xml'], { parseAs: 'string' }, (_request, body: string, done) => done(null, body));
  app.addHook('onRequest', async (request) => {
      const started = process.hrtime.bigint();
      (request as FastifyRequest & { startedAt?: bigint }).startedAt = started;
  });
  app.addHook('onResponse', async (request, reply) => {
      if (settings.logLevel === 'DEBUG' || settings.logLevel === 'TRACE') {
          const headers = Object.fromEntries(Object.entries(request.headers).filter(([key]) => key.toLowerCase().startsWith('x-plex-') && key.toLowerCase() !== 'x-plex-token').map(([key, value]) => [key, value]));
          const started = (request as FastifyRequest & { startedAt?: bigint }).startedAt ?? process.hrtime.bigint();
          console.debug(JSON.stringify({ event: 'request', method: request.method, path: request.url.split('?')[0], queryNames: Object.keys(request.query as object), accept: request.headers.accept ?? '', userAgent: request.headers['user-agent'] ?? '', status: reply.statusCode, durationMs: Number(process.hrtime.bigint() - started) / 1e6, plexHeaders: headers }));
      }
  });
  const xml = (body: string) => ({ body, type: 'application/xml; charset=utf-8' });
  app.get('/', async (request, reply) => { const id = await getIdentity(); let advertisedUrl = settings.publicUrl; try {
      advertisedUrl = await plexDirectUrl(settings.configDir, settings.publicUrl);
  }
  catch { /* certificate enrollment may not have happened yet */ } const claimed = await isClaimed(); return request.headers.accept?.includes('application/json') ? reply.type('application/json').send(serverRootJson(settings.serverName, id.machineIdentifier, claimed)) : reply.type(xml('').type).send(serverRoot(settings.serverName, id.machineIdentifier, advertisedUrl, claimed)); });
  app.get('/identity', async (_request, reply) => { const id = await getIdentity(); return reply.type(xml('').type).send(identity(id.machineIdentifier, await isClaimed())); });
  app.get('/media/providers', async (request, reply) => { const id = await getIdentity(); const claimed = await isClaimed(); return request.headers.accept?.includes('application/json') ? reply.type('application/json').send(mediaProvidersJson(settings.serverName, id.machineIdentifier, claimed)) : reply.type(xml('').type).send(mediaProviders()); });
  app.get('/library/sections', async (_request, reply) => reply.type(xml('').type).send(librarySections()));
  app.get('/hubs/sections/:id', async (request, reply) => { if ((request.params as { id: string }).id !== '1')
      return reply.code(404).send('Unknown library section\n'); return request.headers.accept?.includes('application/json') ? reply.type('application/json').send(libraryHubsJson()) : reply.type(xml('').type).send(libraryHubs()); });
  registerPlaylistRoutes(app, { music: navidrome, playlistIds: plexPlaylistIds, loadPlaylistIds, savePlaylistIds });
  registerLibraryRoutes(app, { music: navidrome, playQueues, playlistIds: plexPlaylistIds, loadPlaylistIds, preserveSourceFormats: settings.preserveSourceFormats });
  app.get('/health', async () => {
    const id = await getIdentity(); const stored = await credentials();
    let registration: RegistrationHealth = { claimed: Boolean(stored.serverToken), cloudRegistered: false, published: false, present: false, owned: false, presence: false, accessTokenReady: false, connectionUrl: false, state: 'not-claimed' };
    if (stored.serverToken) { try { registration = await getRegistrationHealth(id, await plexDirectUrl(settings.configDir, settings.publicUrl), stored.serverToken, stored.authToken ?? ''); } catch (error) { console.warn(JSON.stringify({ event: 'registration_health_failed', error: error instanceof Error ? error.message : 'unknown error' })); } }
    return { status: 'ok', version, server_identity_initialized: Boolean(storedIdentity), authentication_configured: Boolean(stored.serverToken), claim_state: stored.serverToken ? 'claimed' : 'not_attempted', registration_state: registration.state, registration, discovery_state: settings.discoveryEnabled ? 'configured' : 'disabled' };
  });
  app.get('/:/eventsource/notifications', async (_request, reply) => { reply.hijack(); const response = reply.raw; response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' }); response.write(': \n\n'); const keepAlive = setInterval(() => response.write(': -1\n\n'), 15000); response.on('close', () => clearInterval(keepAlive)); });
  app.get('/admin', async (_request, reply) => reply.type('text/html; charset=utf-8').send(adminPage()));
  app.get('/admin.css', async (_request, reply) => reply.type('text/css; charset=utf-8').send(adminStyles()));
  app.get('/admin.js', async (_request, reply) => reply.type('application/javascript; charset=utf-8').send(adminScript()));
  app.get('/admin/status', async () => { const stored = await credentials(); let registration: RegistrationHealth | undefined; if (stored.serverToken) { try { registration = await getRegistrationHealth(await getIdentity(), await plexDirectUrl(settings.configDir, settings.publicUrl), stored.serverToken, stored.authToken ?? ''); } catch { /* status remains useful without cloud health */ } } return { ...adminOperation, accountAuthenticated: Boolean(stored.authToken), certificateReady: await hasPlexCertificate(settings.configDir), registration }; });
  app.post('/admin/login', async (_request, reply) => {
    if (adminOperation.state === 'login_waiting' || adminOperation.state === 'claim_running' || adminOperation.state === 'register_running') return reply.code(409).send({ ...adminOperation, message: 'An operation is already running' });
    const stored = await credentials();
    if (stored.serverToken && stored.authToken) {
      try {
        const current = await getRegistrationHealth(await getIdentity(), await plexDirectUrl(settings.configDir, settings.publicUrl), stored.serverToken, stored.authToken);
        if (current.cloudRegistered) return reply.code(409).send({ state: 'error', message: 'PlexBridge is already registered with Plex; login is disabled to avoid creating another device' });
      } catch { /* allow login to repair a stale local claim */ }
    }
    adminOperation = { state: 'login_waiting' };
    void (async () => { try { await authenticate(await getIdentity(), settings.configDir, { onUrl: (loginUrl) => { adminOperation.loginUrl = loginUrl; } }); await finishRegistration(); if (adminOperation.state !== 'register_complete') adminOperation = { state: 'login_complete', message: 'Plex login complete.' }; } catch (error) { adminOperation = { state: 'error', message: error instanceof Error ? error.message : 'Plex login failed' }; } })();
    return { ...adminOperation, message: 'Open the Plex approval page' };
  });
  app.post('/admin/claim', async (request, reply) => {
    if (adminOperation.state === 'login_waiting' || adminOperation.state === 'claim_running' || adminOperation.state === 'register_running') return reply.code(409).send({ ...adminOperation, message: 'An operation is already running' });
    const body = (request.body ?? {}) as { claimToken?: string }; const pastedClaimToken = body.claimToken?.trim() ?? '';
    const stored = await credentials();
    if (stored.serverToken) return reply.code(409).send({ state: 'error', message: 'This server is already claimed; sign in to Plex to finish setup' });
    if (!pastedClaimToken && !stored.authToken) return reply.code(400).send({ state: 'error', message: 'Paste a claim token or login to Plex first' });
    adminOperation = { state: 'claim_running' };
    void (async () => { try { const id = await getIdentity(); const claimToken = pastedClaimToken || await requestClaimToken(id, settings.serverName, stored.authToken ?? ''); const serverToken = await exchangeClaimToken(id, settings.configDir, claimToken, settings.serverName); const hadCertificate = await hasPlexCertificate(settings.configDir); await ensurePlexCertificate(id, settings.configDir, serverToken); if (!hadCertificate) { adminOperation = { state: 'claim_complete', message: 'Server claimed. Restart PlexBridge once to activate HTTPS, then sign in to Plex to finish setup.' }; return; } await finishRegistration(); } catch (error) { adminOperation = { state: 'error', message: error instanceof Error ? error.message : 'Plex claim failed' }; } })();
    return { ...adminOperation, message: 'Claim and registration started' };
  });
  app.post('/admin/register', async (_request, reply) => {
    if (adminOperation.state === 'login_waiting' || adminOperation.state === 'claim_running' || adminOperation.state === 'register_running') return reply.code(409).send({ ...adminOperation, message: 'An operation is already running' });
    const stored = await credentials();
    if (!stored.serverToken) return reply.code(400).send({ state: 'error', message: 'PlexBridge is not claimed yet' });
    if (!stored.authToken) return reply.code(400).send({ state: 'error', message: 'Sign in to Plex first; registration will resume automatically' });
    adminOperation = { state: 'register_running' };
    void (async () => { try { await finishRegistration(); } catch (error) { adminOperation = { state: 'error', message: error instanceof Error ? error.message : 'Plex registration failed' }; } })();
    return { ...adminOperation, message: 'Registration started' };
  });
  app.post('/myplex/claim', async (request, reply) => {
    const token = (request.query as { token?: string }).token;
    if (!token) return reply.code(400).type('text/plain; charset=utf-8').send('Missing claim token\n');
    try {
      const id = await getIdentity();
      const serverToken = await exchangeClaimToken(id, settings.configDir, token, settings.serverName);
      const accountToken = (await credentials()).authToken ?? '';
      await ensurePlexCertificate(id, settings.configDir, serverToken);
      const registration = await publishServer(id, settings.serverName, await plexDirectUrl(settings.configDir, settings.publicUrl), serverToken, accountToken);
      if (!registration.registeredResourceMatch && accountToken) throw new Error('Plex accepted the claim but did not publish PlexBridge as an account resource');
      return reply.type(xml('').type).send('<?xml version="1.0" encoding="UTF-8"?><MediaContainer size="0" claimed="1"/>');
    }
    catch (error) { console.warn(JSON.stringify({ event: 'claim_failed', error: error instanceof Error ? error.message : 'unknown error' })); return reply.code(502).type('text/plain; charset=utf-8').send('Plex claim exchange failed\n'); }
  });
  app.addHook('onSend', async (_request, reply) => { const id = await getIdentity(); reply.header('X-Plex-Protocol', '1.0'); reply.header('X-Plex-Client-Identifier', id.machineIdentifier); });
  app.all('/*', async (request, reply) => { console.warn(JSON.stringify({ event: 'unsupported_endpoint', method: request.method, path: request.url.split('?')[0] })); return reply.code(404).type('text/plain; charset=utf-8').send('PlexBridge has not implemented this endpoint in Phase 1\n'); });
  return app;
}

