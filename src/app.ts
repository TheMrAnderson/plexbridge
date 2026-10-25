import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { loadOrCreateIdentity, type Identity } from './identity.js';
import type { Settings } from './config.js';
import {
  identity,
  libraryHubs,
  libraryHubsJson,
  librarySections,
  mediaProviders,
  mediaProvidersJson,
  configureLibraryUuid,
  serverRoot,
  serverRootJson,
  type PlexItem
} from './plex/protocol.js';
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
import { homePage, homeScript, homeStyles } from './plex/home-page.js';
import { registerPlaylistRoutes } from './plex/playlist-routes.js';
import { registerLibraryRoutes, type ActivePlayRecord, type PlayRecord } from './plex/library-routes.js';
import { WebAuth } from './web-auth.js';
import { loadAppSettings, saveAppSettings, validateAppSettings, type AppSettings } from './app-settings.js';

export function createApp(
  settings: Settings,
  certificate?: { key: Buffer; cert: Buffer },
  musicProvider?: MusicProvider,
  now: () => number = Date.now,
  timers?: {
    setTimeout: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
    clearTimeout: (timer: ReturnType<typeof setTimeout>) => void;
  }
): FastifyInstance {
  let storedIdentity: Identity | undefined;

  const getIdentity = async () => (storedIdentity ??= await loadOrCreateIdentity(settings.configDir));

  const navidrome: MusicProvider =
    musicProvider ??
    createMusicProvider({
      url: settings.navidromeUrl,
      username: settings.navidromeUsername,
      password: settings.navidromePassword
    });
  const webAuth = new WebAuth(settings.configDir, settings.webUsername, settings.webPassword);
  let appSettings: AppSettings = {
    navidromeUrl: settings.navidromeUrl,
    navidromeUsername: settings.navidromeUsername,
    navidromePassword: settings.navidromePassword,
    syncEnabled: true,
    syncTime: '03:00'
  };

  const credentials = async () => {
    try {
      return JSON.parse(await readFile(join(settings.configDir, 'plex-credentials.json'), 'utf8')) as {
        authToken?: string;
        serverToken?: string;
      };
    } catch {
      return {};
    }
  };

  let adminOperation: {
    state:
      | 'idle'
      | 'login_waiting'
      | 'login_complete'
      | 'claim_running'
      | 'register_running'
      | 'claim_complete'
      | 'register_complete'
      | 'error';
    loginUrl?: string;
    message?: string;
    registration?: unknown;
  } = { state: 'idle' };

  let syncStatus: {
    state: 'idle' | 'running' | 'complete' | 'error';
    startedAt?: string;
    completedAt?: string;
    message?: string;
    counts?: { artists: number; albums: number; songs: number; playlists: number };
  } = { state: 'idle' };
  let syncTimer: ReturnType<typeof setInterval> | undefined;
  let lastScheduledSyncDate = '';
  let invalidateLibraryCaches = () => {};

  const runLibrarySync = async (trigger: 'startup' | 'manual' | 'scheduled') => {
    if (syncStatus.state === 'running') return syncStatus;
    syncStatus = { state: 'running', startedAt: new Date().toISOString(), message: `${trigger} sync started` };
    console.info(JSON.stringify({ event: 'library_sync_start', trigger, configDir: settings.configDir }));
    try {
      const [artists, albums, songs, playlists, genres] = await Promise.all([
        navidrome.artists(),
        navidrome.albums(),
        navidrome.songs(),
        navidrome.playlists(),
        navidrome.genres()
      ]);
      const counts = {
        artists: artists.length,
        albums: albums.length,
        songs: songs.length,
        playlists: playlists.length
      };
      const syncedAt = new Date().toISOString();
      const moods = [
        ...new Set(
          songs.flatMap((song) =>
            (song.mood ?? '')
              .split(/[,;|]/)
              .map((mood) => mood.trim())
              .filter(Boolean)
          )
        )
      ].sort((a, b) => a.localeCompare(b));
      const recordLabels = [
        ...new Set(
          albums.flatMap((album) =>
            (album.recordLabel ?? '')
              .split(/[,;|]/)
              .map((label) => label.trim())
              .filter(Boolean)
          )
        )
      ].sort((a, b) => a.localeCompare(b));
      const snapshot = (name: string, value: unknown) =>
        writeFile(
          join(settings.configDir, `navidrome-${name}.json`),
          `${JSON.stringify({ version: 1, syncedAt, [name]: value }, null, 2)}\n`,
          { mode: 0o600 }
        );
      await Promise.all([
        snapshot('artists', artists),
        snapshot('albums', albums),
        snapshot('songs', songs),
        snapshot('playlists', playlists),
        snapshot('genres', genres),
        snapshot('moods', moods),
        snapshot('record-labels', recordLabels),
        writeFile(
          join(settings.configDir, 'navidrome-library.json'),
          `${JSON.stringify({ version: 2, syncedAt, ...counts, files: { artists: 'navidrome-artists.json', albums: 'navidrome-albums.json', songs: 'navidrome-songs.json', playlists: 'navidrome-playlists.json', genres: 'navidrome-genres.json', moods: 'navidrome-moods.json', recordLabels: 'navidrome-record-labels.json' } }, null, 2)}\n`,
          { mode: 0o600 }
        )
      ]);
      invalidateLibraryCaches();
      syncStatus = {
        state: 'complete',
        startedAt: syncStatus.startedAt,
        completedAt: new Date().toISOString(),
        message: `${trigger} sync complete`,
        counts
      };
      console.info(
        JSON.stringify({
          event: 'library_sync_complete',
          trigger,
          configDir: settings.configDir,
          counts,
          moodCount: moods.length,
          recordLabelCount: recordLabels.length
        })
      );
    } catch (error) {
      syncStatus = {
        state: 'error',
        startedAt: syncStatus.startedAt,
        completedAt: new Date().toISOString(),
        message: error instanceof Error ? error.message : 'Library sync failed'
      };
      console.warn(
        JSON.stringify({
          event: 'library_sync_failed',
          trigger,
          configDir: settings.configDir,
          error: error instanceof Error ? error.message : 'Library sync failed'
        })
      );
    }
    return syncStatus;
  };

  const playQueues = new Map<string, { item: PlexItem; sourceUri: string; response?: string }>();
  const playQueuesFile = join(settings.configDir, 'play-queues.json');
  let playQueuesLoaded = false;
  const loadPlayQueues = async () => {
    if (playQueuesLoaded) return;
    playQueuesLoaded = true;
    try {
      const stored = JSON.parse(await readFile(playQueuesFile, 'utf8')) as {
        queues?: Record<string, { item: PlexItem; sourceUri: string; response?: string }>;
      };
      for (const [id, queue] of Object.entries(stored.queues ?? {}))
        if (queue?.item?.ratingKey && queue.sourceUri) playQueues.set(id, queue);
    } catch {
      /* Queue state is recreated as Plexamp starts a new queue. */
    }
  };
  const savePlayQueues = async () => {
    try {
      await writeFile(
        playQueuesFile,
        `${JSON.stringify({ version: 1, queues: Object.fromEntries(playQueues) }, null, 2)}\n`,
        { mode: 0o600 }
      );
    } catch (error) {
      console.warn(
        JSON.stringify({
          event: 'play_queue_persist_failed',
          error: error instanceof Error ? error.message : 'unknown error'
        })
      );
    }
  };

  const playHistory: PlayRecord[] = [];
  const activePlays = new Map<string, ActivePlayRecord>();

  let playHistoryLoaded = false;

  let playHistorySave = Promise.resolve();

  const playHistoryFile = join(settings.configDir, 'play-history.json');

  const loadPlayHistory = async () => {
    if (playHistoryLoaded) return;
    playHistoryLoaded = true;
    try {
      const stored = JSON.parse(await readFile(playHistoryFile, 'utf8')) as {
        plays?: PlayRecord[];
        active?: Record<string, ActivePlayRecord>;
      };
      if (Array.isArray(stored.plays)) playHistory.push(...stored.plays.slice(0, 100));
      for (const [player, play] of Object.entries(stored.active ?? {}))
        if (play?.trackId) activePlays.set(player, play);
    } catch {
      /* History is created after the first successful scrobble. */
    }
  };

  const savePlayHistory = async () => {
    playHistorySave = playHistorySave
      .then(() =>
        writeFile(
          playHistoryFile,
          `${JSON.stringify({ version: 2, plays: playHistory, active: Object.fromEntries(activePlays) }, null, 2)}\n`,
          { mode: 0o600 }
        )
      )
      .catch((error) => {
        console.warn(
          JSON.stringify({
            event: 'play_history_persist_failed',
            error: error instanceof Error ? error.message : 'unknown error'
          })
        );
      });
    await playHistorySave;
  };

  const recordPlaybackState = async (play: ActivePlayRecord | undefined) => {
    await loadPlayHistory();
    if (!play || play.state === 'stopped') activePlays.delete(play?.player ?? '');
    else activePlays.set(play.player, play);
    await savePlayHistory();
  };

  const recordPlay = async (play: PlayRecord) => {
    await loadPlayHistory();
    activePlays.delete(play.player);
    playHistory.unshift(play);
    playHistory.splice(100);
    await savePlayHistory();
  };

  const hasPlayHistory = async (externalId: string) => {
    await loadPlayHistory();
    return playHistory.some((play) => play.externalId === externalId);
  };

  const plexPlaylistIds = new Map<string, string>();

  let playlistIdsLoaded = false;

  const playlistIdsFile = join(settings.configDir, 'plex-playlist-ids.json');

  const loadPlaylistIds = async () => {
    if (playlistIdsLoaded) return;
    playlistIdsLoaded = true;
    try {
      const stored = JSON.parse(await readFile(playlistIdsFile, 'utf8')) as { playlists?: Record<string, string> };
      for (const [plexId, navidromeId] of Object.entries(stored.playlists ?? {}))
        plexPlaylistIds.set(plexId, navidromeId);
    } catch {
      /* The mapping is created on the first playlist response. */
    }
  };

  const savePlaylistIds = async () => {
    try {
      await writeFile(
        playlistIdsFile,
        `${JSON.stringify({ version: 1, playlists: Object.fromEntries(plexPlaylistIds) }, null, 2)}\n`,
        { mode: 0o600 }
      );
    } catch (error) {
      console.warn(
        JSON.stringify({
          event: 'playlist_id_persist_failed',
          error: error instanceof Error ? error.message : 'unknown error'
        })
      );
    }
  };

  const isClaimed = async () => {
    try {
      await access(join(settings.configDir, 'plex-credentials.json'));
      const credentials = JSON.parse(await readFile(join(settings.configDir, 'plex-credentials.json'), 'utf8'));
      return Boolean(credentials.serverToken);
    } catch {
      return false;
    }
  };

  const finishRegistration = async () => {
    const stored = await credentials();
    if (!stored.serverToken || !stored.authToken) return;
    const id = await getIdentity();
    const hadCertificate = await hasPlexCertificate(settings.configDir);
    await ensurePlexCertificate(id, settings.configDir, stored.serverToken);
    if (!hadCertificate) {
      adminOperation = {
        state: 'register_complete',
        message: 'HTTPS certificate enrolled. Restart PlexBridge to finish setup.'
      };
      return;
    }
    const registration = await publishServer(
      id,
      settings.serverName,
      await plexDirectUrl(settings.configDir, settings.publicUrl, settings.publicPort),
      stored.serverToken,
      stored.authToken,
      undefined,
      undefined,
      settings.port
    );
    const successful =
      registration.health.owned &&
      registration.health.presence &&
      registration.health.accessTokenReady &&
      registration.health.connectionUrl;
    adminOperation = {
      state: 'register_complete',
      message: successful
        ? 'PlexBridge is ready for Plexamp.'
        : 'Plex is still confirming this server. Keep PlexBridge running and refresh shortly.',
      registration
    };
  };

  const app = Fastify({ logger: false, ...(certificate ? { https: certificate } : {}) });
  app.addHook('onReady', async () => {
    await loadPlayQueues();
    await webAuth.initialize();
    appSettings = await loadAppSettings(settings.configDir, settings);
    navidrome.updateSettings?.({
      url: appSettings.navidromeUrl,
      username: appSettings.navidromeUsername,
      password: appSettings.navidromePassword
    });
    const id = await getIdentity();
    configureLibraryUuid(id.libraryUuid ?? id.machineIdentifier);
    await runLibrarySync('startup');
    syncTimer = setInterval(() => {
      if (!appSettings.syncEnabled) return;
      const now = new Date();
      const time = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
      const date = now.toISOString().slice(0, 10);
      if (time === appSettings.syncTime && lastScheduledSyncDate !== date) {
        lastScheduledSyncDate = date;
        void runLibrarySync('scheduled');
      }
    }, 15_000);
  });
  app.addHook('onClose', async () => {
    if (syncTimer) clearInterval(syncTimer);
  });

  const browserPath = (request: FastifyRequest): boolean => {
    const path = request.url.split('?')[0];
    if (path === '/' && request.headers.accept?.includes('text/html')) return true;
    return [
      '/admin',
      '/admin/status',
      '/admin/settings',
      '/admin/sync',
      '/admin/claim',
      '/admin/login',
      '/admin/register',
      '/home/status'
    ].includes(path);
  };
  const cookieValue = (request: FastifyRequest, name: string): string | undefined => {
    const cookies = request.headers.cookie?.split(';') ?? [];
    const entry = cookies.find((cookie) => cookie.trim().startsWith(`${name}=`));
    return entry ? decodeURIComponent(entry.trim().slice(name.length + 1)) : undefined;
  };
  const secureCookie = (request: FastifyRequest) =>
    request.protocol === 'https' || request.headers['x-forwarded-proto']?.toString().split(',')[0].trim() === 'https';
  const localRequest = (request: FastifyRequest) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.ip);
  const isPlayQueuePoll = (request: FastifyRequest) =>
    ['GET', 'HEAD'].includes(request.method) && /^\/playQueues\/[^/]+$/.test(request.url.split('?')[0]);

  app.addHook('onRequest', async (request, reply) => {
    if (!browserPath(request)) return;
    await webAuth.initialize();
    if (webAuth.validSession(cookieValue(request, 'plexbridge_session'))) return;
    if (request.method === 'GET' && request.headers.accept?.includes('text/html')) {
      const returnTo = encodeURIComponent(request.url.startsWith('/') ? request.url : '/');
      return reply.redirect(`/web/login?returnTo=${returnTo}`);
    }
    return reply.code(401).send({ error: 'Web authentication required' });
  });

  app.addContentTypeParser(
    ['application/x-www-form-urlencoded', 'text/plain', 'application/xml'],
    { parseAs: 'string' },
    (_request, body: string, done) => done(null, body)
  );

  app.addHook('onRequest', async (request) => {
    const started = process.hrtime.bigint();
    (request as FastifyRequest & { startedAt?: bigint }).startedAt = started;
    if (settings.logLevel === 'TRACE' && !isPlayQueuePoll(request)) {
      const traceUrl = new URL(request.url, 'http://localhost');
      for (const [key] of traceUrl.searchParams) {
        if (/token|password|auth/i.test(key)) traceUrl.searchParams.set(key, '[REDACTED]');
      }
      const query = Object.fromEntries(
        Object.entries(request.query as Record<string, unknown>).map(([key, value]) => [
          key,
          /token|password|auth/i.test(key) ? '[REDACTED]' : value
        ])
      );
      const headers = Object.fromEntries(
        Object.entries(request.headers)
          .filter(
            ([key]) =>
              key.toLowerCase().startsWith('x-plex-') ||
              ['accept', 'content-type', 'user-agent', 'host'].includes(key.toLowerCase())
          )
          .filter(([key]) => key.toLowerCase() !== 'x-plex-token')
      );
      console.debug(
        JSON.stringify({
          event: 'request_trace',
          requestId: request.id,
          method: request.method,
          url: `${traceUrl.pathname}${traceUrl.search}`,
          remoteAddress: request.ip,
          query,
          headers
        })
      );
    }
  });

  app.addHook('onResponse', async (request, reply) => {
    if ((settings.logLevel === 'DEBUG' || settings.logLevel === 'TRACE') && !isPlayQueuePoll(request)) {
      const headers = Object.fromEntries(
        Object.entries(request.headers)
          .filter(([key]) => key.toLowerCase().startsWith('x-plex-') && key.toLowerCase() !== 'x-plex-token')
          .map(([key, value]) => [key, value])
      );
      const started = (request as FastifyRequest & { startedAt?: bigint }).startedAt ?? process.hrtime.bigint();
      console.debug(
        JSON.stringify({
          event: 'request',
          requestId: request.id,
          method: request.method,
          path: request.url.split('?')[0],
          queryNames: Object.keys(request.query as object),
          accept: request.headers.accept ?? '',
          userAgent: request.headers['user-agent'] ?? '',
          status: reply.statusCode,
          responseContentType: reply.getHeader('content-type') ?? '',
          durationMs: Number(process.hrtime.bigint() - started) / 1e6,
          plexHeaders: headers
        })
      );
    }
  });
  const xml = (body: string) => ({ body, type: 'application/xml; charset=utf-8' });

  app.get('/', async (request, reply) => {
    if (request.headers.accept?.includes('text/html')) return reply.type('text/html; charset=utf-8').send(homePage());
    const id = await getIdentity();
    let advertisedUrl = settings.publicUrl;
    try {
      advertisedUrl = await plexDirectUrl(settings.configDir, settings.publicUrl, settings.publicPort);
    } catch {
      /* certificate enrollment may not have happened yet */
    }
    const claimed = await isClaimed();
    return request.headers.accept?.includes('application/json')
      ? reply.type('application/json').send(serverRootJson(settings.serverName, id.machineIdentifier, claimed))
      : reply.type(xml('').type).send(serverRoot(settings.serverName, id.machineIdentifier, advertisedUrl, claimed));
  });

  app.get('/web/login', async (request, reply) => {
    const query = request.query as { returnTo?: string };
    const returnTo = typeof query.returnTo === 'string' ? query.returnTo : '/';
    const setupLink = webAuth.canUseLocalSetup()
      ? '<p><a href="/web/setup">Configure local credentials from this machine</a></p>'
      : '';
    return reply
      .type('text/html; charset=utf-8')
      .send(
        `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>PlexBridge sign in</title><style>body{font:16px system-ui,sans-serif;max-width:420px;margin:15vh auto;padding:24px;background:#111;color:#eee}form{background:#1d1d1d;padding:24px;border-radius:12px}input{box-sizing:border-box;width:100%;padding:12px;margin:8px 0;background:#292929;border:1px solid #555;border-radius:8px;color:#fff}button{padding:12px 18px;margin-top:8px;border:0;border-radius:8px;background:#e5a400;font-weight:700}p{color:#aaa}</style></head><body><h1>PlexBridge</h1><p>Sign in to view the dashboard.</p><form method="post" action="/web/login"><input type="hidden" name="returnTo" value="${String(returnTo).replaceAll('"', '&quot;')}"><label>Username<input name="username" autocomplete="username" required></label><label>Password<input type="password" name="password" autocomplete="current-password" required></label><button type="submit">Sign in</button></form>${setupLink}</body></html>`
      );
  });

  app.get('/web/setup', async (request, reply) => {
    if (!localRequest(request)) return reply.code(403).send('Local setup only\n');
    if (!webAuth.canUseLocalSetup()) return reply.code(409).send('Web credentials are configured by environment\n');
    return reply
      .type('text/html; charset=utf-8')
      .send(
        '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>PlexBridge local setup</title><style>:root{color-scheme:dark;font:16px system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}*{box-sizing:border-box}body{min-height:100vh;margin:0;background:radial-gradient(circle at 20% 0,#2b2413 0,#151515 42%,#0d0d0d 100%);color:#f5f5f5;display:grid;place-items:center;padding:24px}.shell{width:min(100%,460px)}.brand{display:flex;align-items:center;gap:12px;margin:0 0 24px;color:#f1b52b;font-size:13px;font-weight:800;letter-spacing:.14em}.mark{width:34px;height:34px;border:2px solid #f1b52b;border-radius:10px;display:grid;place-items:center}.mark:after{content:"";width:12px;height:12px;border-radius:4px;background:#f1b52b}.card{background:rgba(29,29,29,.94);border:1px solid #353535;border-radius:18px;padding:30px;box-shadow:0 24px 70px #0008}h1{margin:0 0 10px;font-size:28px;letter-spacing:-.03em}p{color:#aaa;line-height:1.5;margin:0 0 24px}.note{font-size:13px;color:#888;margin-top:18px;margin-bottom:0}label{display:block;margin:18px 0 0;color:#ddd;font-size:14px;font-weight:650}input{display:block;width:100%;margin-top:8px;padding:13px 14px;border:1px solid #4a4a4a;border-radius:10px;background:#111;color:#fff;font:inherit;outline:none}input:focus{border-color:#f1b52b;box-shadow:0 0 0 3px #f1b52b22}button{width:100%;margin-top:24px;padding:13px 16px;border:0;border-radius:10px;background:#f1b52b;color:#17120a;font:inherit;font-weight:800;cursor:pointer}button:hover{background:#ffc94c}</style></head><body><main class="shell"><div class="brand"><span class="mark"></span><span>PLEXBRIDGE</span></div><section class="card"><h1>Set up web access</h1><p>Create the local administrator credentials for your PlexBridge dashboard.</p><form method="post"><label>Username<input name="username" autocomplete="username" required></label><label>Password<input name="password" type="password" minlength="12" autocomplete="new-password" required></label><button type="submit">Save credentials</button></form><p class="note">This setup page is available only from localhost. Your password must be at least 12 characters.</p></section></main></body></html>'
      );
  });

  app.post('/web/setup', async (request, reply) => {
    if (!localRequest(request)) return reply.code(403).send('Local setup only\n');
    if (!webAuth.canUseLocalSetup()) return reply.code(409).send('Web credentials are configured by environment\n');
    const body = new URLSearchParams(typeof request.body === 'string' ? request.body : '');
    const username = body.get('username')?.trim() ?? '';
    const password = body.get('password') ?? '';
    if (username.length < 1 || password.length < 12)
      return reply.code(400).send('Username and a 12-character password are required\n');
    await webAuth.setCredentials(username, password);
    const secure = secureCookie(request) ? '; Secure' : '';
    reply.header(
      'set-cookie',
      `plexbridge_session=${encodeURIComponent(webAuth.createSession())}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800${secure}`
    );
    return reply.redirect('/');
  });

  app.post('/web/login', async (request, reply) => {
    await webAuth.initialize();
    const body = new URLSearchParams(typeof request.body === 'string' ? request.body : '');
    const username = body.get('username') ?? '';
    const password = body.get('password') ?? '';
    const returnTo = body.get('returnTo')?.startsWith('/') ? body.get('returnTo') : '/';
    if (!(await webAuth.verify(username, password)))
      return reply
        .code(401)
        .type('text/html; charset=utf-8')
        .send('<h1>Invalid credentials</h1><p><a href="/web/login">Try again</a></p>');
    const secure = secureCookie(request) ? '; Secure' : '';
    reply.header(
      'set-cookie',
      `plexbridge_session=${encodeURIComponent(webAuth.createSession())}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800${secure}`
    );
    return reply.redirect(returnTo ?? '/');
  });

  app.post('/web/logout', async (_request, reply) => {
    reply.header('set-cookie', 'plexbridge_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
    return reply.redirect('/web/login');
  });

  app.get('/identity', async (_request, reply) => {
    const id = await getIdentity();
    return reply.type(xml('').type).send(identity(id.machineIdentifier, await isClaimed()));
  });

  app.get('/media/providers', async (request, reply) => {
    const id = await getIdentity();
    const claimed = await isClaimed();
    return request.headers.accept?.includes('application/json')
      ? reply.type('application/json').send(mediaProvidersJson(settings.serverName, id.machineIdentifier, claimed))
      : reply.type(xml('').type).send(mediaProviders());
  });

  app.get('/library/sections', async (_request, reply) => reply.type(xml('').type).send(librarySections()));

  app.get('/hubs/sections/:id', async (request, reply) => {
    if ((request.params as { id: string }).id !== '1') return reply.code(404).send('Unknown library section\n');
    return request.headers.accept?.includes('application/json')
      ? reply.type('application/json').send(libraryHubsJson())
      : reply.type(xml('').type).send(libraryHubs());
  });
  registerPlaylistRoutes(app, {
    music: navidrome,
    playQueues,
    playlistIds: plexPlaylistIds,
    loadPlaylistIds,
    savePlaylistIds
  });
  const libraryRoutes = registerLibraryRoutes(app, {
    configDir: settings.configDir,
    music: navidrome,
    playQueues,
    savePlayQueues,
    playlistIds: plexPlaylistIds,
    loadPlaylistIds,
    preserveSourceFormats: settings.preserveSourceFormats,
    now,
    onPlay: recordPlay,
    hasPlayHistory,
    onPlaybackState: recordPlaybackState,
    ...timers
  });
  invalidateLibraryCaches = libraryRoutes.invalidateLibraryCaches;

  app.get('/health', async () => {
    const id = await getIdentity();
    const stored = await credentials();
    let registration: RegistrationHealth = {
      claimed: Boolean(stored.serverToken),
      cloudRegistered: false,
      published: false,
      present: false,
      owned: false,
      presence: false,
      accessTokenReady: false,
      connectionUrl: false,
      state: 'not-claimed'
    };
    if (stored.serverToken) {
      try {
        registration = await getRegistrationHealth(
          id,
          await plexDirectUrl(settings.configDir, settings.publicUrl, settings.publicPort),
          stored.serverToken,
          stored.authToken ?? ''
        );
      } catch (error) {
        console.warn(
          JSON.stringify({
            event: 'registration_health_failed',
            error: error instanceof Error ? error.message : 'unknown error'
          })
        );
      }
    }
    return {
      status: 'ok',
      version,
      server_identity_initialized: Boolean(storedIdentity),
      authentication_configured: Boolean(stored.serverToken),
      claim_state: stored.serverToken ? 'claimed' : 'not_attempted',
      registration_state: registration.state,
      registration,
      discovery_state: settings.discoveryEnabled ? 'configured' : 'disabled'
    };
  });

  app.get('/:/eventsource/notifications', async (_request, reply) => {
    reply.hijack();
    const response = reply.raw;
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive'
    });
    response.write(': \n\n');
    const keepAlive = setInterval(() => response.write(': -1\n\n'), 15000);
    response.on('close', () => clearInterval(keepAlive));
  });

  app.get('/admin', async (_request, reply) => reply.type('text/html; charset=utf-8').send(adminPage()));

  app.get('/admin.css', async (_request, reply) => reply.type('text/css; charset=utf-8').send(adminStyles()));

  app.get('/admin.js', async (_request, reply) =>
    reply.type('application/javascript; charset=utf-8').send(adminScript())
  );

  app.get('/home.css', async (_request, reply) => reply.type('text/css; charset=utf-8').send(homeStyles()));

  app.get('/home.js', async (_request, reply) =>
    reply.type('application/javascript; charset=utf-8').send(homeScript())
  );

  app.get('/admin/status', async () => {
    const stored = await credentials();
    let registration: RegistrationHealth | undefined;
    if (stored.serverToken) {
      try {
        registration = await getRegistrationHealth(
          await getIdentity(),
          await plexDirectUrl(settings.configDir, settings.publicUrl, settings.publicPort),
          stored.serverToken,
          stored.authToken ?? ''
        );
      } catch {
        /* status remains useful without cloud health */
      }
    }
    return {
      ...adminOperation,
      accountAuthenticated: Boolean(stored.authToken),
      certificateReady: await hasPlexCertificate(settings.configDir),
      registration
    };
  });

  const publicAdminSettings = () => ({
    navidromeUrl: appSettings.navidromeUrl,
    navidromeUsername: appSettings.navidromeUsername,
    navidromeConfigured: Boolean(
      appSettings.navidromeUrl && appSettings.navidromeUsername && appSettings.navidromePassword
    ),
    navidromeUrlFromEnv: Boolean(settings.navidromeUrl),
    navidromeUsernameFromEnv: Boolean(settings.navidromeUsername),
    navidromePasswordFromEnv: Boolean(settings.navidromePassword),
    syncEnabled: appSettings.syncEnabled,
    syncTime: appSettings.syncTime,
    sync: syncStatus
  });

  app.get('/admin/settings', async () => publicAdminSettings());

  app.put('/admin/settings', async (request, reply) => {
    const body = (request.body ?? {}) as Partial<AppSettings>;
    const error = validateAppSettings(body);
    if (error) return reply.code(400).send({ error });
    if (!settings.navidromeUrl && body.navidromeUrl !== undefined) appSettings.navidromeUrl = body.navidromeUrl;
    if (!settings.navidromeUsername && body.navidromeUsername !== undefined)
      appSettings.navidromeUsername = body.navidromeUsername;
    if (!settings.navidromePassword && body.navidromePassword !== undefined)
      appSettings.navidromePassword = body.navidromePassword;
    if (body.syncEnabled !== undefined) appSettings.syncEnabled = Boolean(body.syncEnabled);
    if (body.syncTime !== undefined) appSettings.syncTime = body.syncTime;
    await saveAppSettings(settings.configDir, {
      ...appSettings,
      navidromeUrl: settings.navidromeUrl ? '' : appSettings.navidromeUrl,
      navidromeUsername: settings.navidromeUsername ? '' : appSettings.navidromeUsername,
      navidromePassword: settings.navidromePassword ? '' : appSettings.navidromePassword
    });
    navidrome.updateSettings?.({
      url: appSettings.navidromeUrl,
      username: appSettings.navidromeUsername,
      password: appSettings.navidromePassword
    });
    return publicAdminSettings();
  });

  app.post('/admin/sync', async (_request, reply) => {
    if (syncStatus.state === 'running')
      return reply.code(409).send({ ...syncStatus, message: 'A sync is already running' });
    return runLibrarySync('manual');
  });

  app.get('/home/status', async () => {
    const stored = await credentials();
    await loadPlayHistory();
    return { accountAuthenticated: Boolean(stored.authToken), recentPlays: playHistory };
  });

  app.post('/admin/login', async (_request, reply) => {
    if (
      adminOperation.state === 'login_waiting' ||
      adminOperation.state === 'claim_running' ||
      adminOperation.state === 'register_running'
    )
      return reply.code(409).send({ ...adminOperation, message: 'An operation is already running' });
    const stored = await credentials();
    if (stored.serverToken && stored.authToken) {
      try {
        const current = await getRegistrationHealth(
          await getIdentity(),
          await plexDirectUrl(settings.configDir, settings.publicUrl, settings.publicPort),
          stored.serverToken,
          stored.authToken
        );
        if (current.cloudRegistered)
          return reply.code(409).send({
            state: 'error',
            message: 'PlexBridge is already registered with Plex; login is disabled to avoid creating another device'
          });
      } catch {
        /* allow login to repair a stale local claim */
      }
    }
    adminOperation = { state: 'login_waiting' };
    void (async () => {
      try {
        await authenticate(await getIdentity(), settings.configDir, {
          onUrl: (loginUrl) => {
            adminOperation.loginUrl = loginUrl;
          }
        });
        await finishRegistration();
        if (adminOperation.state !== 'register_complete')
          adminOperation = { state: 'login_complete', message: 'Plex login complete.' };
      } catch (error) {
        adminOperation = { state: 'error', message: error instanceof Error ? error.message : 'Plex login failed' };
      }
    })();
    return { ...adminOperation, message: 'Open the Plex approval page' };
  });

  app.post('/admin/claim', async (request, reply) => {
    if (
      adminOperation.state === 'login_waiting' ||
      adminOperation.state === 'claim_running' ||
      adminOperation.state === 'register_running'
    )
      return reply.code(409).send({ ...adminOperation, message: 'An operation is already running' });
    const body = (request.body ?? {}) as { claimToken?: string };
    const pastedClaimToken = body.claimToken?.trim() ?? '';
    const stored = await credentials();
    if (stored.serverToken)
      return reply
        .code(409)
        .send({ state: 'error', message: 'This server is already claimed; sign in to Plex to finish setup' });
    if (!pastedClaimToken && !stored.authToken)
      return reply.code(400).send({ state: 'error', message: 'Paste a claim token or login to Plex first' });
    adminOperation = { state: 'claim_running' };
    void (async () => {
      try {
        const id = await getIdentity();
        const claimToken =
          pastedClaimToken || (await requestClaimToken(id, settings.serverName, stored.authToken ?? ''));
        const serverToken = await exchangeClaimToken(id, settings.configDir, claimToken, settings.serverName);
        const hadCertificate = await hasPlexCertificate(settings.configDir);
        await ensurePlexCertificate(id, settings.configDir, serverToken);
        if (!hadCertificate) {
          adminOperation = {
            state: 'claim_complete',
            message: 'Server claimed. Restart PlexBridge once to activate HTTPS, then sign in to Plex to finish setup.'
          };
          return;
        }
        await finishRegistration();
      } catch (error) {
        adminOperation = { state: 'error', message: error instanceof Error ? error.message : 'Plex claim failed' };
      }
    })();
    return { ...adminOperation, message: 'Claim and registration started' };
  });

  app.post('/admin/register', async (_request, reply) => {
    if (
      adminOperation.state === 'login_waiting' ||
      adminOperation.state === 'claim_running' ||
      adminOperation.state === 'register_running'
    )
      return reply.code(409).send({ ...adminOperation, message: 'An operation is already running' });
    const stored = await credentials();
    if (!stored.serverToken) return reply.code(400).send({ state: 'error', message: 'PlexBridge is not claimed yet' });
    if (!stored.authToken)
      return reply
        .code(400)
        .send({ state: 'error', message: 'Sign in to Plex first; registration will resume automatically' });
    adminOperation = { state: 'register_running' };
    void (async () => {
      try {
        await finishRegistration();
      } catch (error) {
        adminOperation = {
          state: 'error',
          message: error instanceof Error ? error.message : 'Plex registration failed'
        };
      }
    })();
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
      const registration = await publishServer(
        id,
        settings.serverName,
        await plexDirectUrl(settings.configDir, settings.publicUrl, settings.publicPort),
        serverToken,
        accountToken,
        undefined,
        undefined,
        settings.port
      );
      if (!registration.registeredResourceMatch && accountToken)
        throw new Error('Plex accepted the claim but did not publish PlexBridge as an account resource');
      return reply
        .type(xml('').type)
        .send('<?xml version="1.0" encoding="UTF-8"?><MediaContainer size="0" claimed="1"/>');
    } catch (error) {
      console.warn(
        JSON.stringify({ event: 'claim_failed', error: error instanceof Error ? error.message : 'unknown error' })
      );
      return reply.code(502).type('text/plain; charset=utf-8').send('Plex claim exchange failed\n');
    }
  });

  app.addHook('onSend', async (_request, reply) => {
    const id = await getIdentity();
    reply.header('X-Plex-Protocol', '1.0');
    reply.header('X-Plex-Client-Identifier', id.machineIdentifier);
  });

  app.all('/*', async (request, reply) => {
    console.warn(
      JSON.stringify({ event: 'unsupported_endpoint', method: request.method, path: request.url.split('?')[0] })
    );
    return reply
      .code(404)
      .type('text/plain; charset=utf-8')
      .send('PlexBridge has not implemented this endpoint in Phase 1\n');
  });

  return app;
}
