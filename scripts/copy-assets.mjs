import { copyFile, mkdir } from 'node:fs/promises';

await mkdir('dist/src/plex', { recursive: true });
await copyFile('src/plex/admin-page.html', 'dist/src/plex/admin-page.html');
await copyFile('src/plex/admin-page.css', 'dist/src/plex/admin-page.css');
await copyFile('src/plex/admin-client.js', 'dist/src/plex/admin-client.js');
await copyFile('src/plex/home-page.html', 'dist/src/plex/home-page.html');
await copyFile('src/plex/home-page.css', 'dist/src/plex/home-page.css');
await copyFile('src/plex/home-client.js', 'dist/src/plex/home-client.js');
