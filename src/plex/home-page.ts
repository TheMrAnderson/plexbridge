import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

function asset(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./${name}`, import.meta.url)), 'utf8');
}

export function homePage(): string {
  return asset('home-page.html');
}
export function homeStyles(): string {
  return asset('home-page.css');
}
export function homeScript(): string {
  return asset('home-client.js');
}
