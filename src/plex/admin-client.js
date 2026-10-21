const step = document.querySelector('#step');
const status = document.querySelector('#status');
const url = document.querySelector('#url');
const details = document.querySelector('#details');
const token = document.querySelector('#token');
const claim = document.querySelector('#claim');
const login = document.querySelector('#login');

function show(state) {
  const registration = state.registration || {};
  const hasClaim = Boolean(registration.claimed);
  const complete = Boolean(registration.cloudRegistered && registration.connectionUrl);
  const busy = ['login_waiting', 'claim_running', 'register_running'].includes(state.state);
  claim.disabled = hasClaim || busy;
  token.disabled = hasClaim || busy;
  login.disabled = complete || busy;

  if (!hasClaim) step.textContent = 'Step 1: Claim this server';
  else if (!state.accountAuthenticated) step.textContent = 'Step 2: Sign in to Plex to finish setup';
  else if (!state.certificateReady) step.textContent = 'Preparing the secure Plex connection…';
  else if (!complete) step.textContent = 'Connecting this server to Plex…';
  else step.textContent = 'PlexBridge is ready for Plexamp';

  status.textContent = state.state + (state.message ? ` — ${state.message}` : '');
  url.innerHTML = state.loginUrl ? `<a target="_blank" rel="noreferrer" href="${state.loginUrl}">Open Plex approval page</a>` : '';
  details.textContent = state.registration ? JSON.stringify(state.registration, null, 2) : '';
}

async function refresh() {
  try {
    const response = await fetch('/admin/status');
    show(await response.json());
  } catch {
    status.textContent = 'Unable to read setup status';
  }
}

async function post(path, body) {
  const response = await fetch(path, {
    method: 'POST',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  show(await response.json());
  refresh();
}

claim.onclick = () => post('/admin/claim', { claimToken: token.value.trim() });
login.onclick = () => post('/admin/login');
refresh();
setInterval(refresh, 2000);
