const app = document.getElementById('app');
const nav = document.getElementById('floating-nav');
const navProfile = document.getElementById('nav-profile');
const navActors = document.getElementById('nav-actors');
const navShows = document.getElementById('nav-shows');
const navCalendar = document.getElementById('nav-calendar');
const ACTOR_PLACEHOLDER = 'https://placehold.co/500x750?text=Actor';
const MOVIE_PLACEHOLDER = 'https://placehold.co/500x750?text=Movie';
const SHOW_PLACEHOLDER = 'https://placehold.co/500x750?text=Show';
const PLEX_LOGO_PATH = '/assets/plexlogo.png';
const SCAN_ICON_PATH = "M20 5v5h-5l1.9-1.9A6.98 6.98 0 0 0 12 6a7 7 0 0 0-6.93 6h-2.02A9.01 9.01 0 0 1 12 4c2.21 0 4.24.8 5.8 2.12L20 4v1Zm-16 9h5l-1.9 1.9A6.98 6.98 0 0 0 12 18a7 7 0 0 0 6.93-6h2.02A9.01 9.01 0 0 1 12 20c-2.21 0-4.24-.8-5.8-2.12L4 20v-6Z";
const CALENDAR_ICON_PATH = "M7 2h2v2h6V2h2v2h3v18H4V4h3V2Zm11 8H6v10h12V10Zm0-4H6v2h12V6Z";
const ACTORS_BATCH_SIZE = 80;
const SCAN_WORKERS_CONCURRENCY = 8; // "Scan workers"
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
const APP_CACHE_VERSION = 1;
const CACHE_KEYS = {
  profile: 'pc_cache_profile_v1',
  actors: 'pc_cache_actors_v1',
  shows: 'pc_cache_shows_v1',
};
const CAST_ROLES = ['actor', 'director', 'writer'];
const CAST_ROLE_LABELS = {
  actor: 'Actors',
  director: 'Directors',
  writer: 'Writers',
};
const CAST_ROLE_ICONS = {
  actor: '/assets/actor.png',
  director: '/assets/director.png',
  writer: '/assets/writer.png',
};
const CAST_ROLE_STORAGE_KEY = 'castRole';
const SHOW_SEASONS_CACHE_PREFIX = 'pc_cache_show_seasons_v1_';
const SHOW_EPISODES_CACHE_PREFIX = 'pc_cache_show_episodes_v1_';
const CACHE_TTL_MS = {
  profile: 1000 * 60 * 60 * 6,
  actors: 1000 * 60 * 60 * 24,
  shows: 1000 * 60 * 60 * 24,
  showDetail: 1000 * 60 * 60 * 24,
};
const LAST_ROUTE_KEY = 'lastAppRoute';
const LAST_CAST_ROUTE_KEY = 'lastCastRoute';
const LAST_SHOWS_ROUTE_KEY = 'lastShowsRoute';
const CALENDAR_VIEW_MODE_KEY = 'calendarViewMode';
const CALENDAR_SELECTED_DATE_KEY = 'calendarSelectedDate';
const CALENDAR_CURSOR_KEY = 'calendarCursor';
const SHOULD_RESTORE_LAST_ROUTE_ON_BOOT = (() => {
  try {
    const navEntry = performance.getEntriesByType('navigation')?.[0];
    const navType = navEntry?.type || '';
    return navType === 'reload';
  } catch {
    return false;
  }
})();
let hasCheckedBootRouteRestore = false;

function readCalendarCursorFromStorage() {
  try {
    const raw = localStorage.getItem(CALENDAR_CURSOR_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const year = Number(parsed?.year);
    const month = Number(parsed?.month);
    if (!Number.isInteger(year) || !Number.isInteger(month)) return null;
    if (month < 0 || month > 11) return null;
    return { year, month };
  } catch {
    return null;
  }
}

function getCastRoleFromQuery() {
  const role = new URLSearchParams(window.location.search).get('role') || '';
  const normalized = role.trim().toLowerCase();
  return CAST_ROLES.includes(normalized) ? normalized : '';
}

function getActorsCacheKey(role) {
  const normalized = CAST_ROLES.includes(role) ? role : 'actor';
  return `${CACHE_KEYS.actors}_${normalized}`;
}

const state = {
  session: null,
  actors: [],
  shows: [],
  profile: null,
  currentView: 'profile',
  actorsLoaded: false,
  actorsLoadedRole: '',
  showsLoaded: false,
  profileLoaded: false,
  actorsSearchOpen: false,
  actorsSearchQuery: '',
  showsSearchOpen: false,
  showsSearchQuery: '',
  moviesSearchOpen: false,
  moviesSearchQuery: '',
  moviesInitialFilter: localStorage.getItem('moviesInitialFilter') || 'All',
  actorsSortBy: (() => {
    const stored = localStorage.getItem('actorsSortBy') || 'name';
    if (stored === 'amount') return 'movies';
    if (stored === 'date') return 'name';
    if (['movies', 'missing', 'name', 'new', 'upcoming'].includes(stored)) return stored;
    return 'name';
  })(),
  actorsSortDir: localStorage.getItem('actorsSortDir') || 'asc',
  actorsMissingOnly: false,
  actorsInPlexOnly: false,
  actorsNewOnly: false,
  actorsUpcomingOnly: false,
  showsSortBy: (() => {
    const stored = localStorage.getItem('showsSortBy') || 'name';
    if (stored === 'amount') return 'episodes';
    if (['episodes', 'missing', 'name', 'date', 'new', 'upcoming'].includes(stored)) return stored;
    return 'name';
  })(),
  showsSortDir: localStorage.getItem('showsSortDir') || 'asc',
  showsSeasonsSortDir: localStorage.getItem('showsSeasonsSortDir') || 'asc',
  showsEpisodesSortDir: localStorage.getItem('showsEpisodesSortDir') || 'asc',
  showsMissingOnly: false,
  showsInPlexOnly: false,
  showsNewOnly: false,
  showsUpcomingOnly: false,
  showsInitialFilter: localStorage.getItem('showsInitialFilter') || 'All',
  showsVisibleCount: ACTORS_BATCH_SIZE,
  showsImageObserver: null,
  showsImageQueueToken: 0,
  showsImageQueueRunning: false,
  showsImageQueue: [],
  showsImageQueueControllers: new Set(),
  showsImageObjectUrls: new Set(),
  showSeasonsCache: {},
  showEpisodesCache: {},
  showPrefetchControllers: new Set(),
  actorsInitialFilter: localStorage.getItem('actorsInitialFilter') || 'All',
  actorsVisibleCount: ACTORS_BATCH_SIZE,
  castRole: localStorage.getItem(CAST_ROLE_STORAGE_KEY) || '',
  actorsImageObserver: null,
  imageCacheKey: localStorage.getItem('imageCacheKey') || '1',
  createCollectionBusy: false,
  profileRefreshInFlight: false,
  actorsRefreshInFlight: false,
  showsRefreshInFlight: false,
  profileLastRefreshAt: 0,
  actorsLastRefreshAt: 0,
  showsLastRefreshAt: 0,
  calendarCursor: readCalendarCursorFromStorage(),
  calendarRenderToken: 0,
  calendarViewMode: localStorage.getItem(CALENDAR_VIEW_MODE_KEY) === 'day' ? 'day' : 'month',
  calendarSelectedDate: localStorage.getItem(CALENDAR_SELECTED_DATE_KEY) || null,
  calendarShowMovies: localStorage.getItem('calendarShowMovies') !== '0',
  calendarShowShows: localStorage.getItem('calendarShowShows') !== '0',
};

const LOCAL_STORAGE_RESET_KEYS = [
  'moviesInitialFilter',
  'actorsSortBy',
  'actorsSortDir',
  'showsSortBy',
  'showsSortDir',
  'showsSeasonsSortDir',
  'showsEpisodesSortDir',
  'showsInitialFilter',
  'actorsInitialFilter',
  CAST_ROLE_STORAGE_KEY,
  'moviesSortBy',
  'moviesSortDir',
  'imageCacheKey',
  LAST_ROUTE_KEY,
  LAST_CAST_ROUTE_KEY,
  LAST_SHOWS_ROUTE_KEY,
  CALENDAR_VIEW_MODE_KEY,
  CALENDAR_SELECTED_DATE_KEY,
  CALENDAR_CURSOR_KEY,
  CACHE_KEYS.profile,
  CACHE_KEYS.actors,
  CACHE_KEYS.shows,
];
let plexAuthPopup = null;

navProfile.addEventListener('click', () => routeTo('profile'));
navActors.addEventListener('click', () => {
  const currentPath = window.location.pathname;
  if (currentPath.startsWith('/cast')) {
    history.pushState({}, '', '/cast');
    handleLocation();
    return;
  }
  routeTo('actors');
});
navShows.addEventListener('click', () => {
  const currentPath = window.location.pathname;
  if (currentPath.startsWith('/shows')) {
    history.pushState({}, '', '/shows');
    handleLocation();
    return;
  }
  let target = '/shows';
  try {
    const stored = localStorage.getItem(LAST_SHOWS_ROUTE_KEY) || '';
    if (stored.startsWith('/shows')) target = stored;
  } catch {}
  history.pushState({}, '', target);
  handleLocation();
});
navCalendar.addEventListener('click', () => routeTo('calendar'));

window.addEventListener('popstate', handleLocation);

function updateScrollState() {
  document.body.classList.toggle('is-scrolled', window.scrollY > 0);
}

window.addEventListener('scroll', updateScrollState, { passive: true });
updateScrollState();

function cancelShowPrefetches() {
  for (const controller of state.showPrefetchControllers) {
    try {
      controller.abort();
    } catch {}
  }
  state.showPrefetchControllers.clear();
}

function resetShowImageQueue() {
  state.showsImageQueueToken += 1;
  state.showsImageQueueRunning = false;
  state.showsImageQueue = [];
  for (const controller of state.showsImageQueueControllers) {
    try {
      controller.abort();
    } catch {}
  }
  state.showsImageQueueControllers.clear();
  for (const url of state.showsImageObjectUrls) {
    try {
      URL.revokeObjectURL(url);
    } catch {}
  }
  state.showsImageObjectUrls.clear();
}

async function runShowImageQueue(token) {
  if (state.showsImageQueueRunning) return;
  state.showsImageQueueRunning = true;
  try {
    const maxConcurrent = 6;
    const worker = async () => {
      while (state.showsImageQueue.length > 0 && token === state.showsImageQueueToken) {
        const item = state.showsImageQueue.shift();
        if (!item) continue;
        const { img, src } = item;
        if (!img || !img.isConnected) continue;
        if (!src || img.src === src) continue;

        const isLocalApiImage = src.startsWith('/api/') || src.startsWith(window.location.origin);
        if (!isLocalApiImage) {
          // Fallback for external image URLs: load directly without fetch-abort.
          if (token !== state.showsImageQueueToken || !img.isConnected) continue;
          img.src = src;
          continue;
        }

        const controller = new AbortController();
        state.showsImageQueueControllers.add(controller);
        try {
          const response = await fetch(src, { signal: controller.signal, cache: 'force-cache' });
          if (!response.ok) throw new Error(`Image load failed: ${response.status}`);
          const blob = await response.blob();
          if (token !== state.showsImageQueueToken || !img.isConnected) continue;
          const oldObjectUrl = img.dataset.objectUrl || '';
          const objectUrl = URL.createObjectURL(blob);
          img.src = objectUrl;
          img.dataset.objectUrl = objectUrl;
          state.showsImageObjectUrls.add(objectUrl);
          if (oldObjectUrl && state.showsImageObjectUrls.has(oldObjectUrl)) {
            URL.revokeObjectURL(oldObjectUrl);
            state.showsImageObjectUrls.delete(oldObjectUrl);
          }
        } catch (error) {
          if (error?.name !== 'AbortError' && img.isConnected) {
            // Keep placeholder on failed load.
          }
        } finally {
          state.showsImageQueueControllers.delete(controller);
        }
      }
    };

    const workers = [];
    for (let i = 0; i < maxConcurrent; i += 1) {
      workers.push(worker());
    }
    await Promise.all(workers);
  } finally {
    state.showsImageQueueRunning = false;
  }
}

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

function readPersistentCache(cacheKey, ttlMs) {
  try {
    const raw = localStorage.getItem(cacheKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.version !== APP_CACHE_VERSION) return null;
    if (!parsed.saved_at || !parsed.data) return null;
    if (Date.now() - Number(parsed.saved_at) > ttlMs) return null;
    return parsed.data;
  } catch {
    return null;
  }
}

function writePersistentCache(cacheKey, data) {
  try {
    localStorage.setItem(
      cacheKey,
      JSON.stringify({
        version: APP_CACHE_VERSION,
        saved_at: Date.now(),
        data,
      }),
    );
  } catch {}
}

function clearPersistentCache(cacheKey) {
  try {
    localStorage.removeItem(cacheKey);
  } catch {}
}

function persistLastRoute(pathname = window.location.pathname) {
  const normalized = String(pathname || '').trim();
  if (!normalized.startsWith('/')) return;
  try {
    localStorage.setItem(LAST_ROUTE_KEY, normalized);
  } catch {}
}

function persistLastCastRoute(pathAndQuery = `${window.location.pathname}${window.location.search || ''}`) {
  const normalized = String(pathAndQuery || '').trim();
  if (!normalized.startsWith('/cast')) return;
  try {
    localStorage.setItem(LAST_CAST_ROUTE_KEY, normalized);
  } catch {}
}

function persistLastShowsRoute(pathAndQuery = `${window.location.pathname}${window.location.search || ''}`) {
  const normalized = String(pathAndQuery || '').trim();
  if (!normalized.startsWith('/shows')) return;
  try {
    localStorage.setItem(LAST_SHOWS_ROUTE_KEY, normalized);
  } catch {}
}

function applyCalendarUrlState() {
  const params = new URLSearchParams(window.location.search);
  const hasCalendarState =
    params.has('view') || params.has('date') || params.has('year') || params.has('month') || params.has('types');
  if (!hasCalendarState) return false;

  const today = new Date();
  const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const view = params.get('view') === 'day' ? 'day' : 'month';

  const yearRaw = Number(params.get('year'));
  const monthRaw = Number(params.get('month'));
  let cursorYear = Number.isInteger(yearRaw) ? yearRaw : todayStart.getFullYear();
  let cursorMonth = Number.isInteger(monthRaw) ? (monthRaw - 1) : todayStart.getMonth();
  if (cursorMonth < 0 || cursorMonth > 11) cursorMonth = todayStart.getMonth();

  let selectedDate = null;
  if (view === 'day') {
    const rawDate = String(params.get('date') || '').trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(rawDate)) {
      const parsed = new Date(rawDate);
      if (!Number.isNaN(parsed.getTime())) {
        selectedDate = rawDate;
        cursorYear = parsed.getFullYear();
        cursorMonth = parsed.getMonth();
      }
    }
    if (!selectedDate) {
      selectedDate = `${todayStart.getFullYear()}-${String(todayStart.getMonth() + 1).padStart(2, '0')}-${String(todayStart.getDate()).padStart(2, '0')}`;
      cursorYear = todayStart.getFullYear();
      cursorMonth = todayStart.getMonth();
    }
  }

  const types = String(params.get('types') || 'all').toLowerCase();
  if (types === 'movie') {
    state.calendarShowMovies = true;
    state.calendarShowShows = false;
  } else if (types === 'show') {
    state.calendarShowMovies = false;
    state.calendarShowShows = true;
  } else {
    state.calendarShowMovies = true;
    state.calendarShowShows = true;
  }

  state.calendarViewMode = view;
  state.calendarSelectedDate = selectedDate;
  state.calendarCursor = { year: cursorYear, month: cursorMonth };
  persistCalendarViewState();
  localStorage.setItem('calendarShowMovies', state.calendarShowMovies ? '1' : '0');
  localStorage.setItem('calendarShowShows', state.calendarShowShows ? '1' : '0');
  return true;
}

function syncCalendarUrl(historyMode = 'replace') {
  if (window.location.pathname !== '/calendar') return;
  const params = new URLSearchParams();
  const mode = state.calendarViewMode === 'day' ? 'day' : 'month';
  params.set('view', mode);
  if (state.calendarCursor && Number.isInteger(Number(state.calendarCursor.year)) && Number.isInteger(Number(state.calendarCursor.month))) {
    params.set('year', String(Number(state.calendarCursor.year)));
    params.set('month', String(Number(state.calendarCursor.month) + 1));
  }
  if (mode === 'day' && state.calendarSelectedDate) {
    params.set('date', state.calendarSelectedDate);
  }
  const isMovieOnly = state.calendarShowMovies && !state.calendarShowShows;
  const isShowOnly = !state.calendarShowMovies && state.calendarShowShows;
  params.set('types', isMovieOnly ? 'movie' : (isShowOnly ? 'show' : 'all'));

  const nextUrl = `/calendar?${params.toString()}`;
  const currentUrl = `${window.location.pathname}${window.location.search}`;
  if (nextUrl === currentUrl) return;
  if (historyMode === 'push') {
    history.pushState({}, '', nextUrl);
  } else {
    history.replaceState({}, '', nextUrl);
  }
}

function persistCalendarViewState() {
  try {
    localStorage.setItem(CALENDAR_VIEW_MODE_KEY, state.calendarViewMode === 'day' ? 'day' : 'month');
    if (state.calendarSelectedDate) {
      localStorage.setItem(CALENDAR_SELECTED_DATE_KEY, state.calendarSelectedDate);
    } else {
      localStorage.removeItem(CALENDAR_SELECTED_DATE_KEY);
    }
    if (state.calendarCursor && Number.isInteger(Number(state.calendarCursor.year)) && Number.isInteger(Number(state.calendarCursor.month))) {
      localStorage.setItem(
        CALENDAR_CURSOR_KEY,
        JSON.stringify({
          year: Number(state.calendarCursor.year),
          month: Number(state.calendarCursor.month),
        }),
      );
    } else {
      localStorage.removeItem(CALENDAR_CURSOR_KEY);
    }
  } catch {}
}

function clearPrimaryDataCaches() {
  clearPersistentCache(CACHE_KEYS.profile);
  for (const role of CAST_ROLES) {
    clearPersistentCache(getActorsCacheKey(role));
  }
  clearPersistentCache(CACHE_KEYS.shows);
  clearShowDetailPersistentCaches();
  state.profileLastRefreshAt = 0;
  state.actorsLastRefreshAt = 0;
  state.showsLastRefreshAt = 0;
}

function showSeasonsPersistentKey(cacheKey) {
  return `${SHOW_SEASONS_CACHE_PREFIX}${encodeURIComponent(cacheKey)}`;
}

function showEpisodesPersistentKey(cacheKey) {
  return `${SHOW_EPISODES_CACHE_PREFIX}${encodeURIComponent(cacheKey)}`;
}

