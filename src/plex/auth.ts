import { generateKeyPairSync, sign } from 'node:crypto';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Identity } from '../identity.js';
import { PLEX_AUTH_PRODUCT, plexAuthClientIdentifier } from './profile.js';

const API = 'https://clients.plex.tv';
// Plex clients identify servers by this product value. Keep it identical to
// Plex Media Server so clients such as Plexamp do not discard the resource.
const PRODUCT = PLEX_AUTH_PRODUCT;
interface PinResponse { id: number; code: string }
interface TokenResponse { authToken?: string; auth_token?: string; authenticationToken?: string; token?: string }
export interface AuthenticationCallbacks { onUrl?: (url: string) => void; onStatus?: (status: string) => void }
function base64url(value: string | Buffer): string { return Buffer.from(value).toString('base64url'); }
function signedDeviceJwt(clientIdentifier: string, privateKey: string): string {
  const header = base64url(JSON.stringify({ alg: 'EdDSA', typ: 'JWT', kid: clientIdentifier }));
  const payload = base64url(JSON.stringify({ aud: 'plex.tv', iss: clientIdentifier, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 600 }));
  const input = `${header}.${payload}`;
  return `${input}.${sign(null, Buffer.from(input), privateKey).toString('base64url')}`;
}
function headers(clientIdentifier: string, token?: string): Record<string, string> {
  return { Accept: 'application/json', 'Content-Type': 'application/json', 'X-Plex-Product': PRODUCT, 'X-Plex-Client-Identifier': clientIdentifier, ...(token ? { 'X-Plex-Token': token } : {}) };
}
async function json<T>(response: Response): Promise<T> { if (!response.ok) throw new Error(`Plex API returned HTTP ${response.status}`); return response.json() as Promise<T>; }

export async function authenticate(identity: Identity, configDir: string, callbacks: AuthenticationCallbacks = {}): Promise<void> {
  const clientIdentifier = plexAuthClientIdentifier(identity);
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicJwk = publicKey.export({ format: 'jwk' }) as JsonWebKey & { x: string };
  const pin = await json<PinResponse>(await fetch(`${API}/api/v2/pins`, { method: 'POST', headers: headers(clientIdentifier), body: JSON.stringify({ jwk: { kty: 'OKP', crv: 'Ed25519', x: publicJwk.x, kid: clientIdentifier, alg: 'EdDSA' }, strong: true }) }));
  const authUrl = `https://app.plex.tv/auth#?clientID=${encodeURIComponent(clientIdentifier)}&code=${encodeURIComponent(pin.code)}&context%5Bdevice%5D%5Bproduct%5D=${encodeURIComponent(PRODUCT)}`;
  callbacks.onUrl?.(authUrl);
  console.log(`Open this URL and approve PlexBridge:\n${authUrl}`);
  console.log(`Waiting for Plex authorization for PIN ${pin.code}...`);
  callbacks.onStatus?.('waiting_for_approval');
  const privatePem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  let token = '';
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const response = await fetch(`${API}/api/v2/pins/${pin.id}?deviceJWT=${encodeURIComponent(signedDeviceJwt(clientIdentifier, privatePem))}`, { headers: headers(clientIdentifier) });
    if (response.ok) {
      const result = await response.json() as TokenResponse;
      token = result.authToken ?? result.auth_token ?? result.authenticationToken ?? result.token ?? '';
      console.log(JSON.stringify({ event: 'plex_pin_poll', attempt: attempt + 1, status: response.status, authorized: Boolean(token), responseKeys: Object.keys(result) }));
      if (token) break;
    } else {
      console.log(JSON.stringify({ event: 'plex_pin_poll', attempt: attempt + 1, status: response.status, authorized: false }));
      if (![401, 404].includes(response.status)) throw new Error(`Plex PIN polling returned HTTP ${response.status}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  if (!token) throw new Error('Plex authorization timed out or was not approved');
  const user = await json<{ id?: number; username?: string; email?: string }>(await fetch(`${API}/api/v2/user`, { headers: headers(clientIdentifier, token) }));
  const resources = await json<Array<{ name?: string; clientIdentifier?: string; provides?: string }>>(await fetch(`${API}/api/v2/resources?includeHttps=1&includeRelay=1&includeIPv6=1`, { headers: headers(clientIdentifier, token) }));
  const path = join(configDir, 'plex-credentials.json');
  let existing: Record<string, unknown> = {};
  try { existing = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>; } catch { /* first login */ }
  await writeFile(path, `${JSON.stringify({ ...existing, authToken: token, createdAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
  callbacks.onStatus?.('authenticated');
  console.log(JSON.stringify({ authenticated: true, user: { id: user.id, username: user.username, email: user.email }, resourceCount: resources.length, resources: resources.map(({ name, clientIdentifier, provides }) => ({ name, clientIdentifier, provides })) }, null, 2));
}

