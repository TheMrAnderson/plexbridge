import { randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { networkInterfaces } from 'node:os';
import type { Identity } from '../identity.js';
import { PLEX_SERVER_VERSION, plexServerHeaders } from './profile.js';

interface Resource { name?: string; clientIdentifier?: string; provides?: string; owned?: boolean; presence?: boolean; accessToken?: string; connections?: Array<{ uri?: string }>; }
export interface RegistrationHealth { claimed: boolean; cloudRegistered: boolean; published: boolean; present: boolean; owned: boolean; presence: boolean; accessTokenReady: boolean; connectionUrl: boolean; state: 'not-claimed' | 'claimed' | 'published' | 'present' | 'online' | 'access-token-ready'; }
export interface RegistrationResult { publishHttpStatus: number; deviceUpdateHttpStatus: number; connectivityHttpStatus: number; connectivityConfirmed: boolean; registeredResourceMatch: boolean; matches: Array<Pick<Resource, 'name' | 'clientIdentifier' | 'provides'>>; health: RegistrationHealth; }
type Log = (event: string, details: Record<string, unknown>) => void;
type ConnectivityEvent = { address: string; port: number; connectivity: boolean };
type PubSubMessageHandler = (data: string) => void;
let pubSubConnection: Promise<void> | undefined;
const connectivityWaiters = new Map<string, (event: ConnectivityEvent) => void>();

function commonHeaders(identity: Identity, serverName: string): Record<string, string> { return plexServerHeaders(identity, serverName); }
function xml(value: string): string { return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function localAddress(): string { for (const interfaces of Object.values(networkInterfaces())) for (const address of interfaces ?? []) if (address.family === 'IPv4' && !address.internal) return address.address; return ''; }
function publishXml(identity: Identity, serverName: string, publicAddress: string, localHost: string, publicPort: number): string { return `<?xml version="1.0" encoding="UTF-8"?>\n<MediaContainer size="1">\n  <Server relay="1" relayProtocols="ssh" name="${xml(serverName)}" host="" address="${xml(publicAddress)}" localAddresses="${xml(localHost)}" port="${publicPort}" machineIdentifier="${identity.machineIdentifier}" version="${PLEX_SERVER_VERSION}" date="${Date.now() * 1000}" />\n</MediaContainer>`; }
function deviceQuery(publicUrl: string, localHost: string, publicPort: number, token: string): string { const query = new URLSearchParams(); query.append('connections[0][uri]', publicUrl); query.append('connections[0][prefixLength]', '0'); if (localHost) { query.append('connections[1][uri]', `http://${localHost}:${publicPort}`); query.append('connections[1][prefixLength]', '24'); } query.set('httpsEnabled', '1'); query.set('httpsRequired', '0'); query.set('dnsRebindingProtection', '0'); query.set('X-Plex-Token', token); return query.toString(); }
function transient(status: number): boolean { return status === 408 || status === 425 || status === 429 || status >= 500; }

async function requestWithRetry(label: string, url: string, init: RequestInit, fetchImpl: typeof fetch, log: Log): Promise<Response> {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetchImpl(url, init);
      log('registration_http', { label, attempt, status: response.status });
      if (response.status >= 400) {
        const body = (await response.clone().text()).slice(0, 1000).replace(/[A-Za-z0-9_-]{20,}/g, '[REDACTED]');
        if (body) log('registration_http_response', { label, attempt, body });
      }
      if (!transient(response.status) || attempt === 3) return response;
      const retryAfter = Number(response.headers.get('retry-after')); const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 10_000) : 500 * 2 ** (attempt - 1);
      await new Promise((resolve) => setTimeout(resolve, delay));
    } catch (error) {
      log('registration_http_error', { label, attempt, error: error instanceof Error ? error.message : 'unknown error' });
      if (attempt === 3) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** (attempt - 1)));
    }
  }
  throw new Error(`Plex ${label} request failed`);
}

