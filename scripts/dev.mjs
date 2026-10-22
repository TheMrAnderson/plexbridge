import { readdir, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';

async function oldPlexBridgePids() {
  const pids = [];
  for (const entry of await readdir('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const command = (await readFile(`/proc/${entry}/cmdline`)).toString().replaceAll('\0', ' ');
      if (command.includes('dist/src/server.js') && Number(entry) !== process.pid) pids.push(Number(entry));
    } catch {
      // Processes can exit while /proc is being scanned.
    }
  }
  return pids;
}

for (const pid of await oldPlexBridgePids()) {
  console.log(`Stopping previous PlexBridge process ${pid}`);
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    /* already stopped */
  }
}
if ((await oldPlexBridgePids()).length) await new Promise((resolve) => setTimeout(resolve, 500));

const child = spawn(process.execPath, ['--env-file-if-exists=.env', 'dist/src/server.js'], {
  env: { ...process.env, PLEXBRIDGE_CONFIG_DIR: './config' },
  stdio: 'inherit'
});
const stop = (signal) => child.kill(signal);
process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