function readShowSeasonsPersistentCache(cacheKey) {
  return readPersistentCache(showSeasonsPersistentKey(cacheKey), CACHE_TTL_MS.showDetail);
}

function readShowEpisodesPersistentCache(cacheKey) {
  return readPersistentCache(showEpisodesPersistentKey(cacheKey), CACHE_TTL_MS.showDetail);
}

function writeShowSeasonsPersistentCache(cacheKey, data) {
  writePersistentCache(showSeasonsPersistentKey(cacheKey), data);
}

function writeShowEpisodesPersistentCache(cacheKey, data) {
  writePersistentCache(showEpisodesPersistentKey(cacheKey), data);
}

function clearShowDetailPersistentCaches(showId = null) {
  const removeKeys = [];
  const seasonsNeedle = showId ? `${SHOW_SEASONS_CACHE_PREFIX}${encodeURIComponent(`${showId}|`)}` : SHOW_SEASONS_CACHE_PREFIX;
  const episodesNeedle = showId ? `${SHOW_EPISODES_CACHE_PREFIX}${encodeURIComponent(`${showId}|`)}` : SHOW_EPISODES_CACHE_PREFIX;
  for (let i = 0; i < localStorage.length; i += 1) {
    const key = localStorage.key(i);
    if (!key) continue;
    if (key.startsWith(seasonsNeedle) || key.startsWith(episodesNeedle)) {
      removeKeys.push(key);
    }
  }
  for (const key of removeKeys) {
    try {
      localStorage.removeItem(key);
    } catch {}
  }
}

function invalidateShowDetailCaches(showId) {
  const showKey = `${showId}|`;
  state.showSeasonsCache = Object.fromEntries(
    Object.entries(state.showSeasonsCache).filter(([key]) => !key.startsWith(showKey)),
  );
  const episodePrefix = `${showId}|s:`;
  state.showEpisodesCache = Object.fromEntries(
    Object.entries(state.showEpisodesCache).filter(([key]) => !key.startsWith(episodePrefix)),
  );
  clearShowDetailPersistentCaches(showId);
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

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
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

function calendarIconTag(iconClass = 'calendar-icon') {
  return `
    <span class="${iconClass}" aria-hidden="true">
      <svg viewBox="0 0 24 24" role="img" aria-hidden="true">
        <path d="${CALENDAR_ICON_PATH}"></path>
      </svg>
    </span>
  `;
}

function getShowPrimaryStatus(show) {
  const newCount = Number.isFinite(Number(show?.missing_new_count)) ? Number(show.missing_new_count) : 0;
  const oldCount = Number.isFinite(Number(show?.missing_old_count)) ? Number(show.missing_old_count) : 0;
  const upcomingCount = Number.isFinite(Number(show?.missing_upcoming_count)) ? Number(show.missing_upcoming_count) : 0;
  if (newCount > 0) return 'new';
  if (upcomingCount > 0) return 'upcoming';
  if (oldCount > 0) return 'missing';
  if (Number(show?.has_missing_episodes) === 1) return 'missing';
  if (Boolean(show?.missing_scan_at) && Number(show?.has_missing_episodes) === 0) return 'in_plex';
  return 'unknown';
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
  if (mode === 'hyphen') return words.join('-');
  if (mode === 'plus') return words.join('+');
  return words.join('%20');
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
  const normalizedFirstChar = firstChar
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .charAt(0);
  if (/[A-Z]/.test(normalizedFirstChar)) return normalizedFirstChar;
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

function getActorPrimaryStatus(actor) {
  const newCount = Number.isFinite(Number(actor?.missing_new_count)) ? Number(actor.missing_new_count) : 0;
  const missingCount = Number.isFinite(Number(actor?.missing_movie_count)) ? Number(actor.missing_movie_count) : 0;
  const upcomingCount = Number.isFinite(Number(actor?.missing_upcoming_count)) ? Number(actor.missing_upcoming_count) : 0;
  if (newCount > 0) return 'new';
  if (upcomingCount > 0) return 'upcoming';
  if (missingCount > 0) return 'missing';
  if (Boolean(actor?.missing_scan_at)) return 'in_plex';
  return 'unknown';
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

function formatReleasedDate(value, yearFallback = null) {
  if (value && typeof value === 'string') {
    const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (match) return match[1];
    const yearOnly = value.match(/^(\d{4})$/);
    if (yearOnly) return yearOnly[1];
  }
  if (Number.isFinite(Number(yearFallback))) {
    return String(Number(yearFallback));
  }
  return 'No year';
}

function isTodayOrFutureDate(value) {
  if (!value || typeof value !== 'string') return false;
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return false;
  const today = new Date();
  const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  return value >= todayKey;
}

function isFutureDate(value) {
  if (!value || typeof value !== 'string') return false;
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return false;
  const today = new Date();
  const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  return value > todayKey;
}

function applyShowMissingScanUpdate(updated) {
  if (!updated || !updated.show_id) return;
  const idx = state.shows.findIndex((s) => String(s.show_id) === String(updated.show_id));
  if (idx < 0) return;
  const nextMissing = updated.has_missing_episodes;
  const current = state.shows[idx];
  current.has_missing_episodes = nextMissing === null || nextMissing === undefined ? null : (nextMissing ? 1 : 0);
  current.missing_episode_count = Number.isFinite(Number(updated.missing_episode_count))
    ? Number(updated.missing_episode_count)
    : (current.missing_episode_count ?? null);
  current.missing_new_count = Number.isFinite(Number(updated.missing_new_count))
    ? Number(updated.missing_new_count)
    : (current.missing_new_count ?? null);
  current.missing_old_count = Number.isFinite(Number(updated.missing_old_count))
    ? Number(updated.missing_old_count)
    : (current.missing_old_count ?? null);
  current.missing_upcoming_count = Number.isFinite(Number(updated.missing_upcoming_count))
    ? Number(updated.missing_upcoming_count)
    : (current.missing_upcoming_count ?? null);
  current.missing_scan_at = updated.missing_scan_at || current.missing_scan_at || null;
  current.missing_upcoming_air_dates = Array.isArray(updated.missing_upcoming_air_dates)
    ? updated.missing_upcoming_air_dates
    : (current.missing_upcoming_air_dates || []);
}

function applyActorMissingScanUpdate(updated) {
  if (!updated || !updated.actor_id) return;
  const idx = state.actors.findIndex((a) => String(a.actor_id) === String(updated.actor_id));
  if (idx < 0) return;
  const current = state.actors[idx];
  current.movies_in_plex_count = Number.isFinite(Number(updated.movies_in_plex_count))
    ? Number(updated.movies_in_plex_count)
    : (current.movies_in_plex_count ?? null);
  current.missing_movie_count = Number.isFinite(Number(updated.missing_movie_count))
    ? Number(updated.missing_movie_count)
    : (current.missing_movie_count ?? null);
  current.missing_new_count = Number.isFinite(Number(updated.missing_new_count))
    ? Number(updated.missing_new_count)
    : (current.missing_new_count ?? null);
  current.missing_upcoming_count = Number.isFinite(Number(updated.missing_upcoming_count))
    ? Number(updated.missing_upcoming_count)
    : (current.missing_upcoming_count ?? null);
  current.first_release_date = updated.first_release_date || current.first_release_date || null;
  current.next_upcoming_release_date = updated.next_upcoming_release_date || current.next_upcoming_release_date || null;
  current.missing_scan_at = updated.missing_scan_at || current.missing_scan_at || null;
}

function routeTo(view, actorId = null) {
  if (view === 'actor-detail' && actorId) {
    const role = CAST_ROLES.includes(state.castRole) ? state.castRole : '';
    const query = role ? `?role=${encodeURIComponent(role)}` : '';
    history.pushState({}, '', `/cast/${actorId}${query}`);
  } else if (view === 'show-detail' && actorId) {
    history.pushState({}, '', `/shows/${actorId}`);
  } else if (view === 'actors') {
    let target = '';
    try {
      const stored = localStorage.getItem(LAST_CAST_ROUTE_KEY) || '';
      if (stored.startsWith('/cast')) target = stored;
    } catch {}
    if (!target) {
      const role = CAST_ROLES.includes(state.castRole) ? state.castRole : '';
      const query = role ? `?role=${encodeURIComponent(role)}` : '';
      target = `/cast${query}`;
    }
    history.pushState({}, '', target);
  } else {
    history.pushState({}, '', `/${view}`);
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
  navCalendar.classList.toggle('active', view === 'calendar');
}

function setFullWidthGridMode(enabled) {
  document.body.classList.toggle('full-grid-mode', enabled);
}

function scrollToPageTop() {
  window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
}

async function handleLocation() {
  scrollToPageTop();
  cancelShowPrefetches();
  resetShowImageQueue();
  const path = window.location.pathname;
  const shouldTryBootRouteRestore = !hasCheckedBootRouteRestore && SHOULD_RESTORE_LAST_ROUTE_ON_BOOT && path === '/';
  hasCheckedBootRouteRestore = true;
  if (shouldTryBootRouteRestore) {
    const savedPath = localStorage.getItem(LAST_ROUTE_KEY);
    if (savedPath && savedPath !== '/' && savedPath.startsWith('/')) {
      history.replaceState({}, '', savedPath);
      handleLocation();
      return;
    }
  }
  if (path === '/') {
    history.replaceState({}, '', '/profile');
    handleLocation();
    return;
  }
  if (path === '/actors' || path.startsWith('/actors/')) {
    const nextPath = path.replace('/actors', '/cast');
    history.replaceState({}, '', `${nextPath}${window.location.search || ''}`);
    handleLocation();
    return;
  }
  document.body.classList.remove('calendar-view');

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
    await loadProfileData(false);
  }
  if (!state.profile?.tmdb_configured) {
    setFullWidthGridMode(false);
    setNavVisible(false);
    renderOnboardingTmdbStep();
    return;
  }

  if (path.startsWith('/cast/')) {
    persistLastRoute(path);
    persistLastCastRoute(`${path}${window.location.search || ''}`);
    setFullWidthGridMode(true);
    setNavVisible(true);
    const detailRole = getCastRoleFromQuery();
    if (detailRole) {
      state.castRole = detailRole;
      localStorage.setItem(CAST_ROLE_STORAGE_KEY, detailRole);
    }
    const actorId = path.split('/').pop();
    await renderActorDetail(actorId);
    setActiveNav('actors');
    return;
  }

  if (path === '/cast') {
    persistLastRoute(path);
    persistLastCastRoute(`${path}${window.location.search || ''}`);
    setFullWidthGridMode(true);
    setNavVisible(true);
    const roleFromQuery = getCastRoleFromQuery();
    state.castRole = roleFromQuery;
    if (roleFromQuery) localStorage.setItem(CAST_ROLE_STORAGE_KEY, roleFromQuery);
    await renderActors();
    setActiveNav('actors');
    return;
  }

  if (path.startsWith('/shows/')) {
    persistLastRoute(path);
    persistLastShowsRoute(`${path}${window.location.search || ''}`);
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
    persistLastRoute(path);
    persistLastShowsRoute(`${path}${window.location.search || ''}`);
    setFullWidthGridMode(true);
    setNavVisible(true);
    await renderShows();
    setActiveNav('shows');
    return;
  }

  if (path === '/calendar') {
    applyCalendarUrlState();
    syncCalendarUrl('replace');
    persistLastRoute(path);
    document.body.classList.add('calendar-view');
    setFullWidthGridMode(false);
    setNavVisible(true);
    renderCalendar();
    setActiveNav('calendar');
    return;
  }

  persistLastRoute('/profile');
  setFullWidthGridMode(false);
  setNavVisible(true);
  await renderProfile();
  setActiveNav('profile');
}

function renderCalendar() {
  const today = new Date();
  const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  if (!state.calendarCursor) {
    state.calendarCursor = { year: todayStart.getFullYear(), month: todayStart.getMonth() };
  }
  persistCalendarViewState();
  syncCalendarUrl('replace');
  const year = Number(state.calendarCursor.year);
  const month = Number(state.calendarCursor.month);
  const dayViewActive = state.calendarViewMode === 'day' && !!state.calendarSelectedDate;
  const movieOnly = state.calendarShowMovies && !state.calendarShowShows;
  const showOnly = !state.calendarShowMovies && state.calendarShowShows;
  const firstOfMonth = new Date(year, month, 1);
  const monthLabel = firstOfMonth.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  const mondayStartOffset = (firstOfMonth.getDay() + 6) % 7;
  const gridStart = new Date(year, month, 1 - mondayStartOffset);
  const gridEnd = new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + 41);
  const formatDateKey = (date) => {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  };
  const selectedDay = dayViewActive ? new Date(state.calendarSelectedDate) : null;
  const selectedDayKey = selectedDay ? formatDateKey(selectedDay) : null;
  const rangeStart = dayViewActive && selectedDayKey ? selectedDayKey : formatDateKey(gridStart);
  const rangeEnd = dayViewActive && selectedDayKey ? selectedDayKey : formatDateKey(gridEnd);
  const navPrevLabel = dayViewActive ? 'Previous day' : 'Previous month';
  const navNextLabel = dayViewActive ? 'Next day' : 'Next month';
  const dayCells = Array.from({ length: 42 }).map((_, index) => {
    const cellDate = new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + index);
    const dateKey = formatDateKey(cellDate);
    const isOutsideMonth = cellDate.getMonth() !== month;
    const isToday = cellDate.getTime() === todayStart.getTime();
    const isPast = cellDate.getTime() < todayStart.getTime();
    const className = [
      'calendar-day-cell',
      isOutsideMonth ? 'is-outside-month' : '',
      isToday ? 'is-today' : '',
      !isToday && isPast ? 'is-past' : '',
    ].filter(Boolean).join(' ');
    return `
      <div class="${className}" data-date="${dateKey}">
        <button class="calendar-day-number calendar-day-number-btn has-pill-tooltip" type="button" data-open-day="${dateKey}" aria-label="Open ${dateKey}" data-tooltip="View date">
          ${cellDate.getDate()}
        </button>
        <div class="calendar-day-events"></div>
      </div>
    `;
  }).join('');
  const dayViewTitle = selectedDay
    ? selectedDay.toLocaleDateString('en-US', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' })
    : '';
  app.innerHTML = `
    <section class="card calendar-layout-card">
      <div class="calendar-layout-header">
        <button id="calendar-prev-btn" class="toggle-btn has-pill-tooltip" type="button" aria-label="${navPrevLabel}" data-tooltip="${navPrevLabel}">‹</button>
        <div class="calendar-layout-center">
          <button id="calendar-today-btn" class="secondary-btn" type="button">Today</button>
          <button id="calendar-open-picker" class="calendar-month-year-btn" type="button" aria-label="Choose month and year">${monthLabel}</button>
          <button id="calendar-view-toggle" class="secondary-btn calendar-view-toggle-btn has-pill-tooltip ${dayViewActive ? 'active' : ''}" type="button" aria-label="${dayViewActive ? 'Switch to month view' : 'Switch to day view'}" title="${dayViewActive ? 'Month view' : 'Day view'}" data-tooltip="${dayViewActive ? 'Month view' : 'Day view'}">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M4 6h2v2H4V6Zm4 0h12v2H8V6Zm-4 5h2v2H4v-2Zm4 0h12v2H8v-2Zm-4 5h2v2H4v-2Zm4 0h12v2H8v-2Z"/>
            </svg>
          </button>
        </div>
        <button id="calendar-next-btn" class="toggle-btn has-pill-tooltip" type="button" aria-label="${navNextLabel}" data-tooltip="${navNextLabel}">›</button>
      </div>
      ${
        dayViewActive
          ? `
            <div class="calendar-day-view">
              <div class="calendar-day-view-title">${dayViewTitle}</div>
              <div class="calendar-day-view-columns">
                <section class="calendar-day-view-column">
                  <h3>Movies</h3>
                  <div class="calendar-day-view-list" id="calendar-day-view-list-movies"></div>
                </section>
                <section class="calendar-day-view-column">
                  <h3>Shows</h3>
                  <div class="calendar-day-view-list" id="calendar-day-view-list-shows"></div>
                </section>
              </div>
            </div>
          `
          : `
            <div class="calendar-weekdays">
              <span>Mon</span><span>Tue</span><span>Wed</span><span>Thu</span><span>Fri</span><span>Sat</span><span>Sun</span>
            </div>
            <div class="calendar-grid-preview">
              ${dayCells}
            </div>
          `
      }
      <div class="calendar-type-legend">
        <button id="calendar-toggle-movie" class="calendar-type-legend-item ${movieOnly ? 'active' : ''}" type="button" aria-pressed="${movieOnly ? 'true' : 'false'}">
          <i class="calendar-event-dot movie" aria-hidden="true"></i>Movie
        </button>
        <button id="calendar-toggle-show" class="calendar-type-legend-item ${showOnly ? 'active' : ''}" type="button" aria-pressed="${showOnly ? 'true' : 'false'}">
          <i class="calendar-event-dot show" aria-hidden="true"></i>Show
        </button>
      </div>
    </section>
  `;

  document.getElementById('calendar-toggle-movie')?.addEventListener('click', () => {
    const wasMovieOnly = state.calendarShowMovies && !state.calendarShowShows;
    if (wasMovieOnly) {
      state.calendarShowMovies = true;
      state.calendarShowShows = true;
    } else {
      state.calendarShowMovies = true;
      state.calendarShowShows = false;
    }
    localStorage.setItem('calendarShowMovies', state.calendarShowMovies ? '1' : '0');
    localStorage.setItem('calendarShowShows', state.calendarShowShows ? '1' : '0');
    persistCalendarViewState();
    syncCalendarUrl('push');
    renderCalendar();
  });
  document.getElementById('calendar-toggle-show')?.addEventListener('click', () => {
    const wasShowOnly = !state.calendarShowMovies && state.calendarShowShows;
    if (wasShowOnly) {
      state.calendarShowMovies = true;
      state.calendarShowShows = true;
    } else {
      state.calendarShowMovies = false;
      state.calendarShowShows = true;
    }
    localStorage.setItem('calendarShowMovies', state.calendarShowMovies ? '1' : '0');
    localStorage.setItem('calendarShowShows', state.calendarShowShows ? '1' : '0');
    persistCalendarViewState();
    syncCalendarUrl('push');
    renderCalendar();
  });

  document.getElementById('calendar-prev-btn')?.addEventListener('click', () => {
    if (dayViewActive && selectedDay) {
      const next = new Date(selectedDay.getFullYear(), selectedDay.getMonth(), selectedDay.getDate() - 1);
      state.calendarSelectedDate = formatDateKey(next);
      state.calendarCursor = { year: next.getFullYear(), month: next.getMonth() };
    } else {
      const next = new Date(year, month - 1, 1);
      state.calendarCursor = { year: next.getFullYear(), month: next.getMonth() };
    }
    persistCalendarViewState();
    syncCalendarUrl('push');
    renderCalendar();
  });
  document.getElementById('calendar-next-btn')?.addEventListener('click', () => {
    if (dayViewActive && selectedDay) {
      const next = new Date(selectedDay.getFullYear(), selectedDay.getMonth(), selectedDay.getDate() + 1);
      state.calendarSelectedDate = formatDateKey(next);
      state.calendarCursor = { year: next.getFullYear(), month: next.getMonth() };
    } else {
      const next = new Date(year, month + 1, 1);
      state.calendarCursor = { year: next.getFullYear(), month: next.getMonth() };
    }
    persistCalendarViewState();
    syncCalendarUrl('push');
    renderCalendar();
  });
  document.getElementById('calendar-today-btn')?.addEventListener('click', () => {
    state.calendarCursor = { year: todayStart.getFullYear(), month: todayStart.getMonth() };
    if (dayViewActive) {
      state.calendarSelectedDate = formatDateKey(todayStart);
    }
    persistCalendarViewState();
    syncCalendarUrl('push');
    renderCalendar();
  });
  document.getElementById('calendar-open-picker')?.addEventListener('click', () => {
    openCalendarMonthYearPicker(year, month, (pickedYear, pickedMonth) => {
      state.calendarCursor = { year: pickedYear, month: pickedMonth };
      state.calendarViewMode = 'month';
      state.calendarSelectedDate = null;
      persistCalendarViewState();
      syncCalendarUrl('push');
      renderCalendar();
    });
  });
  document.getElementById('calendar-view-toggle')?.addEventListener('click', () => {
    if (dayViewActive) {
      state.calendarViewMode = 'month';
      state.calendarSelectedDate = null;
      state.calendarCursor = { year: todayStart.getFullYear(), month: todayStart.getMonth() };
    } else {
      state.calendarViewMode = 'day';
      state.calendarSelectedDate = formatDateKey(todayStart);
      state.calendarCursor = { year: todayStart.getFullYear(), month: todayStart.getMonth() };
    }
    persistCalendarViewState();
    syncCalendarUrl('push');
    renderCalendar();
  });
  app.querySelectorAll('[data-open-day]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const dateKey = btn.getAttribute('data-open-day');
      if (!dateKey) return;
      state.calendarViewMode = 'day';
      state.calendarSelectedDate = dateKey;
      const selected = new Date(dateKey);
      if (!Number.isNaN(selected.getTime())) {
        state.calendarCursor = { year: selected.getFullYear(), month: selected.getMonth() };
      }
      persistCalendarViewState();
      syncCalendarUrl('push');
      renderCalendar();
    });
  });

  const renderToken = ++state.calendarRenderToken;
  const calendarGridEl = app.querySelector('.calendar-grid-preview');
  if (calendarGridEl) calendarGridEl.classList.add('is-loading');
  api(`/api/calendar/events?start=${rangeStart}&end=${rangeEnd}`)
    .then((payload) => {
      if (renderToken !== state.calendarRenderToken) return;
      const items = (Array.isArray(payload?.items) ? payload.items : []).filter((item) => {
        const type = item?.type === 'show' ? 'show' : 'movie';
        if (type === 'movie') return state.calendarShowMovies;
        return state.calendarShowShows;
      });
      const byDate = new Map();
      for (const item of items) {
        const dateKey = String(item?.date || '').trim();
        if (!dateKey) continue;
        if (!byDate.has(dateKey)) byDate.set(dateKey, []);
        byDate.get(dateKey).push(item);
      }
      const renderMonthEventsHtml = (events) => events.map((event) => {
          const type = event?.type === 'show' ? 'show' : 'movie';
          const title = String(event?.title || '').trim();
          const posterUrl = withImageCacheKey(String(event?.poster_url || '').trim());
          const dateText = formatDateDdMmYyyy(String(event?.date || ''));
          return `
            <div
              class="calendar-event-line"
              data-title="${escapeHtml(title)}"
              data-date="${escapeHtml(dateText)}"
              data-poster="${escapeHtml(posterUrl || '')}"
            >
              <span class="calendar-event-dot ${type}" aria-hidden="true"></span>
              <span class="calendar-event-text">${escapeHtml(title)}</span>
            </div>
          `;
        }).join('');
      const renderDayEventsHtml = (events) => events.map((event) => {
          const type = event?.type === 'show' ? 'show' : 'movie';
          const rawTitle = String(event?.title || '').trim() || 'Untitled';
          const posterUrl = withImageCacheKey(String(event?.poster_url || '').trim());
          const eventDateKey = String(event?.date || '').trim();
          const dateText = formatDateDdMmYyyy(eventDateKey);
          const fallbackPoster = type === 'show' ? SHOW_PLACEHOLDER : MOVIE_PLACEHOLDER;
          const today = new Date();
          const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
          const showDownload = eventDateKey && eventDateKey <= todayKey;
          let displayTitle = rawTitle;
          let showMeta = '';
          let downloadUrl = '';
          if (type === 'show') {
            const match = rawTitle.match(/^(.*?)\s+S(\d+)E(\d+)\s+-\s+.*$/i);
            if (match) {
              const showName = (match[1] || '').trim();
              const seasonNo = String(match[2] || '').padStart(2, '0');
              const episodeNo = String(match[3] || '').padStart(2, '0');
              displayTitle = showName || rawTitle;
              showMeta = `Season ${seasonNo} · Episode ${episodeNo}`;
              if (showDownload) {
                downloadUrl = buildDownloadLink(
                  'episode',
                  buildEpisodeKeyword(displayTitle, Number(seasonNo), Number(episodeNo)),
                );
              }
            }
          } else if (showDownload) {
            downloadUrl = buildDownloadLink('movie', rawTitle);
          }
          const downloadBadge = showDownload
            ? (
              downloadUrl
                ? `<a class="badge-link badge-download calendar-day-download-btn" href="${downloadUrl}" target="_blank" rel="noopener noreferrer">Download <span class="badge-icon badge-icon-download">&#8595;</span></a>`
                : '<span class="badge-link badge-download badge-disabled calendar-day-download-btn">Download <span class="badge-icon badge-icon-download">&#8595;</span></span>'
            )
            : '';
          return `
            <div class="calendar-day-event-item">
              <span class="calendar-day-event-type-dot ${type}" aria-hidden="true"></span>
              <img class="calendar-day-event-poster" src="${posterUrl || fallbackPoster}" alt="${escapeHtml(displayTitle)}" loading="lazy" />
              <div class="calendar-day-event-body">
                <div class="calendar-day-event-title">${escapeHtml(displayTitle)}</div>
                ${showMeta ? `<div class="calendar-day-event-meta">${escapeHtml(showMeta)}</div>` : ''}
                <div class="calendar-day-event-date">${escapeHtml(dateText)}</div>
                ${downloadBadge}
              </div>
            </div>
          `;
        }).join('');

      if (dayViewActive && selectedDayKey) {
        const dayEvents = byDate.get(selectedDayKey) || [];
        const dayMovies = dayEvents.filter((event) => (event?.type === 'show' ? 'show' : 'movie') === 'movie');
        const dayShows = dayEvents.filter((event) => (event?.type === 'show' ? 'show' : 'movie') === 'show');
        const dayMoviesList = document.getElementById('calendar-day-view-list-movies');
        const dayShowsList = document.getElementById('calendar-day-view-list-shows');
        if (dayMoviesList) {
          dayMoviesList.innerHTML = dayMovies.length
            ? renderDayEventsHtml(dayMovies)
            : '<div class="empty">No movie events.</div>';
        }
        if (dayShowsList) {
          dayShowsList.innerHTML = dayShows.length
            ? renderDayEventsHtml(dayShows)
            : '<div class="empty">No show events.</div>';
        }
      } else {
        app.querySelectorAll('.calendar-day-cell').forEach((cell) => {
          const dateKey = cell.getAttribute('data-date');
          const container = cell.querySelector('.calendar-day-events');
          if (!container || !dateKey) return;
          const events = byDate.get(dateKey) || [];
          container.innerHTML = renderMonthEventsHtml(events);
        });
      }
      const existingHoverCard = document.getElementById('calendar-event-hover-card');
      if (existingHoverCard) existingHoverCard.remove();
      if (dayViewActive) return;
      const hoverCard = document.createElement('div');
      hoverCard.id = 'calendar-event-hover-card';
      hoverCard.className = 'calendar-event-hover-card hidden';
      document.body.appendChild(hoverCard);
      const placeHoverCard = (clientX, clientY) => {
        const gap = 12;
        const rect = hoverCard.getBoundingClientRect();
        let left = clientX + gap;
        let top = clientY + gap;
        if (left + rect.width > window.innerWidth - 8) left = clientX - rect.width - gap;
        if (top + rect.height > window.innerHeight - 8) top = clientY - rect.height - gap;
        left = Math.max(8, left);
        top = Math.max(8, top);
        hoverCard.style.left = `${left}px`;
        hoverCard.style.top = `${top}px`;
      };
      app.querySelectorAll('.calendar-event-line').forEach((line) => {
        line.addEventListener('mouseenter', (event) => {
          const rawTitle = line.getAttribute('data-title') || '';
          const dateText = line.getAttribute('data-date') || '';
          const poster = line.getAttribute('data-poster') || '';
          const isShow = !!line.querySelector('.calendar-event-dot.show');
          const fallbackPoster = isShow ? SHOW_PLACEHOLDER : MOVIE_PLACEHOLDER;
          let displayTitle = rawTitle;
          let displayMeta = '';
          if (isShow) {
            const match = rawTitle.match(/^(.*?)\s+S(\d+)E(\d+)\s+-\s+.*$/i);
            if (match) {
              const showName = (match[1] || '').trim();
              const seasonNo = String(match[2] || '').padStart(2, '0');
              const episodeNo = String(match[3] || '').padStart(2, '0');
              displayTitle = showName || rawTitle;
              displayMeta = `Season ${seasonNo} · Episode ${episodeNo}`;
            }
          }
          hoverCard.innerHTML = `
            <img class="calendar-event-hover-poster" src="${poster || fallbackPoster}" alt="${displayTitle}" />
            <div class="calendar-event-hover-text">
              <div class="calendar-event-hover-title">${displayTitle}</div>
              ${displayMeta ? `<div class="calendar-event-hover-meta">${displayMeta}</div>` : ''}
              <div class="calendar-event-hover-date">${dateText}</div>
            </div>
          `;
          hoverCard.classList.remove('hidden');
          placeHoverCard(event.clientX, event.clientY);
        });
        line.addEventListener('mousemove', (event) => {
          if (hoverCard.classList.contains('hidden')) return;
          placeHoverCard(event.clientX, event.clientY);
        });
        line.addEventListener('mouseleave', () => {
          hoverCard.classList.add('hidden');
        });
      });
    })
    .catch(() => {
      // Keep calendar layout visible even if event loading fails.
    })
    .finally(() => {
      if (renderToken !== state.calendarRenderToken) return;
      const currentGrid = app.querySelector('.calendar-grid-preview');
      if (currentGrid) currentGrid.classList.remove('is-loading');
    });
}

