const status = document.querySelector('#status');
const empty = document.querySelector('#empty');
const plays = document.querySelector('#plays');

function render(data) {
  const authenticated = Boolean(data.accountAuthenticated);
  status.textContent = authenticated ? 'Plex authenticated' : 'Plex not authenticated';
  plays.replaceChildren();
  const recentPlays = authenticated ? data.recentPlays || [] : [];
  empty.hidden = recentPlays.length > 0;
  if (!recentPlays.length) {
    empty.textContent = authenticated
      ? 'No recent plays yet. Start listening through Plexamp and they’ll appear here.'
      : 'Sign in to Plex to start listening through Plexamp.';
  }
  for (const play of recentPlays) {
    const row = document.createElement('div');
    row.className = 'play';
    const title = document.createElement('div');
    title.className = 'play-title';
    title.textContent = play.title || play.trackId;
    const meta = document.createElement('div');
    meta.className = 'play-meta';
    meta.textContent = [play.artist, play.album].filter(Boolean).join(' — ') || 'Track metadata unavailable';
    const time = document.createElement('div');
    time.className = 'play-time';
    time.textContent = new Date(play.playedAt).toLocaleString();
    row.append(title, meta, time);
    plays.append(row);
  }
}

async function refresh() {
  try {
    render(await (await fetch('/home/status')).json());
  } catch {
    status.textContent = 'Unable to load play history';
  }
}

refresh();
setInterval(refresh, 5000);