async function publicAddressFromPlex(identity: Identity, serverName: string, fallback: string, fetchImpl: typeof fetch, log: Log): Promise<string> {
  const response = await requestWithRetry('public_ip', 'https://v4.plex.tv/pms/:/ip', { method: 'GET', headers: commonHeaders(identity, serverName) }, fetchImpl, log);
  if (response.ok) {
    const value = (await response.text()).trim();
    if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(value)) return value;
  }
  return fallback;
}

async function plexUserId(accountToken: string, identity: Identity, serverName: string, fetchImpl: typeof fetch, log: Log): Promise<number | undefined> {
  const response = await requestWithRetry('user', 'https://plex.tv/api/v2/user', { method: 'GET', headers: { ...commonHeaders(identity, serverName), Accept: 'application/json', 'X-Plex-Token': accountToken } }, fetchImpl, log);
  if (!response.ok) return undefined;
  const body = await response.json() as { id?: unknown };
  return typeof body.id === 'number' ? body.id : undefined;
}

async function pubSubHosts(identity: Identity, serverName: string, serverToken: string, fetchImpl: typeof fetch, log: Log): Promise<string[]> {
  const response = await requestWithRetry('pubsub_servers', 'https://servers.plex.tv/services/pubsub/servers', { method: 'GET', headers: { ...commonHeaders(identity, serverName), Accept: 'application/xml', 'X-Plex-Token': serverToken } }, fetchImpl, log);
  const body = response.ok ? await response.text() : '';
  const hosts = [...body.matchAll(/<Server\s+host="([^"]+)"/g)].map((match) => match[1]);
  return [...new Set(['pubsub.plex.tv', ...hosts])];
}

async function probePubSubHost(host: string, path: string, identity: Identity): Promise<number> {
  const started = Date.now();
  const ip = (await lookup(host, { family: 4 })).address;
  await new Promise<void>((resolve, reject) => {
    const req = httpsRequest({ host: ip, port: 443, servername: 'pubsub.plex.tv', path, headers: { Host: host, Accept: 'text/event-stream', 'User-Agent': `PlexMediaServer-EventSourceClient/${PLEX_SERVER_VERSION}`, 'X-Plex-Client-Identifier': identity.machineIdentifier, 'X-Plex-Version': PLEX_SERVER_VERSION }, timeout: 5000 });
    let settled = false;
    const finish = (error?: Error) => { if (settled) return; settled = true; req.destroy(); error ? reject(error) : resolve(); };
    req.once('socket', (socket) => socket.once('secureConnect', () => finish()));
    req.once('timeout', () => finish(new Error('connection timeout')));
    req.once('error', (error) => finish(error));
    req.end();
  });
  return Date.now() - started;
}

