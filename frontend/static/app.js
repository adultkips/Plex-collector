const app = document.getElementById('app');
const nav = document.getElementById('floating-nav');
const navProfile = document.getElementById('nav-profile');
const navActors = document.getElementById('nav-actors');
const navShows = document.getElementById('nav-shows');
const ACTOR_PLACEHOLDER = 'https://placehold.co/500x750?text=Actor';
const MOVIE_PLACEHOLDER = 'https://placehold.co/500x750?text=Movie';
const SHOW_PLACEHOLDER = 'https://placehold.co/500x750?text=Show';
const PLEX_LOGO_PATH = '/assets/plexlogo.png';
const SCAN_ICON_PATH = "M20 5v5h-5l1.9-1.9A6.98 6.98 0 0 0 12 6a7 7 0 0 0-6.93 6h-2.02A9.01 9.01 0 0 1 12 4c2.21 0 4.24.8 5.8 2.12L20 4v1Zm-16 9h5l-1.9 1.9A6.98 6.98 0 0 0 12 18a7 7 0 0 0 6.93-6h2.02A9.01 9.01 0 0 1 12 20c-2.21 0-4.24-.8-5.8-2.12L4 20v-6Z";
const ACTORS_BATCH_SIZE = 80;
const ACTOR_INITIAL_FILTERS = ['All', '0-9', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z', 'Æ', 'Ø', 'Å', '#'];
const DEFAULT_DOWNLOAD_PREFIX = {
  actor_start: '',
  actor_mode: 'encoded_space',
  actor_end: '',
  movie_start: '',
  movie_mode: 'encoded_space',
  movie_end: '',
  show_start: '',
  show_mode: 'encoded_space',
  show_end: '',
  season_start: '',
  season_mode: 'encoded_space',
  season_end: '',
  episode_start: '',
  episode_mode: 'encoded_space',
  episode_end: '',
};

const state = {
  session: null,
  actors: [],
  shows: [],
  profile: null,
  currentView: 'profile',
  actorsLoaded: false,
  showsLoaded: false,
  profileLoaded: false,
  actorsSearchOpen: false,
  actorsSearchQuery: '',
  showsSearchOpen: false,
  showsSearchQuery: '',
  moviesSearchOpen: false,
  moviesSearchQuery: '',
  moviesInitialFilter: localStorage.getItem('moviesInitialFilter') || 'All',
  actorsSortBy: localStorage.getItem('actorsSortBy') || 'name',
  actorsSortDir: localStorage.getItem('actorsSortDir') || 'asc',
  showsSortBy: localStorage.getItem('showsSortBy') || 'name',
  showsSortDir: localStorage.getItem('showsSortDir') || 'asc',
  showsSeasonsSortDir: localStorage.getItem('showsSeasonsSortDir') || 'asc',
  showsEpisodesSortDir: localStorage.getItem('showsEpisodesSortDir') || 'asc',
  showsMissingOnly: false,
  showsInPlexOnly: false,
  showsNewOnly: false,
  showsInitialFilter: localStorage.getItem('showsInitialFilter') || 'All',
  showsVisibleCount: ACTORS_BATCH_SIZE,
  showsImageObserver: null,
  showSeasonsCache: {},
  showEpisodesCache: {},
  actorsInitialFilter: localStorage.getItem('actorsInitialFilter') || 'All',
  actorsVisibleCount: ACTORS_BATCH_SIZE,
  actorsImageObserver: null,
  imageCacheKey: localStorage.getItem('imageCacheKey') || '1',
  createCollectionBusy: false,
};
let plexAuthPopup = null;

navProfile.addEventListener('click', () => routeTo('profile'));
navActors.addEventListener('click', () => routeTo('actors'));
navShows.addEventListener('click', () => routeTo('shows'));

window.addEventListener('popstate', handleLocation);

function updateScrollState() {
  document.body.classList.toggle('is-scrolled', window.scrollY > 0);
}

window.addEventListener('scroll', updateScrollState, { passive: true });
updateScrollState();

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

function withImageCacheKey(url) {
  if (!url) return url;
  if (url.startsWith('data:')) return url;
  try {
    const parsed = new URL(url, window.location.origin);
    parsed.searchParams.set('imgv', state.imageCacheKey);
    if (url.startsWith('http://') || url.startsWith('https://')) {
      return parsed.toString();
    }
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return url;
  }
}

function plexLogoTag(className = 'badge-logo') {
  const logoUrl = withImageCacheKey(PLEX_LOGO_PATH);
  return `<img src="${logoUrl}" alt="Plex" class="${className}" loading="lazy" onerror="this.style.display='none'" />`;
}

function scanIconTag(iconClass = 'btn-scan-icon') {
  return `
    <span class="${iconClass}" aria-hidden="true">
      <svg viewBox="0 0 24 24" role="img" aria-hidden="true">
        <path d="${SCAN_ICON_PATH}"></path>
      </svg>
    </span>
  `;
}

function invalidateImageCache() {
  state.imageCacheKey = String(Date.now());
  localStorage.setItem('imageCacheKey', state.imageCacheKey);
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
  const isShow = type === 'show';
  const isSeason = type === 'season';
  const isEpisode = type === 'episode';
  const start = isActor
    ? settings.actor_start
    : (isShow ? settings.show_start : (isSeason ? settings.season_start : (isEpisode ? settings.episode_start : settings.movie_start)));
  const mode = isActor
    ? settings.actor_mode
    : (isShow ? settings.show_mode : (isSeason ? settings.season_mode : (isEpisode ? settings.episode_mode : settings.movie_mode)));
  const end = isActor
    ? settings.actor_end
    : (isShow ? settings.show_end : (isSeason ? settings.season_end : (isEpisode ? settings.episode_end : settings.movie_end)));
  if (!start && !end) return '';
  const keyword = buildDownloadKeyword(rawText, mode);
  if (!keyword) return '';
  return `${start}${keyword}${end}`;
}

function buildDownloadExampleText(type, settings) {
  const isActor = type === 'actor';
  const isShow = type === 'show';
  const isSeason = type === 'season';
  const isEpisode = type === 'episode';
  const start = (isActor
    ? settings.actor_start
    : (isShow ? settings.show_start : (isSeason ? settings.season_start : (isEpisode ? settings.episode_start : settings.movie_start)))) || '';
  const mode = isActor
    ? settings.actor_mode
    : (isShow ? settings.show_mode : (isSeason ? settings.season_mode : (isEpisode ? settings.episode_mode : settings.movie_mode)));
  const end = (isActor
    ? settings.actor_end
    : (isShow ? settings.show_end : (isSeason ? settings.season_end : (isEpisode ? settings.episode_end : settings.movie_end)))) || '';
  if (!start && !end) {
    return '';
  }
  const keyword = buildDownloadKeyword(
    isActor ? 'bruce willis' : (isShow ? 'breaking bad' : (isSeason ? 'breaking bad s01' : (isEpisode ? 'breaking bad s01e01' : 'a day to die'))),
    mode,
  );
  return `E.g.: ${start}${keyword}${end}`;
}

function buildSeasonKeyword(showTitle, seasonNumber) {
  const seasonTag = `s${String(Number(seasonNumber) || 0).padStart(2, '0')}`;
  return `${showTitle || ''} ${seasonTag}`.trim();
}

function buildEpisodeKeyword(showTitle, seasonNumber, episodeNumber) {
  const seasonTag = `s${String(Number(seasonNumber) || 0).padStart(2, '0')}`;
  const episodeTag = `e${String(Number(episodeNumber) || 0).padStart(2, '0')}`;
  return `${showTitle || ''} ${seasonTag}${episodeTag}`.trim();
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

function formatScanDateOnly(value) {
  if (!value) return 'Not scanned';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Not scanned';
  return date.toLocaleDateString();
}

function parseUpcomingAirDates(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.filter((item) => typeof item === 'string' && item.trim());
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) {
        return parsed.filter((item) => typeof item === 'string' && item.trim());
      }
    } catch {
      return [];
    }
  }
  return [];
}

function nextUpcomingAirDate(value) {
  const dates = parseUpcomingAirDates(value);
  if (!dates.length) return null;
  const today = new Date();
  const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  for (const dateStr of dates) {
    if (dateStr >= todayKey) return dateStr;
  }
  return null;
}

function formatDateDdMmYyyy(value) {
  if (!value || typeof value !== 'string') return value;
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return value;
  const [, year, month, day] = match;
  return `${day}.${month}.${year}`;
}

function isTodayOrFutureDate(value) {
  if (!value || typeof value !== 'string') return false;
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return false;
  const today = new Date();
  const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  return value >= todayKey;
}

function applyShowMissingScanUpdate(updated) {
  if (!updated || !updated.show_id) return;
  const idx = state.shows.findIndex((s) => String(s.show_id) === String(updated.show_id));
  if (idx < 0) return;
  const nextMissing = updated.has_missing_episodes;
  const current = state.shows[idx];
  current.has_missing_episodes = nextMissing === null || nextMissing === undefined ? null : (nextMissing ? 1 : 0);
  current.missing_scan_at = updated.missing_scan_at || current.missing_scan_at || null;
  current.missing_upcoming_air_dates = Array.isArray(updated.missing_upcoming_air_dates)
    ? updated.missing_upcoming_air_dates
    : (current.missing_upcoming_air_dates || []);
}

