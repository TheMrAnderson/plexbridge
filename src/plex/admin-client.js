const plexCard = document.querySelector('#plex-card');
const step = document.querySelector('#step');
const status = document.querySelector('#status');
const url = document.querySelector('#url');
const debugDetails = document.querySelector('#debug-details');
const token = document.querySelector('#token');
const claim = document.querySelector('#claim');
const login = document.querySelector('#login');
const settingsForm = document.querySelector('#settings-form');
const navUrl = document.querySelector('#nav-url');
const navUser = document.querySelector('#nav-user');
const navPassword = document.querySelector('#nav-password');
const syncEnabled = document.querySelector('#sync-enabled');
const syncTime = document.querySelector('#sync-time');
const syncButton = document.querySelector('#sync');
const navStatus = document.querySelector('#nav-status');
const syncStatus = document.querySelector('#sync-status');

function showPlex(state) {
  const registration = state.registration || {};
  const hasClaim = Boolean(registration.claimed);
  const complete = Boolean(registration.cloudRegistered && registration.connectionUrl);
  const busy = ['login_waiting', 'claim_running', 'register_running'].includes(state.state);
  plexCard.hidden = complete && !busy;
  claim.disabled = hasClaim || busy;
  token.disabled = hasClaim || busy;
  login.disabled = complete || busy;
  if (!hasClaim) step.textContent = 'Step 1: Claim this server';
  else if (!state.accountAuthenticated) step.textContent = 'Step 2: Sign in to Plex to finish setup';
  else if (!state.certificateReady) step.textContent = 'Preparing the secure Plex connection…';
  else if (!complete) step.textContent = 'Connecting this server to Plex…';
  else step.textContent = 'PlexBridge is ready for Plexamp';
  status.textContent = state.state + (state.message ? ` — ${state.message}` : '');
  url.innerHTML = state.loginUrl
    ? `<a target="_blank" rel="noreferrer" href="${state.loginUrl}">Open Plex approval page</a>`
    : '';
  debugDetails.textContent = state.registration ? JSON.stringify(state.registration, null, 2) : '';
}

function showSettings(settings) {
  navUrl.value = settings.navidromeUrl || '';
  navUser.value = settings.navidromeUsername || '';
  syncEnabled.checked = settings.syncEnabled;
  syncTime.value = settings.syncTime || '03:00';
  navUrl.disabled = settings.navidromeUrlFromEnv;
  navUser.disabled = settings.navidromeUsernameFromEnv;
  navPassword.disabled = settings.navidromePasswordFromEnv;
  navStatus.textContent = settings.navidromeConfigured ? 'Connected' : 'Not configured';
  const sync = settings.sync || {};
  syncStatus.textContent = sync.message || (sync.state === 'idle' ? 'No sync has run yet.' : sync.state);
  if (sync.counts)
    syncStatus.textContent += ` · ${sync.counts.artists} artists · ${sync.counts.albums} albums · ${sync.counts.songs} tracks · ${sync.counts.playlists} playlists`;
  syncButton.disabled = sync.state === 'running' || !settings.navidromeConfigured;
}

async function refresh() {
  try {
    const [plexResponse, settingsResponse] = await Promise.all([fetch('/admin/status'), fetch('/admin/settings')]);
    showPlex(await plexResponse.json());
    showSettings(await settingsResponse.json());
  } catch {
    status.textContent = 'Unable to read admin status';
  }
}

async function post(path, body) {
  const response = await fetch(path, {
    method: 'POST',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  if (!response.ok) syncStatus.textContent = (await response.json()).error || 'Request failed';
  await refresh();
}

settingsForm.onsubmit = async (event) => {
  event.preventDefault();
  const response = await fetch('/admin/settings', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      navidromeUrl: navUrl.value.trim(),
      navidromeUsername: navUser.value.trim(),
      ...(navPassword.value ? { navidromePassword: navPassword.value } : {}),
      syncEnabled: syncEnabled.checked,
      syncTime: syncTime.value
    })
  });
  if (!response.ok) syncStatus.textContent = (await response.json()).error || 'Unable to save settings';
  else {
    navPassword.value = '';
    syncStatus.textContent = 'Settings saved.';
  }
  await refresh();
};

syncButton.onclick = () => post('/admin/sync');
claim.onclick = () => post('/admin/claim', { claimToken: token.value.trim() });
login.onclick = () => post('/admin/login');
refresh();
setInterval(refresh, 3000);