function openCalendarMonthYearPicker(initialYear, initialMonth, onSelect) {
  document.getElementById('calendar-picker-modal')?.remove();
  const monthNames = Array.from({ length: 12 }).map((_, index) =>
    new Date(2000, index, 1).toLocaleDateString('en-US', { month: 'long' }),
  );
  const modal = document.createElement('div');
  modal.id = 'calendar-picker-modal';
  modal.className = 'calendar-picker-modal';
  modal.innerHTML = `
    <div class="calendar-picker-card" role="dialog" aria-modal="true" aria-label="Choose month and year">
      <div class="calendar-picker-header">
        <button id="calendar-picker-back" class="toggle-btn hidden" type="button" aria-label="Back to years">‹</button>
        <h3 id="calendar-picker-title">Choose month</h3>
        <button id="calendar-picker-close" class="toggle-btn" type="button" aria-label="Close">×</button>
      </div>
      <div id="calendar-picker-body" class="calendar-picker-body"></div>
      <div class="calendar-picker-footer">
        <button id="calendar-picker-cancel" class="secondary-btn" type="button">Cancel</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  let selectedYear = Number(initialYear);
  let selectedMonth = Number(initialMonth);
  let mode = 'months';

  const close = () => {
    modal.remove();
  };

  const render = () => {
    const titleEl = modal.querySelector('#calendar-picker-title');
    const backBtn = modal.querySelector('#calendar-picker-back');
    const bodyEl = modal.querySelector('#calendar-picker-body');
    if (!titleEl || !backBtn || !bodyEl) return;

    if (mode === 'years') {
      titleEl.textContent = 'Choose year';
      backBtn.classList.add('hidden');
      const nowYear = new Date().getFullYear();
      const maxYear = nowYear + 1;
      const minYear = nowYear - 1;
      const years = Array.from({ length: (maxYear - minYear) + 1 }).map((_, index) => maxYear - index);
      bodyEl.innerHTML = years
        .map((year) => `<button class="calendar-picker-option ${year === selectedYear ? 'active' : ''}" data-year="${year}" type="button">${year}</button>`)
        .join('');
      bodyEl.querySelectorAll('[data-year]').forEach((button) => {
        button.addEventListener('click', () => {
          selectedYear = Number(button.getAttribute('data-year'));
          mode = 'months';
          render();
        });
      });
      return;
    }

    titleEl.textContent = `${selectedYear}`;
    backBtn.classList.remove('hidden');
    bodyEl.innerHTML = monthNames
      .map((label, monthIndex) => `<button class="calendar-picker-option ${monthIndex === selectedMonth ? 'active' : ''}" data-month="${monthIndex}" type="button">${label}</button>`)
      .join('');
    bodyEl.querySelectorAll('[data-month]').forEach((button) => {
      button.addEventListener('click', () => {
        selectedMonth = Number(button.getAttribute('data-month'));
        if (onSelect) onSelect(selectedYear, selectedMonth);
        close();
      });
    });
  };

  modal.querySelector('#calendar-picker-close')?.addEventListener('click', close);
  modal.querySelector('#calendar-picker-cancel')?.addEventListener('click', close);
  modal.querySelector('#calendar-picker-back')?.addEventListener('click', () => {
    mode = 'years';
    render();
  });
  modal.addEventListener('click', (event) => {
    if (event.target === modal) close();
  });

  render();
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
    history.pushState({}, '', '/profile');
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
      history.pushState({}, '', '/profile');
      await handleLocation();
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  throw new Error('Login timed out. Try again.');
}

async function renderProfile(enableBackgroundRefresh = true) {
  let data;
  try {
    data = await loadProfileData(false);
  } catch (error) {
    app.innerHTML = `<div class="empty">Failed to load profile: ${error.message}</div>`;
    return;
  }
  state.profile = data;
  const downloadPrefix = getDownloadPrefixSettings();
  const actorExampleText = buildDownloadExampleText('actor', downloadPrefix);
  const movieExampleText = buildDownloadExampleText('movie', downloadPrefix);
  const showExampleText = buildDownloadExampleText('show', downloadPrefix);
  const seasonExampleText = buildDownloadExampleText('season', downloadPrefix);
  const episodeExampleText = buildDownloadExampleText('episode', downloadPrefix);

  app.innerHTML = `
    <section class="profile">
      <div class="profile-header card">
        <div class="profile-header-actions">
          <div id="profile-save-status" class="meta no-margin"></div>
          <button id="reset-btn" class="secondary-btn profile-reset-btn">Reset</button>
          <button id="profile-save-btn" class="primary-btn profile-save-btn">Save</button>
        </div>
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
          </div>
          <div class="row settings-row">
            <span class="meta no-margin settings-label settings-label-strong">TMDb key:</span>
            <input id="tmdb-key-input" type="text" name="tmdb_api_key_input" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" data-lpignore="true" data-form-type="other" class="secondary-btn tmdb-key-input" placeholder="Set TMDb API Key in app" />
          </div>
        </div>
      </div>

      <div class="card download-prefix-card">
        <div class="download-prefix-head">
          <h3>Download Prefix</h3>
          <div class="download-prefix-actions">
            <div id="prefix-save-status" class="meta no-margin"></div>
            <button id="prefix-reset-btn" class="secondary-btn" type="button">Reset</button>
            <button id="prefix-save-btn" class="primary-btn" type="button">Save</button>
          </div>
        </div>
        <div class="prefix-section">
          <div class="meta no-margin prefix-section-label settings-label-strong">Cast:</div>
          <div id="actor-prefix-example" class="meta no-margin prefix-example ${actorExampleText ? '' : 'hidden'}">${actorExampleText}</div>
          <div class="row prefix-section-controls">
            <input id="actor-prefix-start" type="text" class="secondary-btn prefix-input" placeholder="Start prefix" value="${downloadPrefix.actor_start}" />
            <select id="actor-prefix-format" class="secondary-btn prefix-format-select" aria-label="Actor keyword format">
              <option value="encoded_space" ${downloadPrefix.actor_mode === 'encoded_space' ? 'selected' : ''}>Bruce%20Willis</option>
              <option value="hyphen" ${downloadPrefix.actor_mode === 'hyphen' ? 'selected' : ''}>Bruce-Willis</option>
              <option value="plus" ${downloadPrefix.actor_mode === 'plus' ? 'selected' : ''}>Bruce+Willis</option>
            </select>
            <input id="actor-prefix-end" type="text" class="secondary-btn prefix-input" placeholder="End prefix" value="${downloadPrefix.actor_end}" />
          </div>
        </div>

        <div class="prefix-section">
          <div class="meta no-margin prefix-section-label settings-label-strong">Movies:</div>
          <div id="movie-prefix-example" class="meta no-margin prefix-example ${movieExampleText ? '' : 'hidden'}">${movieExampleText}</div>
          <div class="row prefix-section-controls">
            <input id="movie-prefix-start" type="text" class="secondary-btn prefix-input" placeholder="Start prefix" value="${downloadPrefix.movie_start}" />
            <select id="movie-prefix-format" class="secondary-btn prefix-format-select" aria-label="Movie keyword format">
              <option value="encoded_space" ${downloadPrefix.movie_mode === 'encoded_space' ? 'selected' : ''}>A%20Day%20to%20Die</option>
              <option value="hyphen" ${downloadPrefix.movie_mode === 'hyphen' ? 'selected' : ''}>A-Day-to-Die</option>
              <option value="plus" ${downloadPrefix.movie_mode === 'plus' ? 'selected' : ''}>A+Day+to+Die</option>
            </select>
            <input id="movie-prefix-end" type="text" class="secondary-btn prefix-input" placeholder="End prefix" value="${downloadPrefix.movie_end}" />
          </div>
        </div>

        <div class="prefix-section">
          <div class="meta no-margin prefix-section-label settings-label-strong">Shows:</div>
          <div id="show-prefix-example" class="meta no-margin prefix-example ${showExampleText ? '' : 'hidden'}">${showExampleText}</div>
          <div class="row prefix-section-controls">
            <input id="show-prefix-start" type="text" class="secondary-btn prefix-input" placeholder="Start prefix" value="${downloadPrefix.show_start}" />
            <select id="show-prefix-format" class="secondary-btn prefix-format-select" aria-label="Show keyword format">
              <option value="encoded_space" ${downloadPrefix.show_mode === 'encoded_space' ? 'selected' : ''}>Breaking%20Bad</option>
              <option value="hyphen" ${downloadPrefix.show_mode === 'hyphen' ? 'selected' : ''}>Breaking-Bad</option>
              <option value="plus" ${downloadPrefix.show_mode === 'plus' ? 'selected' : ''}>Breaking+Bad</option>
            </select>
            <input id="show-prefix-end" type="text" class="secondary-btn prefix-input" placeholder="End prefix" value="${downloadPrefix.show_end}" />
          </div>
        </div>

        <div class="prefix-section">
          <div class="meta no-margin prefix-section-label settings-label-strong">Seasons:</div>
          <div id="season-prefix-example" class="meta no-margin prefix-example ${seasonExampleText ? '' : 'hidden'}">${seasonExampleText}</div>
          <div class="row prefix-section-controls">
            <input id="season-prefix-start" type="text" class="secondary-btn prefix-input" placeholder="Start prefix" value="${downloadPrefix.season_start}" />
            <select id="season-prefix-format" class="secondary-btn prefix-format-select" aria-label="Season keyword format">
              <option value="encoded_space" ${downloadPrefix.season_mode === 'encoded_space' ? 'selected' : ''}>Breaking%20Bad%20s01</option>
              <option value="hyphen" ${downloadPrefix.season_mode === 'hyphen' ? 'selected' : ''}>Breaking-Bad-s01</option>
              <option value="plus" ${downloadPrefix.season_mode === 'plus' ? 'selected' : ''}>Breaking+Bad+s01</option>
            </select>
            <input id="season-prefix-end" type="text" class="secondary-btn prefix-input" placeholder="End prefix" value="${downloadPrefix.season_end}" />
          </div>
        </div>

        <div class="prefix-section">
          <div class="meta no-margin prefix-section-label settings-label-strong">Episodes:</div>
          <div id="episode-prefix-example" class="meta no-margin prefix-example ${episodeExampleText ? '' : 'hidden'}">${episodeExampleText}</div>
          <div class="row prefix-section-controls">
            <input id="episode-prefix-start" type="text" class="secondary-btn prefix-input" placeholder="Start prefix" value="${downloadPrefix.episode_start}" />
            <select id="episode-prefix-format" class="secondary-btn prefix-format-select" aria-label="Episode keyword format">
              <option value="encoded_space" ${downloadPrefix.episode_mode === 'encoded_space' ? 'selected' : ''}>Breaking%20Bad%20s01e01</option>
              <option value="hyphen" ${downloadPrefix.episode_mode === 'hyphen' ? 'selected' : ''}>Breaking-Bad-s01e01</option>
              <option value="plus" ${downloadPrefix.episode_mode === 'plus' ? 'selected' : ''}>Breaking+Bad+s01e01</option>
            </select>
            <input id="episode-prefix-end" type="text" class="secondary-btn prefix-input" placeholder="End prefix" value="${downloadPrefix.episode_end}" />
          </div>
        </div>
      </div>

      <div class="card library-sync-card">
        <div class="library-sync-head">
          <h3>Plex Library Scan</h3>
          <div class="row library-sync-actions">
            <button id="scan-reset-btn" class="secondary-btn">Reset</button>
            <button id="scan-btn" class="primary-btn btn-with-icon">${scanIconTag()}<span>Scan Cast</span></button>
            <button id="scan-shows-btn" class="primary-btn btn-with-icon">${scanIconTag()}<span>Scan Shows</span></button>
          </div>
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
  document.getElementById('scan-reset-btn').addEventListener('click', resetScansOnly);
  document.getElementById('reset-btn').addEventListener('click', resetApp);
  document.getElementById('profile-save-btn').addEventListener('click', saveProfileSettings);
  const tmdbInput = document.getElementById('tmdb-key-input');
  if (tmdbInput && data.tmdb_api_key) {
    tmdbInput.value = data.tmdb_api_key;
  }
  document.getElementById('prefix-save-btn').addEventListener('click', saveAllPrefixes);
  document.getElementById('prefix-reset-btn').addEventListener('click', resetAllPrefixes);
  renderScanLogs(data.scan_logs || [], data.show_scan_logs || []);
  if (enableBackgroundRefresh) {
    refreshProfileInBackground();
  }
}

