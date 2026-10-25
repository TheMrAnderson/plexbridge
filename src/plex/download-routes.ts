import type { FastifyReply, FastifyRequest } from 'fastify';

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

function itemsBody(items: DownloadQueueItem[]): string {
  return JSON.stringify({
    MediaContainer: {
      size: items.length,
      DownloadQueueItem: items.map((item) => ({
        ...item,
        DecisionResult: {
          generalDecisionCode: 1000,
          generalDecisionText: 'Direct play OK.',
          directPlayDecisionCode: 1000,
          directPlayDecisionText: 'Direct play OK.'
        }
      }))
    }
  });
}

function queryKeys(query: Record<string, string | string[] | undefined>): string[] {
  const values = Array.isArray(query.keys) ? query.keys : [query.keys];
  return values
    .flatMap((value) => (value ? value.split(',') : []))
    .map((value) => value.trim())
    .filter((value) => /^\/library\/metadata\/s-[^/?#]+$/.test(value));
}

export function registerDownloadRoutes(app: RouteApp): void {
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
    const added = queryKeys(request.query).map((key) => {
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

  app.delete('/downloadQueue/:queueId/items/:itemId', async (request, reply) => {
    const queue = getQueue(request.params.queueId);
    if (!queue) return reply.code(404).send('Download queue not found\n');
    for (const id of request.params.itemId.split(',').map(Number)) queue.items.delete(id);
    return reply.code(204).send();
  });
}
