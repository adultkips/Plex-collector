const app = document.getElementById('app');
const nav = document.getElementById('floating-nav');
const navProfile = document.getElementById('nav-profile');
const navActors = document.getElementById('nav-actors');
const ACTOR_PLACEHOLDER = 'https://placehold.co/500x750?text=Actor';
const MOVIE_PLACEHOLDER = 'https://placehold.co/500x750?text=Movie';
const ACTORS_BATCH_SIZE = 80;
const ACTOR_INITIAL_FILTERS = ['0-9', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z', 'Æ', 'Ø', 'Å', '#'];
const DEFAULT_DOWNLOAD_PREFIX = {
  actor_start: '',
  actor_mode: 'encoded_space',
  actor_end: '',
  movie_start: '',
  movie_mode: 'encoded_space',
  movie_end: '',
};

const state = {
  session: null,
  actors: [],
  profile: null,
  currentView: 'profile',
  actorsLoaded: false,
  profileLoaded: false,
  actorsSearchOpen: false,
  actorsSearchQuery: '',
  moviesSearchOpen: false,
  moviesSearchQuery: '',
  actorsSortBy: localStorage.getItem('actorsSortBy') || 'name',
  actorsSortDir: localStorage.getItem('actorsSortDir') || 'asc',
  actorsInitialFilter: localStorage.getItem('actorsInitialFilter') || 'A',
  actorsVisibleCount: ACTORS_BATCH_SIZE,
  actorsImageObserver: null,
};
let plexAuthPopup = null;

navProfile.addEventListener('click', () => routeTo('profile'));
navActors.addEventListener('click', () => routeTo('actors'));

window.addEventListener('popstate', handleLocation);

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.detail || `Request failed: ${response.status}`);
  }

  return response.json();
}

function applyImageFallback(img, fallbackSrc) {
  if (!img) return;
  img.addEventListener('error', () => {
    if (img.src !== fallbackSrc) {
      img.src = fallbackSrc;
    }
  });
}