function notifyPubSubMessage(data: string, log: Log, onMessage?: PubSubMessageHandler): void {
  // PMS logs every EventSource payload, not only reachability notifications.
  // Keep the raw payload visible while we reverse-engineer PubSub messages.
  log('pubsub_message', { data: data.slice(0, 4000) });
  onMessage?.(data);
  const match = data.match(/<Message\s+([^>]*)\/>/);
  if (!match) return;
  const attributes = Object.fromEntries([...match[1].matchAll(/([A-Za-z]+)="([^"]*)"/g)].map((item) => [item[1], item[2]]));
  if (attributes.command !== 'notifyConnectivity' || !attributes.asyncIdentifier) return;
  const event = { address: attributes.address ?? '', port: Number(attributes.port ?? 0), connectivity: attributes.connectivity === '1' };
  log('pubsub_event', { asyncIdentifier: attributes.asyncIdentifier, address: event.address, port: event.port, connectivity: event.connectivity });
  connectivityWaiters.get(attributes.asyncIdentifier)?.(event);
  connectivityWaiters.delete(attributes.asyncIdentifier);
}

async function startPubSub(identity: Identity, serverName: string, serverToken: string, accountToken: string, fetchImpl: typeof fetch, log: Log, onMessage?: PubSubMessageHandler): Promise<void> {
  if (pubSubConnection || !accountToken) return;
  const userId = await plexUserId(accountToken, identity, serverName, fetchImpl, log);
  if (userId === undefined) {
    log('pubsub_unavailable', { reason: 'plex_user_id_missing' });
    return;
  }
  const path = `/sub/eventsource/${userId}/${encodeURIComponent(identity.machineIdentifier)}?X-Plex-Token=${encodeURIComponent(serverToken)}`;
  const hosts = await pubSubHosts(identity, serverName, serverToken, fetchImpl, log);
  const timings = await Promise.all(hosts.map(async (host) => {
    try { return { host, milliseconds: await probePubSubHost(host, path, identity) }; }
    catch (error) { return { host, error: error instanceof Error ? error.message : 'unknown error' }; }
  }));
  const reachable = timings.filter((item): item is { host: string; milliseconds: number } => 'milliseconds' in item).sort((left, right) => left.milliseconds - right.milliseconds);
  // PMS initially opens pubsub.plex.tv, then replaces it with a regional POP
  // after querying /services/pubsub/servers. In this environment the central
  // endpoint accepts the stream but only emits keepalives; the regional POP
  // delivers notifyConnectivity. Keep the central endpoint as a fallback.
  const host = reachable.find((item) => item.host !== 'pubsub.plex.tv')?.host ?? 'pubsub.plex.tv';
  log('pubsub_host_selected', { host, timings });
  let readyResolve!: (ready: boolean) => void;
  const ready = new Promise<boolean>((resolve) => { readyResolve = resolve; });
  pubSubConnection = (async () => {
    try {
      const ip = (await lookup(host, { family: 4 })).address;
      await new Promise<void>((resolve, reject) => {
        const req = httpsRequest({ host: ip, port: 443, servername: 'pubsub.plex.tv', path, headers: { Host: host, Accept: 'text/event-stream', 'User-Agent': `PlexMediaServer-EventSourceClient/${PLEX_SERVER_VERSION}`, 'X-Plex-Client-Identifier': identity.machineIdentifier, 'X-Plex-Version': PLEX_SERVER_VERSION } }, (response) => {
          log('pubsub_connected', { host, status: response.statusCode ?? 0, contentType: response.headers['content-type'] ?? '' });
          const connected = (response.statusCode ?? 500) < 400;
          readyResolve(connected);
          if (!connected) { response.resume(); response.once('end', resolve); return; }
          let buffer = '';
          response.setEncoding('utf8');
          response.on('data', (chunk: string) => {
            log('pubsub_chunk', { host, raw: chunk.slice(0, 4000) });
            buffer += chunk;
            const events = buffer.split(/\r?\n\r?\n/);
            buffer = events.pop() ?? '';
            for (const event of events) {
              log('pubsub_sse_event', { host, raw: event.slice(0, 4000) });
              const data = event.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
              if (data) notifyPubSubMessage(data, log, onMessage);
            }
          });
          response.once('end', () => { log('pubsub_closed', { host }); resolve(); });
          response.once('error', reject);
        });
        req.once('error', reject);
        req.end();
      });
    } catch (error) {
      readyResolve(false);
      log('pubsub_error', { host, error: error instanceof Error ? error.message : 'unknown error' });
    } finally {
      pubSubConnection = undefined;
    }
  })();
  const connected = await Promise.race([ready, new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 10_000))]);
  if (!connected) log('pubsub_unavailable', { reason: 'connection_not_ready' });
}

