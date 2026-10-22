import { chmod, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Identity } from '../identity.js';
import { plexServerHeaders } from './profile.js';

const commonHeaders = (identity: Identity, serverName: string, accountToken: string): Record<string, string> =>
  plexServerHeaders(identity, serverName, accountToken);

export async function requestClaimToken(
  identity: Identity,
  serverName: string,
  accountToken: string,
  fetchImpl: typeof fetch = fetch
): Promise<string> {
  if (!accountToken) throw new Error('No Plex account token found. Run login first.');
  const response = await fetchImpl('https://plex.tv/api/claim/token', {
    headers: commonHeaders(identity, serverName, accountToken)
  });
  if (!response.ok) throw new Error(`Plex claim-token request returned HTTP ${response.status}`);
  const body = await response.text();
  const token = body.match(/(?:claimToken|token|claim)=?["=: ]+([A-Za-z0-9_-]+)/i)?.[1] ?? body.trim();
  if (!token || token.length < 10) throw new Error('Plex did not return a usable claim token');
  return token;
}

export async function exchangeClaimToken(
  identity: Identity,
  configDir: string,
  claimToken: string,
  serverName = 'PlexBridge',
  publicUrl = '',
  source: 'local-endpoint' | 'direct-cloud-experiment' = 'local-endpoint',
  fetchImpl: typeof fetch = fetch
): Promise<string> {
  const headers = {
    ...plexServerHeaders(identity, serverName),
    ...(publicUrl ? { 'X-Plex-Custom-Connections': publicUrl } : {})
  };
  const response = await fetchImpl(`https://plex.tv/api/claim/exchange?token=${encodeURIComponent(claimToken)}`, {
    method: 'POST',
    headers
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`Plex claim exchange returned HTTP ${response.status}`);
  const serverToken =
    body.match(/(?:authentication-token|authToken|token)="([^"]+)"/)?.[1] ??
    (() => {
      try {
        const value = JSON.parse(body) as { authenticationToken?: string; authToken?: string; token?: string };
        return value.authenticationToken ?? value.authToken ?? value.token ?? '';
      } catch {
        return '';
      }
    })();
  if (!serverToken) throw new Error('Plex claim exchange succeeded but returned no server token');
  const path = join(configDir, 'plex-credentials.json');
  let credentials: Record<string, unknown> = {};
  try {
    credentials = JSON.parse(await (await import('node:fs/promises')).readFile(path, 'utf8')) as Record<
      string,
      unknown
    >;
  } catch {
    /* first claim before account login */
  }
  await writeFile(
    path,
    `${JSON.stringify({ ...credentials, serverToken, claimSource: source, claimedAt: new Date().toISOString() }, null, 2)}\n`,
    { mode: 0o600 }
  );
  await chmod(path, 0o600);
  return serverToken;
}
