import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { PLEX_SERVER_PRODUCT } from './plex/profile.js';

export interface Identity {
  machineIdentifier: string;
  processedMachineIdentifier: string;
  libraryUuid?: string;
}

function processedIdentifier(machineIdentifier: string): string {
  return createHash('sha1').update(`${machineIdentifier}- ${PLEX_SERVER_PRODUCT}`).digest('hex');
}

export async function loadOrCreateIdentity(configDir: string): Promise<Identity> {
  await mkdir(configDir, { recursive: true });
  const path = join(configDir, 'identity.json');
  try {
    const existing = JSON.parse(await readFile(path, 'utf8')) as Partial<Identity>;
    if (
      existing.machineIdentifier &&
      existing.processedMachineIdentifier === processedIdentifier(existing.machineIdentifier) &&
      existing.libraryUuid
    )
      return existing as Identity;
    const migrated = {
      machineIdentifier: existing.machineIdentifier ?? randomBytes(16).toString('hex'),
      processedMachineIdentifier: processedIdentifier(existing.machineIdentifier ?? ''),
      libraryUuid: existing.libraryUuid ?? randomUUID()
    };
    await writeFile(path, `${JSON.stringify(migrated, null, 2)}\n`, { mode: 0o600 });
    await chmod(path, 0o600);
    return migrated;
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
  }
  const machineIdentifier = randomBytes(16).toString('hex');
  const identity = {
    machineIdentifier,
    processedMachineIdentifier: processedIdentifier(machineIdentifier),
    libraryUuid: randomUUID()
  };
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${JSON.stringify(identity, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
  await chmod(path, 0o600);
  return identity;
}
