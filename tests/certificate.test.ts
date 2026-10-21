import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { ensurePlexCertificate, formatPlexCertificateRequest } from '../src/plex/certificate.js';
import type { Identity } from '../src/identity.js';

const execFile = promisify(execFileCallback);

test('certificate request matches the captured PMS CSR profile', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'plexbridge-csr-'));
  try {
    const commonName = '*.93da506c1c094c7287d11f9b5b9390b4.plex.direct';
    const key = join(dir, 'key.pem');
    const csr = join(dir, 'request.pem');
    await execFile('openssl', ['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', csr, '-subj', `/CN=${commonName}`]);
    const formatted = formatPlexCertificateRequest(await readFile(csr, 'utf8'));
    assert.match(formatted, /^-----BEGIN CERTIFICATE REQUEST-----/);
    assert.match(formatted, /-----END CERTIFICATE REQUEST-----$/);
    assert.match(formatted, /-----BEGIN CERTIFICATE REQUEST-----\nMIICfjCCAWYCAQAwOTE3MDUGA1UEAwwuKi45M2RhNTA2YzFjMDk0YzcyODdkMTFm/);

    const body = formatted.match(/^-----BEGIN CERTIFICATE REQUEST-----([\s\S]+)-----END CERTIFICATE REQUEST-----$/)?.[1];
    assert.ok(body);
    const der = join(dir, 'formatted.der');
    await writeFile(der, Buffer.from(body, 'base64'));
    const asn = (await execFile('openssl', ['asn1parse', '-inform', 'DER', '-in', der])).stdout;
    assert.match(asn, /^    0:d=0 .*cons: SEQUENCE/);
    const details = (await execFile('openssl', ['req', '-in', csr, '-noout', '-text'])).stdout;
    assert.ok(details.includes(`Subject: CN=${commonName}`));
    assert.match(details, /Public-Key: \(2048 bit\)/);
    assert.match(details, /Signature Algorithm: sha256WithRSAEncryption/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('certificate enrollment sends the captured multipart field shape', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'plexbridge-enrollment-'));
  const identity: Identity = { machineIdentifier: 'machine-id', processedMachineIdentifier: 'processed-id' };
  const requests: Array<{ url: string; body: string }> = [];
  let downloadAttempt = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith('/certificate/subject')) return new Response('<subject commonName="*.93da506c1c094c7287d11f9b5b9390b4.plex.direct"/>', { status: 200 });
    if (url.includes('/certificate/csr?')) {
      const request = new Request(url, init);
      requests.push({ url, body: await request.text() });
      return new Response(null, { status: 204 });
    }
    if (url.endsWith('/certificate/download')) {
      downloadAttempt += 1;
      if (downloadAttempt === 1) return new Response(null, { status: 202, headers: { 'retry-after': '0' } });
      return new Response('-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----', { status: 200 });
    }
    throw new Error(`Unexpected URL ${url}`);
  };
  try {
    await ensurePlexCertificate(identity, dir, 'server-token', fetchImpl, () => undefined);
    assert.equal(requests.length, 1);
    assert.match(requests[0].body, /Content-Disposition: form-data; name="file"/);
    assert.doesNotMatch(requests[0].body, /filename=/);
    assert.match(requests[0].body, /-----BEGIN CERTIFICATE REQUEST-----\r?\n/);
    assert.doesNotMatch(requests[0].body, /NEW CERTIFICATE REQUEST/);
    assert.match(requests[0].body, /-----END CERTIFICATE REQUEST-----/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