function sanitizeDownloadQuery(title) {
  return (title || '')
    .replace(/[^a-zA-Z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function getDownloadPrefixSettings() {
  const fromProfile = state.profile?.download_prefix || {};
  return {
    ...DEFAULT_DOWNLOAD_PREFIX,
    ...fromProfile,
  };
}

function buildDownloadKeyword(rawText, mode) {
  const clean = sanitizeDownloadQuery(rawText);
  if (!clean) return '';
  const words = clean.split(' ').filter(Boolean);
  return mode === 'hyphen' ? words.join('-') : words.join('%20');
}

function buildDownloadLink(type, rawText) {
  const settings = getDownloadPrefixSettings();
  const isActor = type === 'actor';
  const start = isActor ? settings.actor_start : settings.movie_start;
  const mode = isActor ? settings.actor_mode : settings.movie_mode;
  const end = isActor ? settings.actor_end : settings.movie_end;
  if (!start && !end) return '';
  const keyword = buildDownloadKeyword(rawText, mode);
  if (!keyword) return '';
  return `${start}${keyword}${end}`;
}

function buildDownloadExampleText(type, settings) {
  const isActor = type === 'actor';
  const start = (isActor ? settings.actor_start : settings.movie_start) || '';
  const mode = isActor ? settings.actor_mode : settings.movie_mode;
  const end = (isActor ? settings.actor_end : settings.movie_end) || '';
  if (!start && !end) {
    return '';
  }
  const keyword = buildDownloadKeyword(isActor ? 'bruce willis' : 'a day to die', mode);
  return `E.g.: ${start}${keyword}${end}`;
}

function getActorInitialBucket(name) {
  const firstChar = (name || '').trim().charAt(0).toUpperCase();
  if (!firstChar) return '#';
  if (/[0-9]/.test(firstChar)) return '0-9';
  if (/[A-Z]/.test(firstChar)) return firstChar;
  if (['Æ', 'Ø', 'Å'].includes(firstChar)) return firstChar;
  return '#';
}

function normalizeActorNameForSort(name) {
  return (name || '')
    .trim()
    .toUpperCase()
    .replaceAll('Æ', 'AE')
    .replaceAll('Ø', 'OE')
    .replaceAll('Å', 'AA')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '');
}

function compareActorNames(a, b) {
  const aName = normalizeActorNameForSort(a?.name);
  const bName = normalizeActorNameForSort(b?.name);
  if (aName < bName) return -1;
  if (aName > bName) return 1;
  return (a?.name || '').localeCompare(b?.name || '', 'en', { sensitivity: 'base' });
}

function routeTo(view, actorId = null) {
  if (view === 'actor-detail' && actorId) {
    history.pushState({}, '', `/actors/${actorId}`);
  } else {
    history.pushState({}, '', `/${view === 'profile' ? '' : view}`);
  }
  handleLocation();
}

function setNavVisible(visible) {
  nav.classList.toggle('hidden', !visible);
}

function setActiveNav(view) {
  navProfile.classList.toggle('active', view === 'profile');
  navActors.classList.toggle('active', view === 'actors');
}

function setFullWidthGridMode(enabled) {
  document.body.classList.toggle('full-grid-mode', enabled);
}

async function handleLocation() {
  const path = window.location.pathname;

  if (!state.session) {
    await bootstrap();
    return;
  }

  if (!state.session.authenticated) {
    setFullWidthGridMode(false);
    setNavVisible(false);
    renderOnboarding();
    return;
  }

  if (!state.profileLoaded) {
    await loadProfileData(true);
  }
  if (!state.profile?.tmdb_configured) {
    setFullWidthGridMode(false);
    setNavVisible(false);
    renderOnboardingTmdbStep();
    return;
  }

  if (path.startsWith('/actors/')) {
    setFullWidthGridMode(true);
    setNavVisible(true);
    const actorId = path.split('/').pop();
    await renderActorDetail(actorId);
    setActiveNav('actors');
    return;
  }

  if (path === '/actors') {
    setFullWidthGridMode(true);
    setNavVisible(true);
    await renderActors();
    setActiveNav('actors');
    return;
  }

  setFullWidthGridMode(false);
  setNavVisible(true);
  await renderProfile();
  setActiveNav('profile');
}

async function bootstrap() {
  try {
    state.session = await api('/api/session');
  } catch (error) {
    app.innerHTML = `<div class="empty">Server error: ${error.message}</div>`;
    return;
  }

  if (!state.session.authenticated) {
    setFullWidthGridMode(false);
    setNavVisible(false);
    renderOnboarding();
    return;
  }

  setNavVisible(true);
  await handleLocation();
}

function renderOnboarding() {
  setNavVisible(false);
  app.innerHTML = `
    <section class="onboarding">
      <div class="card">
        <h1>Plex Collector</h1>
        <p class="subtitle">Connect your Plex account.</p>
        <div class="row onboarding-actions">
          <button id="plex-login" class="primary-btn">Login with Plex</button>
        </div>
        <div class="status" id="onboarding-status"></div>
      </div>
    </section>
  `;

  document.getElementById('plex-login').addEventListener('click', startPlexLogin);
}

function renderOnboardingTmdbStep() {
  const data = state.profile || {};
  app.innerHTML = `
    <section class="onboarding">
      <div class="card">
        <h1>Plex Collector</h1>
        <p class="subtitle">Step 2: Choose Plex Server and add your TMDb API key</p>
        <div class="row onboarding-actions">
          <span class="meta no-margin settings-label settings-label-strong">Server:</span>
          <select id="onboarding-server-select" class="secondary-btn server-select" aria-label="Select server">
            ${(data.available_servers || [])
              .map(
                (server) =>
                  `<option value="${server.client_identifier}" ${
                    server.client_identifier === data.current_server_client_identifier ? 'selected' : ''
                  }>${server.name || 'Unknown server'}</option>`
              )
              .join('')}
          </select>
        </div>
        <div class="row onboarding-actions">
          <span class="meta no-margin settings-label settings-label-strong">TMDb key:</span>
          <input id="onboarding-tmdb-key" type="text" name="tmdb_api_key_input" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" data-lpignore="true" data-form-type="other" class="secondary-btn tmdb-key-input" placeholder="TMDb API Key" />
        </div>
        <div class="row onboarding-actions onboarding-actions-save">
          <button id="onboarding-tmdb-save" class="primary-btn">Save</button>
        </div>
        <div class="status" id="onboarding-status"></div>
      </div>
    </section>
  `;
  document.getElementById('onboarding-tmdb-save').addEventListener('click', onboardingSaveTmdbKey);
}

async function onboardingSaveTmdbKey() {
  const input = document.getElementById('onboarding-tmdb-key');
  const serverSelect = document.getElementById('onboarding-server-select');
  const statusEl = document.getElementById('onboarding-status');
  const key = input?.value?.trim() || '';
  if (!key) {
    statusEl.textContent = 'Enter a key first';
    return;
  }
  try {
    if (serverSelect?.value) {
      await saveServerSelection(serverSelect.value, false);
    }
    await api('/api/tmdb/key', {
      method: 'POST',
      body: JSON.stringify({ api_key: key }),
    });
    statusEl.textContent = 'Saved';
    await loadProfileData(true);
    history.pushState({}, '', '/');
    await handleLocation();
  } catch (error) {
    statusEl.textContent = error.message;
    statusEl.classList.add('error');
  }
}

async function startPlexLogin() {
  const statusEl = document.getElementById('onboarding-status');
  statusEl.textContent = 'Opening Plex login...';

  try {
    const pin = await api('/api/auth/plex/start', { method: 'POST' });
    plexAuthPopup = window.open(pin.login_url, '_blank');

    statusEl.textContent = 'Waiting for Plex authentication...';
    await pollForAuth(pin.pin_id, statusEl);
  } catch (error) {
    statusEl.textContent = error.message;
    statusEl.classList.add('error');
  }
}

async function pollForAuth(pinId, statusEl) {
  const maxAttempts = 120;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const result = await api(`/api/auth/plex/check?pin_id=${pinId}`);
    if (result.authenticated) {
      if (plexAuthPopup && !plexAuthPopup.closed) {
        plexAuthPopup.close();
      }
      plexAuthPopup = null;
      statusEl.textContent = 'Connected. Loading profile...';
      statusEl.classList.remove('error');
      statusEl.classList.add('success');
      state.session = await api('/api/session');
      await loadProfileData(true);
      history.pushState({}, '', '/');
      await handleLocation();
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  throw new Error('Login timed out. Try again.');
}

async function renderProfile() {
  const data = await loadProfileData();
  state.profile = data;
  const downloadPrefix = getDownloadPrefixSettings();
  const actorExampleText = buildDownloadExampleText('actor', downloadPrefix);
  const movieExampleText = buildDownloadExampleText('movie', downloadPrefix);
  const actorPrefixConfigured = Boolean((downloadPrefix.actor_start || '').trim() || (downloadPrefix.actor_end || '').trim());
  const moviePrefixConfigured = Boolean((downloadPrefix.movie_start || '').trim() || (downloadPrefix.movie_end || '').trim());

  app.innerHTML = `
    <section class="profile">
      <div class="profile-header card">
        <button id="reset-btn" class="secondary-btn profile-reset-btn">Reset</button>
        <img src="${data.profile?.thumb || 'https://placehold.co/120x120?text=Plex'}" alt="Profile" />
        <div>
          <h2>${data.profile?.username || 'Unknown user'}</h2>
          <div class="row settings-row">
            <span class="meta no-margin settings-label settings-label-strong">Server:</span>
            <select id="server-select" class="secondary-btn server-select" aria-label="Select server">
              ${(data.available_servers || [])
                .map(
                  (server) =>
                    `<option value="${server.client_identifier}" ${
                      server.client_identifier === data.current_server_client_identifier ? 'selected' : ''
                    }>${server.name || 'Unknown server'}</option>`
                )
                .join('')}
            </select>
            <button id="server-save-btn" class="secondary-btn">Save</button>
            <span class="meta no-margin status-check">${data.current_server_client_identifier ? '✓' : ''}</span>
            <span id="server-select-status" class="meta no-margin"></span>
          </div>
          <div class="row settings-row">
            <span class="meta no-margin settings-label settings-label-strong">TMDb key:</span>
            <input id="tmdb-key-input" type="text" name="tmdb_api_key_input" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" data-lpignore="true" data-form-type="other" class="secondary-btn tmdb-key-input" placeholder="Set TMDb API Key in app" />
            <button id="tmdb-save-btn" class="secondary-btn">Save</button>
            <span class="meta no-margin status-check">${data.tmdb_configured ? '✓' : ''}</span>
            <span id="tmdb-key-status" class="meta no-margin"></span>
          </div>
        </div>
      </div>

      <div class="card download-prefix-card">
        <h3>Download Prefix</h3>
        <div class="row settings-row">
          <span class="meta no-margin prefix-label settings-label-strong">Actors prefix:</span>
          <input id="actor-prefix-start" type="text" class="secondary-btn prefix-input" placeholder="Start prefix" value="${downloadPrefix.actor_start}" />
          <select id="actor-prefix-format" class="secondary-btn prefix-format-select" aria-label="Actor keyword format">
            <option value="encoded_space" ${downloadPrefix.actor_mode === 'encoded_space' ? 'selected' : ''}>Bruce%20Willis</option>
            <option value="hyphen" ${downloadPrefix.actor_mode === 'hyphen' ? 'selected' : ''}>Bruce-Willis</option>
          </select>
          <input id="actor-prefix-end" type="text" class="secondary-btn prefix-input" placeholder="End prefix" value="${downloadPrefix.actor_end}" />
          <button id="actor-prefix-save-btn" class="secondary-btn">Save</button>
          <span id="actor-prefix-check" class="meta no-margin status-check">${actorPrefixConfigured ? '✓' : ''}</span>
          <span id="actor-prefix-status" class="meta no-margin"></span>
        </div>
        <div id="actor-prefix-example" class="meta no-margin prefix-example ${actorExampleText ? '' : 'hidden'}">${actorExampleText}</div>
        <div class="row settings-row">
          <span class="meta no-margin prefix-label settings-label-strong">Film prefix:</span>
          <input id="movie-prefix-start" type="text" class="secondary-btn prefix-input" placeholder="Start prefix" value="${downloadPrefix.movie_start}" />
          <select id="movie-prefix-format" class="secondary-btn prefix-format-select" aria-label="Movie keyword format">
            <option value="encoded_space" ${downloadPrefix.movie_mode === 'encoded_space' ? 'selected' : ''}>A%20Day%20to%20Die</option>
            <option value="hyphen" ${downloadPrefix.movie_mode === 'hyphen' ? 'selected' : ''}>A-Day-to-Die</option>
          </select>
          <input id="movie-prefix-end" type="text" class="secondary-btn prefix-input" placeholder="End prefix" value="${downloadPrefix.movie_end}" />
          <button id="movie-prefix-save-btn" class="secondary-btn">Save</button>
          <span id="movie-prefix-check" class="meta no-margin status-check">${moviePrefixConfigured ? '✓' : ''}</span>
          <span id="movie-prefix-status" class="meta no-margin"></span>
        </div>
        <div id="movie-prefix-example" class="meta no-margin prefix-example ${movieExampleText ? '' : 'hidden'}">${movieExampleText}</div>
      </div>

      <div class="card library-sync-card">
        <h3>Library Sync</h3>
        <p class="subtitle">Scan Plex libraries.</p>
        <div class="row library-sync-actions">
          <button id="scan-btn" class="primary-btn">Scan Actors</button>
          <span id="scan-status" class="meta"></span>
        </div>
        <section class="scan-log">
          <h4>Log</h4>
          <ul id="scan-log-list" class="scan-log-list"></ul>
        </section>
      </div>
    </section>
  `;

  document.getElementById('scan-btn').addEventListener('click', runScan);
  document.getElementById('reset-btn').addEventListener('click', resetApp);
  document.getElementById('tmdb-save-btn').addEventListener('click', saveTmdbKey);
  const serverSelect = document.getElementById('server-select');
  const serverSaveBtn = document.getElementById('server-save-btn');
  if (serverSelect && serverSaveBtn) {
    serverSaveBtn.addEventListener('click', () => {
      selectServer(serverSelect.value);
    });
  }
  const tmdbInput = document.getElementById('tmdb-key-input');
  if (tmdbInput && data.tmdb_api_key) {
    tmdbInput.value = data.tmdb_api_key;
  }
  document.getElementById('actor-prefix-save-btn').addEventListener('click', saveActorPrefix);
  document.getElementById('movie-prefix-save-btn').addEventListener('click', saveMoviePrefix);
  renderScanLogs(data.scan_logs || []);
}

async function loadProfileData(forceRefresh = false) {
  if (!forceRefresh && state.profileLoaded && state.profile) {
    return state.profile;
  }
  const data = await api('/api/profile');
  state.profile = data;
  state.profileLoaded = true;
  return data;
}

async function selectServer(clientIdentifier) {
  const status = document.getElementById('server-select-status');
  status.textContent = 'Switching...';
  try {
    await saveServerSelection(clientIdentifier, true);
    status.textContent = 'Saved';
    state.profileLoaded = false;
    state.actorsLoaded = false;
    await renderProfile();
  } catch (error) {
    status.textContent = error.message;
  }
}

async function saveServerSelection(clientIdentifier, throwOnError = true) {
  try {
    await api('/api/server/select', {
      method: 'POST',
      body: JSON.stringify({ client_identifier: clientIdentifier }),
    });
    return true;
  } catch (error) {
    if (throwOnError) {
      throw error;
    }
    return false;
  }
}

async function saveTmdbKey() {
  const input = document.getElementById('tmdb-key-input');
  const status = document.getElementById('tmdb-key-status');
  const key = input?.value?.trim() || '';
  if (!key) {
    status.textContent = 'Enter a key first';
    return;
  }
  try {
    await api('/api/tmdb/key', {
      method: 'POST',
      body: JSON.stringify({ api_key: key }),
    });
    input.value = '';
    status.textContent = 'Saved';
    state.profileLoaded = false;
    await renderProfile();
  } catch (error) {
    status.textContent = error.message;
  }
}

async function saveActorPrefix() {
  const status = document.getElementById('actor-prefix-status');
  const check = document.getElementById('actor-prefix-check');
  const example = document.getElementById('actor-prefix-example');
  status.textContent = 'Saving...';
  const existing = getDownloadPrefixSettings();
  const payload = {
    actor_start: document.getElementById('actor-prefix-start').value.trim(),
    actor_mode: document.getElementById('actor-prefix-format').value,
    actor_end: document.getElementById('actor-prefix-end').value.trim(),
    movie_start: existing.movie_start,
    movie_mode: existing.movie_mode,
    movie_end: existing.movie_end,
  };
  try {
    const result = await api('/api/download-prefix', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    state.profile = { ...state.profile, download_prefix: result.download_prefix };
    const configured = Boolean((result.download_prefix.actor_start || '').trim() || (result.download_prefix.actor_end || '').trim());
    if (check) check.textContent = configured ? '✓' : '';
    if (example) {
      const text = buildDownloadExampleText('actor', result.download_prefix);
      example.textContent = text;
      example.classList.toggle('hidden', !text);
    }
    status.textContent = 'Saved';
  } catch (error) {
    status.textContent = error.message;
  }
}

async function saveMoviePrefix() {
  const status = document.getElementById('movie-prefix-status');
  const check = document.getElementById('movie-prefix-check');
  const example = document.getElementById('movie-prefix-example');
  status.textContent = 'Saving...';
  const existing = getDownloadPrefixSettings();
  const payload = {
    actor_start: existing.actor_start,
    actor_mode: existing.actor_mode,
    actor_end: existing.actor_end,
    movie_start: document.getElementById('movie-prefix-start').value.trim(),
    movie_mode: document.getElementById('movie-prefix-format').value,
    movie_end: document.getElementById('movie-prefix-end').value.trim(),
  };
  try {
    const result = await api('/api/download-prefix', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    state.profile = { ...state.profile, download_prefix: result.download_prefix };
    const configured = Boolean((result.download_prefix.movie_start || '').trim() || (result.download_prefix.movie_end || '').trim());
    if (check) check.textContent = configured ? '✓' : '';
    if (example) {
      const text = buildDownloadExampleText('movie', result.download_prefix);
      example.textContent = text;
      example.classList.toggle('hidden', !text);
    }
    status.textContent = 'Saved';
  } catch (error) {
    status.textContent = error.message;
  }
}

function renderScanLogs(logs) {
  const list = document.getElementById('scan-log-list');
  if (!list) return;

  if (!logs.length) {
    list.innerHTML = '<li class="scan-log-item">No scans yet.</li>';
    return;
  }

  list.innerHTML = logs
    .slice(0, 5)
    .map((entry) => {
      const dateText = new Date(entry.scanned_at).toLocaleString();
      return `<li class="scan-log-item">${dateText} - ${entry.actors} actors, ${entry.movies} movies</li>`;
    })
    .join('');
}

function showScanModal(message) {
  const modal = document.createElement('div');
  modal.className = 'scan-modal';
  modal.id = 'scan-modal';
  modal.innerHTML = `
    <div class="scan-modal-card card">
      <div class="scan-icon-wrap" id="scan-icon-wrap">
        <div class="scan-spinner" id="scan-spinner"></div>
      </div>
      <div class="scan-modal-msg" id="scan-modal-msg">${message}</div>
    </div>
  `;
  document.body.appendChild(modal);
}

function showScanSuccessModal() {
  const iconWrap = document.getElementById('scan-icon-wrap');
  const msg = document.getElementById('scan-modal-msg');
  if (!iconWrap) return;
  iconWrap.innerHTML = '<div class="scan-check">✓</div>';
  if (msg) msg.textContent = 'Scan complete';
}

function closeScanModal() {
  const modal = document.getElementById('scan-modal');
  if (modal) modal.remove();
}

async function runScan() {
  const status = document.getElementById('scan-status');
  const scanText = 'Scanning...';
  status.classList.remove('success', 'error');
  status.textContent = 'Scanning...';
  showScanModal(scanText);

  try {
    const result = await api('/api/scan/actors', { method: 'POST' });
    status.classList.add('success');
    status.textContent = '✓';
    state.actorsLoaded = false;
    renderScanLogs(result.scan_logs || []);
    showScanSuccessModal();
    setTimeout(closeScanModal, 700);
  } catch (error) {
    status.classList.remove('success');
    status.classList.add('error');
    status.textContent = error.message;
    closeScanModal();
  }
}

async function resetApp() {
  if (!window.confirm('Reset all local app data? This clears Plex login, actor scans, and cached state.')) {
    return;
  }
  await api('/api/reset', { method: 'POST' });
  state.session = { authenticated: false };
  state.actors = [];
  state.profile = null;
  state.actorsLoaded = false;
  state.profileLoaded = false;
  history.pushState({}, '', '/');
  renderOnboarding();
}

async function renderActors() {
  let data = { items: state.actors, last_scan_at: null };
  if (!state.actorsLoaded) {
    data = await api('/api/actors');
    state.actors = data.items;
    state.actorsLoaded = true;
  } else {
    data.last_scan_at = state.profile?.scan_logs?.[0]?.scanned_at || null;
  }

  if (!state.actors.length) {
    app.innerHTML = `
      <div class="topbar">
        <h2>Actors</h2>
      </div>
      <div class="empty actors-empty">No actors yet. Go to Profile and run a scan first.</div>
    `;
    return;
  }

  app.innerHTML = `
    <div class="topbar">
      <div class="topbar-title">
        <h2>Actors</h2>
        <div class="meta">${state.actors.length} actors ${data.last_scan_at ? `- last scan ${new Date(data.last_scan_at).toLocaleString()}` : ''}</div>
      </div>
      <div class="row">
        <div id="actors-search-control" class="search-control ${state.actorsSearchOpen ? 'open' : ''}">
          <button id="actors-search-toggle" class="search-toggle-btn" title="Search" aria-label="Search">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 4a6 6 0 1 1-4.24 10.24A6 6 0 0 1 10 4m0-2a8 8 0 1 0 5.29 14l4.85 4.85 1.41-1.41-4.85-4.85A8 8 0 0 0 10 2Z"/></svg>
          </button>
          <input id="actors-search-input" class="search-input" type="text" placeholder="Search actors" value="${state.actorsSearchQuery}" />
          <button id="actors-search-clear" class="search-clear-btn ${state.actorsSearchOpen ? '' : 'hidden'}" title="Clear search" aria-label="Clear search">×</button>
        </div>
        <select id="actors-sort-by" class="secondary-btn" aria-label="Sort actors by">
          <option value="name" ${state.actorsSortBy === 'name' ? 'selected' : ''}>Name</option>
          <option value="amount" ${state.actorsSortBy === 'amount' ? 'selected' : ''}>Amount</option>
        </select>
        <button id="actors-sort-dir" class="toggle-btn" title="Toggle sort direction" aria-label="Toggle sort direction">${state.actorsSortDir === 'asc' ? '↑' : '↓'}</button>
      </div>
    </div>
    <div class="alphabet-filter" id="actors-alphabet-filter">
      ${(() => {
        const initials = new Set(state.actors.map((actor) => getActorInitialBucket(actor.name)));
        const dynamicFilters = ACTOR_INITIAL_FILTERS.filter((key) => {
          if (['Æ', 'Ø', 'Å'].includes(key)) {
            return initials.has(key);
          }
          return true;
        });
        if (!dynamicFilters.includes(state.actorsInitialFilter)) {
          state.actorsInitialFilter = 'A';
          localStorage.setItem('actorsInitialFilter', state.actorsInitialFilter);
        }
        return dynamicFilters
          .map((key) => `<button class="alpha-btn ${state.actorsInitialFilter === key ? 'active' : ''}" data-filter="${key}">${key}</button>`)
          .join('');
      })()}
    </div>
    <section class="grid" id="actors-grid"></section>
    <div class="load-more-wrap" id="actors-load-more-wrap"></div>
  `;

  document.getElementById('actors-sort-by').addEventListener('change', (event) => {
    state.actorsSortBy = event.target.value;
    localStorage.setItem('actorsSortBy', state.actorsSortBy);
    state.actorsVisibleCount = ACTORS_BATCH_SIZE;
    renderActors();
  });
  document.getElementById('actors-sort-dir').addEventListener('click', () => {
    state.actorsSortDir = state.actorsSortDir === 'asc' ? 'desc' : 'asc';
    localStorage.setItem('actorsSortDir', state.actorsSortDir);
    state.actorsVisibleCount = ACTORS_BATCH_SIZE;
    renderActors();
  });

  const grid = document.getElementById('actors-grid');
  const loadMoreWrap = document.getElementById('actors-load-more-wrap');
  const alphabetFilterEl = document.getElementById('actors-alphabet-filter');
  const sortedActors = [...state.actors].sort((a, b) => {
    if (state.actorsSortBy === 'name') {
      return compareActorNames(a, b);
    }
    return a.appearances - b.appearances;
  });
  if (state.actorsSortDir === 'desc') {
    sortedActors.reverse();
  }

  const renderActorsGrid = () => {
    const query = state.actorsSearchQuery.trim().toLowerCase();
    const isSearching = query.length > 0;
    const filteredByInitial = sortedActors.filter((actor) => getActorInitialBucket(actor.name) === state.actorsInitialFilter);
    const visible = query
      ? sortedActors.filter((actor) => actor.name.toLowerCase().includes(query))
      : filteredByInitial;
    const renderItems = visible.slice(0, state.actorsVisibleCount);

    for (const button of alphabetFilterEl.querySelectorAll('.alpha-btn')) {
      button.classList.remove('active');
      button.disabled = isSearching;
      if (!isSearching && button.dataset.filter === state.actorsInitialFilter) {
        button.classList.add('active');
      }
    }

    if (state.actorsImageObserver) {
      state.actorsImageObserver.disconnect();
      state.actorsImageObserver = null;
    }
    if ('IntersectionObserver' in window) {
      state.actorsImageObserver = new IntersectionObserver((entries, observer) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const img = entry.target;
          const lazySrc = img.dataset.src;
          if (lazySrc && img.src !== lazySrc) {
            img.src = lazySrc;
          }
          observer.unobserve(img);
        }
      }, { rootMargin: '180px 0px' });
    }

    grid.innerHTML = '';
    for (const actor of renderItems) {
      const downloadUrl = buildDownloadLink('actor', actor.name);
      const actorDownloadBadge = downloadUrl
        ? `<a class="badge-link badge-overlay badge-download" href="${downloadUrl}" target="_blank" rel="noopener noreferrer">Download <span class="badge-icon badge-icon-download">↓</span></a>`
        : `<span class="badge-link badge-overlay badge-download badge-disabled">Download <span class="badge-icon badge-icon-download">↓</span></span>`;
      const actorImage = actor.image_url || ACTOR_PLACEHOLDER;
      const card = document.createElement('article');
      card.className = 'actor-card';
      card.innerHTML = `
        <div class="poster-wrap">
          <img class="poster actor-poster-lazy" src="${ACTOR_PLACEHOLDER}" data-src="${actorImage}" alt="${actor.name}" loading="lazy" />
          ${actorDownloadBadge}
        </div>
        <div class="caption">
          <div class="name">${actor.name}</div>
          <div class="count">${actor.appearances} from Plex</div>
        </div>
      `;
      const poster = card.querySelector('.poster');
      applyImageFallback(poster, ACTOR_PLACEHOLDER);
      if (state.actorsImageObserver) {
        state.actorsImageObserver.observe(poster);
      } else {
        poster.src = actorImage;
      }
      const downloadLink = card.querySelector('.badge-link');
      downloadLink.addEventListener('click', (event) => {
        event.stopPropagation();
      });
      card.addEventListener('click', () => routeTo('actor-detail', actor.actor_id));
      grid.appendChild(card);
    }

    const remaining = visible.length - renderItems.length;
    if (remaining > 0) {
      loadMoreWrap.innerHTML = `<button id="actors-load-more" class="secondary-btn">Load more (${remaining})</button>`;
      document.getElementById('actors-load-more').addEventListener('click', () => {
        state.actorsVisibleCount += ACTORS_BATCH_SIZE;
        renderActorsGrid();
      });
    } else {
      loadMoreWrap.innerHTML = '';
    }
  };

  document.getElementById('actors-alphabet-filter').addEventListener('click', (event) => {
    const target = event.target.closest('.alpha-btn');
    if (!target) return;
    state.actorsInitialFilter = target.dataset.filter;
    localStorage.setItem('actorsInitialFilter', state.actorsInitialFilter);
    state.actorsVisibleCount = ACTORS_BATCH_SIZE;
    renderActors();
  });

  const actorsSearchControl = document.getElementById('actors-search-control');
  const actorsSearchToggle = document.getElementById('actors-search-toggle');
  const actorsSearchInput = document.getElementById('actors-search-input');
  const actorsSearchClear = document.getElementById('actors-search-clear');

  const updateActorsSearchClear = () => {
    const hasValue = !!state.actorsSearchQuery.trim();
    actorsSearchClear.classList.toggle('hidden', !state.actorsSearchOpen || !hasValue);
  };

  actorsSearchToggle.addEventListener('click', () => {
    state.actorsSearchOpen = !state.actorsSearchOpen;
    actorsSearchControl.classList.toggle('open', state.actorsSearchOpen);
    if (state.actorsSearchOpen) {
      actorsSearchInput.focus();
    } else {
      state.actorsSearchQuery = '';
      actorsSearchInput.value = '';
      state.actorsVisibleCount = ACTORS_BATCH_SIZE;
      renderActorsGrid();
    }
    updateActorsSearchClear();
  });

  actorsSearchInput.addEventListener('input', (event) => {
    state.actorsSearchQuery = event.target.value;
    state.actorsVisibleCount = ACTORS_BATCH_SIZE;
    renderActorsGrid();
    updateActorsSearchClear();
  });

  actorsSearchClear.addEventListener('click', () => {
    state.actorsSearchQuery = '';
    actorsSearchInput.value = '';
    actorsSearchInput.focus();
    state.actorsVisibleCount = ACTORS_BATCH_SIZE;
    renderActorsGrid();
    updateActorsSearchClear();
  });

  updateActorsSearchClear();
  renderActorsGrid();
}

async function renderActorDetail(actorId) {
  const search = new URLSearchParams(window.location.search);
  const missingOnly = search.get('missingOnly') === '1';
  const inPlexOnly = search.get('inPlexOnly') === '1';
  const defaultMoviesSortBy = localStorage.getItem('moviesSortBy') || 'year';
  const defaultMoviesSortDir = localStorage.getItem('moviesSortDir') || 'desc';
  const sortBy = search.get('sortBy') || defaultMoviesSortBy;
  const sortDir = search.get('sortDir') || defaultMoviesSortDir;

  const data = await api(`/api/actors/${actorId}/movies?missing_only=${missingOnly}&in_plex_only=${inPlexOnly}`);
  const actorName = data.actor.name;
  if (state.moviesSearchQuery) {
    state.moviesSearchOpen = true;
  }

  app.innerHTML = `
    <div class="topbar">
      <div class="topbar-left">
        <button id="actor-detail-back" class="back-icon-btn" title="Back to Actors" aria-label="Back to Actors">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m14 7-5 5 5 5"/></svg>
        </button>
        <div class="topbar-title">
          <h2>${actorName}</h2>
          <div class="meta">${data.items.length} movies</div>
        </div>
      </div>
      <div class="row">
        <div id="movies-search-control" class="search-control ${state.moviesSearchOpen ? 'open' : ''}">
          <button id="movies-search-toggle" class="search-toggle-btn" title="Search" aria-label="Search">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 4a6 6 0 1 1-4.24 10.24A6 6 0 0 1 10 4m0-2a8 8 0 1 0 5.29 14l4.85 4.85 1.41-1.41-4.85-4.85A8 8 0 0 0 10 2Z"/></svg>
          </button>
          <input id="movies-search-input" class="search-input" type="text" placeholder="Search movies" value="${state.moviesSearchQuery}" />
          <button id="movies-search-clear" class="search-clear-btn ${state.moviesSearchOpen ? '' : 'hidden'}" title="Clear search" aria-label="Clear search">×</button>
        </div>
        <select id="movies-sort-by" class="secondary-btn" aria-label="Sort movies by">
          <option value="title" ${sortBy === 'title' ? 'selected' : ''}>Title</option>
          <option value="year" ${sortBy === 'year' ? 'selected' : ''}>Year</option>
        </select>
        <button id="movies-sort-dir" class="toggle-btn" title="Toggle sort direction" aria-label="Toggle sort direction">${sortDir === 'asc' ? '↑' : '↓'}</button>
        <button id="missing-toggle" class="toggle-btn ${missingOnly ? 'active' : ''}">Missing</button>
        <button id="in-plex-toggle" class="toggle-btn ${inPlexOnly ? 'active' : ''}">In Plex</button>
      </div>
    </div>
    <section class="grid" id="movies-grid"></section>
  `;

  document.getElementById('actor-detail-back').addEventListener('click', () => {
    routeTo('actors');
  });

  const pushActorDetailQuery = (params) => {
    const query = params.toString();
    history.pushState({}, '', `/actors/${actorId}${query ? `?${query}` : ''}`);
    renderActorDetail(actorId);
  };

  document.getElementById('missing-toggle').addEventListener('click', () => {
    const next = !missingOnly;
    const params = new URLSearchParams();
    if (next) {
      params.set('missingOnly', '1');
    } else if (inPlexOnly) {
      params.set('inPlexOnly', '1');
    }
    params.set('sortBy', sortBy);
    params.set('sortDir', sortDir);
    pushActorDetailQuery(params);
  });

  document.getElementById('in-plex-toggle').addEventListener('click', () => {
    const next = !inPlexOnly;
    const params = new URLSearchParams();
    if (next) {
      params.set('inPlexOnly', '1');
    } else if (missingOnly) {
      params.set('missingOnly', '1');
    }
    params.set('sortBy', sortBy);
    params.set('sortDir', sortDir);
    pushActorDetailQuery(params);
  });

  document.getElementById('movies-sort-by').addEventListener('change', (event) => {
    localStorage.setItem('moviesSortBy', event.target.value);
    localStorage.setItem('moviesSortDir', sortDir);
    const params = new URLSearchParams(window.location.search);
    params.set('sortBy', event.target.value);
    params.set('sortDir', sortDir);
    pushActorDetailQuery(params);
  });

  document.getElementById('movies-sort-dir').addEventListener('click', () => {
    const params = new URLSearchParams(window.location.search);
    const nextDir = sortDir === 'asc' ? 'desc' : 'asc';
    localStorage.setItem('moviesSortBy', sortBy);
    localStorage.setItem('moviesSortDir', nextDir);
    params.set('sortBy', sortBy);
    params.set('sortDir', nextDir);
    pushActorDetailQuery(params);
  });

  const grid = document.getElementById('movies-grid');
  if (!data.items.length) {
    grid.innerHTML = '<div class="empty">No movies found.</div>';
    return;
  }

  const sortedMovies = [...data.items].sort((a, b) => {
    if (sortBy === 'title') {
      return (a.title || '').localeCompare(b.title || '');
    }
    const ay = a.year ?? -9999;
    const by = b.year ?? -9999;
    return ay - by;
  });
  if (sortDir === 'desc') {
    sortedMovies.reverse();
  }

  const renderMoviesGrid = () => {
    const query = state.moviesSearchQuery.trim().toLowerCase();
    const visible = query
      ? sortedMovies.filter((movie) => (movie.title || '').toLowerCase().includes(query))
      : sortedMovies;

    grid.innerHTML = '';
    for (const movie of visible) {
      const card = document.createElement('article');
      card.className = 'movie-card';
      const tmdbUrl = movie.tmdb_id ? `https://www.themoviedb.org/movie/${movie.tmdb_id}` : null;
      const downloadUrl = buildDownloadLink('movie', movie.title);
      const movieDownloadBadge = downloadUrl
        ? `<a class="badge-link badge-overlay badge-download" href="${downloadUrl}" target="_blank" rel="noopener noreferrer">Download <span class="badge-icon badge-icon-download">↓</span></a>`
        : `<span class="badge-link badge-overlay badge-download badge-disabled">Download <span class="badge-icon badge-icon-download">↓</span></span>`;
      card.innerHTML = `
        <div class="poster-wrap">
          <img class="poster" src="${movie.poster_url || MOVIE_PLACEHOLDER}" alt="${movie.title}" loading="lazy" />
          ${
            movie.in_plex
              ? `<a class="badge-link badge-overlay" href="${movie.plex_web_url}" target="_blank" rel="noopener noreferrer">In Plex <span class="badge-icon badge-icon-check">✓</span></a>`
              : movieDownloadBadge
          }
        </div>
        <div class="caption">
          <div class="name">${movie.title}</div>
          <div class="year">${movie.year || 'Unknown year'}</div>
        </div>
      `;
      if (tmdbUrl) {
        card.addEventListener('click', () => window.open(tmdbUrl, '_blank', 'noopener,noreferrer'));
      }
      const badge = card.querySelector('.badge-overlay');
      if (badge) {
        badge.addEventListener('click', (event) => event.stopPropagation());
      }
      applyImageFallback(card.querySelector('.poster'), MOVIE_PLACEHOLDER);
      grid.appendChild(card);
    }
  };

  const moviesSearchControl = document.getElementById('movies-search-control');
  const moviesSearchToggle = document.getElementById('movies-search-toggle');
  const moviesSearchInput = document.getElementById('movies-search-input');
  const moviesSearchClear = document.getElementById('movies-search-clear');

  const updateMoviesSearchClear = () => {
    const hasValue = !!state.moviesSearchQuery.trim();
    moviesSearchClear.classList.toggle('hidden', !state.moviesSearchOpen || !hasValue);
  };

  moviesSearchToggle.addEventListener('click', () => {
    state.moviesSearchOpen = !state.moviesSearchOpen;
    moviesSearchControl.classList.toggle('open', state.moviesSearchOpen);
    if (state.moviesSearchOpen) {
      moviesSearchInput.focus();
    } else {
      state.moviesSearchQuery = '';
      moviesSearchInput.value = '';
      renderMoviesGrid();
    }
    updateMoviesSearchClear();
  });

  moviesSearchInput.addEventListener('input', (event) => {
    state.moviesSearchQuery = event.target.value;
    renderMoviesGrid();
    updateMoviesSearchClear();
  });

  moviesSearchClear.addEventListener('click', () => {
    state.moviesSearchQuery = '';
    moviesSearchInput.value = '';
    moviesSearchInput.focus();
    renderMoviesGrid();
    updateMoviesSearchClear();
  });

  updateMoviesSearchClear();
  renderMoviesGrid();
}

bootstrap();
