// ==UserScript==
// @name         RLSBB Clean Board
// @namespace    https://chatgpt.local/rlsbb-clean-v11
// @version      2.1.2
// @description  Dense-grid RLSBB cleaner with RapidGator-focused cards, click-to-open post lightbox, clickable category filter pills, AllDebrid-unlock download buttons (browser + aria2/NAS) on both RLSBB and the RapidGator file page itself, a protected.to multi-part-RAR helper for the NAS tray's Manual Import, homepage-only recommendation rail, infinite scroll, quality filters, auto-expanded post details, and a site-wide magnet-link helper (AllDebrid caching + browser/local-aria2 download) that works on any page.
// @author       Personal
// @match        https://rlsbb.in/*
// @match        https://www.rlsbb.in/*
// @match        https://post.rlsbb.in/*
// @match        https://search.rlsbb.in/*
// @match        https://rapidgator.net/file/*
// @match        https://www.rapidgator.net/file/*
// @match        http://protected.to/*
// @match        https://protected.to/*
// @match        *://*/*
// @connect      rlsbb.in
// @connect      www.rlsbb.in
// @connect      post.rlsbb.in
// @connect      search.rlsbb.in
// @connect      api.alldebrid.com
// @connect      192.168.0.200
// @connect      127.0.0.1
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_download
// @grant        GM_info
// @grant        GM_setClipboard
// @run-at       document-end
// @downloadURL  https://raw.githubusercontent.com/PhadeDev/RLSBB_Userscript/main/RLSBB_Userscript.user.js
// @updateURL    https://raw.githubusercontent.com/PhadeDev/RLSBB_Userscript/main/RLSBB_Userscript.user.js
// ==/UserScript==