/** Restore the long-lived PubSub subscription for an already-claimed bridge. */
export async function startRegisteredPubSub(identity: Identity, serverName: string, publicUrl: string, serverToken: string, accountToken: string, fetchImpl: typeof fetch = fetch, log: Log = (event, details) => console.info(JSON.stringify({ event, ...details }))): Promise<void> {
  if (!serverToken || !accountToken) {
    log('pubsub_unavailable', { reason: !serverToken ? 'server_token_missing' : 'account_token_missing' });
    return;
  }
  await startPubSub(identity, serverName, serverToken, accountToken, fetchImpl, log, (data) => {
    if (data.includes('command="notifySharingChange"')) refreshAfterSharingChange(identity, publicUrl, serverToken, accountToken, fetchImpl, log);
  });
}

function refreshAfterSharingChange(identity: Identity, publicUrl: string, serverToken: string, accountToken: string, fetchImpl: typeof fetch, log: Log): void {
  log('sharing_change_received', { action: 'refresh_registration_health' });
  void getRegistrationHealth(identity, publicUrl, serverToken, accountToken, fetchImpl)
    .then((health) => log('sharing_refresh', { ...health }))
    .catch((error) => log('sharing_refresh_failed', { error: error instanceof Error ? error.message : 'unknown error' }));
}

async function waitForConnectivity(asyncIdentifier: string, timeoutMs: number, log: Log): Promise<ConnectivityEvent | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { connectivityWaiters.delete(asyncIdentifier); log('pubsub_timeout', { asyncIdentifier, timeoutMs }); resolve(undefined); }, timeoutMs);
    timer.unref();
    connectivityWaiters.set(asyncIdentifier, (event) => { clearTimeout(timer); resolve(event); });
  });
}

async function resources(accountToken: string, identity: Identity, fetchImpl: typeof fetch): Promise<Resource[]> {
  const response = await fetchImpl('https://clients.plex.tv/api/v2/resources?includeHttps=1&includeRelay=1&includeIPv6=1', { headers: { ...commonHeaders(identity, 'PlexBridge'), Accept: 'application/json', 'X-Plex-Token': accountToken } });
  if (response.status === 401) throw new Error('Plex account token was rejected (HTTP 401); login to Plex again');
  if (!response.ok) return [];
  const body = await response.json() as unknown;
  return Array.isArray(body) ? body as Resource[] : ((body as { resources?: Resource[] }).resources ?? []);
}
function serverListContains(body: string, identity: Identity): boolean { return body.includes(`machineIdentifier="${identity.machineIdentifier}"`) || body.includes(`machineIdentifier="${identity.processedMachineIdentifier}"`); }
function healthFor(claimed: boolean, published: boolean, resource: Resource | undefined, publicUrl: string, publicAddress?: string): RegistrationHealth {
  const present = Boolean(resource); const owned = resource?.owned === true; const cloudRegistered = present && owned; const presence = resource?.presence === true; const accessTokenReady = Boolean(resource?.accessToken); const expectedConnections = [publicUrl.replace(/\/$/, ''), publicAddress ? `http://${publicAddress}:32400` : '']; const connectionUrl = Boolean(resource?.connections?.some((connection) => expectedConnections.includes(connection.uri?.replace(/\/$/, '') ?? '')));
  const state = !claimed ? 'not-claimed' : accessTokenReady ? 'access-token-ready' : presence ? 'online' : present ? 'present' : published ? 'published' : 'claimed';
  return { claimed, cloudRegistered, published, present, owned, presence, accessTokenReady, connectionUrl, state };
}

async function waitForRegistrationHealth(identity: Identity, publicUrl: string, serverToken: string, accountToken: string, fetchImpl: typeof fetch, log: Log, forcePoll = false): Promise<RegistrationHealth> {
  let health = await getRegistrationHealth(identity, publicUrl, serverToken, accountToken, fetchImpl);
  const registrationReady = () => health.present && health.owned && health.accessTokenReady && health.connectionUrl;
  if (!accountToken || (!forcePoll && registrationReady())) {
    if (accountToken && registrationReady() && !health.presence) return waitForPresence(identity, publicUrl, serverToken, accountToken, fetchImpl, health, log);
    return health;
  }
  for (let attempt = 1; attempt <= 24; attempt += 1) {
    const delay = 5000;
    await new Promise((resolve) => setTimeout(resolve, delay));
    health = await getRegistrationHealth(identity, publicUrl, serverToken, accountToken, fetchImpl);
    log('registration_poll', { attempt, delayMs: delay, ...health });
    if (registrationReady() && health.presence) break;
  }
  return registrationReady() && !health.presence ? waitForPresence(identity, publicUrl, serverToken, accountToken, fetchImpl, health, log) : health;
}