function routeTo(view, actorId = null) {
  if (view === 'actor-detail' && actorId) {
    history.pushState({}, '', `/actors/${actorId}`);
  } else if (view === 'show-detail' && actorId) {
    history.pushState({}, '', `/shows/${actorId}`);
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
  navShows.classList.toggle('active', view === 'shows');
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

  if (path.startsWith('/shows/')) {
    setFullWidthGridMode(true);
    setNavVisible(true);
    const seasonMatch = path.match(/^\/shows\/([^/]+)\/seasons\/(\d+)$/);
    if (seasonMatch) {
      const [, showId, seasonNumber] = seasonMatch;
      await renderShowEpisodes(showId, Number(seasonNumber));
    } else {
      const showId = path.split('/')[2];
      await renderShowSeasons(showId);
    }
    setActiveNav('shows');
    return;
  }

  if (path === '/shows') {
    setFullWidthGridMode(true);
    setNavVisible(true);
    await renderShows();
    setActiveNav('shows');
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
          <button id="plex-login" class="primary-btn">Login with Plex <img src="${withImageCacheKey(PLEX_LOGO_PATH)}" alt="Plex" class="badge-logo" loading="lazy" onerror="this.style.display='none'" /></button>
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
  const showExampleText = buildDownloadExampleText('show', downloadPrefix);
  const seasonExampleText = buildDownloadExampleText('season', downloadPrefix);
  const episodeExampleText = buildDownloadExampleText('episode', downloadPrefix);
  const actorPrefixConfigured = Boolean((downloadPrefix.actor_start || '').trim() || (downloadPrefix.actor_end || '').trim());
  const moviePrefixConfigured = Boolean((downloadPrefix.movie_start || '').trim() || (downloadPrefix.movie_end || '').trim());
  const showPrefixConfigured = Boolean((downloadPrefix.show_start || '').trim() || (downloadPrefix.show_end || '').trim());
  const seasonPrefixConfigured = Boolean((downloadPrefix.season_start || '').trim() || (downloadPrefix.season_end || '').trim());
  const episodePrefixConfigured = Boolean((downloadPrefix.episode_start || '').trim() || (downloadPrefix.episode_end || '').trim());

  app.innerHTML = `
    <section class="profile">
      <div class="profile-header card">
        <button id="reset-btn" class="secondary-btn profile-reset-btn">Reset</button>
        <img src="${withImageCacheKey(data.profile?.thumb) || 'https://placehold.co/120x120?text=Plex'}" alt="Profile" />
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
        <div class="row settings-row">
          <span class="meta no-margin prefix-label settings-label-strong">Show prefix:</span>
          <input id="show-prefix-start" type="text" class="secondary-btn prefix-input" placeholder="Start prefix" value="${downloadPrefix.show_start}" />
          <select id="show-prefix-format" class="secondary-btn prefix-format-select" aria-label="Show keyword format">
            <option value="encoded_space" ${downloadPrefix.show_mode === 'encoded_space' ? 'selected' : ''}>Breaking%20Bad</option>
            <option value="hyphen" ${downloadPrefix.show_mode === 'hyphen' ? 'selected' : ''}>Breaking-Bad</option>
          </select>
          <input id="show-prefix-end" type="text" class="secondary-btn prefix-input" placeholder="End prefix" value="${downloadPrefix.show_end}" />
          <button id="show-prefix-save-btn" class="secondary-btn">Save</button>
          <span id="show-prefix-check" class="meta no-margin status-check">${showPrefixConfigured ? '✓' : ''}</span>
          <span id="show-prefix-status" class="meta no-margin"></span>
        </div>
        <div id="show-prefix-example" class="meta no-margin prefix-example ${showExampleText ? '' : 'hidden'}">${showExampleText}</div>
        <div class="row settings-row">
          <span class="meta no-margin prefix-label settings-label-strong">Season prefix:</span>
          <input id="season-prefix-start" type="text" class="secondary-btn prefix-input" placeholder="Start prefix" value="${downloadPrefix.season_start}" />
          <select id="season-prefix-format" class="secondary-btn prefix-format-select" aria-label="Season keyword format">
            <option value="encoded_space" ${downloadPrefix.season_mode === 'encoded_space' ? 'selected' : ''}>Breaking%20Bad%20s01</option>
            <option value="hyphen" ${downloadPrefix.season_mode === 'hyphen' ? 'selected' : ''}>Breaking-Bad-s01</option>
          </select>
          <input id="season-prefix-end" type="text" class="secondary-btn prefix-input" placeholder="End prefix" value="${downloadPrefix.season_end}" />
          <button id="season-prefix-save-btn" class="secondary-btn">Save</button>
          <span id="season-prefix-check" class="meta no-margin status-check">${seasonPrefixConfigured ? '✓' : ''}</span>
          <span id="season-prefix-status" class="meta no-margin"></span>
        </div>
        <div id="season-prefix-example" class="meta no-margin prefix-example ${seasonExampleText ? '' : 'hidden'}">${seasonExampleText}</div>
        <div class="row settings-row">
          <span class="meta no-margin prefix-label settings-label-strong">Episode prefix:</span>
          <input id="episode-prefix-start" type="text" class="secondary-btn prefix-input" placeholder="Start prefix" value="${downloadPrefix.episode_start}" />
          <select id="episode-prefix-format" class="secondary-btn prefix-format-select" aria-label="Episode keyword format">
            <option value="encoded_space" ${downloadPrefix.episode_mode === 'encoded_space' ? 'selected' : ''}>Breaking%20Bad%20s01e01</option>
            <option value="hyphen" ${downloadPrefix.episode_mode === 'hyphen' ? 'selected' : ''}>Breaking-Bad-s01e01</option>
          </select>
          <input id="episode-prefix-end" type="text" class="secondary-btn prefix-input" placeholder="End prefix" value="${downloadPrefix.episode_end}" />
          <button id="episode-prefix-save-btn" class="secondary-btn">Save</button>
          <span id="episode-prefix-check" class="meta no-margin status-check">${episodePrefixConfigured ? '✓' : ''}</span>
          <span id="episode-prefix-status" class="meta no-margin"></span>
        </div>
        <div id="episode-prefix-example" class="meta no-margin prefix-example ${episodeExampleText ? '' : 'hidden'}">${episodeExampleText}</div>
      </div>

      <div class="card library-sync-card">
        <h3>Library Sync</h3>
        <p class="subtitle">Scan Plex libraries.</p>
        <div class="row library-sync-actions">
          <button id="scan-btn" class="primary-btn btn-with-icon">${scanIconTag()}<span>Scan Actors</span></button>
          <button id="scan-shows-btn" class="primary-btn btn-with-icon">${scanIconTag()}<span>Scan Shows</span></button>
          <span id="scan-status" class="meta"></span>
          <span id="scan-shows-status" class="meta"></span>
        </div>
        <section class="scan-log">
          <h4>Log</h4>
          <ul id="scan-log-list" class="scan-log-list"></ul>
        </section>
      </div>
    </section>
  `;

  document.getElementById('scan-btn').addEventListener('click', runScan);
  document.getElementById('scan-shows-btn').addEventListener('click', runShowScan);
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
  document.getElementById('show-prefix-save-btn').addEventListener('click', saveShowPrefix);
  document.getElementById('season-prefix-save-btn').addEventListener('click', saveSeasonPrefix);
  document.getElementById('episode-prefix-save-btn').addEventListener('click', saveEpisodePrefix);
  renderScanLogs(data.scan_logs || [], data.show_scan_logs || []);
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
    state.showsLoaded = false;
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
    show_start: existing.show_start,
    show_mode: existing.show_mode,
    show_end: existing.show_end,
    season_start: existing.season_start,
    season_mode: existing.season_mode,
    season_end: existing.season_end,
    episode_start: existing.episode_start,
    episode_mode: existing.episode_mode,
    episode_end: existing.episode_end,
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
    show_start: existing.show_start,
    show_mode: existing.show_mode,
    show_end: existing.show_end,
    season_start: existing.season_start,
    season_mode: existing.season_mode,
    season_end: existing.season_end,
    episode_start: existing.episode_start,
    episode_mode: existing.episode_mode,
    episode_end: existing.episode_end,
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

async function saveShowPrefix() {
  const status = document.getElementById('show-prefix-status');
  const check = document.getElementById('show-prefix-check');
  const example = document.getElementById('show-prefix-example');
  status.textContent = 'Saving...';
  const existing = getDownloadPrefixSettings();
  const payload = {
    actor_start: existing.actor_start,
    actor_mode: existing.actor_mode,
    actor_end: existing.actor_end,
    movie_start: existing.movie_start,
    movie_mode: existing.movie_mode,
    movie_end: existing.movie_end,
    show_start: document.getElementById('show-prefix-start').value.trim(),
    show_mode: document.getElementById('show-prefix-format').value,
    show_end: document.getElementById('show-prefix-end').value.trim(),
    season_start: existing.season_start,
    season_mode: existing.season_mode,
    season_end: existing.season_end,
    episode_start: existing.episode_start,
    episode_mode: existing.episode_mode,
    episode_end: existing.episode_end,
  };
  try {
    const result = await api('/api/download-prefix', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    state.profile = { ...state.profile, download_prefix: result.download_prefix };
    const configured = Boolean((result.download_prefix.show_start || '').trim() || (result.download_prefix.show_end || '').trim());
    if (check) check.textContent = configured ? '✓' : '';
    if (example) {
      const text = buildDownloadExampleText('show', result.download_prefix);
      example.textContent = text;
      example.classList.toggle('hidden', !text);
    }
    status.textContent = 'Saved';
  } catch (error) {
    status.textContent = error.message;
  }
}

async function saveSeasonPrefix() {
  const status = document.getElementById('season-prefix-status');
  const check = document.getElementById('season-prefix-check');
  const example = document.getElementById('season-prefix-example');
  status.textContent = 'Saving...';
  const existing = getDownloadPrefixSettings();
  const payload = {
    actor_start: existing.actor_start,
    actor_mode: existing.actor_mode,
    actor_end: existing.actor_end,
    movie_start: existing.movie_start,
    movie_mode: existing.movie_mode,
    movie_end: existing.movie_end,
    show_start: existing.show_start,
    show_mode: existing.show_mode,
    show_end: existing.show_end,
    season_start: document.getElementById('season-prefix-start').value.trim(),
    season_mode: document.getElementById('season-prefix-format').value,
    season_end: document.getElementById('season-prefix-end').value.trim(),
    episode_start: existing.episode_start,
    episode_mode: existing.episode_mode,
    episode_end: existing.episode_end,
  };
  try {
    const result = await api('/api/download-prefix', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    state.profile = { ...state.profile, download_prefix: result.download_prefix };
    const configured = Boolean((result.download_prefix.season_start || '').trim() || (result.download_prefix.season_end || '').trim());
    if (check) check.textContent = configured ? '✓' : '';
    if (example) {
      const text = buildDownloadExampleText('season', result.download_prefix);
      example.textContent = text;
      example.classList.toggle('hidden', !text);
    }
    status.textContent = 'Saved';
  } catch (error) {
    status.textContent = error.message;
  }
}

async function saveEpisodePrefix() {
  const status = document.getElementById('episode-prefix-status');
  const check = document.getElementById('episode-prefix-check');
  const example = document.getElementById('episode-prefix-example');
  status.textContent = 'Saving...';
  const existing = getDownloadPrefixSettings();
  const payload = {
    actor_start: existing.actor_start,
    actor_mode: existing.actor_mode,
    actor_end: existing.actor_end,
    movie_start: existing.movie_start,
    movie_mode: existing.movie_mode,
    movie_end: existing.movie_end,
    show_start: existing.show_start,
    show_mode: existing.show_mode,
    show_end: existing.show_end,
    season_start: existing.season_start,
    season_mode: existing.season_mode,
    season_end: existing.season_end,
    episode_start: document.getElementById('episode-prefix-start').value.trim(),
    episode_mode: document.getElementById('episode-prefix-format').value,
    episode_end: document.getElementById('episode-prefix-end').value.trim(),
  };
  try {
    const result = await api('/api/download-prefix', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    state.profile = { ...state.profile, download_prefix: result.download_prefix };
    const configured = Boolean((result.download_prefix.episode_start || '').trim() || (result.download_prefix.episode_end || '').trim());
    if (check) check.textContent = configured ? '✓' : '';
    if (example) {
      const text = buildDownloadExampleText('episode', result.download_prefix);
      example.textContent = text;
      example.classList.toggle('hidden', !text);
    }
    status.textContent = 'Saved';
  } catch (error) {
    status.textContent = error.message;
  }
}

function renderScanLogs(actorLogs, showLogs = []) {
  const list = document.getElementById('scan-log-list');
  if (!list) return;

  const mergedLogs = [
    ...(actorLogs || []).map((entry) => ({ ...entry, _kind: 'actors' })),
    ...(showLogs || []).map((entry) => ({ ...entry, _kind: 'shows' })),
  ].sort((a, b) => new Date(b.scanned_at).getTime() - new Date(a.scanned_at).getTime());

  if (!mergedLogs.length) {
    list.innerHTML = '<li class="scan-log-item">No scans yet.</li>';
    return;
  }

  list.innerHTML = mergedLogs
    .slice(0, 5)
    .map((entry) => {
      const dateText = new Date(entry.scanned_at).toLocaleString();
      if (entry._kind === 'shows') {
        return `<li class="scan-log-item">${dateText} - ${entry.shows} shows, ${entry.episodes} episodes</li>`;
      }
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
      <div class="row" style="justify-content:center; margin-top: 12px;">
        <button id="scan-modal-ok" class="primary-btn hidden" type="button">OK</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  const okBtn = document.getElementById('scan-modal-ok');
  if (okBtn) okBtn.addEventListener('click', closeScanModal);
}

function showScanSuccessModal(message = 'Scan complete', showConfirm = false) {
  const iconWrap = document.getElementById('scan-icon-wrap');
  const msg = document.getElementById('scan-modal-msg');
  const okBtn = document.getElementById('scan-modal-ok');
  if (!iconWrap) return;
  iconWrap.innerHTML = '<div class="scan-check">✓</div>';
  if (msg) msg.textContent = message;
  if (okBtn) {
    okBtn.classList.toggle('hidden', !showConfirm);
    if (showConfirm) okBtn.focus();
  }
}

function closeScanModal() {
  const modal = document.getElementById('scan-modal');
  if (modal) modal.remove();
}

function chooseShowMissingScanMode(scopedCount, allCount) {
  return new Promise((resolve) => {
    const modal = document.createElement('div');
    modal.className = 'scan-modal';
    modal.id = 'scan-choice-modal';
    modal.innerHTML = `
      <div class="scan-modal-card card">
        <div class="scan-modal-msg">Choose scan scope</div>
        <div class="row" style="justify-content:center; gap: 10px; margin-top: 14px; flex-direction: column; align-items: center;">
          <button id="scan-choice-scoped" class="primary-btn" type="button" style="min-width: 170px;">Scan (${scopedCount})</button>
          <button id="scan-choice-all" class="secondary-btn" type="button" style="min-width: 170px;">Scan All (${allCount})</button>
          <button id="scan-choice-cancel" class="toggle-btn" type="button" style="margin-top: 14px; min-width: 170px;">Cancel</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);

    const close = (choice) => {
      modal.remove();
      resolve(choice);
    };

    document.getElementById('scan-choice-scoped')?.addEventListener('click', () => close('scoped'));
    document.getElementById('scan-choice-all')?.addEventListener('click', () => close('all'));
    document.getElementById('scan-choice-cancel')?.addEventListener('click', () => close(null));
  });
}

function showCreateCollectionModal(message) {
  const modal = document.createElement('div');
  modal.className = 'scan-modal';
  modal.id = 'create-collection-modal';
  modal.innerHTML = `
    <div class="scan-modal-card card">
      <div class="scan-icon-wrap" id="create-collection-icon-wrap">
        <div class="scan-spinner"></div>
      </div>
      <div class="scan-modal-msg" id="create-collection-modal-msg">${message}</div>
      <div class="row" id="create-collection-modal-actions" style="justify-content:center; margin-top: 12px;">
        <button id="create-collection-modal-ok" class="primary-btn hidden" type="button">OK</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  const okBtn = document.getElementById('create-collection-modal-ok');
  if (okBtn) {
    okBtn.addEventListener('click', closeCreateCollectionModal);
  }
}

function showCreateCollectionSuccessModal(updatedCount, detail = '') {
  const iconWrap = document.getElementById('create-collection-icon-wrap');
  const msg = document.getElementById('create-collection-modal-msg');
  const okBtn = document.getElementById('create-collection-modal-ok');
  if (!iconWrap) return;
  iconWrap.innerHTML = '<div class="scan-check">✓</div>';
  if (msg) {
    if (updatedCount > 0) {
      msg.textContent = `Collection updated (${updatedCount})`;
    } else if (detail) {
      msg.textContent = detail;
    } else {
      msg.textContent = 'Collection already up to date';
    }
  }
  if (okBtn) {
    okBtn.classList.remove('hidden');
    okBtn.focus();
  }
}

function closeCreateCollectionModal() {
  const modal = document.getElementById('create-collection-modal');
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
    invalidateImageCache();
    status.classList.add('success');
    status.textContent = '✓';
    state.actorsLoaded = false;
    const showLogs = state.profile?.show_scan_logs || [];
    renderScanLogs(result.scan_logs || [], showLogs);
    showScanSuccessModal('Scan complete');
    setTimeout(closeScanModal, 700);
  } catch (error) {
    status.classList.remove('success');
    status.classList.add('error');
    status.textContent = error.message;
    closeScanModal();
  }
}

async function runShowScan() {
  const status = document.getElementById('scan-shows-status');
  const scanText = 'Scanning...';
  status.classList.remove('success', 'error');
  status.textContent = 'Scanning...';
  showScanModal(scanText);

  try {
    const result = await api('/api/scan/shows', { method: 'POST' });
    invalidateImageCache();
    status.classList.add('success');
    status.textContent = '✓';
    state.showsLoaded = false;
    state.showSeasonsCache = {};
    state.showEpisodesCache = {};
    showScanSuccessModal('Scan complete');
    setTimeout(closeScanModal, 700);
    state.profile = { ...state.profile, show_scan_logs: result.show_scan_logs || [] };
    const actorLogs = state.profile?.scan_logs || [];
    renderScanLogs(actorLogs, result.show_scan_logs || []);
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
  state.shows = [];
  state.profile = null;
  state.actorsLoaded = false;
  state.showsLoaded = false;
  state.showSeasonsCache = {};
  state.showEpisodesCache = {};
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
        <div class="meta">${state.actors.length} actors</div>
      </div>
      <div class="row">
        <div id="actors-search-control" class="search-control ${state.actorsSearchOpen ? 'open' : ''}">
          <button id="actors-search-toggle" class="search-toggle-btn has-pill-tooltip" title="Search" aria-label="Search" data-tooltip="Search">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 4a6 6 0 1 1-4.24 10.24A6 6 0 0 1 10 4m0-2a8 8 0 1 0 5.29 14l4.85 4.85 1.41-1.41-4.85-4.85A8 8 0 0 0 10 2Z"/></svg>
          </button>
          <input id="actors-search-input" class="search-input" type="text" placeholder="Search actors" value="${state.actorsSearchQuery}" />
          <button id="actors-search-clear" class="search-clear-btn ${state.actorsSearchOpen ? '' : 'hidden'}" title="Clear search" aria-label="Clear search">×</button>
        </div>
        <select id="actors-sort-by" class="secondary-btn" aria-label="Sort actors by">
          <option value="name" ${state.actorsSortBy === 'name' ? 'selected' : ''}>Name</option>
          <option value="amount" ${state.actorsSortBy === 'amount' ? 'selected' : ''}>Amount</option>
        </select>
        <button id="actors-sort-dir" class="toggle-btn has-pill-tooltip" title="Toggle sort direction" aria-label="Toggle sort direction" data-tooltip="Sort Direction">${state.actorsSortDir === 'asc' ? '↑' : '↓'}</button>
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
          state.actorsInitialFilter = 'All';
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
    const filteredByInitial = state.actorsInitialFilter === 'All'
      ? sortedActors
      : sortedActors.filter((actor) => getActorInitialBucket(actor.name) === state.actorsInitialFilter);
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
      const actorImage = withImageCacheKey(actor.image_url) || ACTOR_PLACEHOLDER;
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

async function renderShows() {
  let data = { items: state.shows, last_scan_at: null };
  if (!state.showsLoaded) {
    data = await api('/api/shows');
    state.shows = data.items;
    state.showsLoaded = true;
  }

  if (!state.shows.length) {
    app.innerHTML = `
      <div class="topbar">
        <h2>Shows</h2>
      </div>
      <div class="empty actors-empty">No shows yet. Go to Profile and run a show scan first.</div>
    `;
    return;
  }

  const hasMissingFlagData = state.shows.some((show) => show.has_missing_episodes !== null && show.has_missing_episodes !== undefined);
  const hasInPlexFlagData = state.shows.some(
    (show) => Boolean(show.missing_scan_at) && Number(show.has_missing_episodes) === 0,
  );
  const hasNewData = state.shows.some((show) => Boolean(nextUpcomingAirDate(show.missing_upcoming_air_dates)));

  app.innerHTML = `
    <div class="topbar">
      <div class="topbar-title">
        <h2>Shows</h2>
        <div class="meta">${state.shows.length} shows</div>
      </div>
      <div class="row">
        <div id="shows-search-control" class="search-control ${state.showsSearchOpen ? 'open' : ''}">
          <button id="shows-search-toggle" class="search-toggle-btn has-pill-tooltip" title="Search" aria-label="Search" data-tooltip="Search">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 4a6 6 0 1 1-4.24 10.24A6 6 0 0 1 10 4m0-2a8 8 0 1 0 5.29 14l4.85 4.85 1.41-1.41-4.85-4.85A8 8 0 0 0 10 2Z"/></svg>
          </button>
          <input id="shows-search-input" class="search-input" type="text" placeholder="Search shows" value="${state.showsSearchQuery}" />
          <button id="shows-search-clear" class="search-clear-btn ${state.showsSearchOpen ? '' : 'hidden'}" title="Clear search" aria-label="Clear search">×</button>
        </div>
        <select id="shows-sort-by" class="secondary-btn" aria-label="Sort shows by">
          <option value="name" ${state.showsSortBy === 'name' ? 'selected' : ''}>Name</option>
          <option value="amount" ${state.showsSortBy === 'amount' ? 'selected' : ''}>Amount</option>
          <option value="date" ${state.showsSortBy === 'date' ? 'selected' : ''}>Date</option>
        </select>
        <button id="shows-sort-dir" class="toggle-btn has-pill-tooltip" title="Toggle sort direction" aria-label="Toggle sort direction" data-tooltip="Sort Direction">${state.showsSortDir === 'asc' ? '↑' : '↓'}</button>
        ${hasMissingFlagData || state.showsMissingOnly ? `<button id="shows-missing-episodes-filter" class="toggle-btn has-pill-tooltip ${state.showsMissingOnly ? 'active' : ''}" data-tooltip="Missing">!</button>` : ''}
        ${hasInPlexFlagData || state.showsInPlexOnly ? `<button id="shows-in-plex-filter" class="toggle-btn has-pill-tooltip ${state.showsInPlexOnly ? 'active' : ''}" data-tooltip="In Plex">&#10003;</button>` : ''}
        ${hasNewData || state.showsNewOnly ? `<button id="shows-new-filter" class="toggle-btn has-pill-tooltip ${state.showsNewOnly ? 'active' : ''}" data-tooltip="New Episodes">NEW</button>` : ''}
      </div>
    </div>
    <div class="alphabet-filter" id="shows-alphabet-filter">
      ${(() => {
        const initials = new Set(state.shows.map((show) => getActorInitialBucket(show.title)));
        const dynamicFilters = ACTOR_INITIAL_FILTERS.filter((key) => {
          if (['Æ', 'Ø', 'Å'].includes(key)) return initials.has(key);
          return true;
        });
        if (!dynamicFilters.includes(state.showsInitialFilter)) {
          state.showsInitialFilter = 'All';
          localStorage.setItem('showsInitialFilter', state.showsInitialFilter);
        }
        return dynamicFilters
          .map((key) => `<button class="alpha-btn ${state.showsInitialFilter === key ? 'active' : ''}" data-filter="${key}">${key}</button>`)
          .join('');
      })()}
    </div>
    <section class="grid" id="shows-grid"></section>
    <div class="load-more-wrap" id="shows-load-more-wrap"></div>
    <button id="shows-scan-missing-btn" class="collection-pill-btn btn-with-icon">${scanIconTag()}<span>Scan Episodes</span></button>
  `;

  document.getElementById('shows-sort-by').addEventListener('change', (event) => {
    state.showsSortBy = event.target.value;
    localStorage.setItem('showsSortBy', state.showsSortBy);
    state.showsVisibleCount = ACTORS_BATCH_SIZE;
    renderShows();
  });
  document.getElementById('shows-sort-dir').addEventListener('click', () => {
    state.showsSortDir = state.showsSortDir === 'asc' ? 'desc' : 'asc';
    localStorage.setItem('showsSortDir', state.showsSortDir);
    state.showsVisibleCount = ACTORS_BATCH_SIZE;
    renderShows();
  });
  const missingFilterBtn = document.getElementById('shows-missing-episodes-filter');
  if (missingFilterBtn) {
    missingFilterBtn.addEventListener('click', () => {
      state.showsMissingOnly = !state.showsMissingOnly;
      if (state.showsMissingOnly) {
        state.showsInPlexOnly = false;
        state.showsNewOnly = false;
      }
      state.showsVisibleCount = ACTORS_BATCH_SIZE;
      renderShows();
    });
  }
  const inPlexFilterBtn = document.getElementById('shows-in-plex-filter');
  if (inPlexFilterBtn) {
    inPlexFilterBtn.addEventListener('click', () => {
      state.showsInPlexOnly = !state.showsInPlexOnly;
      if (state.showsInPlexOnly) {
        state.showsMissingOnly = false;
        state.showsNewOnly = false;
      }
      state.showsVisibleCount = ACTORS_BATCH_SIZE;
      renderShows();
    });
  }
  const newFilterBtn = document.getElementById('shows-new-filter');
  if (newFilterBtn) {
    newFilterBtn.addEventListener('click', () => {
      state.showsNewOnly = !state.showsNewOnly;
      if (state.showsNewOnly) {
        state.showsMissingOnly = false;
        state.showsInPlexOnly = false;
      }
      state.showsVisibleCount = ACTORS_BATCH_SIZE;
      renderShows();
    });
  }

  const grid = document.getElementById('shows-grid');
  const loadMoreWrap = document.getElementById('shows-load-more-wrap');
  const alphabetFilterEl = document.getElementById('shows-alphabet-filter');
  const sortedShows = [...state.shows].sort((a, b) => {
    if (state.showsSortBy === 'name') {
      return compareActorNames({ name: a.title }, { name: b.title });
    }
    if (state.showsSortBy === 'date') {
      const aDate = nextUpcomingAirDate(a.missing_upcoming_air_dates) || '';
      const bDate = nextUpcomingAirDate(b.missing_upcoming_air_dates) || '';
      if (aDate && bDate && aDate !== bDate) return aDate.localeCompare(bDate);
      if (aDate && !bDate) return -1;
      if (!aDate && bDate) return 1;
      return compareActorNames({ name: a.title }, { name: b.title });
    }
    return (a.episodes_in_plex || 0) - (b.episodes_in_plex || 0);
  });
  if (state.showsSortDir === 'desc') sortedShows.reverse();

  const getScopedShows = (includeMissingFilter = true) => {
    const query = state.showsSearchQuery.trim().toLowerCase();
    const filteredByInitial = state.showsInitialFilter === 'All'
      ? sortedShows
      : sortedShows.filter((show) => getActorInitialBucket(show.title) === state.showsInitialFilter);
    let scoped = query ? sortedShows.filter((show) => (show.title || '').toLowerCase().includes(query)) : filteredByInitial;
    if (includeMissingFilter && state.showsMissingOnly) {
      scoped = scoped.filter(
        (show) => Number(show.has_missing_episodes) === 1 && !nextUpcomingAirDate(show.missing_upcoming_air_dates),
      );
    }
    if (includeMissingFilter && state.showsInPlexOnly) {
      scoped = scoped.filter((show) => Boolean(show.missing_scan_at) && Number(show.has_missing_episodes) === 0);
    }
    if (includeMissingFilter && state.showsNewOnly) {
      scoped = scoped.filter((show) => Boolean(nextUpcomingAirDate(show.missing_upcoming_air_dates)));
    }
    return scoped;
  };

  const renderShowsGrid = () => {
    const query = state.showsSearchQuery.trim().toLowerCase();
    const isSearching = query.length > 0;
    const visible = getScopedShows(true);
    const renderItems = visible.slice(0, state.showsVisibleCount);

    for (const button of alphabetFilterEl.querySelectorAll('.alpha-btn')) {
      button.classList.remove('active');
      button.disabled = isSearching;
      if (!isSearching && button.dataset.filter === state.showsInitialFilter) button.classList.add('active');
    }

    if (state.showsImageObserver) {
      state.showsImageObserver.disconnect();
      state.showsImageObserver = null;
    }
    if ('IntersectionObserver' in window) {
      state.showsImageObserver = new IntersectionObserver((entries, observer) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const img = entry.target;
          const lazySrc = img.dataset.src;
          if (lazySrc && img.src !== lazySrc) img.src = lazySrc;
          observer.unobserve(img);
        }
      }, { rootMargin: '180px 0px' });
    }

    grid.innerHTML = '';
    for (const show of renderItems) {
      const downloadUrl = buildDownloadLink('show', show.title);
      const isScanned = Boolean(show.missing_scan_at);
      const hasMissing = isScanned && Number(show.has_missing_episodes) === 1;
      const hasNoMissing = isScanned && Number(show.has_missing_episodes) === 0;
      const scanDateText = formatScanDateOnly(show.missing_scan_at);
      const nextAirDate = nextUpcomingAirDate(show.missing_upcoming_air_dates);
      const nextAirDateText = nextAirDate ? formatDateDdMmYyyy(nextAirDate) : null;
      const hasUpcoming = Boolean(nextAirDateText);
      const upcomingLabel = isScanned
        ? (nextAirDateText ? `New episode: ${nextAirDateText}` : 'No upcoming episodes')
        : '';
      const showStatusBadge = hasNoMissing && show.plex_web_url
        ? `<a class="badge-link badge-overlay" href="${show.plex_web_url}" target="_blank" rel="noopener noreferrer">Plex ${plexLogoTag()}</a>`
        : downloadUrl
          ? `<a class="badge-link badge-overlay badge-download" href="${downloadUrl}" target="_blank" rel="noopener noreferrer">Download <span class="badge-icon badge-icon-download">↓</span></a>`
          : `<span class="badge-link badge-overlay badge-download badge-disabled">Download <span class="badge-icon badge-icon-download">↓</span></span>`;
      const showImage = withImageCacheKey(show.image_url) || SHOW_PLACEHOLDER;
      const card = document.createElement('article');
      card.className = `actor-card${hasUpcoming ? ' has-new' : (hasMissing ? ' has-missing' : '')}`;
      card.innerHTML = `
        <div class="poster-wrap">
          <button class="show-scan-pill" type="button" data-show-id="${show.show_id}" title="Scan episodes for this show" aria-label="Scan episodes for this show">
            <span class="show-scan-pill-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" role="img" aria-hidden="true">
                <path d="${SCAN_ICON_PATH}"></path>
              </svg>
            </span>
            <span class="show-scan-pill-text">${scanDateText}</span>
          </button>
          <img class="poster show-poster-lazy" src="${SHOW_PLACEHOLDER}" data-src="${showImage}" alt="${show.title}" loading="lazy" />
          ${hasUpcoming ? '<span class="new-badge" title="New episodes" aria-label="New episodes">NEW</span>' : ''}
          ${!hasUpcoming && hasMissing ? '<span class="missing-badge" title="Missing episodes" aria-label="Missing episodes">!</span>' : ''}
          ${hasNoMissing ? '<span class="in-plex-badge" title="In Plex" aria-label="In Plex">✓</span>' : ''}
          ${showStatusBadge}
        </div>
        <div class="caption">
          <div class="name">${show.title}</div>
          <div class="count">${show.episodes_in_plex || 0} episodes from Plex</div>
          ${upcomingLabel ? `<div class="count">${upcomingLabel}</div>` : ''}
        </div>
      `;
      const poster = card.querySelector('.poster');
      applyImageFallback(poster, SHOW_PLACEHOLDER);
      if (state.showsImageObserver) state.showsImageObserver.observe(poster);
      else poster.src = showImage;
      const downloadLink = card.querySelector('.badge-link');
      downloadLink.addEventListener('click', (event) => event.stopPropagation());
      const scanPillBtn = card.querySelector('.show-scan-pill');
      scanPillBtn.addEventListener('click', async (event) => {
        event.stopPropagation();
        if (scanPillBtn.disabled) return;
        scanPillBtn.disabled = true;
        showScanModal('Scanned 0/1 shows');
        try {
          const result = await api('/api/shows/missing-scan', {
            method: 'POST',
            body: JSON.stringify({ show_ids: [String(show.show_id)] }),
          });
          const updated = Array.isArray(result.items) ? result.items[0] : null;
          if (updated) applyShowMissingScanUpdate(updated);
          showScanSuccessModal('Missing scan updated for this show.', true);
          renderShows();
        } catch (error) {
          closeScanModal();
          window.alert(error.message);
        } finally {
          scanPillBtn.disabled = false;
        }
      });
      card.addEventListener('click', () => routeTo('show-detail', show.show_id));
      grid.appendChild(card);
    }

    const remaining = visible.length - renderItems.length;
    if (remaining > 0) {
      loadMoreWrap.innerHTML = `<button id="shows-load-more" class="secondary-btn">Load more (${remaining})</button>`;
      document.getElementById('shows-load-more').addEventListener('click', () => {
        state.showsVisibleCount += ACTORS_BATCH_SIZE;
        renderShowsGrid();
      });
    } else {
      loadMoreWrap.innerHTML = '';
    }
  };

  document.getElementById('shows-alphabet-filter').addEventListener('click', (event) => {
    const target = event.target.closest('.alpha-btn');
    if (!target) return;
    state.showsInitialFilter = target.dataset.filter;
    localStorage.setItem('showsInitialFilter', state.showsInitialFilter);
    state.showsVisibleCount = ACTORS_BATCH_SIZE;
    renderShows();
  });

  const showsSearchControl = document.getElementById('shows-search-control');
  const showsSearchToggle = document.getElementById('shows-search-toggle');
  const showsSearchInput = document.getElementById('shows-search-input');
  const showsSearchClear = document.getElementById('shows-search-clear');
  const updateShowsSearchClear = () => {
    const hasValue = !!state.showsSearchQuery.trim();
    showsSearchClear.classList.toggle('hidden', !state.showsSearchOpen || !hasValue);
  };

  showsSearchToggle.addEventListener('click', () => {
    state.showsSearchOpen = !state.showsSearchOpen;
    showsSearchControl.classList.toggle('open', state.showsSearchOpen);
    if (state.showsSearchOpen) showsSearchInput.focus();
    else {
      state.showsSearchQuery = '';
      showsSearchInput.value = '';
      state.showsVisibleCount = ACTORS_BATCH_SIZE;
      renderShowsGrid();
    }
    updateShowsSearchClear();
  });
  showsSearchInput.addEventListener('input', (event) => {
    state.showsSearchQuery = event.target.value;
    state.showsVisibleCount = ACTORS_BATCH_SIZE;
    renderShowsGrid();
    updateShowsSearchClear();
  });
  showsSearchClear.addEventListener('click', () => {
    state.showsSearchQuery = '';
    showsSearchInput.value = '';
    showsSearchInput.focus();
    state.showsVisibleCount = ACTORS_BATCH_SIZE;
    renderShowsGrid();
    updateShowsSearchClear();
  });

  const scanMissingBtn = document.getElementById('shows-scan-missing-btn');
  if (scanMissingBtn) {
    scanMissingBtn.addEventListener('click', async () => {
      if (scanMissingBtn.disabled) return;
      const scoped = getScopedShows(false);
      const scopedIds = scoped.map((item) => String(item.show_id)).filter(Boolean);
      const allIds = state.shows.map((item) => String(item.show_id)).filter(Boolean);
      if (!allIds.length) {
        window.alert('No shows available in current filter.');
        return;
      }
      const choice = await chooseShowMissingScanMode(scopedIds.length, allIds.length);
      if (!choice) return;
      const showIds = choice === 'all' ? allIds : scopedIds;
      if (!showIds.length) {
        window.alert('No shows available in current filter.');
        return;
      }
      scanMissingBtn.disabled = true;
      let scanned = 0;
      let missing = 0;
      let failed = 0;
      const total = showIds.length;
      showScanModal(`Scanned ${scanned}/${total} shows`);
      try {
        for (const showId of showIds) {
          const result = await api('/api/shows/missing-scan', {
            method: 'POST',
            body: JSON.stringify({ show_ids: [showId] }),
          });
          const updates = Array.isArray(result.items) ? result.items : [];
          for (const updated of updates) {
            if (!updated) continue;
            if (updated.has_missing_episodes === true) missing += 1;
            if (updated.has_missing_episodes === null || updated.has_missing_episodes === undefined) failed += 1;
            applyShowMissingScanUpdate(updated);
          }
          scanned += 1;
          const msg = document.getElementById('scan-modal-msg');
          if (msg) msg.textContent = `Scanned ${scanned}/${total} shows`;
        }
        showScanSuccessModal(`Missing: ${missing}, Failed: ${failed}`, true);
        state.showsLoaded = true;
        renderShows();
      } catch (error) {
        closeScanModal();
        window.alert(error.message);
      } finally {
        scanMissingBtn.disabled = false;
      }
    });
  }

  updateShowsSearchClear();
  renderShowsGrid();
}

function showSeasonsCacheKey(showId, missingOnly, inPlexOnly, newOnly) {
  return `${showId}|m:${missingOnly ? 1 : 0}|p:${inPlexOnly ? 1 : 0}|n:${newOnly ? 1 : 0}`;
}

function showEpisodesCacheKey(showId, seasonNumber, missingOnly, inPlexOnly, newOnly) {
  return `${showId}|s:${seasonNumber}|m:${missingOnly ? 1 : 0}|p:${inPlexOnly ? 1 : 0}|n:${newOnly ? 1 : 0}`;
}

async function getShowSeasonsData(showId, missingOnly, inPlexOnly, newOnly) {
  const key = showSeasonsCacheKey(showId, missingOnly, inPlexOnly, newOnly);
  if (state.showSeasonsCache[key]) {
    return state.showSeasonsCache[key];
  }
  const data = await api(`/api/shows/${showId}/seasons?missing_only=${missingOnly}&in_plex_only=${inPlexOnly}&new_only=${newOnly}`);
  state.showSeasonsCache[key] = data;
  return data;
}

async function getShowEpisodesData(showId, seasonNumber, missingOnly, inPlexOnly, newOnly) {
  const key = showEpisodesCacheKey(showId, seasonNumber, missingOnly, inPlexOnly, newOnly);
  if (state.showEpisodesCache[key]) {
    return state.showEpisodesCache[key];
  }
  const data = await api(`/api/shows/${showId}/seasons/${seasonNumber}/episodes?missing_only=${missingOnly}&in_plex_only=${inPlexOnly}&new_only=${newOnly}`);
  state.showEpisodesCache[key] = data;
  return data;
}

async function renderShowSeasons(showId) {
  const search = new URLSearchParams(window.location.search);
  const missingOnly = search.get('missingOnly') === '1';
  const inPlexOnly = search.get('inPlexOnly') === '1';
  const newOnly = search.get('newOnly') === '1';
  const seasonsSortDir = state.showsSeasonsSortDir === 'desc' ? 'desc' : 'asc';
  app.innerHTML = `
    <div class="topbar">
      <div class="topbar-left">
        <button id="shows-back-loading" class="back-icon-btn" title="Back to Shows" aria-label="Back to Shows">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m14 7-5 5 5 5"/></svg>
        </button>
        <div class="topbar-title">
          <h2>Loading seasons...</h2>
          <div class="meta">Please wait</div>
        </div>
      </div>
    </div>
    <section class="grid"><div class="empty">Loading...</div></section>
  `;
  document.getElementById('shows-back-loading')?.addEventListener('click', () => routeTo('shows'));

  const data = await getShowSeasonsData(showId, missingOnly, inPlexOnly, newOnly);

  app.innerHTML = `
    <div class="topbar">
      <div class="topbar-left">
        <button id="shows-back" class="back-icon-btn" title="Back to Shows" aria-label="Back to Shows">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m14 7-5 5 5 5"/></svg>
        </button>
        <div class="topbar-title">
          <h2>${data.show.title}</h2>
          <div class="meta">${data.items.length} seasons</div>
        </div>
      </div>
      <div class="row">
        <button id="seasons-sort-dir" class="toggle-btn has-pill-tooltip" title="Toggle sort direction" aria-label="Toggle sort direction" data-tooltip="Sort Direction">${seasonsSortDir === 'asc' ? '↑' : '↓'}</button>
        <button id="shows-missing-toggle" class="toggle-btn has-pill-tooltip ${missingOnly ? 'active' : ''}" data-tooltip="Missing">!</button>
        <button id="shows-in-plex-toggle" class="toggle-btn has-pill-tooltip ${inPlexOnly ? 'active' : ''}" data-tooltip="In Plex">✓</button>
        <button id="shows-new-toggle" class="toggle-btn has-pill-tooltip ${newOnly ? 'active' : ''}" data-tooltip="New Episodes">NEW</button>
      </div>
    </div>
    <section class="grid" id="show-seasons-grid"></section>
  `;

  const pushQuery = (params) => {
    const query = params.toString();
    history.pushState({}, '', `/shows/${showId}${query ? `?${query}` : ''}`);
    renderShowSeasons(showId);
  };
  document.getElementById('shows-back').addEventListener('click', () => routeTo('shows'));
  document.getElementById('seasons-sort-dir').addEventListener('click', () => {
    state.showsSeasonsSortDir = seasonsSortDir === 'asc' ? 'desc' : 'asc';
    localStorage.setItem('showsSeasonsSortDir', state.showsSeasonsSortDir);
    renderShowSeasons(showId);
  });
  document.getElementById('shows-missing-toggle').addEventListener('click', () => {
    const params = new URLSearchParams();
    const next = !missingOnly;
    if (next) params.set('missingOnly', '1');
    else if (inPlexOnly) params.set('inPlexOnly', '1');
    else if (newOnly) params.set('newOnly', '1');
    pushQuery(params);
  });
  document.getElementById('shows-in-plex-toggle').addEventListener('click', () => {
    const params = new URLSearchParams();
    const next = !inPlexOnly;
    if (next) params.set('inPlexOnly', '1');
    else if (missingOnly) params.set('missingOnly', '1');
    else if (newOnly) params.set('newOnly', '1');
    pushQuery(params);
  });
  document.getElementById('shows-new-toggle').addEventListener('click', () => {
    const params = new URLSearchParams();
    const next = !newOnly;
    if (next) params.set('newOnly', '1');
    else if (missingOnly) params.set('missingOnly', '1');
    else if (inPlexOnly) params.set('inPlexOnly', '1');
    pushQuery(params);
  });

  const grid = document.getElementById('show-seasons-grid');
  if (!data.items.length) {
    grid.innerHTML = '<div class="empty">No seasons found.</div>';
    return;
  }

  // Prefetch unfiltered episodes in the background to reduce click delay.
  if (!missingOnly && !inPlexOnly && !newOnly) {
    for (const season of data.items) {
      const seasonNo = Number(season.season_number);
      const cacheKey = showEpisodesCacheKey(showId, seasonNo, false, false, false);
      if (state.showEpisodesCache[cacheKey]) continue;
      getShowEpisodesData(showId, seasonNo, false, false, false).catch(() => {});
    }
  }

  const seasons = [...data.items].sort((a, b) => {
    const aNo = Number(a.season_number) || 0;
    const bNo = Number(b.season_number) || 0;
    return aNo - bNo;
  });
  if (seasonsSortDir === 'desc') seasons.reverse();

  for (const season of seasons) {
    const seasonDownloadUrl = buildDownloadLink('season', buildSeasonKeyword(data.show.title, season.season_number));
    const seasonDownloadBadge = seasonDownloadUrl
      ? `<a class="badge-link badge-overlay badge-download" href="${seasonDownloadUrl}" target="_blank" rel="noopener noreferrer">Download <span class="badge-icon badge-icon-download">↓</span></a>`
      : '<span class="badge-link badge-overlay badge-download badge-disabled">Download <span class="badge-icon badge-icon-download">↓</span></span>';
    const isUpcoming = Boolean(season.next_upcoming_air_date);
    const isOverflow = Boolean(season.count_overflow) && !isUpcoming;
    const isMissing = !season.in_plex && !isOverflow && !isUpcoming;
    const seasonNextUpcoming = season.next_upcoming_air_date ? formatDateDdMmYyyy(season.next_upcoming_air_date) : null;
    const seasonDateText = season.air_date ? formatDateDdMmYyyy(season.air_date) : null;
    const seasonReleaseLabel = seasonNextUpcoming
      ? `New episode: ${seasonNextUpcoming}`
      : (seasonDateText
        ? (isTodayOrFutureDate(season.air_date) ? `New episode: ${seasonDateText}` : `Released: ${seasonDateText}`)
        : '');
    const card = document.createElement('article');
    card.className = `movie-card${isUpcoming ? ' has-new' : (isOverflow ? ' has-mismatch' : (isMissing ? ' has-missing' : ''))}`;
    card.innerHTML = `
      <div class="poster-wrap">
        <img class="poster" src="${withImageCacheKey(season.poster_url) || SHOW_PLACEHOLDER}" alt="${season.name}" loading="lazy" />
        ${isUpcoming ? '<span class="new-badge" title="Upcoming episodes" aria-label="Upcoming episodes">NEW</span>' : ''}
        ${!isUpcoming && isOverflow ? '<span class="mismatch-badge" title="Count mismatch" aria-label="Count mismatch">!</span>' : ''}
        ${!isUpcoming && !isOverflow && isMissing ? '<span class="missing-badge" title="Missing in Plex" aria-label="Missing in Plex">!</span>' : ''}
        ${season.in_plex ? '<span class="in-plex-badge" title="In Plex" aria-label="In Plex">✓</span>' : ''}
        ${
          season.in_plex
            ? (
              season.plex_web_url
                ? `<a class="badge-link badge-overlay" href="${season.plex_web_url}" target="_blank" rel="noopener noreferrer">Plex ${plexLogoTag()}</a>`
                : `<span class="badge-link badge-overlay">Plex ${plexLogoTag()}</span>`
            )
            : seasonDownloadBadge
        }
      </div>
      <div class="caption">
        <div class="name">${season.name}</div>
        <div class="year">${season.episodes_in_plex || 0}/${season.episode_count || 0} in plex</div>
        ${seasonReleaseLabel ? `<div class="year">${seasonReleaseLabel}</div>` : ''}
      </div>
    `;
    applyImageFallback(card.querySelector('.poster'), SHOW_PLACEHOLDER);
    const badge = card.querySelector('.badge-overlay');
    if (badge && badge.tagName === 'A') badge.addEventListener('click', (event) => event.stopPropagation());
    card.addEventListener('click', () => {
      history.pushState({}, '', `/shows/${showId}/seasons/${season.season_number}`);
      handleLocation();
    });
    grid.appendChild(card);
  }
}

async function renderShowEpisodes(showId, seasonNumber) {
  const search = new URLSearchParams(window.location.search);
  const missingOnly = search.get('missingOnly') === '1';
  const inPlexOnly = search.get('inPlexOnly') === '1';
  const newOnly = search.get('newOnly') === '1';
  const episodesSortDir = state.showsEpisodesSortDir === 'desc' ? 'desc' : 'asc';
  app.innerHTML = `
    <div class="topbar">
      <div class="topbar-left">
        <button id="season-back-loading" class="back-icon-btn" title="Back to Seasons" aria-label="Back to Seasons">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m14 7-5 5 5 5"/></svg>
        </button>
        <div class="topbar-title">
          <h2>Loading episodes...</h2>
          <div class="meta">Please wait</div>
        </div>
      </div>
    </div>
    <section class="grid"><div class="empty">Loading...</div></section>
  `;
  document.getElementById('season-back-loading')?.addEventListener('click', () => {
    history.pushState({}, '', `/shows/${showId}`);
    handleLocation();
  });

  const data = await getShowEpisodesData(showId, seasonNumber, missingOnly, inPlexOnly, newOnly);

  app.innerHTML = `
    <div class="topbar">
      <div class="topbar-left">
        <button id="season-back" class="back-icon-btn" title="Back to Seasons" aria-label="Back to Seasons">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m14 7-5 5 5 5"/></svg>
        </button>
        <div class="topbar-title">
          <h2>${data.show.title} - Season ${seasonNumber}</h2>
          <div class="meta">${data.items.length} episodes</div>
        </div>
      </div>
      <div class="row">
        <button id="episodes-sort-dir" class="toggle-btn has-pill-tooltip" title="Toggle sort direction" aria-label="Toggle sort direction" data-tooltip="Sort Direction">${episodesSortDir === 'asc' ? '↑' : '↓'}</button>
        <button id="episodes-missing-toggle" class="toggle-btn has-pill-tooltip ${missingOnly ? 'active' : ''}" data-tooltip="Missing">!</button>
        <button id="episodes-in-plex-toggle" class="toggle-btn has-pill-tooltip ${inPlexOnly ? 'active' : ''}" data-tooltip="In Plex">✓</button>
        <button id="episodes-new-toggle" class="toggle-btn has-pill-tooltip ${newOnly ? 'active' : ''}" data-tooltip="New Episodes">NEW</button>
      </div>
    </div>
    <section class="grid" id="show-episodes-grid"></section>
  `;

  const pushQuery = (params) => {
    const query = params.toString();
    history.pushState({}, '', `/shows/${showId}/seasons/${seasonNumber}${query ? `?${query}` : ''}`);
    renderShowEpisodes(showId, seasonNumber);
  };
  document.getElementById('season-back').addEventListener('click', () => {
    history.pushState({}, '', `/shows/${showId}`);
    handleLocation();
  });
  document.getElementById('episodes-sort-dir').addEventListener('click', () => {
    state.showsEpisodesSortDir = episodesSortDir === 'asc' ? 'desc' : 'asc';
    localStorage.setItem('showsEpisodesSortDir', state.showsEpisodesSortDir);
    renderShowEpisodes(showId, seasonNumber);
  });
  document.getElementById('episodes-missing-toggle').addEventListener('click', () => {
    const params = new URLSearchParams();
    const next = !missingOnly;
    if (next) params.set('missingOnly', '1');
    else if (inPlexOnly) params.set('inPlexOnly', '1');
    else if (newOnly) params.set('newOnly', '1');
    pushQuery(params);
  });
  document.getElementById('episodes-in-plex-toggle').addEventListener('click', () => {
    const params = new URLSearchParams();
    const next = !inPlexOnly;
    if (next) params.set('inPlexOnly', '1');
    else if (missingOnly) params.set('missingOnly', '1');
    else if (newOnly) params.set('newOnly', '1');
    pushQuery(params);
  });
  document.getElementById('episodes-new-toggle').addEventListener('click', () => {
    const params = new URLSearchParams();
    const next = !newOnly;
    if (next) params.set('newOnly', '1');
    else if (missingOnly) params.set('missingOnly', '1');
    else if (inPlexOnly) params.set('inPlexOnly', '1');
    pushQuery(params);
  });

  const grid = document.getElementById('show-episodes-grid');
  if (!data.items.length) {
    grid.innerHTML = '<div class="empty">No episodes found.</div>';
    return;
  }
  const episodes = [...data.items].sort((a, b) => {
    const aNo = Number(a.episode_number) || 0;
    const bNo = Number(b.episode_number) || 0;
    return aNo - bNo;
  });
  if (episodesSortDir === 'desc') episodes.reverse();

  for (const episode of episodes) {
    const episodeDownloadUrl = buildDownloadLink(
      'episode',
      buildEpisodeKeyword(data.show.title, seasonNumber, episode.episode_number),
    );
    const episodeDownloadBadge = episodeDownloadUrl
      ? `<a class="badge-link badge-overlay badge-download" href="${episodeDownloadUrl}" target="_blank" rel="noopener noreferrer">Download <span class="badge-icon badge-icon-download">↓</span></a>`
      : '<span class="badge-link badge-overlay badge-download badge-disabled">Download <span class="badge-icon badge-icon-download">↓</span></span>';
    const isUpcoming = isTodayOrFutureDate(episode.air_date);
    const isMissing = !episode.in_plex && !isUpcoming;
    const episodeDateText = episode.air_date ? formatDateDdMmYyyy(episode.air_date) : null;
    const episodeReleaseLabel = episodeDateText
      ? (isTodayOrFutureDate(episode.air_date) ? `Releasing: ${episodeDateText}` : `Released: ${episodeDateText}`)
      : '';
    const tmdbEpisodeUrl = data.show?.tmdb_show_id
      ? `https://www.themoviedb.org/tv/${data.show.tmdb_show_id}/season/${seasonNumber}/episode/${episode.episode_number}`
      : null;
    const card = document.createElement('article');
    card.className = `movie-card${isUpcoming ? ' has-new' : (isMissing ? ' has-missing' : '')}`;
    card.innerHTML = `
      <div class="poster-wrap">
        <img class="poster" src="${withImageCacheKey(episode.poster_url) || SHOW_PLACEHOLDER}" alt="${episode.title}" loading="lazy" />
        ${isUpcoming ? '<span class="new-badge" title="Upcoming episode" aria-label="Upcoming episode">NEW</span>' : ''}
        ${!isUpcoming && isMissing ? '<span class="missing-badge" title="Missing in Plex" aria-label="Missing in Plex">!</span>' : ''}
        ${episode.in_plex ? '<span class="in-plex-badge" title="In Plex" aria-label="In Plex">✓</span>' : ''}
        ${
          episode.in_plex
            ? `<a class="badge-link badge-overlay" href="${episode.plex_web_url}" target="_blank" rel="noopener noreferrer">Plex ${plexLogoTag()}</a>`
            : episodeDownloadBadge
        }
      </div>
      <div class="caption">
        <div class="name">E${String(episode.episode_number).padStart(2, '0')} - ${episode.title}</div>
        ${episodeReleaseLabel ? `<div class="year">${episodeReleaseLabel}</div>` : ''}
      </div>
    `;
    const badge = card.querySelector('.badge-overlay');
    if (badge && badge.tagName === 'A') badge.addEventListener('click', (event) => event.stopPropagation());
    if (tmdbEpisodeUrl) {
      card.addEventListener('click', () => window.open(tmdbEpisodeUrl, '_blank', 'noopener,noreferrer'));
    }
    applyImageFallback(card.querySelector('.poster'), SHOW_PLACEHOLDER);
    grid.appendChild(card);
  }
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
  const inPlexCount = data.items.filter((item) => item.in_plex).length;
  const showCreateCollection = inPlexOnly && inPlexCount > 0;
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
          <button id="movies-search-toggle" class="search-toggle-btn has-pill-tooltip" title="Search" aria-label="Search" data-tooltip="Search">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 4a6 6 0 1 1-4.24 10.24A6 6 0 0 1 10 4m0-2a8 8 0 1 0 5.29 14l4.85 4.85 1.41-1.41-4.85-4.85A8 8 0 0 0 10 2Z"/></svg>
          </button>
          <input id="movies-search-input" class="search-input" type="text" placeholder="Search movies" value="${state.moviesSearchQuery}" />
          <button id="movies-search-clear" class="search-clear-btn ${state.moviesSearchOpen ? '' : 'hidden'}" title="Clear search" aria-label="Clear search">×</button>
        </div>
        <select id="movies-sort-by" class="secondary-btn" aria-label="Sort movies by">
          <option value="title" ${sortBy === 'title' ? 'selected' : ''}>Title</option>
          <option value="year" ${sortBy === 'year' ? 'selected' : ''}>Year</option>
        </select>
        <button id="movies-sort-dir" class="toggle-btn has-pill-tooltip" title="Toggle sort direction" aria-label="Toggle sort direction" data-tooltip="Sort Direction">${sortDir === 'asc' ? '↑' : '↓'}</button>
        <button id="missing-toggle" class="toggle-btn has-pill-tooltip ${missingOnly ? 'active' : ''}" data-tooltip="Missing">!</button>
        <button id="in-plex-toggle" class="toggle-btn has-pill-tooltip ${inPlexOnly ? 'active' : ''}" data-tooltip="In Plex">✓</button>
      </div>
    </div>
    <div class="alphabet-filter" id="movies-alphabet-filter">
      ${(() => {
        const initials = new Set(data.items.map((movie) => getActorInitialBucket(movie.title)));
        const dynamicFilters = ACTOR_INITIAL_FILTERS.filter((key) => {
          if (['Æ', 'Ø', 'Å'].includes(key)) return initials.has(key);
          return true;
        });
        if (!dynamicFilters.includes(state.moviesInitialFilter)) {
          state.moviesInitialFilter = 'All';
          localStorage.setItem('moviesInitialFilter', state.moviesInitialFilter);
        }
        return dynamicFilters
          .map((key) => `<button class="alpha-btn ${state.moviesInitialFilter === key ? 'active' : ''}" data-filter="${key}">${key}</button>`)
          .join('');
      })()}
    </div>
    <section class="grid" id="movies-grid"></section>
    ${showCreateCollection ? '<button id="create-collection-btn" class="collection-pill-btn"><span class="btn-plus-icon" aria-hidden="true">+</span><span>Create Collection</span></button>' : ''}
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

  const createCollectionBtn = document.getElementById('create-collection-btn');
  if (createCollectionBtn) {
    createCollectionBtn.addEventListener('click', async () => {
      if (state.createCollectionBusy) return;
      state.createCollectionBusy = true;
      createCollectionBtn.disabled = true;
      showCreateCollectionModal('Creating collection...');
      try {
        const result = await api('/api/collections/create-from-actor', {
          method: 'POST',
          body: JSON.stringify({ actor_id: actorId, collection_name: actorName }),
        });
        const updated = Number(result.updated || 0);
        const unchanged = Number(result.unchanged || 0);
        const sectionCount = Array.isArray(result.sections) ? result.sections.length : 0;
        showCreateCollectionSuccessModal(updated, result.detail || '');
        if (sectionCount > 0) {
          createCollectionBtn.title = `${sectionCount} section(s) updated`;
        } else if (unchanged > 0) {
          createCollectionBtn.title = 'No changes needed';
        }
      } catch (error) {
        closeCreateCollectionModal();
        window.alert(error.message);
      } finally {
        state.createCollectionBusy = false;
        createCollectionBtn.disabled = false;
      }
    });
  }

  const grid = document.getElementById('movies-grid');
  const alphabetFilterEl = document.getElementById('movies-alphabet-filter');
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
    const isSearching = query.length > 0;
    const filteredByInitial = state.moviesInitialFilter === 'All'
      ? sortedMovies
      : sortedMovies.filter((movie) => getActorInitialBucket(movie.title) === state.moviesInitialFilter);
    const visible = query
      ? sortedMovies.filter((movie) => (movie.title || '').toLowerCase().includes(query))
      : filteredByInitial;

    for (const button of alphabetFilterEl.querySelectorAll('.alpha-btn')) {
      button.classList.remove('active');
      button.disabled = isSearching;
      if (!isSearching && button.dataset.filter === state.moviesInitialFilter) {
        button.classList.add('active');
      }
    }

    grid.innerHTML = '';
    for (const movie of visible) {
      const card = document.createElement('article');
      const isMissing = !movie.in_plex;
      card.className = `movie-card${isMissing ? ' has-missing' : ''}`;
      const tmdbUrl = movie.tmdb_id ? `https://www.themoviedb.org/movie/${movie.tmdb_id}` : null;
      const downloadUrl = buildDownloadLink('movie', movie.title);
      const movieDownloadBadge = downloadUrl
        ? `<a class="badge-link badge-overlay badge-download" href="${downloadUrl}" target="_blank" rel="noopener noreferrer">Download <span class="badge-icon badge-icon-download">↓</span></a>`
        : `<span class="badge-link badge-overlay badge-download badge-disabled">Download <span class="badge-icon badge-icon-download">↓</span></span>`;
      card.innerHTML = `
        <div class="poster-wrap">
          <img class="poster" src="${withImageCacheKey(movie.poster_url) || MOVIE_PLACEHOLDER}" alt="${movie.title}" loading="lazy" />
          ${isMissing ? '<span class="missing-badge" title="Missing in Plex" aria-label="Missing in Plex">!</span>' : ''}
          ${movie.in_plex ? '<span class="in-plex-badge" title="In Plex" aria-label="In Plex">✓</span>' : ''}
          ${
            movie.in_plex
              ? `<a class="badge-link badge-overlay" href="${movie.plex_web_url}" target="_blank" rel="noopener noreferrer">Plex ${plexLogoTag()}</a>`
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

  document.getElementById('movies-alphabet-filter').addEventListener('click', (event) => {
    const target = event.target.closest('.alpha-btn');
    if (!target) return;
    state.moviesInitialFilter = target.dataset.filter;
    localStorage.setItem('moviesInitialFilter', state.moviesInitialFilter);
    renderMoviesGrid();
  });

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
