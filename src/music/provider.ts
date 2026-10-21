import { NavidromeClient, type NavidromeSettings } from './navidrome/client.js';
import type { MusicProvider } from './types.js';

export function createMusicProvider(settings: NavidromeSettings): MusicProvider {
  return new NavidromeClient(settings);
}