async function waitForPresence(identity: Identity, publicUrl: string, serverToken: string, accountToken: string, fetchImpl: typeof fetch, initial: RegistrationHealth, log: Log): Promise<RegistrationHealth> {
  let health = initial;
  for (let attempt = 1; attempt <= 8 && !health.presence; attempt += 1) {
    const delay = Math.min(1000 * attempt, 8000);
    await new Promise((resolve) => setTimeout(resolve, delay));
    health = await getRegistrationHealth(identity, publicUrl, serverToken, accountToken, fetchImpl);
    log('presence_poll', { attempt, delayMs: delay, ...health });
  }
  return health;
}

export async function getRegistrationHealth(identity: Identity, publicUrl: string, serverToken: string, accountToken: string, fetchImpl: typeof fetch = fetch): Promise<RegistrationHealth> {
  if (!serverToken) return healthFor(false, false, undefined, publicUrl);
  if (!accountToken) return healthFor(true, false, undefined, publicUrl);
  const publicAddress = (await lookup(new URL(publicUrl).hostname)).address;
  const [accountResources, serverList] = await Promise.all([resources(accountToken, identity, fetchImpl), fetchImpl(`https://servers.plex.tv/servers.xml?includeLite=1&auth_token=${encodeURIComponent(serverToken)}`, { headers: { ...commonHeaders(identity, 'PlexBridge'), Accept: 'application/xml' } }).then(async (response) => response.ok ? response.text() : '')]);
  const resource = accountResources.find((candidate) => candidate.clientIdentifier === identity.processedMachineIdentifier) ?? accountResources.find((candidate) => candidate.clientIdentifier === identity.machineIdentifier);
  const health = healthFor(true, serverListContains(serverList, identity), resource, publicUrl, publicAddress);
  // Once Plex account state is available, cloud registration is the source of
  // truth for `claimed`. A leftover local server token must not disable repair.
  return health.cloudRegistered ? health : { ...health, claimed: false, state: 'not-claimed' };
}