(function () {
  'use strict';

  const STORAGE_KEY = 'rbbCleanBoard.v11';
  const isPostPage = location.hostname.startsWith('post.') || document.body.classList.contains('single-post');
  const isSearchPage = location.hostname.startsWith('search.');
  // Recommended posters only make sense on the true homepage/archive browse view
  const showRecommended = !isPostPage && !isSearchPage;
  const seenIds = new Set();

  let nextPageUrl = '';
  let isLoading = false;
  const state = loadState();

  // ---- in-flight download-op tracking ----
  // AllDebrid unlock (and, worse, magnet caching, which can poll for up to 10 minutes) only
  // exists as JS running in this tab -- if the tab is closed or navigated away mid-unlock, that
  // work is genuinely lost and has to be started over. Once a browser download or aria2 send-off
  // has actually been kicked off, though, it keeps running independently (the browser's own
  // download manager, or the aria2 daemon) and the tab is safe to close. This counter plus the
  // beforeunload listener below turns "is it safe to close this?" from a guess into a real
  // browser-native confirmation prompt during the risky window only.
  let activeDownloadOps = 0;
  function beginDownloadOp() { activeDownloadOps += 1; }
  function endDownloadOp() { activeDownloadOps = Math.max(0, activeDownloadOps - 1); }

  window.addEventListener('beforeunload', event => {
    if (activeDownloadOps > 0) {
      event.preventDefault();
      event.returnValue = '';
    }
  });

  // Ticks a status element every second with a live elapsed-seconds count instead of a single
  // static "Unlocking..." label that never changes -- the actual complaint being answered here
  // is "I can't tell if this is frozen or just slow." Returns a stop function.
  function startElapsedTicker(statusEl, prefix) {
    const startedAt = Date.now();
    const tick = () => {
      if (!statusEl) return;
      const secs = Math.floor((Date.now() - startedAt) / 1000);
      statusEl.textContent = `${prefix} ${secs}s`;
      statusEl.title = secs < 8
        ? 'Unlocking via AllDebrid -- keep this tab open until it says Started/Sent.'
        : 'Some hosts take 30s+ to unlock via AllDebrid. Keep this tab open -- check the console (F12) for live progress.';
    };
    tick();
    const intervalId = setInterval(tick, 1000);
    return () => clearInterval(intervalId);
  }

  function defaultState() {
    return {
      q: '',
      categoryFilter: '',
      sort: 'newest',
      hideSupport: true,
      hideApps: true,
      hideTv: false,
      hideGames: false,
      hideMagazines: true,
      rgOnly: false,
      categoriesOpen: false,
      recommendedOpen: true,
      commentsOpen: true,
      versionFilters: {
        '1080p': false,
        '4k': false,
        'hdr': false,
        'dv': false,
        'x265': false,
        'webdl': false
      }
    };
  }

  function loadState() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
      const base = defaultState();

      return {
        ...base,
        ...saved,
        versionFilters: {
          ...base.versionFilters,
          ...(saved.versionFilters || {})
        }
      };
    } catch {
      return defaultState();
    }
  }

  function saveState() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }

  // Shown in the topbar so it's obvious from a screenshot whether Tampermonkey has actually
  // picked up the latest version — its auto-update check isn't instant even with
  // @updateURL/@downloadURL set correctly.
  function scriptVersion() {
    try {
      return (typeof GM_info !== 'undefined' && GM_info.script && GM_info.script.version) || '?';
    } catch {
      return '?';
    }
  }

  // ---- download settings: AllDebrid API key + aria2 RPC, stored via GM_setValue so they
  // never touch the (public) GitHub repo — entered once through the Settings dialog ----
  function getSetting(key, fallback) {
    if (typeof GM_getValue === 'function') return GM_getValue(key, fallback);
    return localStorage.getItem('rbb_' + key) ?? fallback;
  }

  function setSetting(key, value) {
    if (typeof GM_setValue === 'function') GM_setValue(key, value);
    else localStorage.setItem('rbb_' + key, value);
  }

  function getDownloadSettings() {
    return {
      allDebridKey: getSetting('allDebridKey', ''),
      aria2Rpc: getSetting('aria2Rpc', 'http://192.168.0.200:6800/jsonrpc'),
      aria2Secret: getSetting('aria2Secret', ''),
      // Separate local aria2 instance (runs on this PC, not the NAS) so magnet downloads can
      // land in a folder you pick, rather than the NAS pipeline's fixed 2SORT path.
      localAria2Rpc: getSetting('localAria2Rpc', 'http://127.0.0.1:6802/jsonrpc'),
      localAria2Secret: getSetting('localAria2Secret', ''),
      localAria2Dir: getSetting('localAria2Dir', '/home/Phaderon/Downloads')
    };
  }

  function init() {
    const articles = [...document.querySelectorAll('#post-wrapper article, article.post')];

    if (!articles.length) {
      console.warn('RBB Clean v11: no posts found; leaving original page untouched.');
      return;
    }

    const recommendedItems = showRecommended ? extractRecommendedItems(document) : [];

    injectStyles();
    if (!isPostPage) injectLightbox();
    injectSettingsDialog();
    bindDownloadButtons();
    bindCategoryPills();
    document.body.classList.add('rbb-clean-body', isPostPage ? 'rbb-post-mode' : 'rbb-feed-mode');

    nextPageUrl = findNextPageUrl(document);

    const originalMain = document.querySelector('#main') || document.body;
    const originalSearch = document.querySelector('#HideSearch, form.search-form');
    const categoryWidget = findCategoryWidget();

    const app = document.createElement('section');
    app.id = 'rbb-clean';
    app.innerHTML = makeShell();

    originalMain.prepend(app);

    mountSearch(app, originalSearch);
    mountCategories(app, categoryWidget);
    if (showRecommended) mountRecommended(app, recommendedItems);

    const grid = app.querySelector('[data-grid]');
    articles.forEach(article => appendArticle(article, grid));

    bindUi(app);
    applyFiltersAndSort();

    hideOriginalPageSafely();

    if (showRecommended) {
      refreshRecommendedRail();
      watchRecommendedRail();
    }

    hidePosterWallsSafely();

    if (isPostPage) {
      autoExpandPostPageSections();
    }

    if (!isPostPage) setupInfiniteScroll(grid);
  }

  // ---- RapidGator file-page companion: adds its own Download/To NAS buttons directly on the
  // page you land on after clicking through a protected.to link, since RapidGator's own free-
  // download flow has no automatable button at all. Pre-fills a rename box with whichever
  // release name was most recently clicked from RLSBB (see rememberPendingReleaseName()),
  // since RapidGator's own filename is frequently a cryptic abbreviation. ----
  function initRapidGatorPage() {
    const fileLink = document.querySelector('.file-descr a');
    if (!fileLink) return; // not an actual file page (login/premium/etc.) — leave it alone

    injectStyles();
    injectSettingsDialog();

    const rawFilename = cleanText(fileLink.textContent) || document.title.replace(/^Download file\s*/i, '') || 'download';
    const sizeMatch = document.body.textContent.match(/File size:\s*([\d.,]+\s*[KMGT]?B)/i);
    const fileSize = sizeMatch ? sizeMatch[1] : '';

    const recent = getRecentReleaseNames();
    const suggestedName = recent[0]?.name || '';

    const panel = document.createElement('div');
    panel.id = 'rbb-rg-panel';
    panel.className = 'rbb-card rbb-detail-card rbb-rg-page-panel';
    panel.innerHTML = `
      <div class="rbb-content">
        <h2 class="rbb-card-title">RLSBB Clean Board</h2>
        <p class="rbb-description" style="max-width:none;">
          Detected file: <strong>${esc(rawFilename)}</strong>${fileSize ? ` &middot; ${esc(fileSize)}` : ''}
        </p>
        ${suggestedName ? `<p class="rbb-description" style="max-width:none; color:#9ef0c8;">Guessed from a recent RLSBB click: <strong>${esc(suggestedName)}</strong></p>` : ''}
        <label class="rbb-settings-field">
          <span>Save as</span>
          <input type="text" id="rbb-rg-filename" value="${escAttr(suggestedName || rawFilename)}">
        </label>
        <div class="rbb-settings-actions" style="justify-content:flex-start; gap:10px; margin-top:10px;">
          <button type="button" class="rbb-dl-btn rbb-dl-browser" id="rbb-rg-download" style="width:auto; flex-direction:row; padding:8px 14px;">
            <span class="rbb-dl-icon" aria-hidden="true">&#8595;</span><span class="rbb-dl-label">Download</span>
          </button>
          <button type="button" class="rbb-dl-btn rbb-dl-aria2" id="rbb-rg-tonas" style="width:auto; flex-direction:row; padding:8px 14px;">
            <span class="rbb-dl-icon" aria-hidden="true">&#8677;</span><span class="rbb-dl-label">To NAS</span>
          </button>
          <button type="button" class="rbb-settings-btn" id="rbb-rg-settings" title="Download settings (AllDebrid + aria2)" style="height:auto; padding:6px 10px; font-size:14px;">&#9881;</button>
        </div>
        <span class="rbb-dl-status" id="rbb-rg-status" style="display:block; text-align:left; margin-top:8px;"></span>
        <span class="rbb-dl-progress" id="rbb-rg-progress" style="max-width:260px;"></span>
      </div>
    `;

    const anchor = document.querySelector('.file-descr') || document.body.firstElementChild;
    anchor.parentNode.insertBefore(panel, anchor);

    document.getElementById('rbb-rg-download').addEventListener('click', () => runRapidGatorDownload('browser'));
    document.getElementById('rbb-rg-tonas').addEventListener('click', () => runRapidGatorDownload('aria2'));
    document.getElementById('rbb-rg-settings').addEventListener('click', openSettingsDialog);
  }

  async function runRapidGatorDownload(mode) {
    const input = document.getElementById('rbb-rg-filename');
    const button = document.getElementById(mode === 'aria2' ? 'rbb-rg-tonas' : 'rbb-rg-download');
    const status = document.getElementById('rbb-rg-status');
    const progress = document.getElementById('rbb-rg-progress');
    const chosenName = (input.value || '').trim() || 'download';

    beginDownloadOp();
    button.disabled = true;
    button.classList.add('rbb-dl-busy');
    status.classList.remove('rbb-dl-error');
    if (progress) progress.classList.add('rbb-dl-progress-active');
    const stopTicker = startElapsedTicker(status, 'Unlocking…');

    try {
      const unlocked = await allDebridUnlock(location.href);
      stopTicker();

      // preserve the real file extension even if the user's chosen name doesn't include one
      const finalName = /\.[a-z0-9]{2,4}$/i.test(chosenName)
        ? chosenName
        : chosenName + guessExtension(unlocked.filename);

      const seconds = (unlocked.elapsedMs / 1000).toFixed(1);

      if (mode === 'browser') {
        await browserDownload(unlocked.link, finalName);
        status.textContent = `Started ✓ ${seconds}s`;
        status.title = 'Safe to close this tab now.';
      } else {
        await aria2AddUri(unlocked.link, finalName);
        status.textContent = `Sent ✓ ${seconds}s`;
        status.title = 'Safe to close this tab now.';
      }
    } catch (error) {
      stopTicker();
      logError('RapidGator page download failed:', error);
      status.textContent = error.code === 'LINK_DOWN' ? '❌ File removed from host' : (error.message || 'Failed');
      status.classList.add('rbb-dl-error');
    } finally {
      endDownloadOp();
      button.disabled = false;
      button.classList.remove('rbb-dl-busy');
      if (progress) progress.classList.remove('rbb-dl-progress-active');
    }
  }

  function guessExtension(filename) {
    const match = /\.[a-z0-9]{2,4}$/i.exec(filename || '');
    return match ? match[0] : '';
  }

  // ---- protected.to multi-part splitter page ("Ncrypt Application") ----
  // Some protected.to releases (usually multi-part RARs) land you on a page listing every
  // real rapidgator.net link directly instead of one link to click through. AllDebrid can't
  // batch-unlock+extract these from the browser (that needs real filesystem/7z access), but
  // the user's existing NAS pipeline (rlsbb-watcher.py --queue-direct-url, wired into the tray
  // app's new Manual Import button) already does exactly that. This just detects the page and
  // copies a ready-to-paste block (title + every link) to the clipboard for it.
  function initProtectedToPage() {
    const heading = document.querySelector('.Encrypted-folder');
    const linkNodes = [...document.querySelectorAll('.Encrypted-box .links a[href]')];
    if (!heading || !linkNodes.length) return; // not a splitter page at all — leave alone

    const headingText = cleanText(heading.textContent);
    const sizeMatch = headingText.match(/\[\s*([^\]]+?)\s*\]\s*$/);
    const releaseName = cleanText(headingText.replace(/\[[^\]]*\]\s*$/, ''));
    const size = sizeMatch ? sizeMatch[1] : '';
    const links = linkNodes.map(a => a.href);

    // same cross-page memory used for the RapidGator page's smart rename, in case the user
    // clicks straight into a part instead of using the tray — worth doing even when there's
    // only one link, since the name is already known regardless of how many hops follow
    rememberPendingReleaseName(releaseName);

    // A single link here is usually just another intermediate protected.to hop, not a real
    // multi-part release — showing "split into 1 part" in that case was actively misleading
    // (implied there was something to copy/paste when there wasn't). Only show the panel for
    // genuine multi-part releases; for one link, stay out of the way and let the user click
    // through normally.
    if (links.length < 2) return;

    injectStyles();

    const panel = document.createElement('div');
    panel.id = 'rbb-protected-panel';
    panel.className = 'rbb-card rbb-detail-card rbb-rg-page-panel';
    panel.innerHTML = `
      <div class="rbb-content">
        <h2 class="rbb-card-title">RLSBB Clean Board</h2>
        <p class="rbb-description" style="max-width:none;">
          This release is split into <strong>${links.length}</strong> part${links.length === 1 ? '' : 's'}:
          <strong>${esc(releaseName)}</strong>${size ? ` &middot; ${esc(size)}` : ''}
        </p>
        <p class="rbb-description" style="max-width:none;">
          AllDebrid can unlock each part, but auto-extracting a multi-part RAR needs real filesystem
          access a browser doesn't have — your NAS pipeline already does this via the tray app's
          <strong>Manual Import</strong> (paste icon next to Settings). Copy below, then paste there.
        </p>
        <div class="rbb-settings-actions" style="justify-content:flex-start; gap:10px; margin-top:6px;">
          <button type="button" class="rbb-dl-btn rbb-dl-aria2" id="rbb-protected-copy" style="width:auto; flex-direction:row; padding:8px 14px;">
            <span class="rbb-dl-icon" aria-hidden="true">&#128203;</span><span class="rbb-dl-label">Copy for tray Manual Import</span>
          </button>
        </div>
        <span class="rbb-dl-status" id="rbb-protected-status" style="display:block; text-align:left; margin-top:8px;"></span>
      </div>
    `;

    const anchor = document.querySelector('.Encrypted-box')?.closest('.panel') || document.body.firstElementChild;
    anchor.parentNode.insertBefore(panel, anchor);

    document.getElementById('rbb-protected-copy').addEventListener('click', () => {
      const status = document.getElementById('rbb-protected-status');
      const clipboardText = [releaseName, ...links].join('\n');

      if (typeof GM_setClipboard === 'function') {
        GM_setClipboard(clipboardText);
        status.textContent = 'Copied ✓ — paste into the tray\'s Manual Import';
        status.classList.remove('rbb-dl-error');
      } else {
        status.textContent = 'Clipboard unavailable — copy the links manually';
        status.classList.add('rbb-dl-error');
      }
    });
  }

  function makeShell() {
    return `
      <header class="rbb-topbar">
        <div class="rbb-brand">
          <div class="rbb-logo">RBB</div>
          <div>
            <div class="rbb-title">ReleaseBB</div>
            <div class="rbb-subtitle">${isPostPage ? 'detail picker' : 'release picker'} &middot; v${escAttr(scriptVersion())}</div>
          </div>
        </div>

        <div class="rbb-search" data-search></div>

        <details class="rbb-menu" ${state.categoriesOpen ? 'open' : ''}>
          <summary>Categories</summary>
          <div class="rbb-menu-panel" data-categories></div>
        </details>

        <button type="button" class="rbb-settings-btn" data-open-settings title="Download settings (AllDebrid + aria2)">&#9881;</button>
      </header>

      ${isPostPage ? '' : `
        <nav class="rbb-filters">
          <input class="rbb-filter-input" data-filter="q" type="search" placeholder="Filter cards…" value="${escAttr(state.q)}">

          <select class="rbb-sort" data-filter="sort">
            <option value="newest" ${state.sort === 'newest' ? 'selected' : ''}>Newest first</option>
            <option value="oldest" ${state.sort === 'oldest' ? 'selected' : ''}>Oldest first</option>
            <option value="az" ${state.sort === 'az' ? 'selected' : ''}>Title A–Z</option>
            <option value="za" ${state.sort === 'za' ? 'selected' : ''}>Title Z–A</option>
          </select>

          <div class="rbb-version-filter-group">
            ${versionToggle('1080p', '1080p')}
            ${versionToggle('4k', '4K')}
            ${versionToggle('hdr', 'HDR')}
            ${versionToggle('dv', 'DV')}
            ${versionToggle('x265', 'x265')}
            ${versionToggle('webdl', 'WEB-DL')}
          </div>

          ${toggle('hideSupport', 'Hide support')}
          ${toggle('hideApps', 'Hide apps')}
          ${toggle('hideTv', 'Hide TV')}
          ${toggle('hideGames', 'Hide games')}
          ${toggle('hideMagazines', 'Hide mags')}
          ${toggle('rgOnly', 'RG only')}
        </nav>
      `}

      <div class="rbb-layout ${showRecommended ? '' : 'rbb-layout-full'}">
        <main class="rbb-grid" data-grid></main>
        ${showRecommended ? '<aside class="rbb-side" data-side></aside>' : ''}
      </div>

      <div class="rbb-loader" data-loader hidden>Loading more…</div>
    `;
  }

  function toggle(key, label) {
    return `
      <label class="rbb-toggle">
        <input data-filter="${key}" type="checkbox" ${state[key] ? 'checked' : ''}>
        <span>${label}</span>
      </label>
    `;
  }

  function versionToggle(key, label) {
    return `
      <label class="rbb-version-toggle rbb-version-${key}">
        <input data-version-filter="${key}" type="checkbox" ${state.versionFilters[key] ? 'checked' : ''}>
        <span>${label}</span>
      </label>
    `;
  }

  function mountSearch(app, originalSearch) {
    const mount = app.querySelector('[data-search]');

    if (!originalSearch) {
      mount.innerHTML = `
        <form action="https://search.rlsbb.in/" method="get" class="rbb-site-search">
          <input name="s" type="search" placeholder="Search title / keyword / IMDb ID">
          <button type="submit">Search</button>
        </form>
      `;
      return;
    }

    const clone = originalSearch.cloneNode(true);
    clone.id = 'rbb-site-search';
    clone.className = 'rbb-site-search';

    const input = clone.querySelector('input[type="search"], input[name="s"]');
    if (input) {
      input.placeholder = 'Search title / keyword / IMDb ID';
      input.autocomplete = 'off';
    }

    const button = clone.querySelector('button, input[type="submit"]');
    if (button) {
      button.textContent = 'Search';
      button.value = 'Search';
    }

    mount.appendChild(clone);
  }

  function mountCategories(app, widget) {
    const mount = app.querySelector('[data-categories]');
    if (!mount) return;

    if (!widget) {
      mount.innerHTML = `
        <a href="https://rlsbb.in/category/movies/">Movies</a>
        <a href="https://rlsbb.in/category/tv-shows/">TV Shows</a>
        <a href="https://rlsbb.in/category/games/">Games</a>
        <a href="https://rlsbb.in/category/applications/">Applications</a>
      `;
      return;
    }

    const clone = widget.cloneNode(true);
    clone.querySelectorAll('h1,h2,h3,.widget-title,script,iframe,style').forEach(n => n.remove());
    mount.appendChild(clone);
  }

  function mountRecommended(app, items) {
    const side = app.querySelector('[data-side]');
    if (!side) return;

    side.innerHTML = '';

    const box = document.createElement('details');
    box.className = 'rbb-recommended';
    box.open = !!state.recommendedOpen;

    box.innerHTML = `
      <summary>Recommended</summary>
      <div class="rbb-recommended-scroll" data-recommended-scroll>
        ${items.length ? items.map(item => recommendedItemHtml(item)).join('') : ''}
      </div>
      <div class="rbb-recommended-empty" data-recommended-empty ${items.length ? 'hidden' : ''}>
        Looking for posters…
      </div>
    `;

    side.appendChild(box);

    box.addEventListener('toggle', () => {
      state.recommendedOpen = box.open;
      saveState();
    });

    dedupeRecommendedRail();
  }

  function recommendedItemHtml(item) {
    return `
      <a class="rbb-rec-item" href="${escAttr(item.href)}" target="_blank" rel="noopener noreferrer" title="${escAttr(item.title)}">
        <img src="${escAttr(item.src)}" alt="">
      </a>
    `;
  }

  function appendArticle(article, grid, doc = document) {
    const data = extractArticle(article, doc);

    if (!data.id || seenIds.has(data.id)) return;
    seenIds.add(data.id);

    const card = document.createElement('article');
    card.className = isPostPage ? 'rbb-card rbb-detail-card' : 'rbb-card';

    card.dataset.id = data.id;
    card.dataset.title = data.title.toLowerCase();
    card.dataset.text = data.fullText.toLowerCase();
    card.dataset.categories = data.categories.join(' ').toLowerCase();
    card.dataset.hasRg = data.rgLinks.length ? '1' : '0';
    card.dataset.timestamp = data.timestamp ? String(data.timestamp) : '0';

    const bestRelease = chooseBestRelease(data.releases);
    const otherReleases = data.releases.filter(r => r !== bestRelease);

    const bestRow = bestRelease
      ? makeReleaseRow(bestRelease, true)
      : `<p class="rbb-muted">No RapidGator versions found.</p>`;

    const allRows = otherReleases.length
      ? otherReleases.map(release => makeReleaseRow(release, false)).join('')
      : '';

    const showAll = otherReleases.length
      ? `
        <details class="rbb-all-versions" ${isPostPage ? 'open' : ''}>
          <summary>${isPostPage ? 'All other versions' : 'Show all versions'} (${data.releases.length})</summary>
          <div class="rbb-all-version-list">
            ${allRows}
          </div>
        </details>
      `
      : '';

    card.innerHTML = `
      <a class="rbb-image" href="${escAttr(data.url)}" target="_blank" rel="noopener noreferrer">
        ${data.image ? `<img src="${escAttr(data.image)}" alt="">` : `<div class="rbb-no-image">No image</div>`}
      </a>

      <div class="rbb-content">
        <h2 class="rbb-card-title">
          <a href="${escAttr(data.url)}" target="_blank" rel="noopener noreferrer">${esc(data.title)}</a>
        </h2>

        <div class="rbb-top-meta">
          <div class="rbb-cats">
            ${data.categories.slice(0, 3).map(c => `<button type="button" class="rbb-cat-pill" data-category="${escAttr(c.toLowerCase())}" title="Filter to ${escAttr(c)}">${esc(c)}</button>`).join('')}
          </div>
          <div class="rbb-date-line">
            <strong>${data.postedAbsolute ? esc(data.postedAbsolute) : 'Date unknown'}</strong>
            ${data.postedRelative ? `<span class="rbb-relative">${esc(data.postedRelative)}</span>` : ''}
            ${data.author ? `<span>by ${esc(data.author)}</span>` : ''}
          </div>
        </div>

        <div class="rbb-badges">
          ${data.cardBadges.map(chipHtml).join('')}
        </div>

        ${data.description ? `<p class="rbb-description">${esc(data.description)}</p>` : ''}

        <section class="rbb-release-list">
          <div class="rbb-release-heading">
            <h3>Best RapidGator version</h3>
            <span>${data.releases.length} found</span>
          </div>
          ${bestRow}
          ${showAll}
        </section>

        <details class="rbb-comments" data-comments-url="${escAttr(data.commentsUrl || data.url + '#comments')}" ${isPostPage ? 'open' : ''}>
          <summary>${esc(data.commentsText || 'Comments')}</summary>
          <div class="rbb-comments-body">${isPostPage ? 'Loading original comments…' : 'Open to load comments…'}</div>
        </details>

        <footer class="rbb-footer">
          ${isPostPage ? `<span>${data.tag ? esc(data.tag) : ''}</span>` : `<a class="rbb-open-post-link" href="${escAttr(data.url)}" target="_blank" rel="noopener noreferrer">Open post</a>`}
          ${!isPostPage && data.tag ? `<span>${esc(data.tag)}</span>` : ''}
        </footer>
      </div>

      <div class="rbb-extension-bridge" aria-hidden="true"></div>
    `;

    const bridge = card.querySelector('.rbb-extension-bridge');

    [...data.rgLinks, ...data.commentRgLinks].forEach(link => {
      const a = document.createElement('a');
      a.href = link.href;
      a.textContent = link.label || 'RapidGator';
      a.className = link.className || 'host-rapidgator';
      if (link.rlsId) a.dataset.rlsId = link.rlsId;
      bridge.appendChild(a);
    });

    const comments = card.querySelector('.rbb-comments');
    if (comments) {
      comments.addEventListener('toggle', event => {
        state.commentsOpen = event.currentTarget.open;
        saveState();

        if (event.currentTarget.open) {
          if (isPostPage) showExistingComments(event.currentTarget);
          else loadComments(event.currentTarget);
        }
      });

      if (isPostPage) {
        setTimeout(() => showExistingComments(comments), 0);
      }
    }

    if (!isPostPage) {
      card.classList.add('rbb-card-clickable');
      card.addEventListener('click', event => {
        // Let native <details> toggles and explicit "escape" actions (download buttons,
        // NFO/screenshot extras, comment-RG links, and the footer's "Open post" link) behave
        // normally. Everything else — including the image and title <a> tags, which have real
        // hrefs to the post — should open the lightbox instead of navigating away.
        if (event.target.closest('summary, button, .rbb-mini-extra, .rbb-comment-rg-link, .rbb-open-post-link, .rbb-dl-protected')) {
          return;
        }

        const link = event.target.closest('a');
        if (link) event.preventDefault();

        openLightbox(card, data);
      });
    }

    grid.appendChild(card);
  }

  function makeReleaseRow(release, isBest) {
    const chips = release.badges.map(chipHtml).join('');

    // AllDebrid unlocks whichever RapidGator link is first on the row — no need to also show
    // the raw RapidGator/Backup links, or a separate button per mirror; the download buttons
    // below replace all of that with one clear action per release. Prefer a real rapidgator.net
    // link over a protected.to wrapper if both exist, since AllDebrid can only unlock the former.
    const primaryRgLink = release.rgLinks.find(link => !link.isProtected) || release.rgLinks[0];

    let downloadButtons;
    if (!primaryRgLink) {
      downloadButtons = `<span class="rbb-no-rg">No RapidGator link found</span>`;
    } else if (primaryRgLink.isProtected) {
      // protected.to is a manual click-through page (ads/captcha) — AllDebrid can't unlock it,
      // so this just opens it in a new tab instead of pretending it can be automated.
      downloadButtons = `
        <a class="rbb-dl-btn rbb-dl-protected" data-rg-name="${escAttr(release.name)}" href="${escAttr(primaryRgLink.href)}" target="_blank" rel="noopener noreferrer" title="protected.to requires manually clicking through in a new tab — AllDebrid cannot unlock it automatically">
          <span class="rbb-dl-icon" aria-hidden="true">&#8599;</span><span class="rbb-dl-label">protected.to</span>
        </a>
      `;
    } else {
      downloadButtons = `
        <button type="button" class="rbb-dl-btn rbb-dl-browser" data-rg-url="${escAttr(primaryRgLink.href)}" data-rg-name="${escAttr(release.name)}" title="Unlock via AllDebrid, then download in your browser">
          <span class="rbb-dl-icon" aria-hidden="true">&#8595;</span><span class="rbb-dl-label">Download</span>
        </button>
        <button type="button" class="rbb-dl-btn rbb-dl-aria2" data-rg-url="${escAttr(primaryRgLink.href)}" data-rg-name="${escAttr(release.name)}" title="Unlock via AllDebrid, then send to the NAS (aria2)">
          <span class="rbb-dl-icon" aria-hidden="true">&#8677;</span><span class="rbb-dl-label">To NAS</span>
        </button>
      `;
    }

    const extras = release.extraLinks.length
      ? release.extraLinks.slice(0, 2).map(link => `
        <a class="rbb-mini-extra" href="${escAttr(link.href)}" target="_blank" rel="noopener noreferrer" title="${escAttr(link.label)}">
          ${esc(shortExtraLabel(link.label))}
        </a>
      `).join('')
      : '';

    const tokens = release.tokens.join(' ');
    const primaryQuality = release.primaryQuality || 'Release';

    return `
      <div class="rbb-release-row ${isBest ? 'rbb-best-row' : ''}" data-version-tokens="${escAttr(tokens)}">
        <div class="rbb-quality-block">
          <div class="rbb-quality-label rbb-quality-${escAttr(chipKey(primaryQuality))}">${esc(primaryQuality)}</div>
          <div class="rbb-size-badge">${esc(release.size || 'size unknown')}</div>
        </div>

        <div class="rbb-release-main">
          <div class="rbb-release-name">${esc(release.name || 'Unknown release')}</div>
          <div class="rbb-release-meta">
            ${release.format ? `<span>${esc(release.format)}</span>` : ''}
            ${release.audio ? `<span>${esc(release.audio)}</span>` : ''}
          </div>
          <div class="rbb-release-badges">${chips}</div>
        </div>

        <div class="rbb-release-actions">
          <div class="rbb-release-rg">${downloadButtons}</div>
          ${extras ? `<div class="rbb-release-extras">${extras}</div>` : ''}
          <span class="rbb-dl-status" data-dl-status></span>
          <span class="rbb-dl-progress" data-dl-progress></span>
        </div>
      </div>
    `;
  }

  function chooseBestRelease(releases) {
    if (!releases.length) return null;
    return [...releases].sort((a, b) => bestReleaseScore(b) - bestReleaseScore(a))[0];
  }

  function bestReleaseScore(release) {
    const text = `${release.name} ${release.badges.join(' ')} ${release.tokens.join(' ')}`.toLowerCase();
    const sizeMb = sizeToMb(release.size);

    let score = 0;

    const is4k = /4k|2160p|uhd/.test(text);
    const is1080 = /1080p/.test(text);
    const is720 = /720p/.test(text);
    const is480 = /480p/.test(text);
    const isHdr = /\bhdr\b/.test(text);
    const isDv = /\bdv\b|dolby vision/.test(text);
    const isX265 = /x265|h265|hevc/.test(text);
    const isWebDl = /web[- ]?dl/.test(text);
    const isBluray = /bluray|bdrip/.test(text);

    if (is4k && isHdr && !isDv) score += 10000;
    else if (is4k && !isDv) score += 9000;
    else if (is4k && isDv) score += 8200;
    else if (is1080 && isHdr && !isDv) score += 7000;
    else if (is1080 && isX265) score += 6500;
    else if (is1080) score += 6000;
    else if (is720) score += 3500;
    else if (is480) score += 1500;
    else score += 500;

    if (isHdr && !isDv) score += 300;
    if (isDv) score -= 250;
    if (isX265) score += 120;
    if (isWebDl) score += 90;
    if (isBluray) score += 70;

    if (sizeMb > 0) {
      score += Math.min(sizeMb / 50, 120);
    }

    return score;
  }

  function chipHtml(label) {
    const key = chipKey(label);
    return `<span class="rbb-chip rbb-chip-${escAttr(key)}">${esc(label)}</span>`;
  }

  function chipKey(label) {
    const text = String(label || '').toLowerCase();
    if (text === '4k' || text === '2160p') return '4k';
    if (text === '1080p') return '1080p';
    if (text === '720p') return '720p';
    if (text === '480p') return '480p';
    if (text === 'hdr') return 'hdr';
    if (text === 'dv') return 'dv';
    if (text === 'x265' || text === 'hevc') return 'x265';
    if (text === 'x264') return 'x264';
    if (text === 'web-dl') return 'webdl';
    if (text === 'webrip') return 'webrip';
    if (text === 'bluray') return 'bluray';
    if (text === 'atmos') return 'atmos';
    return 'default';
  }

  function extractArticle(article, doc = document) {
    const titleLink = article.querySelector('.entry-title a, h1 a, h2 a, a[rel="bookmark"]');
    const titleNode = article.querySelector('.entry-title, h1, h2');
    const title = cleanText(titleLink?.textContent || titleNode?.textContent || doc.title.replace(/– ReleaseBB| - ReleaseBB/i, '') || 'Untitled');

    const url = abs(titleLink?.href || location.href);
    const id = article.id || url;

    const content = article.querySelector('.entry-summary, .entry-content') || article;
    const metaNode = article.querySelector('.entry-meta-header-after, .entry-meta-header-before, .entry-meta');
    const meta = cleanText(metaNode?.textContent || '');

    const author = cleanText(metaNode?.querySelector('a[href*="/author/"]')?.textContent || '');

    const categories = [...article.querySelectorAll('.entry-meta a[rel="category tag"], a[rel="category tag"]')]
      .map(a => cleanText(a.textContent))
      .filter(Boolean);

    const tag = cleanText(doc.querySelector('.postTags a')?.textContent || article.querySelector('.postTags a')?.textContent || '');
    const comments = doc.querySelector('.postComments a, a[href$="#comments"], a[href*="#comments"]') || article.querySelector('.postComments a, a[href$="#comments"], a[href*="#comments"]');

    const firstImg = findMainImage(content);
    const releases = extractReleases(content);

    const rgLinks = dedupeLinks(releases.flatMap(release => release.rgLinks));
    const commentRgLinks = extractCommentRapidGatorLinks(doc);

    const postedAbsolute = extractAbsoluteDate(meta, article);
    const postedDate = parsePostedDate(postedAbsolute);

    const readableText = getReadableText(content);
    const description = extractDescription(content);
    const cardBadges = detectBadges(title + ' ' + readableText);

    return {
      id,
      title,
      url,
      image: firstImg ? abs(firstImg.currentSrc || firstImg.src) : '',
      meta,
      author,
      postedAbsolute,
      timestamp: postedDate ? postedDate.getTime() : 0,
      postedRelative: postedDate ? relativeTime(postedDate) : '',
      categories,
      tag,
      commentsUrl: comments ? abs(comments.href) : '',
      commentsText: cleanText(comments?.textContent || ''),
      rgLinks,
      commentRgLinks,
      releases,
      description,
      cardBadges,
      fullText: article.textContent || ''
    };
  }

  function extractReleases(content) {
    const releases = [];
    const paragraphs = [...content.querySelectorAll('p')];
    // Some posts have malformed nested <p> tags in the source HTML, which the browser
    // auto-closes into two separate sibling <p>s: one with "Release Name: X" and no
    // RapidGator link, immediately followed by one with "Download: ...RAPIDGATOR" and
    // no name. Carry the name forward one paragraph so the Download-only segment isn't
    // rejected for having "Download" as its derived name.
    let pendingReleaseName = '';

    for (const p of paragraphs) {
      const segments = segmentParagraphIntoReleases(p);
      let paragraphHasRgLink = false;

      for (const segment of segments) {
        const rgAnchors = segment.anchors.filter(isRapidGatorLink);
        if (!rgAnchors.length) continue;
        paragraphHasRgLink = true;

        let releaseName = segment.name || deriveReleaseName(segment.text);
        releaseName = cleanReleaseName(releaseName);

        if ((!releaseName || /nitroflare|download|single file|rapidgator backup/i.test(releaseName)) && pendingReleaseName) {
          releaseName = pendingReleaseName;
        }

        if (!releaseName || /nitroflare|download|single file|rapidgator backup/i.test(releaseName)) {
          continue;
        }

        const info = extractReleaseInfo(segment.text);
        const badges = detectBadges(`${releaseName} ${segment.text}`);
        const tokens = badgesToTokens(badges, `${releaseName} ${segment.text}`);
        const primaryQuality = getPrimaryQuality(badges, releaseName);

        const rgLinks = rgAnchors.map(a => ({
          href: abs(a.href),
          label: cleanText(a.textContent) || 'RapidGator',
          className: a.className || 'host-rapidgator',
          rlsId: a.dataset?.rlsId || a.getAttribute('data_rls_id') || '',
          // protected.to is a manual click-through wrapper (ads/captcha) around the real
          // RapidGator link — AllDebrid can't unlock it directly, so it needs a plain "open
          // in a new tab" action instead of the automated unlock buttons.
          isProtected: /protected\.to/i.test(a.href)
        }));

        const extraLinks = segment.anchors
          .filter(isUsefulSmallExtraLink)
          .map(anchorToExtra);

        releases.push({
          name: releaseName || 'Release',
          format: info.format,
          audio: info.audio,
          size: info.size,
          badges,
          tokens,
          primaryQuality,
          rgLinks,
          extraLinks
        });
      }

      if (paragraphHasRgLink) {
        pendingReleaseName = '';
      } else {
        // Only overwrite pendingReleaseName when this paragraph actually names a release --
        // some posts have an unrelated paragraph (e.g. "Links: iMDB | Trailer | NFO") sitting
        // between the "Release Name:" paragraph and the "Download:" paragraph that needs it;
        // wiping the name here on no-match dropped that release entirely.
        const nameMatch = p.textContent.match(/release\s*name\s*:\s*([^]*?)(?=size\s*:|links\s*:|download\s*:|$)/i);
        if (nameMatch) pendingReleaseName = cleanReleaseName(cleanText(nameMatch[1]));
      }
    }

    return mergeDuplicateReleases(releases);
  }

  function segmentParagraphIntoReleases(p) {
    const segments = [];
    let current = null;

    const pushCurrent = () => {
      if (!current) return;
      current.text = cleanText(current.textParts.join(' '));
      segments.push(current);
      current = null;
    };

    const ensureCurrent = () => {
      if (!current) {
        current = {
          name: '',
          textParts: [],
          anchors: []
        };
      }
      return current;
    };

    [...p.childNodes].forEach(node => {
      const nodeText = cleanText(node.textContent || '');
      const isElement = node.nodeType === 1;
      const tagName = isElement ? node.tagName.toLowerCase() : '';

      if ((tagName === 'strong' || tagName === 'b') && looksLikeReleaseName(nodeText)) {
        pushCurrent();
        current = {
          name: nodeText,
          textParts: [nodeText],
          anchors: []
        };
        return;
      }

      const active = ensureCurrent();

      if (nodeText) active.textParts.push(nodeText);

      if (isElement) {
        if (node.matches && node.matches('a[href]')) {
          active.anchors.push(node);
        }

        if (node.querySelectorAll) {
          active.anchors.push(...node.querySelectorAll('a[href]'));
        }
      }
    });

    pushCurrent();

    return segments.filter(segment => segment.anchors.length || segment.text);
  }

  function deriveReleaseName(text) {
    const beforeFormat = text.split(/\b(?:MKV|MP4|AVI|RAR|ISO)\b\s*\|/i)[0];
    const beforeNfo = beforeFormat.split(/\bNFO\b/i)[0];

    return cleanText(beforeNfo)
      .replace(/^Download\s+\w+:/i, '')
      .replace(/\b(?:NiTROFLARE|NITROFLARE|RAPIDGATOR|RAPiDGATOR).*$/i, '')
      .trim();
  }

  function cleanReleaseName(name) {
    return cleanText(name)
      .replace(/\s*\[P2P\]\s*/gi, ' [P2P]')
      .replace(/\s*Single File RAR:.*$/i, '')
      .replace(/\s*RAPiDGATOR.*$/i, '')
      .replace(/\s*NiTROFLARE.*$/i, '')
      .replace(/\s*NITROFLARE.*$/i, '')
      .trim();
  }

  function looksLikeReleaseName(text) {
    if (!text) return false;
    if (/rapidgator|nitroflare|single file|links:|download|nfo|screenshot|torrent|subtitles/i.test(text)) return false;

    return /\b(480p|720p|1080p|2160p|4k|web|web-dl|webrip|bluray|bdrip|hdr|dv|x264|h264|x265|h265|hevc|amzn|ntb|rbb|mkv|mp4)\b/i.test(text) || /\./.test(text);
  }

  function extractReleaseInfo(text) {
    const sizeMatch = text.match(/\b\d+(?:[.,]\d+)?\s*(?:GB|MB|MiB|GiB)\b/i);
    const lineMatch = text.match(/\b(MKV|MP4|AVI|RAR|ISO)\b\s*\|\s*([^|]+?)\s*\|\s*(\d+(?:[.,]\d+)?\s*(?:GB|MB|MiB|GiB))/i);

    if (lineMatch) {
      return {
        format: cleanText(lineMatch[1]),
        audio: cleanText(lineMatch[2]),
        size: cleanText(lineMatch[3])
      };
    }

    return {
      format: (text.match(/\b(MKV|MP4|AVI|RAR|ISO)\b/i) || [])[1] || '',
      audio: '',
      size: sizeMatch ? cleanText(sizeMatch[0]) : ''
    };
  }

  function mergeDuplicateReleases(releases) {
    const map = new Map();

    for (const release of releases) {
      const key = release.name.toLowerCase();

      if (!map.has(key)) {
        map.set(key, release);
        continue;
      }

      const existing = map.get(key);
      existing.rgLinks = dedupeLinks([...existing.rgLinks, ...release.rgLinks]);
      existing.extraLinks = dedupeLinks([...existing.extraLinks, ...release.extraLinks]);
      existing.size = existing.size || release.size;
      existing.format = existing.format || release.format;
      existing.audio = existing.audio || release.audio;
      existing.badges = [...new Set([...existing.badges, ...release.badges])];
      existing.tokens = [...new Set([...existing.tokens, ...release.tokens])];
      existing.primaryQuality = getPrimaryQuality(existing.badges, existing.name);
    }

    return [...map.values()].sort((a, b) => bestReleaseScore(b) - bestReleaseScore(a));
  }

  function sizeToMb(size) {
    const match = String(size || '').match(/(\d+(?:[.,]\d+)?)\s*(GB|MB|MiB|GiB)/i);
    if (!match) return 0;

    const value = Number(match[1].replace(',', '.'));
    const unit = match[2].toLowerCase();

    if (unit === 'gb' || unit === 'gib') return value * 1024;
    return value;
  }

  function getPrimaryQuality(badges, text) {
    const combined = `${badges.join(' ')} ${text}`.toLowerCase();

    if (/4k|2160p/.test(combined)) return '4K';
    if (/1080p/.test(combined)) return '1080p';
    if (/720p/.test(combined)) return '720p';
    if (/480p/.test(combined)) return '480p';

    return 'Release';
  }

  function extractDescription(content) {
    const clone = content.cloneNode(true);
    clone.querySelectorAll('script, iframe, style, img, a').forEach(n => n.remove());

    const paragraphs = [...clone.querySelectorAll('p')]
      .map(p => cleanText(p.textContent))
      .filter(Boolean);

    return paragraphs.find(p => {
      if (/^(links|download|single file|nfo|subtitles|mkv|mp4|avi|release name|size|video|audio):/i.test(p)) return false;
      if (/\b(MKV|MP4|AVI|RAR|ISO)\b\s*\|/i.test(p)) return false;
      if (looksLikeReleaseName(p)) return false;
      return p.length > 45;
    }) || '';
  }

  function extractCommentRapidGatorLinks(doc) {
    return dedupeLinks([...doc.querySelectorAll('.commentList a[href*="rapidgator.net"], .comment-list a[href*="rapidgator.net"]')]
      .map(a => ({
        href: abs(a.href),
        label: cleanText(a.textContent) || 'RapidGator',
        className: a.className || 'host-rapidgator',
        rlsId: ''
      })));
  }

  function showExistingComments(details) {
    if (details.dataset.loaded === '1') return;

    const body = details.querySelector('.rbb-comments-body');
    const comments = document.querySelector('.commentList, .comment-list, #comments');

    if (!comments) {
      body.textContent = 'No comments found.';
      details.dataset.loaded = '1';
      return;
    }

    const clone = comments.cloneNode(true);
    clone.querySelectorAll('script, iframe, style, form, #respond').forEach(n => n.remove());

    body.innerHTML = '';
    body.appendChild(clone);
    details.dataset.loaded = '1';
  }

  function autoExpandPostPageSections() {
    if (!isPostPage) return;

    document.querySelectorAll('.rbb-comment-rg, .rbb-comments, .rbb-all-versions').forEach(details => {
      details.open = true;
      details.classList.add('rbb-force-open');
    });

    const comments = document.querySelector('.rbb-comments');
    if (comments) showExistingComments(comments);
  }

  function findMainImage(content) {
    return [...content.querySelectorAll('img')].find(img => {
      const src = img.currentSrc || img.src || '';
      const width = img.naturalWidth || Number(img.width) || 200;
      const height = img.naturalHeight || Number(img.height) || 100;

      if (!src) return false;
      if (/imdb|emoji|favicon|rating|ILx2y|s1\.picimg\.net\/ILx2y/i.test(src)) return false;
      if (width < 80 || height < 45) return false;

      return true;
    });
  }

  function isRapidGatorLink(a) {
    const href = a.href || '';
    const label = cleanText(a.textContent || '');
    const cls = a.className || '';

    if (/host-rapidgator/i.test(cls)) return true;
    if (/rapidgator\.net/i.test(href)) return true;
    if (/rapidgator|rapi?dgator/i.test(label)) return true;

    if (/protected\.to/i.test(href)) {
      const parentText = cleanText(a.parentElement?.textContent || '');
      const nearText = `${label} ${parentText}`;

      return /rapidgator|rapi?dgator/i.test(nearText) && !/nfo|screenshot|subtitle|sample|nitroflare/i.test(label);
    }

    return false;
  }

  function isUsefulSmallExtraLink(a) {
    if (isRapidGatorLink(a)) return false;

    const href = a.href || '';
    const label = cleanText(a.textContent || '');

    if (/nitroflare|torrent|subtitles/i.test(label + ' ' + href)) return false;
    if (/screenshot|sample|nfo/i.test(label)) return true;
    if (/img\.protected\.to|nfo\.protected\.to/i.test(href)) return true;

    return false;
  }

  function anchorToExtra(a) {
    return {
      href: abs(a.href),
      label: cleanText(a.textContent) || guessLabelFromUrl(a.href)
    };
  }

  function dedupeLinks(links) {
    const seen = new Set();

    return links.filter(link => {
      const href = link.href;
      if (!href || seen.has(href)) return false;
      seen.add(href);
      return true;
    });
  }

  function shortExtraLabel(label) {
    const text = cleanText(label).toLowerCase();

    if (text.includes('screenshot')) return '📷';
    if (text.includes('sample')) return '🎞';
    if (text.includes('nfo')) return 'NFO';
    if (text === '#1' || text === '#2' || text === '#3') return '📷';

    return '↗';
  }

  function guessLabelFromUrl(url) {
    if (/nfo/i.test(url)) return 'NFO';
    if (/img/i.test(url)) return 'Screenshot';
    return 'Extra';
  }

  function detectBadges(text) {
    const checks = [
      ['4K', /\b(4k|2160p|uhd)\b/i],
      ['1080p', /\b1080p\b/i],
      ['720p', /\b720p\b/i],
      ['480p', /\b480p\b/i],
      ['WEB-DL', /\bweb[- ]?dl\b/i],
      ['WEBRip', /\bwebrip\b/i],
      ['BluRay', /\bblu[- ]?ray|bdrip\b/i],
      ['HDR', /\bhdr\b/i],
      ['DV', /\b(dv|dolby vision)\b/i],
      ['x265', /\b(x265|h265|hevc)\b/i],
      ['x264', /\b(x264|h264|avc)\b/i],
      ['Atmos', /\batmos\b/i]
    ];

    return checks
      .filter(([, re]) => re.test(text))
      .map(([label]) => label)
      .slice(0, 8);
  }

  function badgesToTokens(badges, text) {
    const tokens = new Set();

    for (const badge of badges) {
      const key = chipKey(badge);
      tokens.add(key);
      if (key === '4k') tokens.add('2160p');
      if (key === 'webdl') tokens.add('web-dl');
    }

    const lower = String(text || '').toLowerCase();

    if (/4k|2160p|uhd/.test(lower)) tokens.add('4k');
    if (/1080p/.test(lower)) tokens.add('1080p');
    if (/720p/.test(lower)) tokens.add('720p');
    if (/480p/.test(lower)) tokens.add('480p');
    if (/hdr/.test(lower)) tokens.add('hdr');
    if (/\bdv\b|dolby vision/.test(lower)) tokens.add('dv');
    if (/x265|h265|hevc/.test(lower)) tokens.add('x265');
    if (/web[- ]?dl/.test(lower)) tokens.add('webdl');

    return [...tokens];
  }

  function extractRecommendedItems(doc) {
    const candidates = [];

    const possibleContainers = [
      doc.querySelector('#site-sidebar'),
      doc.querySelector('#secondary'),
      doc.querySelector('.sidebar'),
      doc.querySelector('.widget-area'),
      ...doc.querySelectorAll('aside, .widget, .textwidget, #text-9, #text-10, #text-11, [id*="text"], [class*="recommend"], [class*="movie"], .owl-carousel, .owl-stage-outer')
    ].filter(Boolean);

    for (const container of possibleContainers) {
      const imgs = [...container.querySelectorAll('img')];
      if (!imgs.length) continue;

      for (const img of imgs) {
        const item = imageToRecommendedItem(img);
        if (item) candidates.push(item);
      }
    }

    if (candidates.length < 4) {
      [...doc.querySelectorAll('img')].forEach(img => {
        if (img.closest('#rbb-clean')) return;
        if (img.closest('article.post')) return;
        if (img.closest('#post-wrapper')) return;

        const item = imageToRecommendedItem(img);
        if (item) candidates.push(item);
      });
    }

    return dedupeRecommendedItems(candidates).slice(0, 120);
  }

  function imageToRecommendedItem(img) {
    const src =
      img.currentSrc ||
      img.src ||
      img.getAttribute('data-src') ||
      img.getAttribute('data-lazy-src') ||
      img.getAttribute('data-original') ||
      firstSrcFromSrcset(img.getAttribute('srcset') || img.getAttribute('data-srcset') || '');

    if (!src) return null;

    if (/favicon|emoji|rss|logo|captcha|counter|histats|rating|imdb|blank|spacer|transparent/i.test(src)) {
      return null;
    }

    if (/gif(?:\?|$)/i.test(src) && !/poster|movie|cover|thumb/i.test(src)) {
      return null;
    }

    const width = img.naturalWidth || Number(img.width) || Number(img.getAttribute('width')) || 120;
    const height = img.naturalHeight || Number(img.height) || Number(img.getAttribute('height')) || 120;

    if (width < 55 || height < 55) return null;

    const a = img.closest('a[href]');

    return {
      href: a ? abs(a.href) : abs(src),
      src: abs(src),
      title: cleanText(img.alt || a?.title || a?.textContent || 'Recommended')
    };
  }

  function firstSrcFromSrcset(srcset) {
    if (!srcset) return '';

    const first = srcset
      .split(',')
      .map(part => part.trim().split(/\s+/)[0])
      .find(Boolean);

    return first || '';
  }

  function dedupeRecommendedItems(items) {
    const seen = new Set();

    return items.filter(item => {
      const key = `${item.href}|${item.src}`;
      if (!item.src || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function refreshRecommendedRail() {
    const scroll = document.querySelector('[data-recommended-scroll]');
    const empty = document.querySelector('[data-recommended-empty]');

    if (!scroll) return;

    const existing = new Set(
      [...scroll.querySelectorAll('img')]
        .map(img => abs(img.currentSrc || img.src || ''))
        .filter(Boolean)
    );

    const freshItems = extractRecommendedItems(document)
      .filter(item => !existing.has(abs(item.src)));

    if (!freshItems.length) {
      if (empty && scroll.children.length === 0) empty.hidden = false;
      return;
    }

    scroll.insertAdjacentHTML('beforeend', freshItems.map(item => recommendedItemHtml(item)).join(''));
    dedupeRecommendedRail();

    if (empty) empty.hidden = scroll.children.length > 0;
  }

  function dedupeRecommendedRail() {
    const scroll = document.querySelector('[data-recommended-scroll]');
    if (!scroll) return;

    const seen = new Set();

    [...scroll.querySelectorAll('.rbb-rec-item')].forEach(item => {
      const img = item.querySelector('img');
      const key = `${item.href}|${img?.src || ''}`;

      if (seen.has(key)) {
        item.remove();
        return;
      }

      seen.add(key);
    });

    const empty = document.querySelector('[data-recommended-empty]');
    if (empty) empty.hidden = scroll.children.length > 0;
  }

  function watchRecommendedRail() {
    let timer = null;

    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        refreshRecommendedRail();
        hidePosterWallsSafely();
      }, 250);
    };

    const observer = new MutationObserver(schedule);

    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['src', 'srcset', 'data-src', 'data-lazy-src', 'data-original']
    });

    setTimeout(schedule, 500);
    setTimeout(schedule, 1500);
    setTimeout(schedule, 3000);
    setTimeout(schedule, 5000);
    setTimeout(schedule, 8000);

    window.addEventListener('load', schedule, { once: true });
  }

  function bindUi(app) {
    app.querySelectorAll('[data-filter]').forEach(input => {
      const handler = () => {
        const key = input.dataset.filter;
        state[key] = input.type === 'checkbox' ? input.checked : input.value;
        saveState();
        applyFiltersAndSort();
      };

      input.addEventListener('input', handler);
      input.addEventListener('change', handler);
    });

    app.querySelectorAll('[data-version-filter]').forEach(input => {
      const handler = () => {
        const key = input.dataset.versionFilter;
        state.versionFilters[key] = input.checked;
        saveState();
        applyFiltersAndSort();
      };

      input.addEventListener('change', handler);
    });

    app.querySelector('.rbb-menu')?.addEventListener('toggle', event => {
      state.categoriesOpen = event.currentTarget.open;
      saveState();
    });

    app.querySelector('[data-open-settings]')?.addEventListener('click', openSettingsDialog);
  }

  function applyFiltersAndSort() {
    const grid = document.querySelector('[data-grid]');
    if (!grid) return;

    const q = String(state.q || '').trim().toLowerCase();
    const activeVersionFilters = Object.entries(state.versionFilters)
      .filter(([, active]) => active)
      .map(([key]) => key);

    const cards = [...grid.querySelectorAll('.rbb-card')];

    cards.forEach(card => {
      const cats = card.dataset.categories || '';
      const text = `${card.dataset.title || ''} ${card.dataset.text || ''}`.toLowerCase();

      let hideCard = false;

      if (!isPostPage) {
        if (q && !text.includes(q)) hideCard = true;
        if (state.categoryFilter && !cats.includes(state.categoryFilter)) hideCard = true;
        if (state.hideSupport && /support us|supportus/.test(text)) hideCard = true;
        if (state.hideApps && /applications|macos|windows/.test(cats + ' ' + text)) hideCard = true;
        if (state.hideTv && /tv shows|foreign tv|tv packs/.test(cats)) hideCard = true;
        if (state.hideGames && /games|mac|pc/.test(cats)) hideCard = true;
        if (state.hideMagazines && /magazines|music|album/.test(cats)) hideCard = true;
        if (state.rgOnly && card.dataset.hasRg !== '1') hideCard = true;
      }

      const rows = [...card.querySelectorAll('.rbb-release-row')];

      if (activeVersionFilters.length && rows.length) {
        let visibleRows = 0;

        rows.forEach(row => {
          const tokens = (row.dataset.versionTokens || '').split(/\s+/).filter(Boolean);
          const match = activeVersionFilters.some(filter => tokens.includes(filter));

          row.hidden = !match;
          if (match) visibleRows++;
        });

        if (visibleRows === 0) hideCard = true;
      } else {
        rows.forEach(row => row.hidden = false);
      }

      card.hidden = hideCard;
    });

    if (isPostPage) return;

    cards.sort((a, b) => {
      const at = Number(a.dataset.timestamp || 0);
      const bt = Number(b.dataset.timestamp || 0);
      const an = a.dataset.title || '';
      const bn = b.dataset.title || '';

      if (state.sort === 'oldest') return at - bt;
      if (state.sort === 'az') return an.localeCompare(bn);
      if (state.sort === 'za') return bn.localeCompare(an);

      return bt - at;
    });

    cards.forEach(card => grid.appendChild(card));
  }

  function setupInfiniteScroll(grid) {
    const sentinel = document.createElement('div');
    sentinel.className = 'rbb-sentinel';
    sentinel.setAttribute('aria-hidden', 'true');

    const layout = grid.closest('.rbb-layout');

    if (layout) {
      layout.after(sentinel);
    } else {
      grid.after(sentinel);
    }

    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) loadNextPage(grid);
    }, { root: null, rootMargin: '1200px 0px', threshold: 0.01 });

    observer.observe(sentinel);

    window.addEventListener('scroll', () => {
      const nearBottom = window.innerHeight + window.scrollY > document.body.scrollHeight - 1400;
      if (nearBottom) loadNextPage(grid);
    }, { passive: true });
  }

  async function loadNextPage(grid) {
    if (isLoading || isPostPage) return;

    if (!nextPageUrl) nextPageUrl = findNextPageUrl(document);
    if (!nextPageUrl) return;

    isLoading = true;

    const loader = document.querySelector('[data-loader]');
    if (loader) loader.hidden = false;

    try {
      const html = await fetchText(nextPageUrl);
      const doc = new DOMParser().parseFromString(html, 'text/html');

      nextPageUrl = findNextPageUrl(doc);

      [...doc.querySelectorAll('#post-wrapper article, article.post')].forEach(article => {
        appendArticle(article, grid, doc);
      });

      applyFiltersAndSort();
      refreshRecommendedRail();
      hidePosterWallsSafely();
    } catch (error) {
      console.warn('RBB Clean v11: next page failed', error);
    } finally {
      isLoading = false;
      if (loader) loader.hidden = true;
    }
  }

  async function loadComments(details) {
    if (details.dataset.loaded === '1') return;

    const body = details.querySelector('.rbb-comments-body');
    body.textContent = 'Loading comments…';

    try {
      const url = (details.dataset.commentsUrl || '').replace(/#.*$/, '');
      const html = await fetchText(url);
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const comments = doc.querySelector('.commentList, .comment-list, #comments');

      if (!comments) {
        body.textContent = 'No comments found.';
      } else {
        comments.querySelectorAll('script, iframe, style, form, #respond').forEach(n => n.remove());
        body.innerHTML = '';
        body.appendChild(comments.cloneNode(true));
      }

      details.dataset.loaded = '1';
    } catch {
      body.textContent = 'Could not load comments.';
    }
  }

  function fetchText(url) {
    return gmRequest({ method: 'GET', url }).then(response => response.responseText);
  }

  // Prefixed console logging so the download flow is actually debuggable from DevTools —
  // AllDebrid's unlock endpoint can be genuinely slow for some hosts, and previously there
  // was no way to tell "still working" apart from "silently stuck".
  const LOG_PREFIX = '[RLSBB Clean Board]';
  function log(...args) { console.log(LOG_PREFIX, ...args); }
  function logError(...args) { console.error(LOG_PREFIX, ...args); }

  // Generic cross-origin request helper (AllDebrid's API and the NAS aria2 RPC are both
  // off-site from rlsbb.in, so this always needs GM_xmlhttpRequest + a matching @connect).
  function gmRequest(details) {
    return new Promise((resolve, reject) => {
      if (typeof GM_xmlhttpRequest === 'function') {
        GM_xmlhttpRequest({
          ...details,
          onload: resolve,
          onerror: reject,
          ontimeout: reject
        });
      } else {
        fetch(details.url, {
          method: details.method || 'GET',
          headers: details.headers,
          body: details.data,
          credentials: 'include'
        })
          .then(async response => ({ status: response.status, responseText: await response.text() }))
          .then(resolve)
          .catch(reject);
      }
    });
  }

  async function allDebridUnlock(link) {
    const { allDebridKey } = getDownloadSettings();
    if (!allDebridKey) {
      openSettingsDialog();
      throw new Error('Add your AllDebrid API key in Settings first.');
    }

    const url = 'https://api.alldebrid.com/v4/link/unlock'
      + '?agent=rlsbb-clean-board'
      + '&apikey=' + encodeURIComponent(allDebridKey)
      + '&link=' + encodeURIComponent(link);

    log('AllDebrid unlock request for', link);
    const startedAt = Date.now();

    // 60s timeout: AllDebrid's unlock can take a while for some hosts (it may be doing its
    // own fetch from the hoster behind the scenes), but it shouldn't ever hang forever.
    const response = await gmRequest({ method: 'GET', url, timeout: 60000 });
    const elapsedMs = Date.now() - startedAt;
    log('AllDebrid responded in', elapsedMs, 'ms —', response.status, response.responseText.slice(0, 300));

    let json;
    try {
      json = JSON.parse(response.responseText);
    } catch {
      logError('AllDebrid response was not valid JSON:', response.responseText.slice(0, 500));
      throw new Error('AllDebrid returned an unreadable response.');
    }

    if (json.status !== 'success') {
      logError('AllDebrid unlock failed:', json.error);
      const error = new Error((json.error && json.error.message) || 'AllDebrid could not unlock this link.');
      error.code = json.error && json.error.code;
      throw error;
    }

    return { ...json.data, elapsedMs }; // { link, filename, filesize, ..., elapsedMs }
  }

  function browserDownload(url, filename) {
    log('Starting browser download:', filename, url);
    return new Promise((resolve, reject) => {
      if (typeof GM_download === 'function') {
        GM_download({
          url,
          name: filename,
          saveAs: false,
          onload: () => { log('Browser download started:', filename); resolve(); },
          onerror: error => {
            logError('GM_download error:', error);
            reject(new Error((error && error.error) || 'Browser refused the download (check for a Tampermonkey permission prompt).'));
          },
          ontimeout: () => {
            logError('GM_download timed out for', filename);
            reject(new Error('Download timed out — check for a Tampermonkey permission prompt.'));
          }
        });
      } else {
        try {
          window.open(url, '_blank', 'noopener');
          resolve();
        } catch (error) {
          reject(error);
        }
      }
    });
  }

  async function aria2AddUri(url, filename) {
    const { aria2Rpc, aria2Secret } = getDownloadSettings();
    if (!aria2Rpc) {
      openSettingsDialog();
      throw new Error('Add your aria2 RPC URL in Settings first.');
    }

    const params = [];
    if (aria2Secret) params.push('token:' + aria2Secret);
    params.push([url]);
    params.push({ out: filename, 'remove-control-file': 'true' });

    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 'rbb-' + Date.now(),
      method: 'aria2.addUri',
      params
    });

    log('aria2.addUri request:', filename, '->', aria2Rpc);

    const response = await gmRequest({
      method: 'POST',
      url: aria2Rpc,
      data: body,
      headers: { 'Content-Type': 'application/json' },
      timeout: 15000
    });

    log('aria2 responded:', response.status, response.responseText.slice(0, 300));

    let json;
    try {
      json = JSON.parse(response.responseText);
    } catch {
      logError('aria2 response was not valid JSON:', response.responseText.slice(0, 500));
      throw new Error('aria2 returned an unreadable response.');
    }

    if (json.error) {
      logError('aria2 rejected the job:', json.error);
      throw new Error(json.error.message || 'aria2 rejected the job.');
    }

    log('aria2 queued job, gid:', json.result);
    return json.result; // gid
  }

  // Local aria2 (this PC, not the NAS) — used by the magnet-link helper so downloads can land
  // wherever the user chooses instead of the NAS pipeline's fixed 2SORT path. Same JSON-RPC
  // shape as aria2AddUri() above, just a different endpoint/secret and an explicit `dir`.
  async function localAria2AddUri(url, filename, dir) {
    const { localAria2Rpc, localAria2Secret } = getDownloadSettings();
    if (!localAria2Rpc) {
      openSettingsDialog();
      throw new Error('Add your local aria2 RPC URL in Settings first.');
    }

    const params = [];
    if (localAria2Secret) params.push('token:' + localAria2Secret);
    params.push([url]);

    const options = { out: filename, 'remove-control-file': 'true' };
    if (dir) options.dir = dir;
    params.push(options);

    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 'rbb-' + Date.now(),
      method: 'aria2.addUri',
      params
    });

    log('local aria2.addUri request:', filename, '->', localAria2Rpc, 'dir:', dir || '(default)');

    const response = await gmRequest({
      method: 'POST',
      url: localAria2Rpc,
      data: body,
      headers: { 'Content-Type': 'application/json' },
      timeout: 15000
    });

    log('local aria2 responded:', response.status, response.responseText.slice(0, 300));

    let json;
    try {
      json = JSON.parse(response.responseText);
    } catch {
      logError('local aria2 response was not valid JSON:', response.responseText.slice(0, 500));
      throw new Error('Local aria2 returned an unreadable response.');
    }

    if (json.error) {
      logError('local aria2 rejected the job:', json.error);
      throw new Error(json.error.message || 'Local aria2 rejected the job.');
    }

    log('local aria2 queued job, gid:', json.result);
    return json.result; // gid
  }

  // ---- AllDebrid magnet caching ----
  // Unlike a hoster link, a magnet can't be unlocked instantly -- AllDebrid has to fetch/seed
  // the torrent on their own servers first. Upload registers it (often instant for already-
  // popular torrents), then status is polled until AllDebrid reports it ready, at which point
  // it returns direct download links per file -- no separate link/unlock call needed for these.
  async function allDebridUploadMagnet(magnetUri) {
    const { allDebridKey } = getDownloadSettings();
    if (!allDebridKey) {
      openSettingsDialog();
      throw new Error('Add your AllDebrid API key in Settings first.');
    }

    const url = 'https://api.alldebrid.com/v4/magnet/upload'
      + '?agent=rlsbb-clean-board'
      + '&apikey=' + encodeURIComponent(allDebridKey)
      + '&magnets[]=' + encodeURIComponent(magnetUri);

    log('AllDebrid magnet upload request for', magnetUri.slice(0, 80) + '…');
    const response = await gmRequest({ method: 'GET', url, timeout: 30000 });
    log('AllDebrid magnet upload responded:', response.status, response.responseText.slice(0, 400));

    let json;
    try {
      json = JSON.parse(response.responseText);
    } catch {
      logError('AllDebrid magnet upload response was not valid JSON:', response.responseText.slice(0, 500));
      throw new Error('AllDebrid returned an unreadable response.');
    }

    if (json.status !== 'success') {
      logError('AllDebrid magnet upload failed:', json.error);
      throw new Error((json.error && json.error.message) || 'AllDebrid could not accept this magnet.');
    }

    const magnet = json.data && json.data.magnets && json.data.magnets[0];
    if (!magnet || magnet.error) {
      const message = magnet && magnet.error && magnet.error.message;
      throw new Error(message || 'AllDebrid rejected this magnet.');
    }

    return magnet; // { id, name, size, ready, ... }
  }

  // AllDebrid deprecated the old /v4/magnet/status (confirmed 2026-07-19 by the API itself
  // returning "This API endpoint has been discontinued") in favour of /v4.1/magnet/status —
  // note the version bump is in the URL path itself, not a query param. Status no longer
  // carries download links at all; those now live behind the separate /v4/magnet/files call
  // (still plain v4), see allDebridMagnetFiles() below. v4.1 also dropped the old ?apikey=
  // query-param auth used everywhere else in this file for a Bearer header instead — sending
  // the old style here gets a generic "Unauthorized" back rather than any clearer complaint.
  async function allDebridMagnetStatus(id) {
    const { allDebridKey } = getDownloadSettings();
    const url = 'https://api.alldebrid.com/v4.1/magnet/status'
      + '?agent=rlsbb-clean-board'
      + '&id=' + encodeURIComponent(id);

    const response = await gmRequest({
      method: 'GET',
      url,
      headers: { Authorization: 'Bearer ' + allDebridKey },
      timeout: 30000
    });

    let json;
    try {
      json = JSON.parse(response.responseText);
    } catch {
      logError('AllDebrid magnet status response was not valid JSON:', response.responseText.slice(0, 500));
      throw new Error('AllDebrid returned an unreadable status response.');
    }

    if (json.status !== 'success') {
      throw new Error((json.error && json.error.message) || 'AllDebrid could not check this magnet.');
    }

    const magnets = (json.data && json.data.magnets) || [];
    const magnet = Array.isArray(magnets) ? magnets[0] : magnets;
    return magnet; // { id, filename, size, status, statusCode, downloaded, seeders, downloadSpeed }
  }

  // Files (and their download links) are a separate call from status as of the v4.1 split —
  // response nests subfolders via an `e` array, so this flattens the whole tree into a plain
  // list of { name, size, link } using the real field names (n/s/l), not filename/size/link.
  async function allDebridMagnetFiles(id) {
    const { allDebridKey } = getDownloadSettings();
    const url = 'https://api.alldebrid.com/v4/magnet/files'
      + '?agent=rlsbb-clean-board'
      + '&apikey=' + encodeURIComponent(allDebridKey)
      + '&id[]=' + encodeURIComponent(id);

    const response = await gmRequest({ method: 'GET', url, timeout: 30000 });
    log('AllDebrid magnet files responded:', response.status, response.responseText.slice(0, 400));

    let json;
    try {
      json = JSON.parse(response.responseText);
    } catch {
      logError('AllDebrid magnet files response was not valid JSON:', response.responseText.slice(0, 500));
      throw new Error('AllDebrid returned an unreadable files response.');
    }

    if (json.status !== 'success') {
      throw new Error((json.error && json.error.message) || 'AllDebrid could not list files for this magnet.');
    }

    const magnets = (json.data && json.data.magnets) || [];
    const magnet = Array.isArray(magnets) ? magnets[0] : magnets;
    const rawFiles = (magnet && magnet.files) || [];

    const flat = [];
    (function walk(entries) {
      for (const entry of entries || []) {
        if (entry.l) flat.push({ name: entry.n, size: Number(entry.s || 0), link: entry.l });
        if (entry.e) walk(entry.e); // subfolder
      }
    })(rawFiles);

    return flat;
  }

  // Polls status every 5s until AllDebrid reports the magnet ready (or errors/times out),
  // calling onProgress with a short human-readable string after every check so the UI can show
  // live status instead of looking frozen during what can be a multi-minute wait. Only waits
  // for "ready" — the actual files/links come from a separate allDebridMagnetFiles() call.
  async function pollMagnetUntilReady(id, onProgress, timeoutMs = 10 * 60 * 1000) {
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
      const status = await allDebridMagnetStatus(id);
      log('AllDebrid magnet status:', JSON.stringify(status).slice(0, 300));

      const statusText = String((status && status.status) || '').toLowerCase();

      if (statusText.includes('ready')) {
        return status;
      }

      if (statusText.includes('error') || statusText.includes('fail') || statusText.includes('dead') || statusText.includes('expired')) {
        throw new Error(`AllDebrid: magnet ${status.status || 'failed'} (no seeders/dead torrent?)`);
      }

      if (onProgress) {
        const pct = status && status.size
          ? Math.min(100, Math.round(((status.downloaded || 0) / status.size) * 100))
          : null;
        onProgress(pct === null ? `Caching on AllDebrid… (${status.status || 'processing'})` : `Caching on AllDebrid… ${pct}%`);
      }

      await new Promise(resolve => setTimeout(resolve, 5000));
    }

    throw new Error('Timed out waiting for AllDebrid to cache this magnet (10 min).');
  }

  // ---- universal magnet-link helper: runs on every page (not just RLSBB), since a magnet
  // link can turn up anywhere. Deliberately styled with plain inline styles rather than the
  // RLSBB dark-theme stylesheet, and namespaced classes -- this runs on arbitrary third-party
  // pages we don't control, so it needs to be robust against unknown host CSS rather than
  // relying on our own stylesheet always winning (a lesson learned the hard way on RLSBB itself:
  // even a page we DO fully control had leftover CSS silently hide a button once already). ----
  function injectMagnetHelperStyles() {
    if (document.getElementById('rbb-magnet-styles')) return;

    const style = document.createElement('style');
    style.id = 'rbb-magnet-styles';
    style.textContent = `
      .rbb-magnet-group { all: initial !important; display: inline-flex !important; gap: 4px !important; margin-left: 6px !important; vertical-align: middle !important; }
      .rbb-magnet-btn {
        all: unset !important;
        box-sizing: border-box !important;
        display: inline-flex !important;
        align-items: center !important;
        gap: 3px !important;
        padding: 2px 7px !important;
        border-radius: 999px !important;
        font: 11px/1.3 -apple-system, Segoe UI, Roboto, Arial, sans-serif !important;
        font-weight: 700 !important;
        cursor: pointer !important;
        white-space: nowrap !important;
        border: 1px solid rgba(0,0,0,.25) !important;
      }
      .rbb-magnet-btn.rbb-magnet-browser { background: #2e8b6f !important; color: #fff !important; }
      .rbb-magnet-btn.rbb-magnet-browser:hover { background: #37a683 !important; }
      .rbb-magnet-btn.rbb-magnet-local { background: #2b6fa4 !important; color: #fff !important; }
      .rbb-magnet-btn.rbb-magnet-local:hover { background: #3a86c4 !important; }
      .rbb-magnet-btn.rbb-magnet-settings { background: #555 !important; color: #fff !important; padding: 2px 6px !important; }
      .rbb-magnet-btn.rbb-magnet-settings:hover { background: #6b6b6b !important; }
      .rbb-magnet-btn:disabled { opacity: .55 !important; cursor: default !important; }
      .rbb-magnet-status { all: initial !important; font: 11px/1.3 -apple-system, Segoe UI, Roboto, Arial, sans-serif !important; color: #444 !important; margin-left: 6px !important; }
      .rbb-magnet-progress {
        all: initial !important;
        display: none !important;
        height: 3px !important;
        width: 60px !important;
        margin-left: 6px !important;
        border-radius: 999px !important;
        overflow: hidden !important;
        background: rgba(0,0,0,.15) !important;
        vertical-align: middle !important;
      }
      .rbb-magnet-progress.rbb-magnet-progress-active { display: inline-block !important; }
      .rbb-magnet-progress.rbb-magnet-progress-active::after {
        content: '' !important;
        display: block !important;
        height: 100% !important;
        width: 40% !important;
        background: #2b6fa4 !important;
        border-radius: 999px !important;
        animation: rbb-magnet-sweep 1.1s ease-in-out infinite !important;
      }
      @keyframes rbb-magnet-sweep {
        0% { margin-left: -40%; }
        100% { margin-left: 100%; }
      }
    `;
    document.head.appendChild(style);
  }

  function scanForMagnetLinks() {
    const links = document.querySelectorAll('a[href^="magnet:"]:not([data-rbb-magnet-done])');

    links.forEach(link => {
      link.dataset.rbbMagnetDone = '1';

      const group = document.createElement('span');
      group.className = 'rbb-magnet-group';
      group.innerHTML = `
        <button type="button" class="rbb-magnet-btn rbb-magnet-browser" title="Cache via AllDebrid, then download in your browser">⬇ AllDebrid</button>
        <button type="button" class="rbb-magnet-btn rbb-magnet-local" title="Cache via AllDebrid, then send to local aria2 (choose folder)">➟ aria2</button>
        <button type="button" class="rbb-magnet-btn rbb-magnet-settings" title="Download settings (AllDebrid key, aria2 RPC/secret)">⚙</button>
        <span class="rbb-magnet-status" data-magnet-status></span>
        <span class="rbb-magnet-progress" data-magnet-progress></span>
      `;

      link.insertAdjacentElement('afterend', group);

      const suggestedName = cleanText(link.textContent) || (link.href.match(/dn=([^&]+)/) || [])[1] || 'download';

      group.querySelector('.rbb-magnet-settings').addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        openSettingsDialog();
      });
      group.querySelector('.rbb-magnet-browser').addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        handleMagnetButtonClick('browser', link.href, decodeURIComponent(suggestedName), group);
      });
      group.querySelector('.rbb-magnet-local').addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        handleMagnetButtonClick('local-aria2', link.href, decodeURIComponent(suggestedName), group);
      });
    });
  }

  function sanitizeFolderName(name) {
    return String(name || 'download')
      .replace(/[\\/:*?"<>|]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 150) || 'download';
  }

  async function handleMagnetButtonClick(mode, magnetUri, suggestedName, group) {
    const status = group.querySelector('[data-magnet-status]');
    const progress = group.querySelector('[data-magnet-progress]');
    const buttons = group.querySelectorAll('.rbb-magnet-btn');

    let destDir = '';
    if (mode === 'local-aria2') {
      const { localAria2Dir } = getDownloadSettings();
      destDir = window.prompt('Save to folder (on this PC):', localAria2Dir || '/home/Phaderon/Downloads');
      if (destDir === null) return; // cancelled
    }

    beginDownloadOp();
    buttons.forEach(b => { b.disabled = true; });
    status.textContent = 'Uploading magnet to AllDebrid…';
    status.title = 'Caching this magnet can take a while for less-seeded torrents — keep this tab open until it says a download has started/been sent.';
    if (progress) progress.classList.add('rbb-magnet-progress-active');

    try {
      const uploaded = await allDebridUploadMagnet(magnetUri);
      log('AllDebrid magnet accepted:', uploaded);

      if (!uploaded.ready) {
        await pollMagnetUntilReady(uploaded.id, text => { status.textContent = `${text} — keep this tab open`; });
      }

      status.textContent = 'Fetching file list…';
      const files = await allDebridMagnetFiles(uploaded.id);
      if (!files.length) throw new Error('AllDebrid reported ready but returned no files.');

      // A single big video file (+ nfo/sample/poster junk) is a "pick the real content" case —
      // just grab the largest file, as before. But a repack/split-archive release (multiple
      // substantial parts that only work TOGETHER, e.g. fg-01.bin/fg-02.bin/fg-03.bin + setup.exe)
      // needs every required part, or the download is useless on its own — this is exactly what
      // went wrong the first time this shipped: "largest file only" silently dropped the other
      // 33GB+ of required parts for a FitGirl repack.
      //
      // Multi-part is detected by counting files that are "substantial" relative to the release,
      // not against one flat byte count. A flat >=100MB floor looked right for the first repack
      // tested, but broke on a real one where fg-02.bin/fg-03.bin (92.5MB/47MB) sat just under
      // that line — only fg-01.bin got counted, isMultiPart came out false, and the other two
      // required parts got silently dropped exactly like the original bug this was meant to fix.
      // The floor now scales with the largest file in the torrent (2%, floored at 20MB so tiny
      // junk like .nfo/.txt/.md5 still never counts) — a 1.4GB main part makes anything down to
      // ~29MB count as a real part, while a lone 8GB movie still only has its ~40MB sample fall
      // well short of the ~160MB floor that implies, so it correctly stays single-file.
      const JUNK_FLOOR_BYTES = 20 * 1024 * 1024;
      const largestBytes = files.reduce((max, f) => Math.max(max, Number(f.size || 0)), 0);
      const significantFloor = Math.max(JUNK_FLOOR_BYTES, largestBytes * 0.02);
      const significant = files.filter(f => Number(f.size || 0) >= significantFloor);
      const isMultiPart = significant.length > 1;

      let toDownload;
      let folderName = '';
      if (isMultiPart) {
        // "optional-*"/sample extras (bonus soundtracks, alternate VO language packs, preview
        // clips) are genuinely optional per the release's own naming convention — everything
        // else in a multi-part release is required, however small (checksums, setup.exe).
        const isSkippable = name => /(^|[-_. ])(optional|sample)($|[-_. ])/i.test(name || '');
        toDownload = files.filter(f => !isSkippable(f.name));
        if (!toDownload.length) toDownload = files; // don't strand the user with an empty queue
        folderName = sanitizeFolderName(uploaded.name || suggestedName);
      } else {
        const best = files.reduce((a, b) => (Number(b.size || 0) > Number(a.size || 0) ? b : a));
        toDownload = [best];
      }

      let done = 0;
      let failed = 0;
      for (const file of toDownload) {
        const filename = file.name || suggestedName;
        done += 1;
        status.textContent = isMultiPart
          ? `Resolving file ${done}/${toDownload.length}: ${filename}…`
          : 'Resolving direct download link…';

        try {
          // magnet/files' own links (alldebrid.com/f/...) turned out to serve an HTML login
          // page rather than the file when fetched anonymously by aria2/GM_download — resolving
          // through the same link/unlock step already used for hoster links gets a real direct
          // URL instead.
          const resolved = await allDebridUnlock(file.link);
          const directUrl = resolved.link || file.link;

          if (mode === 'browser') {
            // GM_download's `name` accepts forward slashes to create a subfolder inside the
            // browser's own Downloads directory, so a multi-part release still lands together.
            const browserName = isMultiPart ? `${folderName}/${filename}` : filename;
            await browserDownload(directUrl, browserName);
          } else {
            // aria2 creates missing directories under `dir` itself, so nesting the release's
            // own folder name under the user's chosen destination is enough to keep every part
            // together instead of dumping loose files straight into it.
            const jobDir = isMultiPart ? `${destDir}/${folderName}` : destDir;
            await localAria2AddUri(directUrl, filename, jobDir);
          }
        } catch (fileError) {
          failed += 1;
          logError(`Magnet file "${filename}" failed:`, fileError);
        }
      }

      if (failed) {
        status.textContent = `${done - failed}/${toDownload.length} file(s) queued, ${failed} failed — see console`;
        status.style.color = '#c0392b';
      } else if (isMultiPart) {
        status.textContent = mode === 'browser'
          ? `${toDownload.length} files started ✓ (in "${folderName}") — safe to close this tab`
          : `${toDownload.length} files sent to local aria2 ✓ (${destDir}/${folderName}) — safe to close this tab`;
      } else {
        status.textContent = mode === 'browser' ? 'Download started ✓ — safe to close this tab' : `Sent to local aria2 ✓ (${destDir}) — safe to close this tab`;
      }
    } catch (error) {
      logError('Magnet handling failed:', error);
      status.textContent = error.message || 'Failed';
      status.style.color = '#c0392b';
    } finally {
      endDownloadOp();
      buttons.forEach(b => { b.disabled = false; });
      if (progress) progress.classList.remove('rbb-magnet-progress-active');
      setTimeout(() => { status.textContent = ''; status.style.color = ''; status.title = ''; }, 12000);
    }
  }

  function initMagnetLinkHelper() {
    injectMagnetHelperStyles();
    scanForMagnetLinks();

    const observer = new MutationObserver(() => scanForMagnetLinks());
    observer.observe(document.body, { childList: true, subtree: true });
  }

  // Replaces a release row's action buttons with an unmissable "gone" banner instead of a
  // small line of red status text that's easy to overlook or mistake for a transient error.
  function markReleaseRowDead(button) {
    const row = button.closest('.rbb-release-row');
    if (!row) return;

    row.classList.add('rbb-release-dead');

    const actions = row.querySelector('.rbb-release-actions');
    if (actions) {
      actions.innerHTML = `
        <div class="rbb-dead-banner" title="AllDebrid confirmed this file no longer exists on the file hoster (error code LINK_DOWN)">
          &#10060; File removed<br>from host
        </div>
      `;
    }
  }

  async function handleDownloadButtonClick(button) {
    const rgUrl = button.dataset.rgUrl;
    const releaseName = button.dataset.rgName || 'download';
    const mode = button.classList.contains('rbb-dl-aria2') ? 'aria2' : 'browser';
    const actions = button.closest('.rbb-release-actions');
    const status = actions?.querySelector('[data-dl-status]');
    const progress = actions?.querySelector('[data-dl-progress]');

    beginDownloadOp();
    button.disabled = true;
    button.classList.add('rbb-dl-busy');
    if (status) status.classList.remove('rbb-dl-error');
    if (progress) progress.classList.add('rbb-dl-progress-active');
    const stopTicker = status ? startElapsedTicker(status, 'Unlocking…') : null;

    try {
      const unlocked = await allDebridUnlock(rgUrl);
      if (stopTicker) stopTicker();
      const directUrl = unlocked.link;
      const filename = unlocked.filename || releaseName;
      const seconds = (unlocked.elapsedMs / 1000).toFixed(1);

      if (mode === 'browser') {
        await browserDownload(directUrl, filename);
        if (status) { status.textContent = `Started ✓ ${seconds}s`; status.title = `Download started (unlocked in ${seconds}s) — safe to close this tab now.`; }
      } else {
        await aria2AddUri(directUrl, filename);
        if (status) { status.textContent = `Sent ✓ ${seconds}s`; status.title = `Sent to aria2 (unlocked in ${seconds}s) — safe to close this tab now.`; }
      }
    } catch (error) {
      if (stopTicker) stopTicker();
      logError('Download button failed:', error);

      // LINK_DOWN means AllDebrid confirmed the file no longer exists on the hoster at all —
      // that's permanent, not a transient error, so replace the buttons with an unmissable
      // banner instead of a small line of red text easy to overlook.
      if (error.code === 'LINK_DOWN') {
        markReleaseRowDead(button);
        return;
      }

      if (status) {
        const message = error.message || 'Failed';
        status.textContent = message.length > 22 ? message.slice(0, 21) + '…' : message;
        status.title = message;
        status.classList.add('rbb-dl-error');
      }
    } finally {
      endDownloadOp();
      button.disabled = false;
      button.classList.remove('rbb-dl-busy');
      if (progress) progress.classList.remove('rbb-dl-progress-active');
      setTimeout(() => {
        if (status) { status.textContent = ''; status.title = ''; status.classList.remove('rbb-dl-error'); }
      }, 10000);
    }
  }

  // One delegated listener covers every card, including cards cloned into the lightbox later
  function bindDownloadButtons() {
    document.addEventListener('click', event => {
      // .rbb-dl-protected is a plain link to protected.to — let it navigate normally instead
      // of treating it as an AllDebrid-unlockable button. Remember the release name first so
      // the RapidGator file page you land on can pre-fill its rename box with the real title
      // instead of the hoster's often-cryptic filename (see rememberPendingReleaseName()).
      const protectedLink = event.target.closest('.rbb-dl-protected');
      if (protectedLink) {
        rememberPendingReleaseName(protectedLink.dataset.rgName);
        return;
      }

      const button = event.target.closest('.rbb-dl-btn');
      if (!button) return;

      event.preventDefault();
      event.stopPropagation();
      handleDownloadButtonClick(button);
    });
  }

  // Keeps the last few release names the user clicked through to protected.to for, each
  // timestamped, so the RapidGator page can guess which one you're currently downloading.
  function rememberPendingReleaseName(name) {
    if (!name) return;

    let list = [];
    try { list = JSON.parse(getSetting('recentReleaseNames', '[]')); } catch { list = []; }

    list.unshift({ name, at: Date.now() });
    setSetting('recentReleaseNames', JSON.stringify(list.slice(0, 5)));
  }

  // Only entries from the last 20 minutes are offered — long enough to cover a slow ad-gate
  // click-through, short enough that a stale guess from hours ago won't get suggested.
  function getRecentReleaseNames() {
    let list = [];
    try { list = JSON.parse(getSetting('recentReleaseNames', '[]')); } catch { list = []; }

    const cutoff = Date.now() - 20 * 60 * 1000;
    return list.filter(entry => entry.at >= cutoff);
  }

  // Category pills (TV Shows / Games / Movies / ...) filter the grid down to that category.
  // Works whether clicked on a normal grid card or on the cloned card inside the lightbox.
  function bindCategoryPills() {
    document.addEventListener('click', event => {
      const pill = event.target.closest('.rbb-cat-pill');
      if (!pill) return;

      event.preventDefault();
      event.stopPropagation();

      const category = pill.dataset.category || '';
      state.categoryFilter = state.categoryFilter === category ? '' : category;
      saveState();
      applyFiltersAndSort();

      if (pill.closest('#rbb-lightbox-dialog')) closeLightbox();
    });
  }

  function injectLightbox() {
    if (document.getElementById('rbb-lightbox-dialog')) return;

    // a native <dialog> renders in the browser's top layer, so it can't be broken by an
    // ancestor's `transform`/`filter`/`contain` (a common WP-theme trick that silently turns
    // `position: fixed` into "fixed relative to that ancestor" instead of the viewport)
    const dialog = document.createElement('dialog');
    dialog.id = 'rbb-lightbox-dialog';
    dialog.className = 'rbb-lightbox-dialog';
    dialog.innerHTML = `
      <button type="button" class="rbb-lightbox-close" aria-label="Close">
        <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" focusable="false">
          <path d="M5 5 L19 19 M19 5 L5 19" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" fill="none"></path>
        </svg>
      </button>
      <div class="rbb-lightbox-body"></div>
    `;

    document.body.appendChild(dialog);

    dialog.addEventListener('click', event => {
      if (event.target === dialog) closeLightbox();
    });

    dialog.querySelector('.rbb-lightbox-close').addEventListener('click', closeLightbox);
    dialog.addEventListener('cancel', () => { document.body.style.overflow = ''; });
    dialog.addEventListener('close', () => { document.body.style.overflow = ''; });
  }

  function openLightbox(sourceCard, data) {
    const dialog = document.getElementById('rbb-lightbox-dialog');
    if (!dialog) return;

    const body = dialog.querySelector('.rbb-lightbox-body');
    const clone = sourceCard.cloneNode(true);
    clone.classList.add('rbb-detail-card');

    clone.querySelectorAll('.rbb-comments, .rbb-all-versions').forEach(details => {
      details.open = true;
      details.classList.add('rbb-force-open');
    });

    body.innerHTML = '';
    body.appendChild(clone);
    dialog.scrollTop = 0;
    if (!dialog.open) dialog.showModal();
    document.body.style.overflow = 'hidden';

    // cloning drops listeners, so kick off the comment fetch directly rather than
    // waiting for a toggle event that will never fire on this detached <details>
    const commentsDetails = clone.querySelector('.rbb-comments');
    if (commentsDetails) loadComments(commentsDetails);
  }

  function closeLightbox() {
    const dialog = document.getElementById('rbb-lightbox-dialog');
    if (!dialog || !dialog.open) return;

    dialog.close();
    document.body.style.overflow = '';
  }

  function injectSettingsDialog() {
    if (document.getElementById('rbb-settings-dialog')) return;

    const dialog = document.createElement('dialog');
    dialog.id = 'rbb-settings-dialog';
    dialog.className = 'rbb-lightbox-dialog rbb-settings-dialog';
    dialog.innerHTML = `
      <button type="button" class="rbb-lightbox-close" aria-label="Close">
        <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" focusable="false">
          <path d="M5 5 L19 19 M19 5 L5 19" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" fill="none"></path>
        </svg>
      </button>
      <div class="rbb-card rbb-detail-card">
        <div class="rbb-content">
          <h2 class="rbb-card-title">Download settings</h2>
          <p class="rbb-description" style="max-width:none;">
            Stored only in this browser (Tampermonkey storage) — never written back to the script's GitHub repo.
          </p>

          <form class="rbb-settings-form">
            <label class="rbb-settings-field">
              <span>AllDebrid API key</span>
              <input type="password" name="allDebridKey" autocomplete="off" placeholder="from alldebrid.com/apikeys">
            </label>
            <label class="rbb-settings-field">
              <span>aria2 RPC URL</span>
              <input type="text" name="aria2Rpc" autocomplete="off" placeholder="http://192.168.0.200:6800/jsonrpc">
            </label>
            <label class="rbb-settings-field">
              <span>aria2 RPC secret (optional)</span>
              <input type="password" name="aria2Secret" autocomplete="off" placeholder="leave blank if none">
            </label>
            <p class="rbb-description" style="max-width:none; margin-top:2px;">
              Local aria2 (this PC) — used by the magnet-link helper below, so downloads land wherever you choose instead of the NAS's fixed folder.
            </p>
            <label class="rbb-settings-field">
              <span>Local aria2 RPC URL</span>
              <input type="text" name="localAria2Rpc" autocomplete="off" placeholder="http://127.0.0.1:6802/jsonrpc">
            </label>
            <label class="rbb-settings-field">
              <span>Local aria2 RPC secret</span>
              <input type="password" name="localAria2Secret" autocomplete="off" placeholder="leave blank if none">
            </label>
            <label class="rbb-settings-field">
              <span>Default local download folder</span>
              <input type="text" name="localAria2Dir" autocomplete="off" placeholder="/home/Phaderon/Downloads">
            </label>
            <div class="rbb-settings-actions">
              <span class="rbb-settings-status" data-settings-status></span>
              <button type="submit" class="rbb-rg-action">Save</button>
            </div>
          </form>
        </div>
      </div>
    `;

    document.body.appendChild(dialog);

    dialog.addEventListener('click', event => {
      if (event.target === dialog) closeSettingsDialog();
    });
    dialog.querySelector('.rbb-lightbox-close').addEventListener('click', closeSettingsDialog);
    dialog.addEventListener('cancel', () => { document.body.style.overflow = ''; });
    dialog.addEventListener('close', () => { document.body.style.overflow = ''; });

    dialog.querySelector('.rbb-settings-form').addEventListener('submit', event => {
      event.preventDefault();
      const form = event.currentTarget;
      setSetting('allDebridKey', form.allDebridKey.value.trim());
      setSetting('aria2Rpc', form.aria2Rpc.value.trim());
      setSetting('aria2Secret', form.aria2Secret.value.trim());
      setSetting('localAria2Rpc', form.localAria2Rpc.value.trim());
      setSetting('localAria2Secret', form.localAria2Secret.value.trim());
      setSetting('localAria2Dir', form.localAria2Dir.value.trim());

      const status = dialog.querySelector('[data-settings-status]');
      status.textContent = 'Saved ✓';
      setTimeout(() => { status.textContent = ''; }, 2500);
    });
  }

  function openSettingsDialog() {
    const dialog = document.getElementById('rbb-settings-dialog');
    if (!dialog) return;

    const settings = getDownloadSettings();
    const form = dialog.querySelector('.rbb-settings-form');
    form.allDebridKey.value = settings.allDebridKey;
    form.aria2Rpc.value = settings.aria2Rpc;
    form.aria2Secret.value = settings.aria2Secret;
    form.localAria2Rpc.value = settings.localAria2Rpc;
    form.localAria2Secret.value = settings.localAria2Secret;
    form.localAria2Dir.value = settings.localAria2Dir;

    if (!dialog.open) dialog.showModal();
    document.body.style.overflow = 'hidden';
  }

  function closeSettingsDialog() {
    const dialog = document.getElementById('rbb-settings-dialog');
    if (!dialog || !dialog.open) return;

    dialog.close();
    document.body.style.overflow = '';
  }

  function hideOriginalPageSafely() {
    const app = document.querySelector('#rbb-clean');

    if (!app || !app.querySelector('.rbb-card')) {
      console.warn('RBB Clean v11: custom UI did not render; original page left visible.');
      return;
    }

    const selectors = [
      '#masthead',
      '.site-header',
      '.main-navigation',
      '.site-logo-wrapper',
      '.dark-button',
      '.information',
      '#secondary',
      '#site-sidebar',
      '.widget-area',
      '.sidebar',
      '#post-wrapper',
      '.pagination',
      '.nav-links',
      '.page-header',
      '#wpfront-scroll-top-container'
    ];

    selectors.forEach(selector => {
      document.querySelectorAll(selector).forEach(element => {
        if (!element.closest('#rbb-clean')) {
          element.classList.add('rbb-hidden-original');
          element.style.display = 'none';
        }
      });
    });
  }

  function hidePosterWallsSafely() {
    const app = document.querySelector('#rbb-clean');
    if (!app) return;

    refreshRecommendedRail();

    [...document.querySelectorAll('div, aside, section')].forEach(el => {
      if (el === document.body || el === document.documentElement) return;
      if (el.contains(app) || app.contains(el)) return;
      if (el.closest('#rbb-clean')) return;

      const imgs = [...el.querySelectorAll('img')];
      if (imgs.length < 8) return;

      const usablePosterCount = imgs
        .map(imageToRecommendedItem)
        .filter(Boolean).length;

      if (usablePosterCount < 4) return;

      const rect = el.getBoundingClientRect();

      if (rect.height > 160 || rect.width > 160) {
        el.classList.add('rbb-hidden-original');
        el.style.display = 'none';
      }
    });
  }

  function findCategoryWidget() {
    return [...document.querySelectorAll('aside, .widget')]
      .find(widget => {
        const text = widget.textContent || '';
        return /categories/i.test(text) && widget.querySelector('a[href*="/category/"]');
      });
  }

  function findNextPageUrl(doc) {
    const selectors = [
      'a.next.page-numbers',
      '.nav-links a.next',
      'a[rel="next"]',
      '.pagination a.next',
      'a.page-numbers.next'
    ];

    for (const selector of selectors) {
      const link = doc.querySelector(selector);
      if (link && link.href) return abs(link.href);
    }

    const candidates = [...doc.querySelectorAll('a[href]')];
    const textNext = candidates.find(a => /next|older|»|›/i.test(cleanText(a.textContent)));
    if (textNext) return abs(textNext.href);

    const current = doc.querySelector('.page-numbers.current');
    if (current) {
      const currentNumber = Number(cleanText(current.textContent));
      const nextNumber = currentNumber + 1;
      const numericNext = candidates.find(a => cleanText(a.textContent) === String(nextNumber));
      if (numericNext) return abs(numericNext.href);
    }

    return '';
  }

  function extractAbsoluteDate(meta, article) {
    const match = meta.match(/Posted on\s+(.+?)\s+in\s+/i);
    if (match) return cleanText(match[1]);

    const month = cleanText(article.querySelector('.postMonth')?.textContent || '');
    const day = cleanText(article.querySelector('.postDay')?.textContent || '').replace(/\s+/g, ' ');

    if (month && day) return `${month} ${day}`;
    return '';
  }

  function parsePostedDate(text) {
    if (!text) return null;

    const cleaned = text
      .replace(/(\d+)(st|nd|rd|th)/gi, '$1')
      .replace(/\s+at\s+/i, ' ')
      .trim();

    let parsed = new Date(cleaned);
    if (!Number.isNaN(parsed.getTime())) return parsed;

    const match = cleaned.match(/^([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})?\s*(\d{1,2}:\d{1,2})\s*(am|pm)?$/i);
    if (match) {
      const year = match[3] || new Date().getFullYear();
      const time = match[4] || '00:00';
      const ampm = match[5] || '';
      parsed = new Date(`${match[1]} ${match[2]} ${year} ${time} ${ampm}`);
      if (!Number.isNaN(parsed.getTime())) return parsed;
    }

    return null;
  }

  function relativeTime(date) {
    const diffMs = Date.now() - date.getTime();
    const diffMinutes = Math.round(diffMs / 60000);

    if (diffMinutes < 1) return 'just now';
    if (diffMinutes < 60) return `${diffMinutes}m ago`;

    const hours = Math.round(diffMinutes / 60);
    if (hours < 24) return `${hours}h ago`;

    const days = Math.round(hours / 24);
    if (days < 30) return `${days}d ago`;

    const months = Math.round(days / 30);
    if (months < 12) return `${months}mo ago`;

    const years = Math.round(months / 12);
    return `${years}y ago`;
  }

  function getReadableText(node) {
    const clone = node.cloneNode(true);
    clone.querySelectorAll('script, iframe, style, .imdbRatingPlugin, img').forEach(n => n.remove());
    clone.querySelectorAll('br').forEach(br => br.replaceWith('\n'));
    return cleanTextWithLines(clone.textContent || '');
  }

  function abs(url) {
    try {
      return new URL(url, location.href).href;
    } catch {
      return url || '';
    }
  }

  function cleanText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function cleanTextWithLines(value) {
    return String(value || '')
      .replace(/\r/g, '')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n\s+/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function esc(value) {
    return String(value || '').replace(/[&<>'"]/g, char => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      "'": '&#39;',
      '"': '&quot;'
    }[char]));
  }

  function escAttr(value) {
    return esc(value);
  }

  function injectStyles() {
    if (document.getElementById('rbb-clean-v11-styles')) return;

    const style = document.createElement('style');
    style.id = 'rbb-clean-v11-styles';

    style.textContent = `
      :root {
        --rbb-bg: #0e151d;
        --rbb-border: rgba(255,255,255,.11);
        --rbb-border-strong: rgba(119,188,255,.24);
        --rbb-text: #edf4fb;
        --rbb-muted: #9baebe;
        --rbb-faint: #738697;
        --rbb-blue: #67b7ff;
        --rbb-brass: #d6a64c;
        --rbb-shadow: 0 22px 68px rgba(0,0,0,.38);
      }

      html,
      body.rbb-clean-body {
        background:
          radial-gradient(circle at top left, rgba(49, 88, 124, .22), transparent 34rem),
          linear-gradient(180deg, #0e151d 0%, #0b1118 100%) !important;
        color: var(--rbb-text) !important;
      }

      body.rbb-clean-body .site-wrapper,
      body.rbb-clean-body .site,
      body.rbb-clean-body .site-content,
      body.rbb-clean-body .site-content-inside,
      body.rbb-clean-body .container,
      body.rbb-clean-body .row,
      body.rbb-clean-body #primary,
      body.rbb-clean-body main {
        max-width: none !important;
        width: 100% !important;
        padding: 0 !important;
        margin: 0 !important;
        background: transparent !important;
        float: none !important;
        flex: none !important;
      }

      body.rbb-clean-body .row { display: block !important; }
      .rbb-hidden-original { display: none !important; }

      #rbb-clean {
        width: min(1680px, calc(100vw - 34px));
        margin: 10px auto 80px;
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;
      }

      .rbb-topbar {
        display: grid;
        grid-template-columns: 190px minmax(300px, 1fr) 104px 48px;
        gap: 9px;
        align-items: center;
        margin-bottom: 8px;
      }

      .rbb-brand,
      .rbb-search,
      .rbb-filters,
      .rbb-recommended {
        border: 1px solid var(--rbb-border);
        background: linear-gradient(145deg, rgba(255,255,255,.07), rgba(255,255,255,.028));
        backdrop-filter: blur(18px);
        box-shadow: var(--rbb-shadow);
        border-radius: 14px;
      }

      .rbb-brand {
        height: 48px;
        display: flex;
        align-items: center;
        gap: 9px;
        padding: 7px 10px;
      }

      .rbb-logo {
        width: 30px;
        height: 30px;
        border-radius: 10px;
        display: grid;
        place-items: center;
        font-size: 10px;
        font-weight: 950;
        color: #111822;
        background: linear-gradient(135deg, #d8b05d, #f5d994);
      }

      .rbb-title {
        font-size: 16px;
        line-height: 1;
        font-weight: 950;
        letter-spacing: -.03em;
      }

      .rbb-subtitle {
        margin-top: 4px;
        color: var(--rbb-muted);
        font-size: 10px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .rbb-search {
        height: 48px;
        padding: 6px;
      }

      .rbb-site-search {
        height: 100%;
        display: flex !important;
        align-items: center !important;
        gap: 7px;
        margin: 0 !important;
      }

      .rbb-site-search label {
        flex: 1;
        margin: 0 !important;
        display: flex !important;
        align-items: center !important;
      }

      .rbb-site-search input[type="search"],
      .rbb-site-search input[name="s"] {
        width: 100% !important;
        height: 36px !important;
        min-height: 36px !important;
        line-height: 36px !important;
        border-radius: 10px !important;
        border: 1px solid var(--rbb-border-strong) !important;
        background: rgba(0,0,0,.20) !important;
        color: var(--rbb-text) !important;
        padding: 0 12px !important;
        font-size: 13px !important;
        outline: none !important;
        box-sizing: border-box !important;
      }

      .rbb-site-search button,
      .rbb-site-search input[type="submit"] {
        width: 76px !important;
        height: 36px !important;
        min-height: 36px !important;
        border: 0 !important;
        border-radius: 10px !important;
        background: linear-gradient(135deg, #2b6fa4, #5b9fd7) !important;
        color: white !important;
        font-weight: 850 !important;
        font-size: 11px !important;
        cursor: pointer;
        display: inline-flex !important;
        align-items: center !important;
        justify-content: center !important;
        padding: 0 !important;
        box-sizing: border-box !important;
      }

      .rbb-menu { position: relative; height: 48px; }

      .rbb-menu > summary {
        height: 48px;
        display: flex;
        align-items: center;
        justify-content: center;
        list-style: none;
        border-radius: 14px;
        border: 1px solid var(--rbb-border);
        background: linear-gradient(145deg, rgba(255,255,255,.07), rgba(255,255,255,.028));
        padding: 0 10px;
        cursor: pointer;
        font-size: 11px;
        font-weight: 800;
        color: var(--rbb-text);
        box-shadow: var(--rbb-shadow);
      }

      .rbb-menu > summary::-webkit-details-marker { display: none; }

      .rbb-menu-panel {
        position: absolute;
        right: 0;
        top: calc(100% + 8px);
        z-index: 80;
        width: min(390px, 92vw);
        max-height: 70vh;
        overflow: auto;
        border-radius: 14px;
        border: 1px solid var(--rbb-border);
        background: rgba(12,20,29,.98);
        box-shadow: var(--rbb-shadow);
        padding: 14px;
      }

      .rbb-menu-panel a {
        color: var(--rbb-blue) !important;
        text-decoration: none !important;
      }

      .rbb-menu-panel ul {
        margin: 5px 0 5px 16px;
        padding: 0;
      }

      .rbb-filters {
        position: sticky;
        top: 8px;
        z-index: 50;
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: 7px;
        padding: 7px;
        margin-bottom: 10px;
      }

      .rbb-filter-input,
      .rbb-sort {
        height: 29px;
        border-radius: 9px;
        border: 1px solid var(--rbb-border);
        background: rgba(0,0,0,.20);
        color: var(--rbb-text);
        padding: 0 10px;
        font-size: 12px;
        outline: none;
      }

      .rbb-filter-input {
        flex: 1 1 180px;
        max-width: 260px;
      }

      .rbb-version-filter-group {
        display: flex;
        flex-wrap: wrap;
        gap: 5px;
        align-items: center;
      }

      .rbb-toggle,
      .rbb-version-toggle {
        height: 29px;
        display: inline-flex;
        align-items: center;
        gap: 6px;
        border-radius: 999px;
        padding: 0 9px;
        border: 1px solid var(--rbb-border);
        background: rgba(255,255,255,.035);
        color: var(--rbb-muted);
        font-size: 11px;
        user-select: none;
        cursor: pointer;
      }

      .rbb-toggle input,
      .rbb-version-toggle input {
        accent-color: var(--rbb-brass);
        width: 12px;
        height: 12px;
      }

      .rbb-toggle:has(input:checked) {
        color: var(--rbb-text);
        border-color: rgba(214,166,76,.40);
        background: rgba(214,166,76,.10);
      }

      .rbb-version-toggle:has(input:checked) {
        color: #f8fbff;
        border-color: rgba(255,255,255,.25);
      }

      .rbb-version-1080p:has(input:checked) { background: rgba(52, 116, 191, .42); }
      .rbb-version-4k:has(input:checked) { background: rgba(214, 166, 76, .42); }
      .rbb-version-hdr:has(input:checked) { background: rgba(139, 100, 211, .42); }
      .rbb-version-dv:has(input:checked) { background: rgba(190, 82, 157, .42); }
      .rbb-version-x265:has(input:checked) { background: rgba(77, 157, 130, .42); }
      .rbb-version-webdl:has(input:checked) { background: rgba(80, 128, 164, .42); }

      .rbb-layout {
        display: grid !important;
        grid-template-columns: minmax(0, 1fr) 220px !important;
        gap: 14px;
        align-items: start;
      }

      /* post pages and search results don't show the recommended rail (homepage only) */
      .rbb-layout-full {
        grid-template-columns: minmax(0, 1fr) !important;
      }

      .rbb-grid {
        grid-column: 1 !important;
        grid-row: 1 !important;
        min-width: 0;
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
        gap: 12px;
        align-items: start;
      }

      /* post detail pages only ever hold a single card - the dense auto-fill
         grid above still reserves several empty 300px+ columns beside it,
         which is what made the detail card look squished into a corner.
         Fall back to a single centred, full-width column instead. */
      .rbb-post-mode .rbb-grid {
        display: block;
      }

      .rbb-post-mode .rbb-detail-card {
        max-width: 960px;
        margin: 0 auto;
      }

      .rbb-side {
        grid-column: 2 !important;
        grid-row: 1 !important;
        width: auto !important;
        min-width: 0 !important;
        max-width: 220px !important;
        position: sticky;
        top: 72px;
        align-self: start;
        min-height: 200px;
      }

      .rbb-sentinel {
        height: 1px;
        width: 1px;
        pointer-events: none;
      }

      .rbb-recommended {
        padding: 10px;
        max-height: calc(100vh - 92px);
        overflow: hidden;
      }

      .rbb-recommended > summary {
        cursor: pointer;
        font-size: 11px;
        font-weight: 900;
        text-transform: uppercase;
        letter-spacing: .02em;
        color: var(--rbb-muted);
        list-style: none;
      }

      .rbb-recommended > summary::-webkit-details-marker { display: none; }

      .rbb-recommended-scroll {
        margin-top: 9px;
        max-height: calc(100vh - 135px);
        overflow-y: auto;
        display: grid;
        grid-template-columns: 1fr;
        gap: 9px;
        padding-right: 2px;
      }

      .rbb-rec-item { display: block; }

      .rbb-rec-item img {
        width: 100% !important;
        aspect-ratio: 169 / 250;
        height: auto !important;
        object-fit: cover;
        display: block;
        border-radius: 11px;
        border: 1px solid var(--rbb-border);
        box-shadow: 0 10px 26px rgba(0,0,0,.24);
        background: #071019;
      }

      .rbb-recommended-empty {
        color: var(--rbb-faint);
        font-size: 11px;
        margin-top: 8px;
      }

      .rbb-card {
        position: relative;
        overflow: hidden;
        border-radius: 16px;
        border: 1px solid var(--rbb-border);
        background: linear-gradient(155deg, rgba(255,255,255,.074), rgba(255,255,255,.028));
        backdrop-filter: blur(18px);
        box-shadow: 0 12px 34px rgba(0,0,0,.30);
      }

      .rbb-card[hidden],
      .rbb-release-row[hidden] {
        display: none !important;
      }

      .rbb-card-clickable {
        cursor: pointer;
        transition: transform .12s ease, border-color .12s ease;
      }

      .rbb-card-clickable:hover {
        transform: translateY(-2px);
        border-color: rgba(119,188,255,.30);
      }

      /* dense grid card is the default; .rbb-detail-card (post page + lightbox) restores the spacious layout */
      .rbb-image {
        display: flex;
        align-items: center;
        justify-content: center;
        width: calc(100% - 16px);
        aspect-ratio: 16 / 6;
        overflow: hidden;
        background: #071019;
        border-radius: 12px;
        margin: 8px 8px 0;
        color: var(--rbb-faint);
        font-size: 10px;
      }

      .rbb-detail-card .rbb-image {
        width: calc(100% - 20px);
        aspect-ratio: 520 / 170;
        border-radius: 16px;
        margin: 10px 10px 0;
      }

      .rbb-image img {
        width: 100%;
        height: 100%;
        object-fit: cover;
        object-position: center top;
        display: block;
        transition: transform .22s ease, opacity .22s ease;
        background: #071019;
      }

      .rbb-card:hover .rbb-image img {
        transform: scale(1.006);
        opacity: .98;
      }

      .rbb-no-image {
        height: 100%;
        min-height: 60px;
        display: grid;
        place-items: center;
        color: var(--rbb-muted);
        font-size: 12px;
      }

      .rbb-detail-card .rbb-no-image { min-height: 170px; }

      .rbb-content {
        padding: 11px 12px 12px;
        min-width: 0;
      }

      .rbb-detail-card .rbb-content { padding: 16px; }

      .rbb-card-title {
        margin: 0 0 6px !important;
        font-size: 14px !important;
        font-weight: 850 !important;
        line-height: 1.25 !important;
        letter-spacing: -.01em;
        text-wrap: balance;
      }

      .rbb-detail-card .rbb-card-title {
        margin: 0 0 8px !important;
        font-size: 26px !important;
        font-weight: 950 !important;
        line-height: 1.12 !important;
        letter-spacing: -.02em;
      }

      .rbb-card-title a {
        color: var(--rbb-text) !important;
        text-decoration: none !important;
      }

      .rbb-top-meta {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 8px 12px;
        margin-bottom: 9px;
      }

      .rbb-cats,
      .rbb-badges,
      .rbb-release-badges {
        display: flex;
        flex-wrap: wrap;
        gap: 5px;
      }

      .rbb-cat-pill,
      .rbb-relative {
        display: inline-flex;
        align-items: center;
        min-height: 20px;
        border-radius: 999px;
        padding: 3px 7px;
        font-size: 10px;
        font-weight: 800;
        line-height: 1;
      }

      .rbb-cat-pill {
        all: unset;
        box-sizing: border-box;
        display: inline-flex;
        align-items: center;
        min-height: 20px;
        border-radius: 999px;
        padding: 3px 7px;
        font-size: 10px;
        font-weight: 800;
        font-family: inherit;
        line-height: 1;
        color: #c8d5df;
        background: rgba(255,255,255,.058);
        cursor: pointer;
      }

      .rbb-cat-pill:hover { color: #fff; background: rgba(103,183,255,.28); }

      .rbb-date-line {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 7px;
        color: var(--rbb-muted);
        font-size: 11px;
      }

      .rbb-date-line strong {
        color: #dce8f4;
        font-weight: 850;
      }

      .rbb-relative {
        color: #111822;
        background: linear-gradient(135deg, #c9d9e7, #ffffff);
        white-space: nowrap;
      }

      .rbb-chip {
        display: inline-flex;
        align-items: center;
        min-height: 20px;
        border-radius: 999px;
        padding: 3px 8px;
        font-size: 10px;
        font-weight: 950;
        line-height: 1;
        border: 1px solid rgba(255,255,255,.10);
      }

      .rbb-chip-4k { color: #fff3cf; background: rgba(188, 132, 35, .70); border-color: rgba(255, 207, 110, .28); }
      .rbb-chip-1080p { color: #dff0ff; background: rgba(45, 105, 175, .70); border-color: rgba(121, 187, 255, .28); }
      .rbb-chip-720p { color: #e4f8ff; background: rgba(48, 119, 139, .64); border-color: rgba(132, 218, 239, .24); }
      .rbb-chip-480p { color: #d7dee7; background: rgba(96, 106, 118, .60); border-color: rgba(210, 220, 230, .18); }
      .rbb-chip-hdr { color: #f0e7ff; background: rgba(113, 78, 181, .66); border-color: rgba(192, 159, 255, .28); }
      .rbb-chip-dv { color: #ffe3f3; background: rgba(161, 62, 129, .70); border-color: rgba(255, 144, 212, .28); }
      .rbb-chip-x265 { color: #defaf1; background: rgba(47, 126, 103, .66); border-color: rgba(128, 234, 202, .24); }
      .rbb-chip-x264 { color: #eef5fb; background: rgba(86, 103, 122, .62); border-color: rgba(200, 215, 230, .18); }
      .rbb-chip-webdl { color: #e6f4ff; background: rgba(55, 100, 136, .68); border-color: rgba(132, 196, 244, .24); }
      .rbb-chip-webrip { color: #e8f6ff; background: rgba(52, 90, 124, .62); border-color: rgba(132, 196, 244, .20); }
      .rbb-chip-bluray { color: #ece8ff; background: rgba(71, 72, 143, .66); border-color: rgba(166, 168, 255, .22); }
      .rbb-chip-atmos { color: #fff0d7; background: rgba(143, 93, 44, .66); border-color: rgba(245, 191, 88, .22); }
      .rbb-chip-default { color: #dce8f4; background: rgba(255,255,255,.08); }

      .rbb-badges { margin-bottom: 8px; gap: 4px; }
      .rbb-badges .rbb-chip { font-size: 9px; padding: 2px 6px; min-height: 16px; }

      .rbb-description {
        color: #c3d1dc;
        font-size: 11px;
        line-height: 1.45;
        margin: 6px 0 8px;
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
      }

      .rbb-detail-card .rbb-description {
        color: #dce7f2;
        font-size: 12px;
        margin: 8px 0 10px;
        display: block;
        -webkit-line-clamp: initial;
        overflow: visible;
        max-width: 65ch;
      }

      .rbb-release-list {
        margin-top: 8px;
        display: grid;
        gap: 6px;
      }

      .rbb-release-heading {
        display: flex;
        align-items: center;
        justify-content: space-between;
        border-top: 1px solid rgba(255,255,255,.075);
        padding-top: 9px;
      }

      .rbb-release-heading h3 {
        margin: 0 !important;
        color: var(--rbb-blue);
        font-size: 12px !important;
        font-weight: 950;
      }

      .rbb-release-heading span {
        color: var(--rbb-faint);
        font-size: 10px;
      }

      .rbb-release-row {
        display: grid;
        grid-template-columns: 64px minmax(0, 1fr) 78px;
        gap: 8px;
        align-items: center;
        padding: 8px;
        border-radius: 12px;
        background: rgba(0,0,0,.18);
        border: 1px solid rgba(255,255,255,.07);
      }

      .rbb-detail-card .rbb-release-row {
        grid-template-columns: 116px minmax(0, 1fr) 128px;
        gap: 12px;
        padding: 12px;
        border-radius: 16px;
      }

      .rbb-best-row {
        background: linear-gradient(145deg, rgba(214,166,76,.13), rgba(0,0,0,.20));
        border-color: rgba(214,166,76,.25);
      }

      .rbb-quality-block {
        display: grid;
        gap: 4px;
      }

      .rbb-detail-card .rbb-quality-block { gap: 7px; }

      .rbb-quality-label {
        width: fit-content;
        min-width: 52px;
        text-align: center;
        border-radius: 999px;
        padding: 5px 8px;
        font-size: 11px;
        font-weight: 1000;
        color: #101820;
        background: linear-gradient(135deg, #dbe9f6, #ffffff);
      }

      .rbb-detail-card .rbb-quality-label {
        min-width: 68px;
        padding: 8px 12px;
        font-size: 15px;
      }

      .rbb-quality-4k {
        color: #211603;
        background: linear-gradient(135deg, #c89532, #ffe09a);
      }

      .rbb-quality-1080p {
        color: #061526;
        background: linear-gradient(135deg, #77baff, #e2f3ff);
      }

      .rbb-quality-720p {
        color: #061b21;
        background: linear-gradient(135deg, #83d7e8, #e8fbff);
      }

      .rbb-quality-480p {
        color: #111820;
        background: linear-gradient(135deg, #c7d0da, #f3f7fb);
      }

      .rbb-size-badge {
        width: fit-content;
        min-width: 52px;
        text-align: center;
        border-radius: 8px;
        padding: 5px 7px;
        color: #f7dca3;
        background: rgba(214,166,76,.12);
        border: 1px solid rgba(214,166,76,.24);
        font-size: 11px;
        font-weight: 1000;
        white-space: nowrap;
        font-variant-numeric: tabular-nums;
      }

      .rbb-detail-card .rbb-size-badge {
        min-width: 68px;
        padding: 7px 10px;
        font-size: 15px;
      }

      .rbb-release-name {
        color: #edf4fb;
        font-weight: 850;
        font-size: 11px;
        line-height: 1.35;
        word-break: break-word;
        overflow: hidden;
        text-overflow: ellipsis;
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
      }

      .rbb-detail-card .rbb-release-name {
        font-size: 13px;
        display: block;
        -webkit-line-clamp: initial;
      }

      .rbb-release-meta {
        display: flex;
        flex-wrap: wrap;
        gap: 7px;
        margin-top: 5px;
        color: var(--rbb-muted);
        font-size: 11px;
      }

      .rbb-release-badges {
        margin-top: 5px;
      }

      .rbb-release-row .rbb-release-badges .rbb-chip { font-size: 9px; padding: 2px 6px; min-height: 15px; }
      .rbb-detail-card .rbb-release-row .rbb-release-badges .rbb-chip { font-size: 10px; padding: 3px 8px; min-height: 20px; }

      .rbb-release-actions {
        display: flex;
        flex-direction: column;
        align-items: stretch;
        gap: 6px;
      }

      .rbb-release-rg {
        display: flex;
        flex-direction: column;
        gap: 5px;
      }

      .rbb-rg-action {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-height: 26px;
        border-radius: 9px;
        padding: 5px 9px;
        color: #f6ead4 !important;
        background: linear-gradient(135deg, #6b4a1f, #a5752e);
        border: 1px solid rgba(245,191,88,.30);
        font-weight: 950;
        text-decoration: none !important;
        font-size: 10px;
        box-shadow: 0 6px 16px rgba(0,0,0,.18);
      }

      .rbb-detail-card .rbb-rg-action {
        min-height: 34px;
        border-radius: 11px;
        padding: 7px 12px;
        font-size: 12px;
        box-shadow: 0 10px 24px rgba(0,0,0,.18);
      }

      .rbb-rg-action:hover { filter: brightness(1.12); }

      .rbb-settings-btn {
        height: 48px;
        border-radius: 14px;
        border: 1px solid var(--rbb-border);
        background: linear-gradient(145deg, rgba(255,255,255,.07), rgba(255,255,255,.028));
        color: var(--rbb-text);
        font-size: 18px;
        cursor: pointer;
        box-shadow: var(--rbb-shadow);
      }

      .rbb-settings-btn:hover { filter: brightness(1.15); }

      .rbb-dl-btn {
        all: unset;
        box-sizing: border-box;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 2px;
        width: 100%;
        min-height: 34px;
        padding: 4px 2px;
        border-radius: 8px;
        border: 1px solid rgba(255,255,255,.14);
        font-weight: 850;
        font-family: inherit;
        cursor: pointer;
        line-height: 1.15;
        white-space: normal;
        text-align: center;
      }

      .rbb-dl-icon { font-size: 12px; }
      .rbb-dl-label { font-size: 9px; }

      .rbb-detail-card .rbb-dl-btn { flex-direction: row; min-height: 32px; padding: 6px 8px; gap: 5px; }
      .rbb-detail-card .rbb-dl-icon { font-size: 13px; }
      .rbb-detail-card .rbb-dl-label { font-size: 11px; white-space: nowrap; }

      .rbb-dl-browser { background: rgba(77,157,130,.28); color: #b6f2dc; }
      .rbb-dl-browser:hover { background: rgba(77,157,130,.42); }

      .rbb-dl-aria2 { background: rgba(45,105,175,.28); color: #cfe6ff; }
      .rbb-dl-aria2:hover { background: rgba(45,105,175,.42); }

      .rbb-dl-protected { background: rgba(214,166,76,.24); color: #f7dca3; text-decoration: none; }
      .rbb-dl-protected:hover { background: rgba(214,166,76,.38); }

      .rbb-dl-btn:disabled { opacity: .55; cursor: default; }

      .rbb-release-dead { opacity: .62; }
      .rbb-release-dead .rbb-release-name { text-decoration: line-through; }
      .rbb-release-dead .rbb-quality-block { filter: grayscale(1); }

      .rbb-dead-banner {
        display: flex;
        align-items: center;
        justify-content: center;
        text-align: center;
        width: 100%;
        min-height: 34px;
        padding: 6px 4px;
        border-radius: 8px;
        background: rgba(220,60,60,.22);
        border: 1px solid rgba(255,120,120,.45);
        color: #ffb8b8;
        font-size: 9px;
        font-weight: 900;
        line-height: 1.25;
        cursor: help;
      }

      .rbb-detail-card .rbb-dead-banner { font-size: 11px; min-height: 32px; padding: 8px; }

      .rbb-dl-busy {
        animation: rbb-dl-pulse 1s ease-in-out infinite;
      }

      @keyframes rbb-dl-pulse {
        0%, 100% { opacity: 1; }
        50% { opacity: .45; }
      }

      .rbb-dl-status {
        display: block;
        width: 100%;
        text-align: right;
        font-size: 10px;
        color: var(--rbb-blue);
        min-height: 12px;
      }

      .rbb-dl-status.rbb-dl-error { color: #ff9d9d; }

      /* indeterminate sweep bar - a stronger "this is genuinely still working" signal than
         the status text alone, since AllDebrid unlock/caching has no real progress percentage
         for most single-file hosts. */
      .rbb-dl-progress {
        display: none;
        height: 3px;
        width: 100%;
        margin-top: 5px;
        border-radius: 999px;
        overflow: hidden;
        background: rgba(255,255,255,.08);
      }

      .rbb-dl-progress.rbb-dl-progress-active {
        display: block;
      }

      .rbb-dl-progress.rbb-dl-progress-active::after {
        content: '';
        display: block;
        height: 100%;
        width: 40%;
        background: var(--rbb-blue);
        border-radius: 999px;
        animation: rbb-dl-sweep 1.1s ease-in-out infinite;
      }

      @keyframes rbb-dl-sweep {
        0% { margin-left: -40%; }
        100% { margin-left: 100%; }
      }

      .rbb-settings-form {
        display: grid;
        gap: 12px;
        margin-top: 6px;
      }

      .rbb-settings-field {
        display: grid;
        gap: 5px;
        font-size: 12px;
        color: var(--rbb-muted);
      }

      .rbb-settings-field input {
        height: 36px;
        border-radius: 9px;
        border: 1px solid var(--rbb-border-strong);
        background: rgba(0,0,0,.20);
        color: var(--rbb-text);
        padding: 0 10px;
        font-size: 13px;
        outline: none;
      }

      .rbb-settings-actions {
        display: flex;
        align-items: center;
        justify-content: flex-end;
        gap: 10px;
        margin-top: 4px;
      }

      .rbb-settings-status { font-size: 12px; color: #9ef0c8; }

      .rbb-no-rg,
      .rbb-muted {
        color: var(--rbb-faint);
        font-size: 12px;
      }

      .rbb-release-extras {
        display: flex;
        justify-content: flex-end;
        gap: 5px;
        opacity: .75;
      }

      .rbb-mini-extra {
        width: 25px;
        height: 25px;
        display: grid;
        place-items: center;
        border-radius: 8px;
        border: 1px solid var(--rbb-border);
        background: rgba(0,0,0,.22);
        color: var(--rbb-blue) !important;
        text-decoration: none !important;
        font-size: 9px;
        font-weight: 900;
      }

      .rbb-all-versions {
        margin-top: 3px;
        border-top: 1px solid rgba(255,255,255,.06);
        padding-top: 7px;
      }

      .rbb-all-versions > summary {
        cursor: pointer;
        width: fit-content;
        color: var(--rbb-blue);
        font-weight: 900;
        font-size: 12px;
        list-style: none;
        padding: 5px 0;
      }

      .rbb-all-versions > summary::-webkit-details-marker { display: none; }

      .rbb-all-version-list {
        display: grid;
        gap: 8px;
        margin-top: 4px;
      }

      .rbb-card .rbb-release-actions img,
      .rbb-card .rbb-release-actions svg,
      .rbb-card .rbb-release-actions canvas,
      .rbb-card .rbb-release-actions iframe,
      .rbb-card .rbb-release-actions object,
      .rbb-card .rbb-release-rg > a:not(.rbb-rg-action):not(.rbb-dl-protected),
      .rbb-card .rbb-release-actions > a:not(.rbb-rg-action):not(.rbb-mini-extra):not(.rbb-dl-protected) {
        display: none !important;
      }

      .rbb-comments,
      .rbb-comment-rg {
        margin-top: 8px;
        padding-top: 8px;
        border-top: 1px solid rgba(255,255,255,.075);
      }

      .rbb-comments > summary,
      .rbb-comment-rg > summary {
        cursor: pointer;
        color: var(--rbb-blue);
        font-weight: 900;
        font-size: 11px;
        list-style: none;
      }

      .rbb-comments > summary::-webkit-details-marker,
      .rbb-comment-rg > summary::-webkit-details-marker {
        display: none;
      }

      body.rbb-post-mode .rbb-force-open > summary {
        pointer-events: none !important;
        cursor: default !important;
        color: var(--rbb-blue) !important;
      }

      body.rbb-post-mode .rbb-force-open > summary::after {
        content: " — expanded";
        color: var(--rbb-faint);
        font-weight: 700;
      }

      .rbb-comment-rg-list {
        display: flex;
        flex-wrap: wrap;
        gap: 7px;
        margin-top: 8px;
      }

      .rbb-comment-rg-link {
        color: #f6ead4 !important;
        border: 1px solid rgba(245,191,88,.22);
        background: rgba(107,74,31,.52);
        border-radius: 9px;
        padding: 6px 9px;
        font-size: 11px;
        font-weight: 850;
        text-decoration: none !important;
      }

      .rbb-comments-body {
        margin-top: 9px;
        max-height: 340px;
        overflow: auto;
        color: #dbe8f5;
        font-size: 12px;
      }

      .rbb-comments-body .commentList,
      .rbb-comments-body .comment-list,
      .rbb-comments-body #comments {
        color: #dbe8f5 !important;
        background: transparent !important;
        list-style: none !important;
        margin: 0 !important;
        padding: 0 !important;
      }

      /* the site's own comment markup (.author/.avatar/.name/.messageBox/.date/.content) has
         its own light-theme box styling that otherwise bleeds through as a white panel here */
      .rbb-comments-body li.comment {
        display: flex !important;
        gap: 8px !important;
        padding: 9px 0 !important;
        margin: 0 !important;
        border: 0 !important;
        border-top: 1px solid rgba(255,255,255,.07) !important;
        background: transparent !important;
      }

      .rbb-comments-body li.comment:first-child { border-top: 0 !important; }

      .rbb-comments-body .author {
        flex-shrink: 0 !important;
        width: 30px !important;
        background: transparent !important;
      }

      .rbb-comments-body .avatar {
        width: 30px !important;
        height: 30px !important;
        border-radius: 50% !important;
        background: rgba(255,255,255,.08) !important;
        overflow: hidden !important;
      }

      .rbb-comments-body .avatar img,
      .rbb-comments-body .name img {
        width: 100% !important;
        max-width: 220px !important;
        height: auto !important;
        border-radius: 6px !important;
        display: block !important;
      }

      .rbb-comments-body .name {
        font-weight: 850 !important;
        color: #dce8f4 !important;
        background: transparent !important;
        font-size: 12px !important;
      }

      .rbb-comments-body .messageBox {
        flex: 1 !important;
        min-width: 0 !important;
        background: transparent !important;
        border: 0 !important;
        box-shadow: none !important;
        padding: 0 !important;
        max-height: none !important;
      }

      .rbb-comments-body .date {
        color: var(--rbb-faint) !important;
        font-size: 10px !important;
        background: transparent !important;
        margin-bottom: 4px !important;
      }

      .rbb-comments-body .content,
      .rbb-comments-body .content p {
        background: transparent !important;
        color: #dbe8f5 !important;
        margin: 0 !important;
        line-height: 1.5 !important;
        word-break: break-word !important;
      }

      .rbb-comments-body a {
        color: var(--rbb-blue) !important;
        word-break: break-all !important;
      }

      .rbb-footer {
        display: flex;
        justify-content: space-between;
        gap: 10px;
        margin-top: 10px;
        color: var(--rbb-faint);
        font-size: 10px;
      }

      .rbb-footer a {
        color: var(--rbb-blue) !important;
        text-decoration: none !important;
        font-weight: 900;
      }

      .rbb-extension-bridge {
        position: absolute !important;
        left: -99999px !important;
        top: auto !important;
        width: 1px !important;
        height: 1px !important;
        overflow: hidden !important;
        opacity: 0 !important;
        pointer-events: none !important;
      }

      .rbb-loader {
        margin: 28px auto;
        width: fit-content;
        padding: 10px 16px;
        border-radius: 999px;
        background: rgba(255,255,255,.08);
        color: var(--rbb-muted);
      }

      .screen-reader-text { display: none !important; }

      .rbb-lightbox-dialog {
        position: fixed;
        inset: 0;
        margin: auto;
        width: min(760px, calc(100vw - 32px));
        max-width: none;
        max-height: 90vh;
        padding: 0;
        border: 0;
        border-radius: 20px;
        overflow-y: auto;
        background: transparent;
        color: var(--rbb-text);
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;
      }

      /* the dialog itself carries no background so its rounded corners show through;
         .rbb-detail-card (the cloned post card) supplies the actual panel look */
      .rbb-lightbox-dialog .rbb-card { margin: 0; }

      .rbb-settings-dialog { width: min(420px, calc(100vw - 32px)); }

      /* standalone panel injected on the RapidGator file page itself — the host page has its
         own plain light theme, so this needs to carry its own spacing rather than relying on
         .rbb-layout/.rbb-topbar like the RLSBB pages do */
      .rbb-rg-page-panel {
        width: min(620px, calc(100vw - 32px));
        margin: 16px auto;
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;
      }

      .rbb-rg-page-panel .rbb-card-title { font-size: 18px !important; }
      .rbb-rg-page-panel input#rbb-rg-filename { width: 100%; }

      .rbb-lightbox-dialog::backdrop {
        background: rgba(4,8,12,.72);
        backdrop-filter: blur(6px);
      }

      .rbb-lightbox-dialog[open] {
        animation: rbb-lightbox-in .16s ease;
      }

      @keyframes rbb-lightbox-in {
        from { opacity: 0; transform: translateY(10px) scale(.98); }
        to { opacity: 1; transform: translateY(0) scale(1); }
      }

      @media (prefers-reduced-motion: reduce) {
        .rbb-lightbox-dialog[open] { animation: none; }
      }

      /* !important throughout: the host page's own theme (WPFront scroll-to-top, gallery
         lightbox plugins, etc.) styles generic round icon buttons aggressively, and has
         collided with this button twice already — all:unset alone isn't enough to beat
         another author stylesheet's rules, only the browser's own defaults. */
      .rbb-lightbox-close {
        all: unset !important;
        box-sizing: border-box !important;
        position: absolute !important;
        top: 10px !important;
        right: 10px !important;
        width: 30px !important;
        height: 30px !important;
        min-width: 30px !important;
        min-height: 30px !important;
        max-width: 30px !important;
        max-height: 30px !important;
        padding: 0 !important;
        margin: 0 !important;
        display: flex !important;
        align-items: center !important;
        justify-content: center !important;
        border-radius: 50% !important;
        border: 1px solid rgba(255,255,255,.22) !important;
        background: rgba(10,16,22,.88) !important;
        color: #edf4fb !important;
        line-height: 1 !important;
        cursor: pointer !important;
        box-shadow: 0 6px 18px rgba(0,0,0,.35) !important;
        z-index: 5 !important;
      }

      .rbb-lightbox-close svg { display: block !important; width: 14px !important; height: 14px !important; color: inherit !important; }

      .rbb-lightbox-close:hover {
        background: #223142 !important;
        border-color: rgba(255,255,255,.34) !important;
      }

      .rbb-lightbox-close:focus-visible {
        outline: 2px solid var(--rbb-blue) !important;
        outline-offset: 2px !important;
      }

      @media (max-width: 980px) {
        #rbb-clean { width: calc(100vw - 20px); }

        .rbb-layout {
          grid-template-columns: 1fr !important;
        }

        .rbb-grid {
          grid-column: 1 !important;
        }

        .rbb-side {
          display: none !important;
        }
      }

      @media (max-width: 860px) {
        .rbb-topbar {
          grid-template-columns: 1fr;
        }

        .rbb-release-row {
          grid-template-columns: 1fr;
        }

        .rbb-release-actions {
          align-items: flex-start;
        }

        .rbb-release-rg {
          justify-content: flex-start;
        }
      }
    `;

    document.head.appendChild(style);
  }

  const isRlsbbHost = /(^|\.)rlsbb\.in$/i.test(location.hostname);
  const onRapidGator = /(^|\.)rapidgator\.net$/i.test(location.hostname);
  const onProtectedTo = /(^|\.)protected\.to$/i.test(location.hostname);

  function bootForThisPage() {
    // The magnet-link helper is universal (runs everywhere the @match covers, i.e. every
    // site) and independent of which RLSBB-specific flow (if any) also runs on this page.
    injectSettingsDialog();
    initMagnetLinkHelper();

    if (onRapidGator) initRapidGatorPage();
    else if (onProtectedTo) initProtectedToPage();
    else if (isRlsbbHost) init();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootForThisPage);
  } else {
    bootForThisPage();
  }
})();