async function loadProfileData(forceRefresh = false) {
  if (!forceRefresh && state.profileLoaded && state.profile) {
    return state.profile;
  }
  if (!forceRefresh && !state.profileLoaded) {
    const cached = readPersistentCache(CACHE_KEYS.profile, CACHE_TTL_MS.profile);
    if (cached) {
      state.profile = cached;
      state.profileLoaded = true;
      return cached;
    }
  }
  const data = await api('/api/profile');
  state.profile = data;
  state.profileLoaded = true;
  writePersistentCache(CACHE_KEYS.profile, data);
  return data;
}

async function refreshProfileInBackground() {
  if (state.profileRefreshInFlight) return;
  if (Date.now() - state.profileLastRefreshAt < 60000) return;
  state.profileRefreshInFlight = true;
  try {
    const data = await loadProfileData(true);
    state.profile = data;
    state.profileLastRefreshAt = Date.now();
    if (window.location.pathname === '/') {
      renderProfile(false);
    }
  } catch {
    // Silent background refresh failure.
  } finally {
    state.profileRefreshInFlight = false;
  }
}

async function selectServer(clientIdentifier) {
  const status = document.getElementById('server-select-status');
  status.textContent = 'Switching...';
  try {
    await saveServerSelection(clientIdentifier, true);
    status.textContent = 'Saved';
    state.profileLoaded = false;
    state.actorsLoaded = false;
    state.actorsLoadedRole = '';
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
    clearPrimaryDataCaches();
    return true;
  } catch (error) {
    if (throwOnError) {
      throw error;
    }
    return false;
  }
}

