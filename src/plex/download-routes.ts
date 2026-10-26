import type { FastifyReply, FastifyRequest } from 'fastify';
import { Readable } from 'node:stream';
import type { ReadableStream } from 'node:stream/web';
import type { MusicProvider } from '../music/types.js';
import { audioStreamOptions, parseMetadataKey } from './metadata.js';

type RouteRequest = FastifyRequest<{
  Querystring: Record<string, string | string[] | undefined>;
  Params: Record<string, string>;
}>;
type RouteReply = FastifyReply;

interface RouteApp {
  get(path: string, handler: (request: RouteRequest, reply: RouteReply) => unknown): unknown;
  post(path: string, handler: (request: RouteRequest, reply: RouteReply) => unknown): unknown;
  delete(path: string, handler: (request: RouteRequest, reply: RouteReply) => unknown): unknown;
}

interface DownloadRouteDependencies {
  music: MusicProvider;
  preserveSourceFormats: boolean;
}

interface DownloadQueueItem {
  id: number;
  queueId: number;
  key: string;
  status: 'available';
}

interface DownloadQueue {
  id: number;
  items: Map<number, DownloadQueueItem>;
}

function queueBody(queue: DownloadQueue): string {
  return JSON.stringify({
    MediaContainer: {
      size: 1,
      DownloadQueue: [{ id: queue.id, status: queue.items.size ? 'available' : 'done', itemCount: queue.items.size }]
    }
  });
}

const decision = {
  generalDecisionCode: 1000,
  generalDecisionText: 'Direct play OK.',
  directPlayDecisionCode: 1000,
  directPlayDecisionText: 'Direct play OK.'
};

function itemsBody(items: DownloadQueueItem[]): string {
  return JSON.stringify({
    MediaContainer: {
      size: items.length,
      DownloadQueueItem: items.map((item) => ({
        ...item,
        DecisionResult: decision
      }))
    }
  });
}

function queryKeys(query: Record<string, string | string[] | undefined>): { keys?: string[]; error?: string } {
  const values = Array.isArray(query.keys) ? query.keys : [query.keys];
  const supplied = values.flatMap((value) => (value ? value.split(',') : [])).map((value) => value.trim());
  if (!supplied.length) return { error: 'The keys query parameter is required\n' };
  const invalid = supplied.filter((value) => !/^\/library\/metadata\/s-[^/?#]+$/.test(value));
  if (invalid.length) return { error: `Unsupported download key: ${invalid[0]}\n` };
  return {
    keys: supplied
  };
}

export function registerDownloadRoutes(
  app: RouteApp,
  { music, preserveSourceFormats }: DownloadRouteDependencies
): void {
  const queues = new Map<number, DownloadQueue>();
  const clientQueues = new Map<string, DownloadQueue>();
  let nextQueueId = 1;
  let nextItemId = 1;

  const getQueue = (id: string): DownloadQueue | undefined => queues.get(Number(id));
  const json = (reply: RouteReply, body: string) => reply.type('application/json').send(body);

  app.post('/downloadQueue', async (request, reply) => {
    const clientId = request.headers['x-plex-client-identifier'];
    const clientKey = Array.isArray(clientId) ? clientId[0] : clientId;
    const existing = clientKey ? clientQueues.get(clientKey) : undefined;
    if (existing) return json(reply, queueBody(existing));
    const queue: DownloadQueue = { id: nextQueueId++, items: new Map() };
    queues.set(queue.id, queue);
    if (clientKey) clientQueues.set(clientKey, queue);
    return json(reply, queueBody(queue));
  });

  app.get('/downloadQueue/:queueId', async (request, reply) => {
    const queue = getQueue(request.params.queueId);
    return queue ? json(reply, queueBody(queue)) : reply.code(404).send('Download queue not found\n');
  });

  app.post('/downloadQueue/:queueId/add', async (request, reply) => {
    const queue = getQueue(request.params.queueId);
    if (!queue) return reply.code(404).send('Download queue not found\n');
    const parsedKeys = queryKeys(request.query);
    if (parsedKeys.error) return reply.code(400).send(parsedKeys.error);
    if (!parsedKeys.keys) return reply.code(400).send('The keys query parameter is required\n');
    const added = parsedKeys.keys.map((key) => {
      const existing = [...queue.items.values()].find((item) => item.key === key);
      if (existing) return existing;
      const item: DownloadQueueItem = { id: nextItemId++, queueId: queue.id, key, status: 'available' };
      queue.items.set(item.id, item);
      return item;
    });
    return json(
      reply,
      JSON.stringify({
        MediaContainer: { size: added.length, AddedQueueItems: added.map(({ key, id }) => ({ key, id })) }
      })
    );
  });

  app.get('/downloadQueue/:queueId/items', async (request, reply) => {
    const queue = getQueue(request.params.queueId);
    return queue
      ? json(reply, itemsBody([...queue.items.values()]))
      : reply.code(404).send('Download queue not found\n');
  });

  app.get('/downloadQueue/:queueId/items/:itemId', async (request, reply) => {
    const queue = getQueue(request.params.queueId);
    const item = queue?.items.get(Number(request.params.itemId));
    return item ? json(reply, itemsBody([item])) : reply.code(404).send('Download queue item not found\n');
  });

  app.get('/downloadQueue/:queueId/item/:itemId/decision', async (request, reply) => {
    const queue = getQueue(request.params.queueId);
    const item = queue?.items.get(Number(request.params.itemId));
    return item
      ? json(reply, JSON.stringify({ MediaContainer: { size: 1, ...decision, DecisionResult: decision } }))
      : reply.code(404).send('Download queue item not found\n');
  });

  app.get('/downloadQueue/:queueId/item/:itemId/media', async (request, reply) => {
    const queue = getQueue(request.params.queueId);
    const item = queue?.items.get(Number(request.params.itemId));
    const parsed = item ? parseMetadataKey(item.key.replace('/library/metadata/', '')) : undefined;
    if (!item || parsed?.kind !== 's') return reply.code(404).send('Download queue item not found\n');
    try {
      const song = await music.song(parsed.id);
      const clientProfile = String(request.headers['x-plex-client-profile-extra'] ?? '');
      const source = await music.streamUrl(
        parsed.id,
        audioStreamOptions(song, preserveSourceFormats, true, clientProfile)
      );
      const range = request.headers.range;
      const response = await fetch(source, range ? { headers: { range } } : undefined);
      if (!response.ok || !response.body) return reply.code(502).send('Download media unavailable\n');
      if (response.status === 206) reply.code(206);
      reply.header('content-type', response.headers.get('content-type') ?? 'audio/mpeg');
      for (const header of ['content-range', 'accept-ranges', 'content-length']) {
        const value = response.headers.get(header);
        if (value) reply.header(header, value);
      }
      return reply.send(Readable.fromWeb(response.body as unknown as ReadableStream));
    } catch {
      return reply.code(502).send('Download media unavailable\n');
    }
  });

  app.post('/downloadQueue/:queueId/items/:itemId/restart', async (request, reply) => {
    const queue = getQueue(request.params.queueId);
    const item = queue?.items.get(Number(request.params.itemId));
    return item ? reply.code(200).send() : reply.code(404).send('Download queue item not found\n');
  });

  app.delete('/downloadQueue/:queueId/items/:itemId', async (request, reply) => {
    const queue = getQueue(request.params.queueId);
    if (!queue) return reply.code(404).send('Download queue not found\n');
    for (const id of request.params.itemId.split(',').map(Number)) queue.items.delete(id);
    return reply.code(204).send();
  });
}
