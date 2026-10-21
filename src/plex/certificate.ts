import { execFile as execFileCallback } from 'node:child_process';
import { chmod, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { lookup } from 'node:dns/promises';
import type { Identity } from '../identity.js';
import { plexServerHeaders } from './profile.js';

const execFile = promisify(execFileCallback);
type Log = (event: string, details: Record<string, unknown>) => void;

function headers(identity: Identity, token: string): Record<string, string> {
  return plexServerHeaders(identity, 'PlexBridge', token, identity.processedMachineIdentifier);
}
async function exists(path: string): Promise<boolean> { try { await stat(path); return true; } catch { return false; } }
export function formatPlexCertificateRequest(value: string): string { const match = value.match(/-----BEGIN ([^-]+)-----([\s\S]+?)-----END \1-----/); if (!match) throw new Error('OpenSSL did not produce a valid certificate request'); return `-----BEGIN CERTIFICATE REQUEST-----\n${match[2].trim()}\n-----END CERTIFICATE REQUEST-----`; }

export async function hasPlexCertificate(configDir: string): Promise<boolean> { return await exists(join(configDir, 'plex-tls-key.pem')) && await exists(join(configDir, 'plex-tls-cert.pem')); }
export async function loadPlexCertificate(configDir: string): Promise<{ key: Buffer; cert: Buffer } | undefined> { if (!await hasPlexCertificate(configDir)) return undefined; return { key: await readFile(join(configDir, 'plex-tls-key.pem')), cert: await readFile(join(configDir, 'plex-tls-cert.pem')) }; }

export async function plexDirectUrl(configDir: string, publicUrl: string, port = 32400): Promise<string> {
  if (!await hasPlexCertificate(configDir)) throw new Error('Plex-direct certificate is required before publishing PlexBridge');
  const address = (await lookup(new URL(publicUrl).hostname)).address;
  const certificate = await execFile('openssl', ['x509', '-in', join(configDir, 'plex-tls-cert.pem'), '-noout', '-subject']);
  const suffix = certificate.stdout.match(/CN\s*=\s*\*\.([^,\s]+)/)?.[1];
  if (!suffix) throw new Error('Plex-direct certificate subject did not include a wildcard hostname');
  return `https://${address.replaceAll('.', '-')}.${suffix}:${port}`;
}

export async function ensurePlexCertificate(identity: Identity, configDir: string, serverToken: string, fetchImpl: typeof fetch = fetch, log: Log = (event, details) => console.info(JSON.stringify({ event, ...details }))): Promise<boolean> {
  if (await hasPlexCertificate(configDir)) return true;
  if (!serverToken) throw new Error('Plex server token is required for certificate enrollment');
  const endpoint = `https://servers.plex.tv/api/v2/devices/${encodeURIComponent(identity.processedMachineIdentifier)}`;
  const subjectResponse = await fetchImpl(`${endpoint}/certificate/subject`, { headers: headers(identity, serverToken) });
  if (!subjectResponse.ok) throw new Error(`Plex certificate subject request returned HTTP ${subjectResponse.status}`);
  const commonName = (await subjectResponse.text()).match(/commonName="([^"]+)"/)?.[1];
  if (!commonName) throw new Error('Plex certificate subject did not include a common name');
  const temporaryDir = await mkdtemp(join(configDir, '.plex-certificate-'));
  const keyPath = join(temporaryDir, 'key.pem'); const csrPath = join(temporaryDir, 'request.pem');
  try {
    await execFile('openssl', ['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath, '-out', csrPath, '-subj', `/CN=${commonName}`]);
    const formattedCsr = formatPlexCertificateRequest(await readFile(csrPath, 'utf8'));
    const form = new FormData(); form.append('file', formattedCsr);
    const csrResponse = await fetchImpl(`${endpoint}/certificate/csr?reason=new&invalidIn=0`, { method: 'PUT', headers: headers(identity, serverToken), body: form });
    const csrResponseBody = (await csrResponse.clone().text()).slice(0, 500).replace(/[A-Za-z0-9_-]{20,}/g, '[REDACTED]');
    log('certificate_csr', { status: csrResponse.status, commonName, csrLength: formattedCsr.length, responseBody: csrResponseBody || undefined });
    if (!csrResponse.ok && csrResponse.status !== 204) throw new Error(`Plex certificate CSR request returned HTTP ${csrResponse.status}`);
    let certificate = '';
    for (let attempt = 1; attempt <= 60; attempt += 1) {
      const response = await fetchImpl(`${endpoint}/certificate/download`, { headers: { ...headers(identity, serverToken), Accept: 'application/x-pem-file' } });
      log('certificate_download', { attempt, status: response.status });
      if (response.status === 200) { certificate = await response.text(); break; }
      if (response.status !== 202) throw new Error(`Plex certificate download returned HTTP ${response.status}`);
      const retryAfter = Number(response.headers.get('retry-after') ?? '1'); await new Promise((resolve) => setTimeout(resolve, Math.min(Number.isFinite(retryAfter) ? retryAfter * 1000 : 1000, 10_000)));
    }
    if (!certificate.includes('-----BEGIN CERTIFICATE-----')) throw new Error('Plex certificate download did not complete within 60 attempts');
    const keyTarget = join(configDir, 'plex-tls-key.pem'); const certTarget = join(configDir, 'plex-tls-cert.pem');
    await writeFile(`${keyTarget}.tmp`, await readFile(keyPath), { mode: 0o600 }); await writeFile(`${certTarget}.tmp`, certificate, { mode: 0o600 });
    await rename(`${keyTarget}.tmp`, keyTarget); await rename(`${certTarget}.tmp`, certTarget); await chmod(keyTarget, 0o600); await chmod(certTarget, 0o600);
    log('certificate_ready', { commonName }); return true;
  } finally { await rm(temporaryDir, { recursive: true, force: true }); }
}