async function resetScansOnly() {
  if (!window.confirm('Reset all scan data only?')) {
    return;
  }
  const scanStatus = document.getElementById('scan-status');
  if (scanStatus) scanStatus.textContent = 'Resetting...';
  try {
    const result = await api('/api/scan/reset', { method: 'POST' });
    clearPrimaryDataCaches();
    state.actors = [];
    state.shows = [];
    state.actorsLoaded = false;
    state.actorsLoadedRole = '';
    state.showsLoaded = false;
    state.showSeasonsCache = {};
    state.showEpisodesCache = {};
    if (state.profile) {
      state.profile = {
        ...state.profile,
        scan_logs: result.scan_logs || [],
        show_scan_logs: result.show_scan_logs || [],
      };
    }
    renderScanLogs(result.scan_logs || [], result.show_scan_logs || []);
    if (scanStatus) scanStatus.textContent = 'Reset';
  } catch (error) {
    if (scanStatus) scanStatus.textContent = error.message;
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
      return `<li class="scan-log-item">${dateText} - ${entry.actors} cast, ${entry.movies} movies</li>`;
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

async function saveProfileSettings() {
  const status = document.getElementById('profile-save-status');
  const saveBtn = document.getElementById('profile-save-btn');
  const serverSelect = document.getElementById('server-select');
  const tmdbInput = document.getElementById('tmdb-key-input');
  if (status) status.textContent = 'Saving...';
  if (saveBtn) saveBtn.disabled = true;
  try {
    const selectedServer = serverSelect?.value?.trim();
    if (selectedServer) {
      await saveServerSelection(selectedServer, true);
    }
    const key = tmdbInput?.value?.trim() || '';
    if (key) {
      await api('/api/tmdb/key', {
        method: 'POST',
        body: JSON.stringify({ api_key: key }),
      });
    }
    clearPrimaryDataCaches();
    state.profileLoaded = false;
    state.actorsLoaded = false;
    state.actorsLoadedRole = '';
    state.showsLoaded = false;
    await renderProfile();
    const refreshedStatus = document.getElementById('profile-save-status');
    if (refreshedStatus) refreshedStatus.textContent = 'Saved';
  } catch (error) {
    if (status) status.textContent = error.message;
  } finally {
    if (saveBtn) saveBtn.disabled = false;
  }
}

function getPrefixPayloadFromInputs() {
  return {
    actor_start: document.getElementById('actor-prefix-start')?.value?.trim() || '',
    actor_mode: document.getElementById('actor-prefix-format')?.value || 'encoded_space',
    actor_end: document.getElementById('actor-prefix-end')?.value?.trim() || '',
    movie_start: document.getElementById('movie-prefix-start')?.value?.trim() || '',
    movie_mode: document.getElementById('movie-prefix-format')?.value || 'encoded_space',
    movie_end: document.getElementById('movie-prefix-end')?.value?.trim() || '',
    show_start: document.getElementById('show-prefix-start')?.value?.trim() || '',
    show_mode: document.getElementById('show-prefix-format')?.value || 'encoded_space',
    show_end: document.getElementById('show-prefix-end')?.value?.trim() || '',
    season_start: document.getElementById('season-prefix-start')?.value?.trim() || '',
    season_mode: document.getElementById('season-prefix-format')?.value || 'encoded_space',
    season_end: document.getElementById('season-prefix-end')?.value?.trim() || '',
    episode_start: document.getElementById('episode-prefix-start')?.value?.trim() || '',
    episode_mode: document.getElementById('episode-prefix-format')?.value || 'encoded_space',
    episode_end: document.getElementById('episode-prefix-end')?.value?.trim() || '',
  };
}

async function saveAllPrefixes() {
  const status = document.getElementById('prefix-save-status');
  const saveBtn = document.getElementById('prefix-save-btn');
  if (status) status.textContent = 'Saving...';
  if (saveBtn) saveBtn.disabled = true;
  try {
    const result = await api('/api/download-prefix', {
      method: 'POST',
      body: JSON.stringify(getPrefixPayloadFromInputs()),
    });
    state.profile = { ...state.profile, download_prefix: result.download_prefix };
    writePersistentCache(CACHE_KEYS.profile, state.profile);
    await renderProfile();
    const refreshedStatus = document.getElementById('prefix-save-status');
    if (refreshedStatus) refreshedStatus.textContent = 'Saved';
  } catch (error) {
    if (status) status.textContent = error.message;
  } finally {
    if (saveBtn) saveBtn.disabled = false;
  }
}

async function resetAllPrefixes() {
  if (!window.confirm('Reset all Download Prefix fields?')) {
    return;
  }
  const status = document.getElementById('prefix-save-status');
  const resetBtn = document.getElementById('prefix-reset-btn');
  if (status) status.textContent = 'Resetting...';
  if (resetBtn) resetBtn.disabled = true;
  try {
    const result = await api('/api/download-prefix', {
      method: 'POST',
      body: JSON.stringify(DEFAULT_DOWNLOAD_PREFIX),
    });
    state.profile = { ...state.profile, download_prefix: result.download_prefix };
    writePersistentCache(CACHE_KEYS.profile, state.profile);
    await renderProfile();
    const refreshedStatus = document.getElementById('prefix-save-status');
    if (refreshedStatus) refreshedStatus.textContent = 'Reset';
  } catch (error) {
    if (status) status.textContent = error.message;
  } finally {
    if (resetBtn) resetBtn.disabled = false;
  }
}

function showScanSuccessModal(message = 'Scan complete', showConfirm = false) {
  const iconWrap = document.getElementById('scan-icon-wrap');
  const msg = document.getElementById('scan-modal-msg');
  const okBtn = document.getElementById('scan-modal-ok');
  if (!iconWrap) return;
  iconWrap.innerHTML = '<div class="scan-check">&#10003;</div>';
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

function chooseShowMissingScanMode(scopedCount, allCount, unscannedCount = 0) {
  return new Promise((resolve) => {
    const modal = document.createElement('div');
    modal.className = 'scan-modal';
    modal.id = 'scan-choice-modal';
    modal.innerHTML = `
      <div class="scan-modal-card card">
        <div class="scan-modal-msg">Choose scan scope</div>
        <div class="row" style="justify-content:center; gap: 10px; margin-top: 14px; flex-direction: column; align-items: center;">
          <button id="scan-choice-scoped" class="primary-btn" type="button" style="min-width: 170px;">Scan (${scopedCount})</button>
          ${unscannedCount > 0 ? `<button id="scan-choice-unscanned" class="secondary-btn" type="button" style="min-width: 170px;">Unscanned (${unscannedCount})</button>` : ''}
          <button id="scan-choice-all" class="secondary-btn" type="button" style="min-width: 170px;">All (${allCount})</button>
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
    document.getElementById('scan-choice-unscanned')?.addEventListener('click', () => close('unscanned'));
    document.getElementById('scan-choice-cancel')?.addEventListener('click', () => close(null));
  });
}

async function runScanWorkers({
  ids,
  label,
  workerFn,
  onUpdate,
  concurrency = SCAN_WORKERS_CONCURRENCY,
}) {
  const total = ids.length;
  let cursor = 0;
  let completed = 0;
  let fatalError = null;

  const safeConcurrency = Math.max(1, Math.min(Number(concurrency) || 1, total || 1));

  const updateProgress = () => {
    const msg = document.getElementById('scan-modal-msg');
    if (msg) msg.textContent = `Scanned ${completed}/${total} ${label}`;
  };

  updateProgress();

  const worker = async () => {
    while (true) {
      if (fatalError) return;
      const idx = cursor;
      if (idx >= total) return;
      cursor += 1;
      const id = ids[idx];
      try {
        const result = await workerFn(id);
        if (typeof onUpdate === 'function') onUpdate(result, id);
      } catch (error) {
        fatalError = error;
        return;
      } finally {
        completed += 1;
        updateProgress();
      }
    }
  };

  await Promise.all(Array.from({ length: safeConcurrency }, () => worker()));
  if (fatalError) throw fatalError;
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
  iconWrap.innerHTML = '<div class="scan-check">&#10003;</div>';
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
  const scanText = 'Scanning...';
  showScanModal(scanText);

  try {
    const result = await api('/api/scan/actors', { method: 'POST' });
    clearPrimaryDataCaches();
    invalidateImageCache();
    state.actorsLoaded = false;
    state.actorsLoadedRole = '';
    const showLogs = state.profile?.show_scan_logs || [];
    renderScanLogs(result.scan_logs || [], showLogs);
    showScanSuccessModal('Scan complete', true);
  } catch (error) {
    closeScanModal();
  }
}

function chooseCreateCollectionMode(inPlexCount) {
  return new Promise((resolve) => {
    const modal = document.createElement('div');
    modal.className = 'scan-modal';
    modal.id = 'create-collection-choice-modal';
    modal.innerHTML = `
      <div class="scan-modal-card card">
        <div class="scan-modal-msg">Choose collection type</div>
        <div class="row" style="justify-content:center; gap: 10px; margin-top: 14px; flex-direction: column; align-items: center;">
          <button id="collection-choice-regular" class="primary-btn" type="button" style="min-width: 170px;">In Plex (${inPlexCount})</button>
          <button id="collection-choice-smart" class="secondary-btn" type="button" style="min-width: 170px;">Smart Collection</button>
          <button id="collection-choice-cancel" class="toggle-btn" type="button" style="margin-top: 14px; min-width: 170px;">Cancel</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
    const close = (choice) => {
      modal.remove();
      resolve(choice);
    };
    document.getElementById('collection-choice-regular')?.addEventListener('click', () => close('regular'));
    document.getElementById('collection-choice-smart')?.addEventListener('click', () => close('smart'));
    document.getElementById('collection-choice-cancel')?.addEventListener('click', () => close(null));
  });
}

async function runShowScan() {
  const scanText = 'Scanning...';
  showScanModal(scanText);

  try {
    const result = await api('/api/scan/shows', { method: 'POST' });
    clearPrimaryDataCaches();
    invalidateImageCache();
    state.showsLoaded = false;
    state.showSeasonsCache = {};
    state.showEpisodesCache = {};
    showScanSuccessModal('Scan complete', true);
    state.profile = { ...state.profile, show_scan_logs: result.show_scan_logs || [] };
    const actorLogs = state.profile?.scan_logs || [];
    renderScanLogs(actorLogs, result.show_scan_logs || []);
  } catch (error) {
    closeScanModal();
  }
}

async function resetApp() {
  if (!window.confirm('Reset all app data? This will clear everything.')) {
    return;
  }
  await api('/api/reset', { method: 'POST' });
  clearPrimaryDataCaches();
  for (const key of LOCAL_STORAGE_RESET_KEYS) {
    localStorage.removeItem(key);
  }
  state.session = { authenticated: false };
  state.actors = [];
  state.shows = [];
  state.profile = null;
  state.currentView = 'profile';
  state.actorsLoaded = false;
  state.actorsLoadedRole = '';
  state.showsLoaded = false;
  state.showSeasonsCache = {};
  state.showEpisodesCache = {};
  state.profileLoaded = false;
  state.actorsSearchOpen = false;
  state.actorsSearchQuery = '';
  state.showsSearchOpen = false;
  state.showsSearchQuery = '';
  state.moviesSearchOpen = false;
  state.moviesSearchQuery = '';
  state.moviesInitialFilter = 'All';
  state.actorsSortBy = 'name';
  state.actorsSortDir = 'asc';
  state.actorsMissingOnly = false;
  state.actorsInPlexOnly = false;
  state.actorsNewOnly = false;
  state.actorsUpcomingOnly = false;
  state.showsSortBy = 'name';
  state.showsSortDir = 'asc';
  state.showsSeasonsSortDir = 'asc';
  state.showsEpisodesSortDir = 'asc';
  state.showsMissingOnly = false;
  state.showsInPlexOnly = false;
  state.showsNewOnly = false;
  state.showsUpcomingOnly = false;
  state.showsInitialFilter = 'All';
  state.showsVisibleCount = ACTORS_BATCH_SIZE;
  state.actorsInitialFilter = 'All';
  state.actorsVisibleCount = ACTORS_BATCH_SIZE;
  state.imageCacheKey = '1';
  state.createCollectionBusy = false;
  if (state.actorsImageObserver) {
    state.actorsImageObserver.disconnect();
    state.actorsImageObserver = null;
  }
  if (state.showsImageObserver) {
    state.showsImageObserver.disconnect();
    state.showsImageObserver = null;
  }
  history.pushState({}, '', '/profile');
  renderOnboarding();
}

async function loadActorsData(forceRefresh = false, role = 'actor') {
  const castRole = CAST_ROLES.includes(role) ? role : 'actor';
  const cacheKey = getActorsCacheKey(castRole);
  if (!forceRefresh && state.actorsLoaded && state.actorsLoadedRole === castRole && Array.isArray(state.actors)) {
    return { items: state.actors };
  }
  if (!forceRefresh && !state.actorsLoaded) {
    const cached = readPersistentCache(cacheKey, CACHE_TTL_MS.actors);
    if (cached && Array.isArray(cached.items)) {
      state.actors = cached.items;
      state.actorsLoaded = true;
      state.actorsLoadedRole = castRole;
      return cached;
    }
  }
  const data = await api(`/api/actors?role=${encodeURIComponent(castRole)}`);
  state.actors = Array.isArray(data.items) ? data.items : [];
  state.actorsLoaded = true;
  state.actorsLoadedRole = castRole;
  writePersistentCache(cacheKey, { items: state.actors });
  return { ...data, items: state.actors };
}

async function refreshActorsInBackground() {
  if (!CAST_ROLES.includes(state.castRole)) return;
  if (state.actorsRefreshInFlight) return;
  if (Date.now() - state.actorsLastRefreshAt < 60000) return;
  state.actorsRefreshInFlight = true;
  try {
    await loadActorsData(true, state.castRole);
    state.actorsLastRefreshAt = Date.now();
    if (window.location.pathname === '/cast') {
      renderActors(false);
    }
  } catch {
    // Silent background refresh failure.
  } finally {
    state.actorsRefreshInFlight = false;
  }
}

async function loadShowsData(forceRefresh = false) {
  if (!forceRefresh && state.showsLoaded && Array.isArray(state.shows)) {
    return { items: state.shows };
  }
  if (!forceRefresh && !state.showsLoaded) {
    const cached = readPersistentCache(CACHE_KEYS.shows, CACHE_TTL_MS.shows);
    if (cached && Array.isArray(cached.items)) {
      state.shows = cached.items;
      state.showsLoaded = true;
      return cached;
    }
  }
  const data = await api('/api/shows');
  state.shows = Array.isArray(data.items) ? data.items : [];
  state.showsLoaded = true;
  writePersistentCache(CACHE_KEYS.shows, { items: state.shows });
  return { ...data, items: state.shows };
}

async function refreshShowsInBackground() {
  if (state.showsRefreshInFlight) return;
  if (Date.now() - state.showsLastRefreshAt < 60000) return;
  state.showsRefreshInFlight = true;
  try {
    await loadShowsData(true);
    state.showsLastRefreshAt = Date.now();
    if (window.location.pathname === '/shows') {
      renderShows(false);
    }
  } catch {
    // Silent background refresh failure.
  } finally {
    state.showsRefreshInFlight = false;
  }
}

async function renderCastRoleChooser() {
  const roleMeta = await api('/api/cast/roles');
  const totals = roleMeta?.items || {};
  app.innerHTML = `
    <div class="topbar">
      <div class="topbar-title">
        <h2>Cast</h2>
        <div class="meta">Choose a role</div>
      </div>
    </div>
    <section class="grid cast-role-grid" id="cast-role-grid"></section>
  `;
  const grid = document.getElementById('cast-role-grid');
  for (const role of CAST_ROLES) {
    const label = CAST_ROLE_LABELS[role];
    const total = Number(totals[role] || 0);
    const card = document.createElement('article');
    card.className = 'actor-card';
    card.innerHTML = `
      <div class="caption role-choice-caption">
        <div class="role-choice-icon"><img src="${CAST_ROLE_ICONS[role] || ''}" alt="" loading="lazy" /></div>
        <div class="name">${label}</div>
        <div class="count">Total: ${total}</div>
      </div>
    `;
    card.addEventListener('click', () => {
      state.castRole = role;
      localStorage.setItem(CAST_ROLE_STORAGE_KEY, role);
      history.pushState({}, '', `/cast?role=${encodeURIComponent(role)}`);
      handleLocation();
    });
    grid.appendChild(card);
  }
}

async function renderActors(enableBackgroundRefresh = true) {
  const activeRole = getCastRoleFromQuery();
  if (!CAST_ROLES.includes(activeRole)) {
    state.castRole = '';
    await renderCastRoleChooser();
    return;
  }
  state.castRole = activeRole;
  const roleLabel = CAST_ROLE_LABELS[activeRole] || 'Actors';
  const roleSingular = activeRole === 'director' ? 'director' : (activeRole === 'writer' ? 'writer' : 'actor');
  let data = { items: state.actors, last_scan_at: null };
  if (!state.actorsLoaded || state.actorsLoadedRole !== activeRole) {
    data = await loadActorsData(false, activeRole);
  } else {
    data = { items: state.actors, last_scan_at: state.profile?.scan_logs?.[0]?.scanned_at || null };
  }

  if (!state.actors.length) {
    app.innerHTML = `
      <div class="topbar">
        <h2>${roleLabel}</h2>
      </div>
      <div class="empty actors-empty">No ${roleLabel.toLowerCase()} yet. Go to Profile and run a scan first.</div>
    `;
    return;
  }

  app.innerHTML = `
    <div class="topbar">
      <div class="topbar-left">
        <button id="cast-role-back" class="back-icon-btn" title="Back to Cast Roles" aria-label="Back to Cast Roles">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m14 7-5 5 5 5"/></svg>
        </button>
        <div class="topbar-title">
          <h2>${roleLabel}</h2>
          <div class="meta">Total: ${state.actors.length}</div>
        </div>
      </div>
      <div class="row">
        <div id="actors-search-control" class="search-control ${state.actorsSearchOpen ? 'open' : ''}">
          <button id="actors-search-toggle" class="search-toggle-btn has-pill-tooltip" title="Search" aria-label="Search" data-tooltip="Search">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 4a6 6 0 1 1-4.24 10.24A6 6 0 0 1 10 4m0-2a8 8 0 1 0 5.29 14l4.85 4.85 1.41-1.41-4.85-4.85A8 8 0 0 0 10 2Z"/></svg>
          </button>
          <input id="actors-search-input" class="search-input" type="text" placeholder="Search ${roleLabel.toLowerCase()}" value="${state.actorsSearchQuery}" />
          <button id="actors-search-clear" class="search-clear-btn ${state.actorsSearchOpen ? '' : 'hidden'}" title="Clear search" aria-label="Clear search">×</button>
        </div>
        <select id="actors-sort-by" class="secondary-btn" aria-label="Sort cast by">
          <option value="movies" ${state.actorsSortBy === 'movies' ? 'selected' : ''}>Movies</option>
          <option value="missing" ${state.actorsSortBy === 'missing' ? 'selected' : ''}>Missing</option>
          <option value="name" ${state.actorsSortBy === 'name' ? 'selected' : ''}>Name</option>
          <option value="new" ${state.actorsSortBy === 'new' ? 'selected' : ''}>New</option>
          <option value="upcoming" ${state.actorsSortBy === 'upcoming' ? 'selected' : ''}>Upcoming</option>
        </select>
        <button id="actors-sort-dir" class="toggle-btn has-pill-tooltip" title="Toggle sort direction" aria-label="Toggle sort direction" data-tooltip="Sort Direction">${state.actorsSortDir === 'asc' ? '&#8593;' : '&#8595;'}</button>
        <button id="actors-in-plex-filter" class="toggle-btn has-pill-tooltip ${state.actorsInPlexOnly ? 'active' : ''}" data-tooltip="In Plex">&#10003;</button>
        <button id="actors-missing-filter" class="toggle-btn has-pill-tooltip ${state.actorsMissingOnly ? 'active' : ''}" data-tooltip="Missing">!</button>
        <button id="actors-upcoming-filter" class="toggle-btn has-pill-tooltip ${state.actorsUpcomingOnly ? 'active' : ''}" data-tooltip="Upcoming">${calendarIconTag('calendar-filter-icon')}</button>
        <button id="actors-new-filter" class="toggle-btn has-pill-tooltip ${state.actorsNewOnly ? 'active' : ''}" data-tooltip="New">NEW</button>
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
    <button id="actors-scan-missing-btn" class="collection-pill-btn btn-with-icon">${scanIconTag()}<span>Scan Movies</span></button>
  `;

  document.getElementById('cast-role-back')?.addEventListener('click', () => {
    state.castRole = '';
    localStorage.removeItem(CAST_ROLE_STORAGE_KEY);
    history.pushState({}, '', '/cast');
    handleLocation();
  });

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
  const actorsMissingBtn = document.getElementById('actors-missing-filter');
  if (actorsMissingBtn) {
    actorsMissingBtn.addEventListener('click', () => {
      state.actorsMissingOnly = !state.actorsMissingOnly;
      if (state.actorsMissingOnly) {
        state.actorsInPlexOnly = false;
        state.actorsNewOnly = false;
        state.actorsUpcomingOnly = false;
      }
      state.actorsVisibleCount = ACTORS_BATCH_SIZE;
      renderActors();
    });
  }
  const actorsInPlexBtn = document.getElementById('actors-in-plex-filter');
  if (actorsInPlexBtn) {
    actorsInPlexBtn.addEventListener('click', () => {
      state.actorsInPlexOnly = !state.actorsInPlexOnly;
      if (state.actorsInPlexOnly) {
        state.actorsMissingOnly = false;
        state.actorsNewOnly = false;
        state.actorsUpcomingOnly = false;
      }
      state.actorsVisibleCount = ACTORS_BATCH_SIZE;
      renderActors();
    });
  }
  const actorsNewBtn = document.getElementById('actors-new-filter');
  if (actorsNewBtn) {
    actorsNewBtn.addEventListener('click', () => {
      state.actorsNewOnly = !state.actorsNewOnly;
      if (state.actorsNewOnly) {
        state.actorsMissingOnly = false;
        state.actorsInPlexOnly = false;
        state.actorsUpcomingOnly = false;
      }
      state.actorsVisibleCount = ACTORS_BATCH_SIZE;
      renderActors();
    });
  }
  const actorsUpcomingBtn = document.getElementById('actors-upcoming-filter');
  if (actorsUpcomingBtn) {
    actorsUpcomingBtn.addEventListener('click', () => {
      state.actorsUpcomingOnly = !state.actorsUpcomingOnly;
      if (state.actorsUpcomingOnly) {
        state.actorsMissingOnly = false;
        state.actorsInPlexOnly = false;
        state.actorsNewOnly = false;
      }
      state.actorsVisibleCount = ACTORS_BATCH_SIZE;
      renderActors();
    });
  }

  const grid = document.getElementById('actors-grid');
  const loadMoreWrap = document.getElementById('actors-load-more-wrap');
  const alphabetFilterEl = document.getElementById('actors-alphabet-filter');
  const sortedActors = [...state.actors].sort((a, b) => {
    if (state.actorsSortBy === 'name') {
      return compareActorNames(a, b);
    }
    if (state.actorsSortBy === 'movies') {
      const aMovies = Number.isFinite(Number(a.movies_in_plex_count)) ? Number(a.movies_in_plex_count) : Number(a.appearances || 0);
      const bMovies = Number.isFinite(Number(b.movies_in_plex_count)) ? Number(b.movies_in_plex_count) : Number(b.appearances || 0);
      if (aMovies !== bMovies) return aMovies - bMovies;
      return compareActorNames(a, b);
    }
    if (state.actorsSortBy === 'missing') {
      const aMissing = Number.isFinite(Number(a.missing_movie_count)) ? Number(a.missing_movie_count) : 0;
      const bMissing = Number.isFinite(Number(b.missing_movie_count)) ? Number(b.missing_movie_count) : 0;
      if (aMissing !== bMissing) return aMissing - bMissing;
      return compareActorNames(a, b);
    }
    if (state.actorsSortBy === 'new') {
      const aNew = Number.isFinite(Number(a.missing_new_count)) ? Number(a.missing_new_count) : 0;
      const bNew = Number.isFinite(Number(b.missing_new_count)) ? Number(b.missing_new_count) : 0;
      if (aNew !== bNew) return aNew - bNew;
      return compareActorNames(a, b);
    }
    if (state.actorsSortBy === 'upcoming') {
      const aDate = String(a.next_upcoming_release_date || '');
      const bDate = String(b.next_upcoming_release_date || '');
      if (aDate && bDate && aDate !== bDate) return aDate.localeCompare(bDate);
      if (aDate && !bDate) return -1;
      if (!aDate && bDate) return 1;
      return compareActorNames(a, b);
    }
    return compareActorNames(a, b);
  });
  if (state.actorsSortDir === 'desc') {
    sortedActors.reverse();
  }

  const renderActorsGrid = (incremental = false) => {
    const query = state.actorsSearchQuery.trim().toLowerCase();
    const isSearching = query.length > 0;
    const filteredByInitial = state.actorsInitialFilter === 'All'
      ? sortedActors
      : sortedActors.filter((actor) => getActorInitialBucket(actor.name) === state.actorsInitialFilter);
    let visible = query
      ? sortedActors.filter((actor) => actor.name.toLowerCase().includes(query))
      : filteredByInitial;
    if (state.actorsMissingOnly) {
      visible = visible.filter((actor) => {
        const count = Number.isFinite(Number(actor.missing_movie_count)) ? Number(actor.missing_movie_count) : 0;
        return count > 0;
      });
    }
    if (state.actorsInPlexOnly) {
      visible = visible.filter((actor) => getActorPrimaryStatus(actor) === 'in_plex');
    }
    if (state.actorsNewOnly) {
      visible = visible.filter((actor) => Number.isFinite(Number(actor.missing_new_count)) && Number(actor.missing_new_count) > 0);
    }
    if (state.actorsUpcomingOnly) {
      visible = visible.filter((actor) => Number.isFinite(Number(actor.missing_upcoming_count)) && Number(actor.missing_upcoming_count) > 0);
    }
    const renderItems = visible.slice(0, state.actorsVisibleCount);

    for (const button of alphabetFilterEl.querySelectorAll('.alpha-btn')) {
      button.classList.remove('active');
      button.disabled = isSearching;
      if (!isSearching && button.dataset.filter === state.actorsInitialFilter) {
        button.classList.add('active');
      }
    }

    if (!incremental && state.actorsImageObserver) {
      state.actorsImageObserver.disconnect();
      state.actorsImageObserver = null;
    }
    if (!state.actorsImageObserver && 'IntersectionObserver' in window) {
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

    if (!incremental) {
      grid.innerHTML = '';
    }
    const alreadyRendered = incremental ? grid.querySelectorAll('.actor-card').length : 0;
    const itemsToRender = incremental ? renderItems.slice(alreadyRendered) : renderItems;
    for (const actor of itemsToRender) {
      const downloadUrl = buildDownloadLink('actor', actor.name);
      const actorDownloadBadge = downloadUrl
        ? `<a class="badge-link badge-overlay badge-download" href="${downloadUrl}" target="_blank" rel="noopener noreferrer">Download <span class="badge-icon badge-icon-download">&#8595;</span></a>`
        : `<span class="badge-link badge-overlay badge-download badge-disabled">Download <span class="badge-icon badge-icon-download">&#8595;</span></span>`;
      const actorImage = withImageCacheKey(actor.image_url) || ACTOR_PLACEHOLDER;
      const newCount = Number.isFinite(Number(actor.missing_new_count)) ? Number(actor.missing_new_count) : 0;
      const missingCount = Number.isFinite(Number(actor.missing_movie_count)) ? Number(actor.missing_movie_count) : 0;
      const upcomingCount = Number.isFinite(Number(actor.missing_upcoming_count)) ? Number(actor.missing_upcoming_count) : 0;
      const hasNew = newCount > 0;
      const hasUpcoming = upcomingCount > 0;
      const hasMissing = missingCount > 0;
      const actorStatus = hasNew ? 'new' : (hasUpcoming ? 'upcoming' : (hasMissing ? 'missing' : getActorPrimaryStatus(actor)));
      const isInPlex = actorStatus === 'in_plex';
      const upcomingText = actor.next_upcoming_release_date ? formatDateDdMmYyyy(actor.next_upcoming_release_date) : '';
      const moviesInPlex = Number.isFinite(Number(actor.movies_in_plex_count)) ? Number(actor.movies_in_plex_count) : Number(actor.appearances || 0);
      const scanDateText = formatScanDateOnly(actor.missing_scan_at);
      const card = document.createElement('article');
      card.className = `actor-card${actorStatus === 'new' ? ' has-new' : (actorStatus === 'missing' ? ' has-missing' : (actorStatus === 'upcoming' ? ' has-upcoming' : ''))}`;
      card.innerHTML = `
        <div class="poster-wrap">
          <button class="show-scan-pill" type="button" data-actor-id="${actor.actor_id}" title="Scan movies for this ${roleSingular}" aria-label="Scan movies for this ${roleSingular}">
            <span class="show-scan-pill-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" role="img" aria-hidden="true">
                <path d="${SCAN_ICON_PATH}"></path>
              </svg>
            </span>
            <span class="show-scan-pill-text">${scanDateText}</span>
          </button>
          <img class="poster actor-poster-lazy" src="${ACTOR_PLACEHOLDER}" data-src="${actorImage}" alt="${actor.name}" loading="lazy" />
          ${(hasNew || hasUpcoming || hasMissing) ? `
            <div class="status-badges">
              ${hasNew ? '<span class="new-badge" title="New missing movies" aria-label="New missing movies">NEW</span>' : ''}
              ${hasUpcoming ? `<span class="upcoming-badge" title="Upcoming movies" aria-label="Upcoming movies">${calendarIconTag('upcoming-badge-icon')}</span>` : ''}
              ${hasMissing ? '<span class="missing-badge" title="Missing movies" aria-label="Missing movies">!</span>' : ''}
            </div>
          ` : ''}
          ${isInPlex ? '<span class="in-plex-badge" title="In Plex" aria-label="In Plex">&#10003;</span>' : ''}
          ${isInPlex
            ? '<span class="badge-link badge-overlay">Plex ' + plexLogoTag() + '</span>'
            : actorDownloadBadge}
        </div>
        <div class="caption">
          <div class="name">${actor.name}</div>
          ${moviesInPlex > 0 ? `<div class="count">Movies: ${moviesInPlex} in Plex</div>` : ''}
          ${missingCount > 0 ? `<div class="count">Missing: ${missingCount} movies</div>` : ''}
          ${newCount > 0 ? `<div class="count">New: ${newCount} movies</div>` : ''}
          ${upcomingText ? `<div class="count">Upcoming: ${upcomingText}</div>` : ''}
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
      const scanPillBtn = card.querySelector('.show-scan-pill');
      scanPillBtn.addEventListener('click', async (event) => {
        event.stopPropagation();
        if (scanPillBtn.disabled) return;
        scanPillBtn.disabled = true;
        showScanModal('Scanned 0/1 cast');
        try {
          const result = await api('/api/actors/missing-scan', {
            method: 'POST',
            body: JSON.stringify({ actor_ids: [String(actor.actor_id)] }),
          });
          const updates = Array.isArray(result.items) ? result.items : [];
          for (const updated of updates) {
            if (!updated) continue;
            applyActorMissingScanUpdate(updated);
          }
          showScanSuccessModal('Actor updated', true);
          renderActors();
        } catch (error) {
          closeScanModal();
          window.alert(error.message);
        } finally {
          scanPillBtn.disabled = false;
        }
      });
      card.addEventListener('click', () => routeTo('actor-detail', actor.actor_id));
      grid.appendChild(card);
    }

    const remaining = visible.length - renderItems.length;
    if (remaining > 0) {
      loadMoreWrap.innerHTML = `<button id="actors-load-more" class="secondary-btn">Load more (${remaining})</button>`;
      document.getElementById('actors-load-more').addEventListener('click', () => {
        state.actorsVisibleCount += ACTORS_BATCH_SIZE;
        renderActorsGrid(true);
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

  const getScopedActors = () => {
    const query = state.actorsSearchQuery.trim().toLowerCase();
    const filteredByInitial = state.actorsInitialFilter === 'All'
      ? sortedActors
      : sortedActors.filter((actor) => getActorInitialBucket(actor.name) === state.actorsInitialFilter);
    let scoped = query ? sortedActors.filter((actor) => actor.name.toLowerCase().includes(query)) : filteredByInitial;
    if (state.actorsMissingOnly) {
      scoped = scoped.filter((actor) => {
        const count = Number.isFinite(Number(actor.missing_movie_count)) ? Number(actor.missing_movie_count) : 0;
        return count > 0;
      });
    }
    if (state.actorsInPlexOnly) scoped = scoped.filter((actor) => getActorPrimaryStatus(actor) === 'in_plex');
    if (state.actorsNewOnly) scoped = scoped.filter((actor) => Number.isFinite(Number(actor.missing_new_count)) && Number(actor.missing_new_count) > 0);
    if (state.actorsUpcomingOnly) scoped = scoped.filter((actor) => Number.isFinite(Number(actor.missing_upcoming_count)) && Number(actor.missing_upcoming_count) > 0);
    return scoped;
  };

  const scanMissingBtn = document.getElementById('actors-scan-missing-btn');
  if (scanMissingBtn) {
    scanMissingBtn.addEventListener('click', async () => {
      if (scanMissingBtn.disabled) return;
      const scoped = getScopedActors();
      const scopedIds = scoped.map((item) => String(item.actor_id)).filter(Boolean);
      const allIds = state.actors.map((item) => String(item.actor_id)).filter(Boolean);
      const unscannedIds = scoped
        .filter((item) => !item?.missing_scan_at)
        .map((item) => String(item.actor_id))
        .filter(Boolean);
      if (!allIds.length) {
        window.alert('No cast available in current filter.');
        return;
      }
      const choice = await chooseShowMissingScanMode(scopedIds.length, allIds.length, unscannedIds.length);
      if (!choice) return;
      const actorIds = choice === 'all'
        ? allIds
        : (choice === 'unscanned' ? unscannedIds : scopedIds);
      if (!actorIds.length) {
        window.alert(choice === 'unscanned' ? 'No unscanned cast items found.' : 'No cast available in current filter.');
        return;
      }
      scanMissingBtn.disabled = true;
      const total = actorIds.length;
      showScanModal(`Scanned 0/${total} cast`);
      try {
        await runScanWorkers({
          ids: actorIds,
          label: 'actors',
          workerFn: (actorId) => api('/api/actors/missing-scan', {
            method: 'POST',
            body: JSON.stringify({ actor_ids: [actorId] }),
          }),
          onUpdate: (result) => {
            const updates = Array.isArray(result?.items) ? result.items : [];
            for (const updated of updates) {
              if (!updated) continue;
              applyActorMissingScanUpdate(updated);
            }
          },
        });
        showScanSuccessModal('Scan completed', true);
        state.actorsLoaded = true;
        renderActors();
      } catch (error) {
        closeScanModal();
        window.alert(error.message);
      } finally {
        scanMissingBtn.disabled = false;
      }
    });
  }

  updateActorsSearchClear();
  renderActorsGrid();
  if (enableBackgroundRefresh) {
    refreshActorsInBackground();
  }
}

async function renderShows(enableBackgroundRefresh = true) {
  let data = { items: state.shows, last_scan_at: null };
  if (!state.showsLoaded) {
    data = await loadShowsData(false);
  } else {
    data = { items: state.shows, last_scan_at: null };
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

  app.innerHTML = `
    <div class="topbar">
      <div class="topbar-title">
        <h2>Shows</h2>
        <div class="meta">Total: ${state.shows.length}</div>
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
          <option value="date" ${state.showsSortBy === 'date' ? 'selected' : ''}>Date</option>
          <option value="episodes" ${state.showsSortBy === 'episodes' ? 'selected' : ''}>Episodes</option>
          <option value="missing" ${state.showsSortBy === 'missing' ? 'selected' : ''}>Missing</option>
          <option value="name" ${state.showsSortBy === 'name' ? 'selected' : ''}>Name</option>
          <option value="new" ${state.showsSortBy === 'new' ? 'selected' : ''}>New</option>
          <option value="upcoming" ${state.showsSortBy === 'upcoming' ? 'selected' : ''}>Upcoming</option>
        </select>
        <button id="shows-sort-dir" class="toggle-btn has-pill-tooltip" title="Toggle sort direction" aria-label="Toggle sort direction" data-tooltip="Sort Direction">${state.showsSortDir === 'asc' ? '&#8593;' : '&#8595;'}</button>
        <button id="shows-in-plex-filter" class="toggle-btn has-pill-tooltip ${state.showsInPlexOnly ? 'active' : ''}" data-tooltip="In Plex">&#10003;</button>
        <button id="shows-missing-episodes-filter" class="toggle-btn has-pill-tooltip ${state.showsMissingOnly ? 'active' : ''}" data-tooltip="Missing">!</button>
        <button id="shows-upcoming-filter" class="toggle-btn has-pill-tooltip ${state.showsUpcomingOnly ? 'active' : ''}" data-tooltip="Upcoming">${calendarIconTag('calendar-filter-icon')}</button>
        <button id="shows-new-filter" class="toggle-btn has-pill-tooltip ${state.showsNewOnly ? 'active' : ''}" data-tooltip="New Episodes">NEW</button>
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
        state.showsUpcomingOnly = false;
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
        state.showsUpcomingOnly = false;
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
        state.showsUpcomingOnly = false;
      }
      state.showsVisibleCount = ACTORS_BATCH_SIZE;
      renderShows();
    });
  }
  const upcomingFilterBtn = document.getElementById('shows-upcoming-filter');
  if (upcomingFilterBtn) {
    upcomingFilterBtn.addEventListener('click', () => {
      state.showsUpcomingOnly = !state.showsUpcomingOnly;
      if (state.showsUpcomingOnly) {
        state.showsMissingOnly = false;
        state.showsInPlexOnly = false;
        state.showsNewOnly = false;
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
      // Date = first release date for the show (best available local field: year).
      const aYear = Number.isFinite(Number(a.year)) ? Number(a.year) : 0;
      const bYear = Number.isFinite(Number(b.year)) ? Number(b.year) : 0;
      if (aYear !== bYear) return aYear - bYear;
      return compareActorNames({ name: a.title }, { name: b.title });
    }
    if (state.showsSortBy === 'episodes') {
      return (a.episodes_in_plex || 0) - (b.episodes_in_plex || 0);
    }
    if (state.showsSortBy === 'missing') {
      // Missing sort follows the UI semantics: Missing = old + new (excluding upcoming).
      const aOld = Number.isFinite(Number(a.missing_old_count)) ? Number(a.missing_old_count) : 0;
      const aNew = Number.isFinite(Number(a.missing_new_count)) ? Number(a.missing_new_count) : 0;
      const bOld = Number.isFinite(Number(b.missing_old_count)) ? Number(b.missing_old_count) : 0;
      const bNew = Number.isFinite(Number(b.missing_new_count)) ? Number(b.missing_new_count) : 0;
      const aMissing = aOld + aNew;
      const bMissing = bOld + bNew;
      if (aMissing !== bMissing) return aMissing - bMissing;
      return compareActorNames({ name: a.title }, { name: b.title });
    }
    if (state.showsSortBy === 'new') {
      const aNew = Number.isFinite(Number(a.missing_new_count)) ? Number(a.missing_new_count) : 0;
      const bNew = Number.isFinite(Number(b.missing_new_count)) ? Number(b.missing_new_count) : 0;
      if (aNew !== bNew) return aNew - bNew;
      return compareActorNames({ name: a.title }, { name: b.title });
    }
    if (state.showsSortBy === 'upcoming') {
      const aDate = nextUpcomingAirDate(a.missing_upcoming_air_dates) || '';
      const bDate = nextUpcomingAirDate(b.missing_upcoming_air_dates) || '';
      if (aDate && bDate && aDate !== bDate) return aDate.localeCompare(bDate);
      if (aDate && !bDate) return -1;
      if (!aDate && bDate) return 1;
      return compareActorNames({ name: a.title }, { name: b.title });
    }
    return compareActorNames({ name: a.title }, { name: b.title });
  });
  if (state.showsSortDir === 'desc') sortedShows.reverse();

  const getScopedShows = (includeMissingFilter = true) => {
    const query = state.showsSearchQuery.trim().toLowerCase();
    const filteredByInitial = state.showsInitialFilter === 'All'
      ? sortedShows
      : sortedShows.filter((show) => getActorInitialBucket(show.title) === state.showsInitialFilter);
    let scoped = query ? sortedShows.filter((show) => (show.title || '').toLowerCase().includes(query)) : filteredByInitial;
    if (includeMissingFilter && state.showsMissingOnly) {
      scoped = scoped.filter((show) => {
        const oldCount = Number.isFinite(Number(show.missing_old_count)) ? Number(show.missing_old_count) : 0;
        const newCount = Number.isFinite(Number(show.missing_new_count)) ? Number(show.missing_new_count) : 0;
        return (oldCount + newCount) > 0;
      });
    }
    if (includeMissingFilter && state.showsInPlexOnly) {
      scoped = scoped.filter((show) => getShowPrimaryStatus(show) === 'in_plex');
    }
    if (includeMissingFilter && state.showsNewOnly) {
      scoped = scoped.filter((show) => Number.isFinite(Number(show.missing_new_count)) && Number(show.missing_new_count) > 0);
    }
    if (includeMissingFilter && state.showsUpcomingOnly) {
      scoped = scoped.filter((show) => Number.isFinite(Number(show.missing_upcoming_count)) && Number(show.missing_upcoming_count) > 0);
    }
    return scoped;
  };

  const renderShowsGrid = (incremental = false) => {
    const query = state.showsSearchQuery.trim().toLowerCase();
    const isSearching = query.length > 0;
    const visible = getScopedShows(true);
    const renderItems = visible.slice(0, state.showsVisibleCount);

    for (const button of alphabetFilterEl.querySelectorAll('.alpha-btn')) {
      button.classList.remove('active');
      button.disabled = isSearching;
      if (!isSearching && button.dataset.filter === state.showsInitialFilter) button.classList.add('active');
    }

    if (!incremental) {
      resetShowImageQueue();
    }
    const queueToken = state.showsImageQueueToken;

    if (!incremental) {
      grid.innerHTML = '';
    }
    const alreadyRendered = incremental ? grid.querySelectorAll('.actor-card').length : 0;
    const itemsToRender = incremental ? renderItems.slice(alreadyRendered) : renderItems;
    for (const show of itemsToRender) {
      const downloadUrl = buildDownloadLink('show', show.title);
      const newCount = Number.isFinite(Number(show.missing_new_count)) ? Number(show.missing_new_count) : 0;
      const oldCount = Number.isFinite(Number(show.missing_old_count)) ? Number(show.missing_old_count) : 0;
      const upcomingCount = Number.isFinite(Number(show.missing_upcoming_count)) ? Number(show.missing_upcoming_count) : 0;
      const hasNew = newCount > 0;
      const hasUpcoming = upcomingCount > 0;
      const hasMissing = (oldCount + newCount) > 0 || (!hasNew && !hasUpcoming && getShowPrimaryStatus(show) === 'missing');
      const showStatus = hasNew ? 'new' : (hasUpcoming ? 'upcoming' : (hasMissing ? 'missing' : getShowPrimaryStatus(show)));
      const isNew = showStatus === 'new';
      const isUpcoming = showStatus === 'upcoming';
      const hasNoMissing = showStatus === 'in_plex';
      const scanDateText = formatScanDateOnly(show.missing_scan_at);
      const nextAirDate = nextUpcomingAirDate(show.missing_upcoming_air_dates);
      const nextAirDateText = nextAirDate ? formatDateDdMmYyyy(nextAirDate) : null;
      const totalMissingInclNew = Math.max(0, oldCount + newCount);
      const releasedText = formatReleasedDate(null, show.year);
      const showStatusBadge = hasNoMissing && show.plex_web_url
        ? `<a class="badge-link badge-overlay" href="${show.plex_web_url}" target="_blank" rel="noopener noreferrer">Plex ${plexLogoTag()}</a>`
        : downloadUrl
          ? `<a class="badge-link badge-overlay badge-download" href="${downloadUrl}" target="_blank" rel="noopener noreferrer">Download <span class="badge-icon badge-icon-download">&#8595;</span></a>`
          : `<span class="badge-link badge-overlay badge-download badge-disabled">Download <span class="badge-icon badge-icon-download">&#8595;</span></span>`;
      const showImage = withImageCacheKey(show.image_url) || SHOW_PLACEHOLDER;
      const card = document.createElement('article');
      card.className = `actor-card${isNew ? ' has-new' : (hasMissing ? ' has-missing' : (isUpcoming ? ' has-upcoming' : ''))}`;
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
          ${(hasNew || hasUpcoming || hasMissing) ? `
            <div class="status-badges">
              ${hasNew ? '<span class="new-badge" title="New missing episodes" aria-label="New missing episodes">NEW</span>' : ''}
              ${hasUpcoming ? `<span class="upcoming-badge" title="Upcoming episodes" aria-label="Upcoming episodes">${calendarIconTag('upcoming-badge-icon')}</span>` : ''}
              ${hasMissing ? '<span class="missing-badge" title="Missing episodes" aria-label="Missing episodes">!</span>' : ''}
            </div>
          ` : ''}
          ${hasNoMissing ? '<span class="in-plex-badge" title="In Plex" aria-label="In Plex">&#10003;</span>' : ''}
          ${showStatusBadge}
        </div>
        <div class="caption">
          <div class="name">${show.title}</div>
          <div class="count">${releasedText}</div>
          <div class="count">Episodes: ${show.episodes_in_plex || 0} in Plex</div>
          ${nextAirDateText ? `<div class="count">Upcoming: ${nextAirDateText}</div>` : ''}
          ${newCount > 0 ? `<div class="count">New: ${newCount} episodes</div>` : ''}
          ${totalMissingInclNew > 0 ? `<div class="count">Missing: ${totalMissingInclNew} episodes</div>` : ''}
        </div>
      `;
      const poster = card.querySelector('.poster');
      applyImageFallback(poster, SHOW_PLACEHOLDER);
      state.showsImageQueue.push({ img: poster, src: showImage });
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
          showScanSuccessModal('Show updated', true);
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

    void runShowImageQueue(queueToken);

    const remaining = visible.length - renderItems.length;
    if (remaining > 0) {
      loadMoreWrap.innerHTML = `<button id="shows-load-more" class="secondary-btn">Load more (${remaining})</button>`;
      document.getElementById('shows-load-more').addEventListener('click', () => {
        state.showsVisibleCount += ACTORS_BATCH_SIZE;
        renderShowsGrid(true);
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
      const scoped = getScopedShows(true);
      const scopedIds = scoped.map((item) => String(item.show_id)).filter(Boolean);
      const allIds = state.shows.map((item) => String(item.show_id)).filter(Boolean);
      const unscannedIds = scoped
        .filter((item) => !item?.missing_scan_at)
        .map((item) => String(item.show_id))
        .filter(Boolean);
      if (!allIds.length) {
        window.alert('No shows available in current filter.');
        return;
      }
      const choice = await chooseShowMissingScanMode(scopedIds.length, allIds.length, unscannedIds.length);
      if (!choice) return;
      const showIds = choice === 'all'
        ? allIds
        : (choice === 'unscanned' ? unscannedIds : scopedIds);
      if (!showIds.length) {
        window.alert(choice === 'unscanned' ? 'No unscanned shows found.' : 'No shows available in current filter.');
        return;
      }
      scanMissingBtn.disabled = true;
      const total = showIds.length;
      showScanModal(`Scanned 0/${total} shows`);
      try {
        await runScanWorkers({
          ids: showIds,
          label: 'shows',
          workerFn: (showId) => api('/api/shows/missing-scan', {
            method: 'POST',
            body: JSON.stringify({ show_ids: [showId] }),
          }),
          onUpdate: (result) => {
            const updates = Array.isArray(result?.items) ? result.items : [];
            for (const updated of updates) {
              if (!updated) continue;
              applyShowMissingScanUpdate(updated);
            }
          },
        });
        showScanSuccessModal('Scan completed', true);
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
  if (enableBackgroundRefresh) {
    refreshShowsInBackground();
  }
}

function showSeasonsCacheKey(showId, missingOnly, inPlexOnly, newOnly, upcomingOnly) {
  return `${showId}|m:${missingOnly ? 1 : 0}|p:${inPlexOnly ? 1 : 0}|n:${newOnly ? 1 : 0}|u:${upcomingOnly ? 1 : 0}`;
}

function showEpisodesCacheKey(showId, seasonNumber, missingOnly, inPlexOnly, newOnly, upcomingOnly) {
  return `${showId}|s:${seasonNumber}|m:${missingOnly ? 1 : 0}|p:${inPlexOnly ? 1 : 0}|n:${newOnly ? 1 : 0}|u:${upcomingOnly ? 1 : 0}`;
}

function filterSeasonItems(items, missingOnly, inPlexOnly, newOnly, upcomingOnly) {
  let filtered = Array.isArray(items) ? [...items] : [];
  if (missingOnly) {
    filtered = filtered.filter((item) => {
      const oldCount = Number.isFinite(Number(item.missing_old_count)) ? Number(item.missing_old_count) : 0;
      const newCount = Number.isFinite(Number(item.missing_new_count)) ? Number(item.missing_new_count) : 0;
      return (oldCount + newCount) > 0;
    });
  }
  if (inPlexOnly) {
    filtered = filtered.filter((item) => Boolean(item.in_plex));
  }
  if (newOnly) {
    filtered = filtered.filter((item) => {
      const newCount = Number.isFinite(Number(item.missing_new_count)) ? Number(item.missing_new_count) : 0;
      return newCount > 0;
    });
  }
  if (upcomingOnly) {
    filtered = filtered.filter((item) => {
      const upcomingCount = Number.isFinite(Number(item.missing_upcoming_count)) ? Number(item.missing_upcoming_count) : 0;
      return upcomingCount > 0;
    });
  }
  return filtered;
}

function filterEpisodeItems(items, missingOnly, inPlexOnly, newOnly, upcomingOnly) {
  let filtered = Array.isArray(items) ? [...items] : [];
  if (missingOnly) filtered = filtered.filter((item) => item.status === 'missing' || item.status === 'new');
  if (inPlexOnly) filtered = filtered.filter((item) => Boolean(item.in_plex));
  if (newOnly) filtered = filtered.filter((item) => item.status === 'new');
  if (upcomingOnly) filtered = filtered.filter((item) => item.status === 'upcoming');
  return filtered;
}

function buildFilteredSeasonsData(baseData, missingOnly, inPlexOnly, newOnly, upcomingOnly) {
  return {
    ...baseData,
    items: filterSeasonItems(baseData?.items || [], missingOnly, inPlexOnly, newOnly, upcomingOnly),
    missing_only: missingOnly,
    in_plex_only: inPlexOnly,
    new_only: newOnly,
    upcoming_only: upcomingOnly,
  };
}

function buildFilteredEpisodesData(baseData, missingOnly, inPlexOnly, newOnly, upcomingOnly) {
  return {
    ...baseData,
    items: filterEpisodeItems(baseData?.items || [], missingOnly, inPlexOnly, newOnly, upcomingOnly),
    missing_only: missingOnly,
    in_plex_only: inPlexOnly,
    new_only: newOnly,
    upcoming_only: upcomingOnly,
  };
}

function getCachedShowSeasonsData(showId, missingOnly, inPlexOnly, newOnly, upcomingOnly) {
  const key = showSeasonsCacheKey(showId, missingOnly, inPlexOnly, newOnly, upcomingOnly);
  if (state.showSeasonsCache[key]) return state.showSeasonsCache[key];
  const persistedExact = readShowSeasonsPersistentCache(key);
  if (persistedExact) {
    state.showSeasonsCache[key] = persistedExact;
    return persistedExact;
  }
  const baseKey = showSeasonsCacheKey(showId, false, false, false, false);
  const base = state.showSeasonsCache[baseKey] || readShowSeasonsPersistentCache(baseKey);
  if (!base) return null;
  state.showSeasonsCache[baseKey] = base;
  const derived = buildFilteredSeasonsData(base, missingOnly, inPlexOnly, newOnly, upcomingOnly);
  state.showSeasonsCache[key] = derived;
  writeShowSeasonsPersistentCache(key, derived);
  return derived;
}

function getCachedShowEpisodesData(showId, seasonNumber, missingOnly, inPlexOnly, newOnly, upcomingOnly) {
  const key = showEpisodesCacheKey(showId, seasonNumber, missingOnly, inPlexOnly, newOnly, upcomingOnly);
  if (state.showEpisodesCache[key]) return state.showEpisodesCache[key];
  const persistedExact = readShowEpisodesPersistentCache(key);
  if (persistedExact) {
    state.showEpisodesCache[key] = persistedExact;
    return persistedExact;
  }
  const baseKey = showEpisodesCacheKey(showId, seasonNumber, false, false, false, false);
  const base = state.showEpisodesCache[baseKey] || readShowEpisodesPersistentCache(baseKey);
  if (!base) return null;
  state.showEpisodesCache[baseKey] = base;
  const derived = buildFilteredEpisodesData(base, missingOnly, inPlexOnly, newOnly, upcomingOnly);
  state.showEpisodesCache[key] = derived;
  writeShowEpisodesPersistentCache(key, derived);
  return derived;
}

async function getShowSeasonsData(showId, missingOnly, inPlexOnly, newOnly, upcomingOnly) {
  const cached = getCachedShowSeasonsData(showId, missingOnly, inPlexOnly, newOnly, upcomingOnly);
  if (cached) return cached;
  const baseKey = showSeasonsCacheKey(showId, false, false, false, false);
  const baseData = await api(`/api/shows/${showId}/seasons?missing_only=false&in_plex_only=false&new_only=false&upcoming_only=false`);
  state.showSeasonsCache[baseKey] = baseData;
  writeShowSeasonsPersistentCache(baseKey, baseData);
  const key = showSeasonsCacheKey(showId, missingOnly, inPlexOnly, newOnly, upcomingOnly);
  const data = (missingOnly || inPlexOnly || newOnly || upcomingOnly)
    ? buildFilteredSeasonsData(baseData, missingOnly, inPlexOnly, newOnly, upcomingOnly)
    : baseData;
  state.showSeasonsCache[key] = data;
  writeShowSeasonsPersistentCache(key, data);
  return data;
}

async function getShowEpisodesData(showId, seasonNumber, missingOnly, inPlexOnly, newOnly, upcomingOnly) {
  return getShowEpisodesDataWithOptions(showId, seasonNumber, missingOnly, inPlexOnly, newOnly, upcomingOnly, {});
}

async function getShowEpisodesDataWithOptions(showId, seasonNumber, missingOnly, inPlexOnly, newOnly, upcomingOnly, fetchOptions = {}) {
  const cached = getCachedShowEpisodesData(showId, seasonNumber, missingOnly, inPlexOnly, newOnly, upcomingOnly);
  if (cached) return cached;
  const baseKey = showEpisodesCacheKey(showId, seasonNumber, false, false, false, false);
  const baseData = await api(
    `/api/shows/${showId}/seasons/${seasonNumber}/episodes?missing_only=false&in_plex_only=false&new_only=false&upcoming_only=false`,
    fetchOptions,
  );
  state.showEpisodesCache[baseKey] = baseData;
  writeShowEpisodesPersistentCache(baseKey, baseData);
  const key = showEpisodesCacheKey(showId, seasonNumber, missingOnly, inPlexOnly, newOnly, upcomingOnly);
  const data = (missingOnly || inPlexOnly || newOnly || upcomingOnly)
    ? buildFilteredEpisodesData(baseData, missingOnly, inPlexOnly, newOnly, upcomingOnly)
    : baseData;
  state.showEpisodesCache[key] = data;
  writeShowEpisodesPersistentCache(key, data);
  return data;
}

function startShowEpisodePrefetch(showId, seasonNumbers) {
  if (!seasonNumbers.length) return;
  const targetPath = `/shows/${showId}`;
  const maxConcurrent = 3;
  let index = 0;

  const worker = async () => {
    while (index < seasonNumbers.length) {
      if (window.location.pathname !== targetPath) return;
      const seasonNo = seasonNumbers[index];
      index += 1;
      const cacheKey = showEpisodesCacheKey(showId, seasonNo, false, false, false, false);
      if (state.showEpisodesCache[cacheKey]) continue;
      const controller = new AbortController();
      state.showPrefetchControllers.add(controller);
      try {
        await getShowEpisodesDataWithOptions(showId, seasonNo, false, false, false, false, { signal: controller.signal });
      } catch (error) {
        if (error?.name !== 'AbortError') {
          // Ignore background prefetch failures.
        }
      } finally {
        state.showPrefetchControllers.delete(controller);
      }
    }
  };

  for (let i = 0; i < maxConcurrent; i += 1) {
    void worker();
  }
}

async function renderShowSeasons(showId) {
  const search = new URLSearchParams(window.location.search);
  const missingOnly = search.get('missingOnly') === '1';
  const inPlexOnly = search.get('inPlexOnly') === '1';
  const newOnly = search.get('newOnly') === '1';
  const upcomingOnly = search.get('upcomingOnly') === '1';
  const seasonsSortDir = state.showsSeasonsSortDir === 'desc' ? 'desc' : 'asc';
  const cachedData = getCachedShowSeasonsData(showId, missingOnly, inPlexOnly, newOnly, upcomingOnly);
  if (!cachedData) {
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
  }

  const data = cachedData || await getShowSeasonsData(showId, missingOnly, inPlexOnly, newOnly, upcomingOnly);

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
        <button id="seasons-sort-dir" class="toggle-btn has-pill-tooltip" title="Toggle sort direction" aria-label="Toggle sort direction" data-tooltip="Sort Direction">${seasonsSortDir === 'asc' ? '&#8593;' : '&#8595;'}</button>
        <button id="shows-in-plex-toggle" class="toggle-btn has-pill-tooltip ${inPlexOnly ? 'active' : ''}" data-tooltip="In Plex">&#10003;</button>
        <button id="shows-missing-toggle" class="toggle-btn has-pill-tooltip ${missingOnly ? 'active' : ''}" data-tooltip="Missing">!</button>
        <button id="shows-upcoming-toggle" class="toggle-btn has-pill-tooltip ${upcomingOnly ? 'active' : ''}" data-tooltip="Upcoming">${calendarIconTag('calendar-filter-icon')}</button>
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
    else if (upcomingOnly) params.set('upcomingOnly', '1');
    pushQuery(params);
  });
  document.getElementById('shows-in-plex-toggle').addEventListener('click', () => {
    const params = new URLSearchParams();
    const next = !inPlexOnly;
    if (next) params.set('inPlexOnly', '1');
    else if (missingOnly) params.set('missingOnly', '1');
    else if (newOnly) params.set('newOnly', '1');
    else if (upcomingOnly) params.set('upcomingOnly', '1');
    pushQuery(params);
  });
  document.getElementById('shows-new-toggle').addEventListener('click', () => {
    const params = new URLSearchParams();
    const next = !newOnly;
    if (next) params.set('newOnly', '1');
    else if (missingOnly) params.set('missingOnly', '1');
    else if (inPlexOnly) params.set('inPlexOnly', '1');
    else if (upcomingOnly) params.set('upcomingOnly', '1');
    pushQuery(params);
  });
  document.getElementById('shows-upcoming-toggle').addEventListener('click', () => {
    const params = new URLSearchParams();
    const next = !upcomingOnly;
    if (next) params.set('upcomingOnly', '1');
    else if (missingOnly) params.set('missingOnly', '1');
    else if (inPlexOnly) params.set('inPlexOnly', '1');
    else if (newOnly) params.set('newOnly', '1');
    pushQuery(params);
  });

  const grid = document.getElementById('show-seasons-grid');
  if (!data.items.length) {
    grid.innerHTML = '<div class="empty">No seasons found.</div>';
    return;
  }

  // Prefetch unfiltered episodes in the background to reduce click delay.
  if (!missingOnly && !inPlexOnly && !newOnly && !upcomingOnly) {
    const seasonNumbers = data.items
      .map((season) => Number(season.season_number))
      .filter((num) => Number.isFinite(num) && num > 0);
    startShowEpisodePrefetch(showId, seasonNumbers);
  }

  const seasons = [...data.items].sort((a, b) => {
    const aNo = Number(a.season_number) || 0;
    const bNo = Number(b.season_number) || 0;
    return aNo - bNo;
  });
  if (seasonsSortDir === 'desc') seasons.reverse();

  for (const season of seasons) {
    const seasonDownloadUrl = buildDownloadLink('season', buildSeasonKeyword(data.show.title, season.season_number));
    const seasonNewCount = Number.isFinite(Number(season.missing_new_count)) ? Number(season.missing_new_count) : 0;
    const seasonOldCount = Number.isFinite(Number(season.missing_old_count)) ? Number(season.missing_old_count) : 0;
    const seasonUpcomingCount = Number.isFinite(Number(season.missing_upcoming_count)) ? Number(season.missing_upcoming_count) : 0;
    const hasNew = seasonNewCount > 0;
    const hasUpcoming = seasonUpcomingCount > 0;
    const hasMissing = (seasonOldCount + seasonNewCount) > 0 || (!hasNew && !hasUpcoming && season.status === 'missing');
    const seasonEpisodesInPlex = Number.isFinite(Number(season.episodes_in_plex)) ? Number(season.episodes_in_plex) : 0;
    const isNew = hasNew;
    const isUpcoming = !hasNew && hasUpcoming;
    const isMissing = !hasNew && !hasUpcoming && hasMissing;
    const seasonReleasedText = formatReleasedDate(season.air_date, null);
    const seasonYearFromRelease = Number.parseInt(String(seasonReleasedText || ''), 10);
    const seasonYear = Number.isFinite(seasonYearFromRelease)
      ? seasonYearFromRelease
      : (Number.isFinite(Number(season.year)) ? Number(season.year) : null);
    const hideInPlexVisuals = seasonYear === 0 && seasonEpisodesInPlex === 0;
    const showSeasonInPlex = Boolean(season.in_plex) && !hideInPlexVisuals;
    const seasonNextUpcoming = season.next_upcoming_air_date ? formatDateDdMmYyyy(season.next_upcoming_air_date) : null;
    const seasonMissingInclNew = Math.max(0, seasonOldCount + seasonNewCount);
    const seasonDownloadBadge = hideInPlexVisuals
      ? ''
      : (
        seasonDownloadUrl
          ? `<a class="badge-link badge-overlay badge-download" href="${seasonDownloadUrl}" target="_blank" rel="noopener noreferrer">Download <span class="badge-icon badge-icon-download">&#8595;</span></a>`
          : '<span class="badge-link badge-overlay badge-download badge-disabled">Download <span class="badge-icon badge-icon-download">&#8595;</span></span>'
      );
    const card = document.createElement('article');
    card.className = `movie-card${isNew ? ' has-new' : (isMissing ? ' has-missing' : (isUpcoming ? ' has-upcoming' : ''))}${hideInPlexVisuals ? ' no-date' : ''}`;
    card.innerHTML = `
      <div class="poster-wrap">
        <img class="poster" src="${withImageCacheKey(season.poster_url) || SHOW_PLACEHOLDER}" alt="${season.name}" loading="lazy" />
        ${(hasNew || hasUpcoming || hasMissing) ? `
          <div class="status-badges">
            ${hasNew ? '<span class="new-badge" title="New missing episodes" aria-label="New missing episodes">NEW</span>' : ''}
            ${hasUpcoming ? `<span class="upcoming-badge" title="Upcoming episodes" aria-label="Upcoming episodes">${calendarIconTag('upcoming-badge-icon')}</span>` : ''}
            ${hasMissing ? '<span class="missing-badge" title="Missing in Plex" aria-label="Missing in Plex">!</span>' : ''}
          </div>
        ` : ''}
        ${showSeasonInPlex ? '<span class="in-plex-badge" title="In Plex" aria-label="In Plex">&#10003;</span>' : ''}
        ${
          showSeasonInPlex
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
        <div class="year">${seasonReleasedText}</div>
        <div class="year">Episodes: ${season.episodes_in_plex || 0} in Plex</div>
        ${seasonNextUpcoming ? `<div class="year">Upcoming: ${seasonNextUpcoming}</div>` : ''}
        ${seasonNewCount > 0 ? `<div class="year">New: ${seasonNewCount} episodes</div>` : ''}
        ${seasonMissingInclNew > 0 ? `<div class="year">Missing: ${seasonMissingInclNew} episodes</div>` : ''}
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
  const upcomingOnly = search.get('upcomingOnly') === '1';
  const episodesSortDir = state.showsEpisodesSortDir === 'desc' ? 'desc' : 'asc';
  const cachedData = getCachedShowEpisodesData(showId, seasonNumber, missingOnly, inPlexOnly, newOnly, upcomingOnly);
  if (!cachedData) {
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
  }

  const data = cachedData || await getShowEpisodesData(showId, seasonNumber, missingOnly, inPlexOnly, newOnly, upcomingOnly);

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
        <button id="episodes-sort-dir" class="toggle-btn has-pill-tooltip" title="Toggle sort direction" aria-label="Toggle sort direction" data-tooltip="Sort Direction">${episodesSortDir === 'asc' ? '&#8593;' : '&#8595;'}</button>
        <button id="episodes-in-plex-toggle" class="toggle-btn has-pill-tooltip ${inPlexOnly ? 'active' : ''}" data-tooltip="In Plex">&#10003;</button>
        <button id="episodes-missing-toggle" class="toggle-btn has-pill-tooltip ${missingOnly ? 'active' : ''}" data-tooltip="Missing">!</button>
        <button id="episodes-upcoming-toggle" class="toggle-btn has-pill-tooltip ${upcomingOnly ? 'active' : ''}" data-tooltip="Upcoming">${calendarIconTag('calendar-filter-icon')}</button>
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
    else if (upcomingOnly) params.set('upcomingOnly', '1');
    pushQuery(params);
  });
  document.getElementById('episodes-in-plex-toggle').addEventListener('click', () => {
    const params = new URLSearchParams();
    const next = !inPlexOnly;
    if (next) params.set('inPlexOnly', '1');
    else if (missingOnly) params.set('missingOnly', '1');
    else if (newOnly) params.set('newOnly', '1');
    else if (upcomingOnly) params.set('upcomingOnly', '1');
    pushQuery(params);
  });
  document.getElementById('episodes-new-toggle').addEventListener('click', () => {
    const params = new URLSearchParams();
    const next = !newOnly;
    if (next) params.set('newOnly', '1');
    else if (missingOnly) params.set('missingOnly', '1');
    else if (inPlexOnly) params.set('inPlexOnly', '1');
    else if (upcomingOnly) params.set('upcomingOnly', '1');
    pushQuery(params);
  });
  document.getElementById('episodes-upcoming-toggle').addEventListener('click', () => {
    const params = new URLSearchParams();
    const next = !upcomingOnly;
    if (next) params.set('upcomingOnly', '1');
    else if (missingOnly) params.set('missingOnly', '1');
    else if (inPlexOnly) params.set('inPlexOnly', '1');
    else if (newOnly) params.set('newOnly', '1');
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
    const allowEpisodeDownload = Boolean(episode.air_date) && !isFutureDate(episode.air_date);
    const episodeDownloadBadge = allowEpisodeDownload
      ? (
        episodeDownloadUrl
          ? `<a class="badge-link badge-overlay badge-download" href="${episodeDownloadUrl}" target="_blank" rel="noopener noreferrer">Download <span class="badge-icon badge-icon-download">&#8595;</span></a>`
          : '<span class="badge-link badge-overlay badge-download badge-disabled">Download <span class="badge-icon badge-icon-download">&#8595;</span></span>'
      )
      : '';
    const isUpcoming = episode.status === 'upcoming';
    const isNew = episode.status === 'new';
    const isIgnored = episode.status === 'ignored' || Boolean(episode.ignored);
    const isMissing = episode.status === 'missing' || episode.status === 'new';
    const isToggleableIgnore = episode.status === 'missing' || isIgnored;
    const episodeDateText = episode.air_date ? formatDateDdMmYyyy(episode.air_date) : null;
    const episodeReleaseLabel = episodeDateText || '';
    const tmdbEpisodeUrl = data.show?.tmdb_show_id
      ? `https://www.themoviedb.org/tv/${data.show.tmdb_show_id}/season/${seasonNumber}/episode/${episode.episode_number}`
      : null;
    const card = document.createElement('article');
    card.className = `movie-card${isNew ? ' has-new' : (isMissing ? ' has-missing' : (isUpcoming ? ' has-upcoming' : ''))}`;
    const renderEpisodeStatusBadges = (status) => {
      const badgeNew = status === 'new';
      const badgeUpcoming = status === 'upcoming';
      const badgeMissing = status === 'missing' || status === 'new';
      if (!(badgeNew || badgeUpcoming || badgeMissing)) return '';
      return `
        <div class="status-badges">
          ${badgeNew ? '<span class="new-badge" title="New missing episode" aria-label="New missing episode">NEW</span>' : ''}
          ${badgeUpcoming ? `<span class="upcoming-badge" title="Upcoming episode" aria-label="Upcoming episode">${calendarIconTag('upcoming-badge-icon')}</span>` : ''}
          ${badgeMissing ? '<span class="missing-badge" title="Missing in Plex" aria-label="Missing in Plex">!</span>' : ''}
        </div>
      `;
    };
    card.innerHTML = `
      <div class="poster-wrap">
        ${isToggleableIgnore ? `<button class="ignore-toggle-btn ignore-toggle-overlay" type="button" data-episode-number="${episode.episode_number}" data-ignored="${isIgnored ? '1' : '0'}">${isIgnored ? 'Unignore' : 'Ignore'}</button>` : ''}
        <img class="poster" src="${withImageCacheKey(episode.poster_url) || SHOW_PLACEHOLDER}" alt="${episode.title}" loading="lazy" />
        ${renderEpisodeStatusBadges(episode.status)}
        ${episode.in_plex ? '<span class="in-plex-badge" title="In Plex" aria-label="In Plex">&#10003;</span>' : ''}
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
    const ignoreToggleBtn = card.querySelector('.ignore-toggle-btn');
    if (ignoreToggleBtn) {
      ignoreToggleBtn.addEventListener('click', async (event) => {
        event.stopPropagation();
        if (ignoreToggleBtn.disabled) return;
        ignoreToggleBtn.disabled = true;
        try {
          const nextIgnored = ignoreToggleBtn.dataset.ignored !== '1';
          await api(`/api/shows/${showId}/seasons/${seasonNumber}/episodes/${episode.episode_number}/ignore`, {
            method: 'POST',
            body: JSON.stringify({ ignored: nextIgnored }),
          });
          // Live update card state without full page re-render.
          const nextStatus = nextIgnored ? 'ignored' : 'missing';
          episode.status = nextStatus;
          episode.ignored = nextIgnored;
          const statusWrap = card.querySelector('.status-badges');
          const nextStatusHtml = renderEpisodeStatusBadges(nextStatus);
          if (nextStatusHtml) {
            if (statusWrap) {
              statusWrap.outerHTML = nextStatusHtml;
            } else {
              const posterWrap = card.querySelector('.poster-wrap');
              posterWrap.insertAdjacentHTML('beforeend', nextStatusHtml);
            }
          } else if (statusWrap) {
            statusWrap.remove();
          }
          card.classList.remove('has-new', 'has-missing', 'has-upcoming');
          if (nextStatus === 'new') card.classList.add('has-new');
          else if (nextStatus === 'missing') card.classList.add('has-missing');
          else if (nextStatus === 'upcoming') card.classList.add('has-upcoming');
          ignoreToggleBtn.dataset.ignored = nextIgnored ? '1' : '0';
          ignoreToggleBtn.textContent = nextIgnored ? 'Unignore' : 'Ignore';
          const refresh = await api('/api/shows/missing-scan', {
            method: 'POST',
            body: JSON.stringify({ show_ids: [String(showId)] }),
          });
          const updated = Array.isArray(refresh.items) ? refresh.items[0] : null;
          if (updated) applyShowMissingScanUpdate(updated);
          invalidateShowDetailCaches(showId);
          const shouldHideInCurrentFilter = (
            (missingOnly && !(nextStatus === 'missing' || nextStatus === 'new'))
            || (inPlexOnly && !episode.in_plex)
            || (newOnly && nextStatus !== 'new')
            || (upcomingOnly && nextStatus !== 'upcoming')
          );
          if (shouldHideInCurrentFilter) {
            card.remove();
            if (!grid.querySelector('.movie-card')) {
              grid.innerHTML = '<div class="empty">No episodes found.</div>';
            }
          }
          ignoreToggleBtn.disabled = false;
        } catch (error) {
          window.alert(error.message);
          ignoreToggleBtn.disabled = false;
        }
      });
    }
    if (tmdbEpisodeUrl) {
      card.addEventListener('click', () => window.open(tmdbEpisodeUrl, '_blank', 'noopener,noreferrer'));
    }
    applyImageFallback(card.querySelector('.poster'), SHOW_PLACEHOLDER);
    grid.appendChild(card);
  }
}

async function renderActorDetail(actorId) {
  const search = new URLSearchParams(window.location.search);
  const castRole = (() => {
    const role = (search.get('role') || state.castRole || '').trim().toLowerCase();
    return CAST_ROLES.includes(role) ? role : 'actor';
  })();
  state.castRole = castRole;
  localStorage.setItem(CAST_ROLE_STORAGE_KEY, castRole);
  const missingOnly = search.get('missingOnly') === '1';
  const inPlexOnly = search.get('inPlexOnly') === '1';
  const newOnly = search.get('newOnly') === '1';
  const upcomingOnly = search.get('upcomingOnly') === '1';
  const defaultMoviesSortBy = localStorage.getItem('moviesSortBy') || 'date';
  const defaultMoviesSortDir = localStorage.getItem('moviesSortDir') || 'desc';
  const rawSortBy = search.get('sortBy') || defaultMoviesSortBy;
  const sortBy = rawSortBy === 'year' ? 'date' : rawSortBy;
  const sortDir = search.get('sortDir') || defaultMoviesSortDir;

  const data = await api(`/api/actors/${actorId}/movies?missing_only=${missingOnly}&in_plex_only=${inPlexOnly}&new_only=${newOnly}&upcoming_only=${upcomingOnly}&role=${encodeURIComponent(castRole)}`);
  const actorName = data.actor.name;
  const inPlexCount = data.items.filter((item) => item.in_plex).length;
  const showCreateCollection = true;
  if (state.moviesSearchQuery) {
    state.moviesSearchOpen = true;
  }

  app.innerHTML = `
    <div class="topbar">
      <div class="topbar-left">
        <button id="actor-detail-back" class="back-icon-btn" title="Back to Cast" aria-label="Back to Cast">
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
          <option value="date" ${sortBy === 'date' ? 'selected' : ''}>Date</option>
          <option value="title" ${sortBy === 'title' ? 'selected' : ''}>Title</option>
          <option value="missing" ${sortBy === 'missing' ? 'selected' : ''}>Missing</option>
          <option value="new" ${sortBy === 'new' ? 'selected' : ''}>New</option>
          <option value="upcoming" ${sortBy === 'upcoming' ? 'selected' : ''}>Upcoming</option>
        </select>
        <button id="movies-sort-dir" class="toggle-btn has-pill-tooltip" title="Toggle sort direction" aria-label="Toggle sort direction" data-tooltip="Sort Direction">${sortDir === 'asc' ? '&#8593;' : '&#8595;'}</button>
        <button id="in-plex-toggle" class="toggle-btn has-pill-tooltip ${inPlexOnly ? 'active' : ''}" data-tooltip="In Plex">&#10003;</button>
        <button id="missing-toggle" class="toggle-btn has-pill-tooltip ${missingOnly ? 'active' : ''}" data-tooltip="Missing">!</button>
        <button id="movies-upcoming-toggle" class="toggle-btn has-pill-tooltip ${upcomingOnly ? 'active' : ''}" data-tooltip="Upcoming">${calendarIconTag('calendar-filter-icon')}</button>
        <button id="movies-new-toggle" class="toggle-btn has-pill-tooltip ${newOnly ? 'active' : ''}" data-tooltip="New">NEW</button>
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
    history.pushState({}, '', `/cast?role=${encodeURIComponent(castRole)}`);
    handleLocation();
  });

  const pushActorDetailQuery = (params) => {
    const query = params.toString();
    const nextParams = new URLSearchParams(query || '');
    nextParams.set('role', castRole);
    history.pushState({}, '', `/cast/${actorId}?${nextParams.toString()}`);
    renderActorDetail(actorId);
  };

  const missingToggle = document.getElementById('missing-toggle');
  if (missingToggle) {
    missingToggle.addEventListener('click', () => {
      const params = new URLSearchParams();
      const next = !missingOnly;
      if (next) params.set('missingOnly', '1');
      else if (inPlexOnly) params.set('inPlexOnly', '1');
      else if (newOnly) params.set('newOnly', '1');
      else if (upcomingOnly) params.set('upcomingOnly', '1');
      params.set('sortBy', sortBy);
      params.set('sortDir', sortDir);
      pushActorDetailQuery(params);
    });
  }

  const inPlexToggle = document.getElementById('in-plex-toggle');
  if (inPlexToggle) {
    inPlexToggle.addEventListener('click', () => {
      const params = new URLSearchParams();
      const next = !inPlexOnly;
      if (next) params.set('inPlexOnly', '1');
      else if (missingOnly) params.set('missingOnly', '1');
      else if (newOnly) params.set('newOnly', '1');
      else if (upcomingOnly) params.set('upcomingOnly', '1');
      params.set('sortBy', sortBy);
      params.set('sortDir', sortDir);
      pushActorDetailQuery(params);
    });
  }
  const moviesNewToggle = document.getElementById('movies-new-toggle');
  if (moviesNewToggle) {
    moviesNewToggle.addEventListener('click', () => {
      const params = new URLSearchParams();
      const next = !newOnly;
      if (next) params.set('newOnly', '1');
      else if (missingOnly) params.set('missingOnly', '1');
      else if (inPlexOnly) params.set('inPlexOnly', '1');
      else if (upcomingOnly) params.set('upcomingOnly', '1');
      params.set('sortBy', sortBy);
      params.set('sortDir', sortDir);
      pushActorDetailQuery(params);
    });
  }
  const moviesUpcomingToggle = document.getElementById('movies-upcoming-toggle');
  if (moviesUpcomingToggle) {
    moviesUpcomingToggle.addEventListener('click', () => {
      const params = new URLSearchParams();
      const next = !upcomingOnly;
      if (next) params.set('upcomingOnly', '1');
      else if (missingOnly) params.set('missingOnly', '1');
      else if (inPlexOnly) params.set('inPlexOnly', '1');
      else if (newOnly) params.set('newOnly', '1');
      params.set('sortBy', sortBy);
      params.set('sortDir', sortDir);
      pushActorDetailQuery(params);
    });
  }

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
      const mode = await chooseCreateCollectionMode(inPlexCount);
      if (!mode) return;
      state.createCollectionBusy = true;
      createCollectionBtn.disabled = true;
      showCreateCollectionModal(mode === 'smart' ? 'Creating smart collection...' : 'Creating collection...');
      try {
        const result = await api(
          mode === 'smart' ? '/api/collections/create-smart-from-actor' : '/api/collections/create-from-actor',
          {
            method: 'POST',
            body: JSON.stringify({
              actor_id: actorId,
              collection_name: actorName,
              role: castRole,
            }),
          },
        );
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
    if (sortBy === 'date') {
      const aDate = String(a.release_date || '');
      const bDate = String(b.release_date || '');
      if (aDate && bDate && aDate !== bDate) return aDate.localeCompare(bDate);
      if (aDate && !bDate) return -1;
      if (!aDate && bDate) return 1;
      return (a.title || '').localeCompare(b.title || '');
    }
    if (sortBy === 'title') {
      return (a.title || '').localeCompare(b.title || '');
    }
    if (sortBy === 'missing') {
      const av = (a.status === 'missing' || a.status === 'new') ? 1 : 0;
      const bv = (b.status === 'missing' || b.status === 'new') ? 1 : 0;
      if (av !== bv) return av - bv;
      return (a.title || '').localeCompare(b.title || '');
    }
    if (sortBy === 'new') {
      const av = a.status === 'new' ? 1 : 0;
      const bv = b.status === 'new' ? 1 : 0;
      if (av !== bv) return av - bv;
      return (a.title || '').localeCompare(b.title || '');
    }
    if (sortBy === 'upcoming') {
      const aDate = a.status === 'upcoming' ? String(a.release_date || '') : '';
      const bDate = b.status === 'upcoming' ? String(b.release_date || '') : '';
      if (aDate && bDate && aDate !== bDate) return aDate.localeCompare(bDate);
      if (aDate && !bDate) return -1;
      if (!aDate && bDate) return 1;
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
      const isNew = movie.status === 'new';
      const isUpcoming = movie.status === 'upcoming';
      const isIgnored = movie.status === 'ignored' || Boolean(movie.ignored);
      const isMissing = movie.status === 'missing' || movie.status === 'new';
      const isToggleableIgnore = movie.status === 'missing' || isIgnored;
      card.className = `movie-card${isNew ? ' has-new' : (isMissing ? ' has-missing' : (isUpcoming ? ' has-upcoming' : ''))}${movie.release_date ? '' : ' no-date'}`;
      const tmdbUrl = movie.tmdb_id ? `https://www.themoviedb.org/movie/${movie.tmdb_id}` : null;
      const downloadUrl = buildDownloadLink('movie', movie.title);
      const allowMovieDownload = Boolean(movie.release_date) && !isFutureDate(movie.release_date);
      const movieDownloadBadge = allowMovieDownload
        ? (
          downloadUrl
            ? `<a class="badge-link badge-overlay badge-download" href="${downloadUrl}" target="_blank" rel="noopener noreferrer">Download <span class="badge-icon badge-icon-download">&#8595;</span></a>`
            : `<span class="badge-link badge-overlay badge-download badge-disabled">Download <span class="badge-icon badge-icon-download">&#8595;</span></span>`
        )
        : '';
      const releaseLabel = movie.release_date ? formatDateDdMmYyyy(movie.release_date) : 'No date';
      const renderMovieStatusBadges = (status) => {
        const badgeNew = status === 'new';
        const badgeUpcoming = status === 'upcoming';
        const badgeMissing = status === 'missing' || status === 'new';
        if (!(badgeNew || badgeUpcoming || badgeMissing)) return '';
        return `
          <div class="status-badges">
            ${badgeNew ? '<span class="new-badge" title="New missing movie" aria-label="New missing movie">NEW</span>' : ''}
            ${badgeUpcoming ? `<span class="upcoming-badge" title="Upcoming movie" aria-label="Upcoming movie">${calendarIconTag('upcoming-badge-icon')}</span>` : ''}
            ${badgeMissing ? '<span class="missing-badge" title="Missing in Plex" aria-label="Missing in Plex">!</span>' : ''}
          </div>
        `;
      };
      card.innerHTML = `
        <div class="poster-wrap">
          ${isToggleableIgnore && movie.tmdb_id ? `<button class="ignore-toggle-btn ignore-toggle-overlay" type="button" data-tmdb-id="${movie.tmdb_id}" data-ignored="${isIgnored ? '1' : '0'}">${isIgnored ? 'Unignore' : 'Ignore'}</button>` : ''}
          <img class="poster" src="${withImageCacheKey(movie.poster_url) || MOVIE_PLACEHOLDER}" alt="${movie.title}" loading="lazy" />
          ${renderMovieStatusBadges(movie.status)}
          ${movie.in_plex ? '<span class="in-plex-badge" title="In Plex" aria-label="In Plex">&#10003;</span>' : ''}
          ${
            movie.in_plex
              ? `<a class="badge-link badge-overlay" href="${movie.plex_web_url}" target="_blank" rel="noopener noreferrer">Plex ${plexLogoTag()}</a>`
              : movieDownloadBadge
          }
        </div>
        <div class="caption">
          <div class="name">${movie.title}</div>
          <div class="year">${releaseLabel}</div>
        </div>
      `;
      if (tmdbUrl) {
        card.addEventListener('click', () => window.open(tmdbUrl, '_blank', 'noopener,noreferrer'));
      }
      const badge = card.querySelector('.badge-overlay');
      if (badge) {
        badge.addEventListener('click', (event) => event.stopPropagation());
      }
      const ignoreToggleBtn = card.querySelector('.ignore-toggle-btn');
      if (ignoreToggleBtn) {
        ignoreToggleBtn.addEventListener('click', async (event) => {
          event.stopPropagation();
          if (ignoreToggleBtn.disabled) return;
          ignoreToggleBtn.disabled = true;
          try {
            const nextIgnored = ignoreToggleBtn.dataset.ignored !== '1';
            const tmdbMovieId = Number(movie.tmdb_id || 0);
            if (!Number.isFinite(tmdbMovieId) || tmdbMovieId <= 0) {
              throw new Error('TMDb id missing for this movie');
            }
            await api(`/api/actors/${actorId}/movies/${tmdbMovieId}/ignore`, {
              method: 'POST',
              body: JSON.stringify({ ignored: nextIgnored }),
            });
            const nextStatus = nextIgnored ? 'ignored' : 'missing';
            movie.status = nextStatus;
            movie.ignored = nextIgnored;
            const statusWrap = card.querySelector('.status-badges');
            const nextStatusHtml = renderMovieStatusBadges(nextStatus);
            if (nextStatusHtml) {
              if (statusWrap) statusWrap.outerHTML = nextStatusHtml;
              else card.querySelector('.poster-wrap').insertAdjacentHTML('beforeend', nextStatusHtml);
            } else if (statusWrap) {
              statusWrap.remove();
            }
            card.classList.remove('has-new', 'has-missing', 'has-upcoming');
            if (nextStatus === 'new') card.classList.add('has-new');
            else if (nextStatus === 'missing') card.classList.add('has-missing');
            else if (nextStatus === 'upcoming') card.classList.add('has-upcoming');
            ignoreToggleBtn.dataset.ignored = nextIgnored ? '1' : '0';
            ignoreToggleBtn.textContent = nextIgnored ? 'Unignore' : 'Ignore';
            const refresh = await api('/api/actors/missing-scan', {
              method: 'POST',
              body: JSON.stringify({ actor_ids: [actorId] }),
            });
            const updated = Array.isArray(refresh.items) ? refresh.items[0] : null;
            if (updated) {
              applyActorMissingScanUpdate(updated);
              for (const role of CAST_ROLES) clearPersistentCache(getActorsCacheKey(role));
            }
            const shouldHideInCurrentFilter = (
              (missingOnly && !(nextStatus === 'missing' || nextStatus === 'new'))
              || (inPlexOnly && !movie.in_plex)
              || (newOnly && nextStatus !== 'new')
              || (upcomingOnly && nextStatus !== 'upcoming')
            );
            if (shouldHideInCurrentFilter) {
              card.remove();
              if (!grid.querySelector('.movie-card')) {
                grid.innerHTML = '<div class="empty">No movies found.</div>';
              }
            }
            ignoreToggleBtn.disabled = false;
          } catch (error) {
            window.alert(error.message);
            ignoreToggleBtn.disabled = false;
          }
        });
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




