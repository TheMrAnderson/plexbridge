import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

function asset(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./${name}`, import.meta.url)), 'utf8');
}

export function adminPage(): string {
  return asset('admin-page.html');
}
export function adminStyles(): string {
  return asset('admin-page.css');
}
export function adminScript(): string {
  return asset('admin-client.js');
}
