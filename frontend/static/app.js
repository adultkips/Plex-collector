const app = document.getElementById('app');
const nav = document.getElementById('floating-nav');
const navProfile = document.getElementById('nav-profile');
const navActors = document.getElementById('nav-actors');
const ACTOR_PLACEHOLDER = 'https://placehold.co/500x750?text=Actor';
const MOVIE_PLACEHOLDER = 'https://placehold.co/500x750?text=Movie';

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
        </div>
        <select id="actors-sort-by" class="secondary-btn" aria-label="Sort actors by">
          <option value="name" ${state.actorsSortBy === 'name' ? 'selected' : ''}>Name</option>
          <option value="amount" ${state.actorsSortBy === 'amount' ? 'selected' : ''}>Amount</option>
        </select>
        <button id="actors-sort-dir" class="toggle-btn" title="Toggle sort direction" aria-label="Toggle sort direction">${state.actorsSortDir === 'asc' ? '↑' : '↓'}</button>
      </div>
    </div>
    <section class="grid" id="actors-grid"></section>
  `;

  document.getElementById('actors-sort-by').addEventListener('change', (event) => {
    state.actorsSortBy = event.target.value;
    localStorage.setItem('actorsSortBy', state.actorsSortBy);
    renderActors();
  });
  document.getElementById('actors-sort-dir').addEventListener('click', () => {
    state.actorsSortDir = state.actorsSortDir === 'asc' ? 'desc' : 'asc';
    localStorage.setItem('actorsSortDir', state.actorsSortDir);
    renderActors();
  });

  const grid = document.getElementById('actors-grid');
  const sortedActors = [...state.actors].sort((a, b) => {
    if (state.actorsSortBy === 'name') {
      return a.name.localeCompare(b.name);
    }
    return a.appearances - b.appearances;
  });
  if (state.actorsSortDir === 'desc') {
    sortedActors.reverse();
  }

  const renderActorsGrid = () => {
    const query = state.actorsSearchQuery.trim().toLowerCase();
    const visible = query
      ? sortedActors.filter((actor) => actor.name.toLowerCase().includes(query))
      : sortedActors;

    grid.innerHTML = '';
    for (const actor of visible) {
      const card = document.createElement('article');
      card.className = 'actor-card';
      card.innerHTML = `
        <img class="poster" src="${actor.image_url || ACTOR_PLACEHOLDER}" alt="${actor.name}" loading="lazy" />
        <div class="caption">
          <div class="name">${actor.name}</div>
          <div class="count">${actor.appearances} from Plex</div>
        </div>
      `;
      applyImageFallback(card.querySelector('.poster'), ACTOR_PLACEHOLDER);
      card.addEventListener('click', () => routeTo('actor-detail', actor.actor_id));
      grid.appendChild(card);
    }
  };

  const actorsSearchControl = document.getElementById('actors-search-control');
  const actorsSearchToggle = document.getElementById('actors-search-toggle');
  const actorsSearchInput = document.getElementById('actors-search-input');

  actorsSearchToggle.addEventListener('click', () => {
    state.actorsSearchOpen = !state.actorsSearchOpen;
    actorsSearchControl.classList.toggle('open', state.actorsSearchOpen);
    if (state.actorsSearchOpen) {
      actorsSearchInput.focus();
    } else {
      state.actorsSearchQuery = '';
      actorsSearchInput.value = '';
      renderActorsGrid();
    }
  });

  actorsSearchInput.addEventListener('input', (event) => {
    state.actorsSearchQuery = event.target.value;
    renderActorsGrid();
  });

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
      <div class="topbar-title">
        <h2>${actorName}</h2>
        <div class="meta">${data.items.length} movies</div>
      </div>
      <div class="row">
        <div id="movies-search-control" class="search-control ${state.moviesSearchOpen ? 'open' : ''}">
          <button id="movies-search-toggle" class="search-toggle-btn" title="Search" aria-label="Search">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 4a6 6 0 1 1-4.24 10.24A6 6 0 0 1 10 4m0-2a8 8 0 1 0 5.29 14l4.85 4.85 1.41-1.41-4.85-4.85A8 8 0 0 0 10 2Z"/></svg>
          </button>
          <input id="movies-search-input" class="search-input" type="text" placeholder="Search movies" value="${state.moviesSearchQuery}" />
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
      const downloadTitle = sanitizeDownloadQuery(movie.title);
      const downloadUrl = `https://login.superbits.org/search?search=${encodeURIComponent(downloadTitle)}`;
      card.innerHTML = `
        <div class="poster-wrap">
          <img class="poster" src="${movie.poster_url || MOVIE_PLACEHOLDER}" alt="${movie.title}" loading="lazy" />
          ${
            movie.in_plex
              ? `<a class="badge-link badge-overlay" href="${movie.plex_web_url}" target="_blank" rel="noopener noreferrer">In Plex <span class="badge-icon badge-icon-check">✓</span></a>`
              : `<a class="badge-link badge-overlay badge-download" href="${downloadUrl}" target="_blank" rel="noopener noreferrer">Download <span class="badge-icon badge-icon-download">↓</span></a>`
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
  });

  moviesSearchInput.addEventListener('input', (event) => {
    state.moviesSearchQuery = event.target.value;
    renderMoviesGrid();
  });

  renderMoviesGrid();
}

bootstrap();