export async function publishServer(identity: Identity, serverName: string, publicUrl: string, serverToken: string, accountToken = '', fetchImpl: typeof fetch = fetch, log: Log = (event, details) => console.info(JSON.stringify({ event, ...details }))): Promise<RegistrationResult> {
  if (!publicUrl) throw new Error('PLEXBRIDGE_PUBLIC_URL is required to publish PlexBridge');
  if (!serverToken) throw new Error('Plex server token is required to publish PlexBridge');
  const normalizedUrl = publicUrl.replace(/\/$/, '');
  const publicHost = new URL(normalizedUrl).hostname;
  const dnsAddress = (await lookup(publicHost)).address;
  const publicAddress = await publicAddressFromPlex(identity, serverName, dnsAddress, fetchImpl, log);
  const publicPort = 32400;
  const localHost = localAddress(); const publishBody = publishXml(identity, serverName, publicAddress, localHost, publicPort); const deviceParams = deviceQuery(normalizedUrl, localHost, publicPort, serverToken); const headers = { ...commonHeaders(identity, serverName), 'X-Plex-Token': serverToken }; const publishHeaders = { ...headers, 'Content-Type': 'application/xml' };
  log('registration_start', { machineIdentifier: identity.machineIdentifier, processedMachineIdentifier: identity.processedMachineIdentifier, connectionUrl: normalizedUrl, publicAddress, localAddress: localHost, publicPort });
  log('publish_request', { body: publishBody });
  await requestWithRetry('geoip', 'https://servers.plex.tv/api/v2/geoip', { method: 'GET', headers: { ...headers, Accept: 'application/xml' } }, fetchImpl, log);
  await requestWithRetry('features', `https://servers.plex.tv/api/v2/features?X-Plex-Token=${encodeURIComponent(serverToken)}`, { method: 'GET', headers: { ...headers, Accept: 'application/xml' } }, fetchImpl, log);
  // PMS keeps its PubSub subscription alive before it publishes the server
  // record. The connectivity callback is routed to that existing subscription.
  const asyncIdentifier = randomUUID();
  await startPubSub(identity, serverName, serverToken, accountToken, fetchImpl, log, (data) => {
    if (data.includes('command="notifySharingChange"')) refreshAfterSharingChange(identity, publicUrl, serverToken, accountToken, fetchImpl, log);
  });
  const connectivityEventPromise = accountToken ? waitForConnectivity(asyncIdentifier, 120_000, log) : Promise.resolve(undefined);
  // This is the endpoint used by PMS itself. Do not retry 422/403/404: repeated calls can trigger a Plex-side throttle.
  const publish = await requestWithRetry('publish', `https://servers.plex.tv/servers.xml?auth_token=${encodeURIComponent(serverToken)}`, { method: 'POST', headers: publishHeaders, body: publishBody }, fetchImpl, log);
  const publishResponseBody = (await publish.clone().text()).slice(0, 4000).replace(/[A-Za-z0-9_-]{20,}/g, '[REDACTED]');
  if (publishResponseBody) log('publish_response', { body: publishResponseBody });
  // This transition is used by current PMS builds; it is diagnostic because Plex has changed its availability over time.
  const connectivity = await requestWithRetry('connectivity', `https://servers.plex.tv/api/servers/${encodeURIComponent(identity.machineIdentifier)}/connectivity?X-Plex-Token=${encodeURIComponent(serverToken)}&asyncIdentifier=${encodeURIComponent(asyncIdentifier)}`, { method: 'PUT', headers }, fetchImpl, log);
  const deviceUpdate = await requestWithRetry('device_update', `https://servers.plex.tv/api/v2/devices/${encodeURIComponent(identity.machineIdentifier)}?${deviceParams}`, { method: 'PUT', headers }, fetchImpl, log);
  const deviceUpdateBody = (await deviceUpdate.clone().text()).slice(0, 4000).replace(/[A-Za-z0-9_-]{20,}/g, '[REDACTED]');
  if (deviceUpdateBody) log('device_update_response', { body: deviceUpdateBody });
  const healthPromise = waitForRegistrationHealth(identity, normalizedUrl, serverToken, accountToken, fetchImpl, log, true);
  const [health, connectivityEvent] = await Promise.all([healthPromise, connectivityEventPromise]);
  if (connectivityEvent) log('connectivity_confirmed', { asyncIdentifier, address: connectivityEvent.address, port: connectivityEvent.port, connectivity: connectivityEvent.connectivity });
  const accountResources = accountToken ? await resources(accountToken, identity, fetchImpl) : [];
  const matches = accountResources.filter((resource) => resource.clientIdentifier === identity.processedMachineIdentifier || resource.clientIdentifier === identity.machineIdentifier).map(({ name, clientIdentifier, provides }) => ({ name, clientIdentifier, provides }));
  const connectivityConfirmed = connectivityEvent?.connectivity === true;
  log('registration_status', { publishHttpStatus: publish.status, deviceUpdateHttpStatus: deviceUpdate.status, connectivityHttpStatus: connectivity.status, connectivityConfirmed, ...health });
  return { publishHttpStatus: publish.status, deviceUpdateHttpStatus: deviceUpdate.status, connectivityHttpStatus: connectivity.status, connectivityConfirmed, registeredResourceMatch: matches.length > 0, matches, health };
}
