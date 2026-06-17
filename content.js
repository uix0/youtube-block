// YouTube Channel Blocker — content script
// 1. Remembers which video you last right-clicked.
// 2. Hides every video whose channel you've blocked, anywhere on the site.
//
// YouTube now uses the "view-model" architecture (yt-lockup-view-model). The
// home grid exposes a channel handle (/@name), but the watch-page sidebar does
// NOT expose any channel link — only the avatar's aria-label="Go to channel X".
// So we match on EITHER the channel handle OR the channel name.

(() => {
  "use strict";

  // Elements that wrap a single video "card" across YouTube's surfaces.
  // New view-model surfaces + legacy renderers (for older/experiment layouts).
  const VIDEO_CONTAINERS = [
    "yt-lockup-view-model",          // NEW: home, sidebar, search, etc.
    "ytd-rich-item-renderer",        // grid cell wrapping a lockup (home)
    "ytd-video-renderer",            // legacy search / list
    "ytd-compact-video-renderer",    // legacy sidebar
    "ytd-grid-video-renderer",       // legacy channel grids
    "ytd-playlist-video-renderer",   // legacy playlist entries
    "ytd-rich-grid-media"            // legacy grid media
  ];
  const CONTAINER_SELECTOR = VIDEO_CONTAINERS.join(",");
  // Same list, but only cards we haven't already resolved — keeps steady-state
  // passes cheap on long infinite-scroll sessions.
  const UNCHECKED_SELECTOR = VIDEO_CONTAINERS.map(
    (s) => s + ":not([data-ycb-checked])"
  ).join(",");

  // When we hide, prefer hiding the outer grid cell so no empty slot remains.
  const HIDE_WRAPPER_SELECTOR = "ytd-rich-item-renderer, ytd-rich-grid-media";

  // Anchors that point at a channel (when one exists).
  const CHANNEL_ANCHOR_SELECTOR =
    'a[href^="/@"], a[href^="/channel/"], a[href^="/user/"], a[href^="/c/"]';

  const GO_TO_CHANNEL_PREFIX = "Go to channel ";

  // blocked = { key: { handle, name, level } }. Key is handle if known, else
  // "name:<lower>". level is "feed" (default: hidden everywhere EXCEPT search)
  // or "all" (hidden everywhere including search).
  let blocked = {};
  let blockedByHandle = new Map();
  let blockedByName = new Map(); // key: lowercased+trimmed name
  let settings = { hideShorts: false, hideGaming: false };
  let lastRightClicked = null;

  // ---- storage helpers -----------------------------------------------------

  function rebuildIndexes() {
    blockedByHandle = new Map();
    blockedByName = new Map();
    for (const k of Object.keys(blocked)) {
      const e = blocked[k] || {};
      if (e.handle) blockedByHandle.set(e.handle, e);
      if (e.name) blockedByName.set(e.name.trim().toLowerCase(), e);
    }
    // The blocklist changed, so every card must be re-evaluated.
    resetChecks();
  }

  function resetChecks() {
    document
      .querySelectorAll("[data-ycb-checked]")
      .forEach((el) => el.removeAttribute("data-ycb-checked"));
  }

  function loadAll() {
    chrome.storage.sync.get(
      { blockedChannels: {}, hideShorts: false, hideGaming: false },
      (data) => {
        blocked = data.blockedChannels || {};
        settings.hideShorts = !!data.hideShorts;
        settings.hideGaming = !!data.hideGaming;
        rebuildIndexes();
        applySettings();
        applyBlocking();
        ensureWatchButton();
        ensureSidebarEntry();
        ensureMastheadButton();
      }
    );
  }

  function saveBlocked() {
    chrome.storage.sync.set({ blockedChannels: blocked });
  }

  function applySettings() {
    const body = document.body;
    if (!body) return;
    body.classList.toggle("ycb-hide-shorts", settings.hideShorts);
    body.classList.toggle("ycb-hide-gaming", settings.hideGaming);
    if (settings.hideShorts && location.pathname.startsWith("/shorts")) {
      location.replace("https://www.youtube.com/");
    }
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync" && area !== "local") return;
    if (changes.blockedChannels) {
      blocked = changes.blockedChannels.newValue || {};
      rebuildIndexes();
      applyBlocking();
      ensureWatchButton();
      refreshPanelIfOpen();
    }
    if (changes.hideShorts) settings.hideShorts = !!changes.hideShorts.newValue;
    if (changes.hideGaming) settings.hideGaming = !!changes.hideGaming.newValue;
    if (changes.hideShorts || changes.hideGaming) {
      applySettings();
      refreshPanelIfOpen();
    }
  });

  // ---- channel extraction --------------------------------------------------

  function handleFromAnchor(a) {
    try {
      const p = new URL(a.href, location.origin).pathname.replace(/\/$/, "");
      const m =
        p.match(/^\/@[^/]+/) || p.match(/^\/(channel|user|c)\/[^/]+/);
      return m ? m[0] : null;
    } catch (e) {
      return null;
    }
  }

  // Returns { handle, name } for the card containing `el` (either may be null).
  function channelOfContainer(container) {
    let handle = null;
    let name = null;

    // 1. Channel handle from a real channel link (present on home/search).
    const anchors = container.querySelectorAll(CHANNEL_ANCHOR_SELECTOR);
    for (const a of anchors) {
      const h = handleFromAnchor(a);
      if (h) {
        handle = h;
        const t = (a.textContent || "").trim();
        if (t) name = t;
        break;
      }
    }

    // 2. Channel name from the avatar's aria-label (present on home AND sidebar).
    if (!name) {
      const avatar = container.querySelector(
        '[aria-label^="' + GO_TO_CHANNEL_PREFIX + '"]'
      );
      if (avatar) {
        name = avatar
          .getAttribute("aria-label")
          .slice(GO_TO_CHANNEL_PREFIX.length)
          .trim();
      }
    }

    if (!handle && !name) return null;
    return { handle, name: name || null };
  }

  function findChannel(el) {
    if (!el || !el.closest) return null;
    const container = el.closest(CONTAINER_SELECTOR);
    if (!container) return null;
    return channelOfContainer(container);
  }

  // Resolve the card at a screen point by walking EVERY element stacked there.
  // Needed because hovering a thumbnail plays a shared <video> preview that
  // lives outside the card, so the card sits *beneath* it at the cursor.
  function findChannelAtPoint(x, y) {
    if (typeof x !== "number" || typeof y !== "number") return null;
    const els = document.elementsFromPoint(x, y);
    for (const el of els) {
      const container = el.closest && el.closest(CONTAINER_SELECTOR);
      if (container) {
        const info = channelOfContainer(container);
        if (info && (info.handle || info.name)) return info;
      }
    }
    return null;
  }

  // The channel of the video currently being watched (from the metadata header).
  function getWatchChannel() {
    const owner = document.querySelector(
      "ytd-watch-metadata ytd-video-owner-renderer"
    );
    if (!owner) return null;
    const a = owner.querySelector(CHANNEL_ANCHOR_SELECTOR);
    const handle = a ? handleFromAnchor(a) : null;
    let name = null;
    const nameEl = owner.querySelector(
      "ytd-channel-name #text a, ytd-channel-name a, #channel-name a"
    );
    if (nameEl) name = (nameEl.textContent || "").trim();
    if (!name && a) name = (a.textContent || "").trim();
    if (!handle && !name) return null;
    return { handle, name: name || null };
  }

  // ---- blocking ------------------------------------------------------------

  // Returns the matching blocked entry (with .level) or null.
  function blockedEntryFor(info) {
    if (!info) return null;
    if (info.handle && blockedByHandle.has(info.handle))
      return blockedByHandle.get(info.handle);
    if (info.name) {
      const n = info.name.trim().toLowerCase();
      if (blockedByName.has(n)) return blockedByName.get(n);
    }
    return null;
  }

  function isBlocked(info) {
    return !!blockedEntryFor(info);
  }

  function hasAnyBlocked() {
    return blockedByHandle.size > 0 || blockedByName.size > 0;
  }

  let lastOnSearch = null;

  function applyBlocking() {
    if (!hasAnyBlocked()) {
      document
        .querySelectorAll('[data-ycb-hidden="true"]')
        .forEach((el) => el.removeAttribute("data-ycb-hidden"));
      resetChecks();
      return;
    }
    // On the search results page, only "all"-level channels are hidden;
    // "feed"-level (the default) channels are allowed to appear in search.
    const onSearch = location.pathname.startsWith("/results");
    // The hide rule depends on whether we're in search, so a transition
    // between search and non-search requires re-evaluating every card.
    if (onSearch !== lastOnSearch) {
      resetChecks();
      lastOnSearch = onSearch;
    }
    // Only touch cards we haven't resolved yet. A card whose channel hasn't
    // loaded yet stays unmarked and gets retried on the next pass.
    const containers = document.querySelectorAll(UNCHECKED_SELECTOR);
    for (const c of containers) {
      const info = channelOfContainer(c);
      if (!info) continue; // channel not in the DOM yet — try again later
      c.setAttribute("data-ycb-checked", "1");
      const target = c.closest(HIDE_WRAPPER_SELECTOR) || c;
      const entry = blockedEntryFor(info);
      const level = entry && (entry.level || "feed");
      const shouldHide = entry && (!onSearch || level === "all");
      if (shouldHide) {
        target.setAttribute("data-ycb-hidden", "true");
      } else if (target.getAttribute("data-ycb-hidden")) {
        target.removeAttribute("data-ycb-hidden");
      }
    }
  }

  function blockChannel(info, level) {
    if (!info || (!info.handle && !info.name)) return false;
    const key = info.handle || "name:" + info.name.trim().toLowerCase();
    const existing = blocked[key] || {};
    blocked[key] = {
      handle: info.handle || existing.handle || null,
      name: info.name || existing.name || null,
      level: level || existing.level || "feed"
    };
    rebuildIndexes();
    saveBlocked();
    applyBlocking();
    return true;
  }

  function setChannelLevel(key, level) {
    if (!blocked[key]) return;
    blocked[key].level = level;
    rebuildIndexes();
    saveBlocked();
    applyBlocking();
  }

  function removeByKey(key) {
    delete blocked[key];
    rebuildIndexes();
    saveBlocked();
    applyBlocking();
  }

  // ---- watch-page "Block channel" button -----------------------------------

  // Outline "block" sign (circle + diagonal slash). Lighter stroke and a
  // smaller circle (with padding) so it matches YouTube's native 24px glyphs.
  // Uses currentColor so it inherits each surface's icon color.
  const BLOCK_ICON =
    '<svg height="24" viewBox="0 0 24 24" width="24" focusable="false" ' +
    'aria-hidden="true" style="pointer-events:none;display:inherit;width:100%;height:100%;">' +
    '<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" ' +
    'stroke-width="1.6"></circle>' +
    '<line x1="18.36" y1="5.64" x2="5.64" y2="18.36" fill="none" ' +
    'stroke="currentColor" stroke-width="1.6" stroke-linecap="round"></line></svg>';

  function ensureWatchButton() {
    const bar = document.querySelector(
      "ytd-watch-metadata #top-level-buttons-computed"
    );
    if (!bar) return;

    let wrap = bar.querySelector(".ycb-watch-button");
    if (!wrap) {
      wrap = document.createElement("yt-button-view-model");
      wrap.className = "ycb-watch-button style-scope ytd-menu-renderer";
      wrap.innerHTML =
        '<button-view-model class="ytSpecButtonViewModelHost">' +
        '<button type="button" class="ytSpecButtonShapeNextHost ytSpecButtonShapeNextTonal ' +
        "ytSpecButtonShapeNextMono ytSpecButtonShapeNextSizeM ytSpecButtonShapeNextIconLeading " +
        'ytSpecButtonShapeNextEnableBackdropFilterExperiment" aria-label="Block this channel">' +
        '<div aria-hidden="true" class="ytSpecButtonShapeNextIcon">' +
        '<span class="ytIconWrapperHost" style="width:24px;height:24px;">' +
        '<span class="yt-icon-shape ytSpecIconShapeHost">' +
        '<div style="width:100%;height:100%;display:block;fill:currentcolor;">' +
        BLOCK_ICON +
        "</div></span></span></div>" +
        '<div class="ytSpecButtonShapeNextButtonTextContent ycb-watch-button-label">Block</div>' +
        "</button></button-view-model>";

      const btn = wrap.querySelector("button");
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const info = getWatchChannel();
        if (info) openManageModal(info);
      });

      // Insert to the left of the like/dislike button.
      bar.insertBefore(wrap, bar.firstChild);
    }

    // Reflect current block state on the label.
    const info = getWatchChannel();
    const label = wrap.querySelector(".ycb-watch-button-label");
    const btn = wrap.querySelector("button");
    if (info && isBlocked(info)) {
      if (label) label.textContent = "Blocked";
      wrap.classList.add("ycb-blocked");
      btn.setAttribute("aria-label", "Unblock this channel");
    } else {
      if (label) label.textContent = "Block";
      wrap.classList.remove("ycb-blocked");
      btn.setAttribute("aria-label", "Block this channel");
    }
  }

  // ---- confirmation modal --------------------------------------------------

  let modalKeyHandler = null;

  function closeModal() {
    const overlay = document.getElementById("ycb-modal-overlay");
    if (overlay) overlay.remove();
    if (modalKeyHandler) {
      document.removeEventListener("keydown", modalKeyHandler, true);
      modalKeyHandler = null;
    }
  }

  // Builds the two-option level chooser. Returns an element whose
  // .selected getter (via dataset) reflects the current pick.
  function buildLevelChooser(current) {
    const wrap = document.createElement("div");
    wrap.className = "ycb-levels";
    const opts = [
      {
        level: "feed",
        title: "Feed only",
        desc: "Hidden from home, recommendations & sidebar. Still appears in search."
      },
      {
        level: "all",
        title: "Everywhere",
        desc: "Also hidden from search results."
      }
    ];
    wrap.dataset.level = current || "feed";
    for (const o of opts) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "ycb-level-opt";
      row.dataset.level = o.level;
      row.innerHTML =
        '<span class="ycb-radio"></span>' +
        '<span class="ycb-level-text"><span class="ycb-level-title"></span>' +
        '<span class="ycb-level-desc"></span></span>';
      row.querySelector(".ycb-level-title").textContent = o.title;
      row.querySelector(".ycb-level-desc").textContent = o.desc;
      if ((current || "feed") === o.level) row.classList.add("ycb-selected");
      row.addEventListener("click", () => {
        wrap.dataset.level = o.level;
        wrap
          .querySelectorAll(".ycb-level-opt")
          .forEach((r) => r.classList.toggle("ycb-selected", r === row));
      });
      wrap.appendChild(row);
    }
    return wrap;
  }

  // Modal for blocking a new channel OR managing an already-blocked one.
  function openManageModal(info) {
    closeModal();
    const existing = blockedEntryFor(info);
    const isBlockedNow = !!existing;
    const currentLevel = (existing && existing.level) || "feed";
    const name = info.name || info.handle || "this channel";

    const overlay = document.createElement("div");
    overlay.id = "ycb-modal-overlay";

    const modal = document.createElement("div");
    modal.id = "ycb-modal";
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");

    const h2 = document.createElement("h2");
    h2.textContent = isBlockedNow ? "Manage block" : "Block channel?";

    const p = document.createElement("p");
    p.textContent = isBlockedNow
      ? `Choose where “${name}” stays hidden.`
      : `Choose where to hide “${name}”.`;

    const chooser = buildLevelChooser(currentLevel);

    const actions = document.createElement("div");
    actions.id = "ycb-modal-actions";

    const leftBtn = document.createElement("button");
    leftBtn.type = "button";
    const confirmBtn = document.createElement("button");
    confirmBtn.type = "button";

    if (isBlockedNow) {
      leftBtn.id = "ycb-unblock";
      leftBtn.className = "ycb-danger-text";
      leftBtn.textContent = "Unblock";
      leftBtn.addEventListener("click", () => {
        unblockChannel(info);
        toast(`Unblocked: ${name}`);
        closeModal();
        ensureWatchButton();
      });
      confirmBtn.id = "ycb-confirm";
      confirmBtn.textContent = "Save";
      confirmBtn.addEventListener("click", () => {
        blockChannel(info, chooser.dataset.level);
        toast(`Updated: ${name}`);
        closeModal();
        ensureWatchButton();
      });
    } else {
      leftBtn.id = "ycb-cancel";
      leftBtn.textContent = "Cancel";
      leftBtn.addEventListener("click", closeModal);
      confirmBtn.id = "ycb-confirm";
      confirmBtn.className = "ycb-danger";
      confirmBtn.textContent = "Block channel";
      confirmBtn.addEventListener("click", () => {
        blockChannel(info, chooser.dataset.level);
        toast(`Blocked: ${name}`);
        closeModal();
        ensureWatchButton();
      });
    }

    actions.appendChild(leftBtn);
    actions.appendChild(confirmBtn);
    modal.appendChild(h2);
    modal.appendChild(p);
    modal.appendChild(chooser);
    modal.appendChild(actions);
    overlay.appendChild(modal);

    overlay.addEventListener("mousedown", (e) => {
      if (e.target === overlay) closeModal();
    });
    modalKeyHandler = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        closeModal();
      }
    };
    document.addEventListener("keydown", modalKeyHandler, true);

    document.body.appendChild(overlay);
    confirmBtn.focus();
  }

  function unblockChannel(info) {
    for (const k of Object.keys(blocked)) {
      const e = blocked[k] || {};
      const handleMatch = info.handle && e.handle === info.handle;
      const nameMatch =
        info.name &&
        e.name &&
        e.name.trim().toLowerCase() === info.name.trim().toLowerCase();
      if (handleMatch || nameMatch) delete blocked[k];
    }
    rebuildIndexes();
    saveBlocked();
    applyBlocking();
  }

  // ---- sidebar "Manage Blocks" entry ---------------------------------------

  function iconSpanHTML() {
    // No YouTube icon classes here — they impose their own sizing/weight.
    return '<span class="ycb-guide-icon">' + BLOCK_ICON + "</span>";
  }

  // Use PLAIN elements (not Polymer custom elements). Creating real
  // ytd-*-entry-renderer nodes risks YouTube's framework upgrading them and
  // wiping our markup; plain anchors styled via content.css are stable.
  function ensureSidebarEntry() {
    // Mini (collapsed) guide.
    const mini = document.querySelector("ytd-mini-guide-renderer #items");
    if (mini && !mini.querySelector(".ycb-guide-entry")) {
      const a = document.createElement("a");
      a.className = "ycb-guide-entry ycb-mini-guide-entry";
      a.setAttribute("role", "button");
      a.setAttribute("tabindex", "0");
      a.setAttribute("title", "Manage Blocks");
      a.innerHTML =
        iconSpanHTML() + '<span class="ycb-mini-guide-title">Blocks</span>';
      a.addEventListener("click", (e) => {
        e.preventDefault();
        openControlPanel();
      });
      mini.appendChild(a);
    }

    // Full (expanded) guide — inject into the first section's item list.
    const full = document.querySelector(
      "ytd-guide-renderer ytd-guide-section-renderer #items"
    );
    if (full && !full.querySelector(".ycb-guide-entry")) {
      const a = document.createElement("a");
      a.className = "ycb-guide-entry ycb-full-guide-entry";
      a.setAttribute("role", "button");
      a.setAttribute("tabindex", "0");
      a.setAttribute("title", "Manage Blocks");
      a.innerHTML =
        iconSpanHTML() + '<span class="ycb-full-guide-title">Manage Blocks</span>';
      a.addEventListener("click", (e) => {
        e.preventDefault();
        openControlPanel();
      });
      full.appendChild(a);
    }
  }

  // ---- masthead (topbar) button --------------------------------------------

  function ensureMastheadButton() {
    const buttons = document.querySelector("ytd-masthead #end #buttons");
    if (!buttons || buttons.querySelector(".ycb-masthead-button")) return;
    const el = document.createElement("button");
    el.type = "button";
    el.className = "ycb-masthead-button";
    el.setAttribute("aria-label", "Manage Blocks");
    el.setAttribute("title", "Manage Blocks");
    el.innerHTML = '<span class="ycb-guide-icon">' + BLOCK_ICON + "</span>";
    el.addEventListener("click", (e) => {
      e.preventDefault();
      openControlPanel();
    });
    buttons.insertBefore(el, buttons.firstChild);
  }

  // ---- control panel -------------------------------------------------------

  let panelKeyHandler = null;

  function closeControlPanel() {
    const overlay = document.getElementById("ycb-panel-overlay");
    if (overlay) overlay.remove();
    if (panelKeyHandler) {
      document.removeEventListener("keydown", panelKeyHandler, true);
      panelKeyHandler = null;
    }
  }

  function channelUrl(entry) {
    if (entry.handle) return "https://www.youtube.com" + entry.handle;
    if (entry.name)
      return (
        "https://www.youtube.com/results?search_query=" +
        encodeURIComponent(entry.name)
      );
    return "https://www.youtube.com";
  }

  function renderPanelBody(body) {
    body.innerHTML = "";

    // Global filters.
    const filters = document.createElement("div");
    filters.className = "ycb-panel-section";
    filters.innerHTML = '<div class="ycb-panel-subtitle">Filters</div>';
    const mk = (id, label, checked) => {
      const row = document.createElement("label");
      row.className = "ycb-toggle-row";
      row.innerHTML =
        "<span></span>" +
        '<span class="ycb-switch"><input type="checkbox" id="' +
        id +
        '"' +
        (checked ? " checked" : "") +
        '><span class="ycb-slider"></span></span>';
      row.querySelector("span").textContent = label;
      return row;
    };
    const shortsRow = mk("ycb-tg-shorts", "Hide all Shorts", settings.hideShorts);
    const gamingRow = mk(
      "ycb-tg-gaming",
      "Hide Gaming & Playables",
      settings.hideGaming
    );
    filters.appendChild(shortsRow);
    filters.appendChild(gamingRow);
    body.appendChild(filters);

    shortsRow.querySelector("input").addEventListener("change", (e) => {
      settings.hideShorts = e.target.checked;
      chrome.storage.sync.set({ hideShorts: settings.hideShorts });
      applySettings();
    });
    gamingRow.querySelector("input").addEventListener("change", (e) => {
      settings.hideGaming = e.target.checked;
      chrome.storage.sync.set({ hideGaming: settings.hideGaming });
      applySettings();
    });

    // Blocked channel list.
    const keys = Object.keys(blocked);
    const listSection = document.createElement("div");
    listSection.className = "ycb-panel-section";
    const subtitle = document.createElement("div");
    subtitle.className = "ycb-panel-subtitle";
    subtitle.textContent = `Blocked channels (${keys.length})`;
    listSection.appendChild(subtitle);

    if (keys.length === 0) {
      const empty = document.createElement("div");
      empty.className = "ycb-panel-empty";
      empty.textContent =
        "No channels blocked yet. Right-click a video and choose “Block this channel”.";
      listSection.appendChild(empty);
    } else {
      keys
        .sort((a, b) => {
          const la = (blocked[a].name || blocked[a].handle || a).toLowerCase();
          const lb = (blocked[b].name || blocked[b].handle || b).toLowerCase();
          return la.localeCompare(lb);
        })
        .forEach((key) => {
          const entry = blocked[key];
          const row = document.createElement("div");
          row.className = "ycb-channel-row";

          const link = document.createElement("a");
          link.className = "ycb-channel-link";
          link.href = channelUrl(entry);
          link.target = "_blank";
          link.rel = "noopener";
          link.innerHTML =
            '<span class="ycb-channel-name"></span>' +
            '<span class="ycb-channel-handle"></span>';
          link.querySelector(".ycb-channel-name").textContent =
            entry.name || entry.handle || key;
          link.querySelector(".ycb-channel-handle").textContent =
            entry.handle || "";

          const select = document.createElement("select");
          select.className = "ycb-level-select";
          select.innerHTML =
            '<option value="feed">Feed only</option>' +
            '<option value="all">Everywhere</option>';
          select.value = entry.level || "feed";
          select.addEventListener("change", () => {
            setChannelLevel(key, select.value);
          });

          const remove = document.createElement("button");
          remove.type = "button";
          remove.className = "ycb-remove-btn";
          remove.textContent = "Remove";
          remove.addEventListener("click", () => {
            removeByKey(key);
            renderPanelBody(body);
            ensureWatchButton();
          });

          row.appendChild(link);
          row.appendChild(select);
          row.appendChild(remove);
          listSection.appendChild(row);
        });
    }
    body.appendChild(listSection);
  }

  function openControlPanel() {
    if (document.getElementById("ycb-panel-overlay")) return;

    const overlay = document.createElement("div");
    overlay.id = "ycb-panel-overlay";

    const panel = document.createElement("div");
    panel.id = "ycb-panel";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");

    const header = document.createElement("div");
    header.id = "ycb-panel-header";
    header.innerHTML =
      "<h2>Manage Blocks</h2>" +
      '<button type="button" id="ycb-panel-close" aria-label="Close">✕</button>';

    const bodyEl = document.createElement("div");
    bodyEl.id = "ycb-panel-body";

    panel.appendChild(header);
    panel.appendChild(bodyEl);
    overlay.appendChild(panel);

    header
      .querySelector("#ycb-panel-close")
      .addEventListener("click", closeControlPanel);
    overlay.addEventListener("mousedown", (e) => {
      if (e.target === overlay) closeControlPanel();
    });
    panelKeyHandler = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        closeControlPanel();
      }
    };
    document.addEventListener("keydown", panelKeyHandler, true);

    renderPanelBody(bodyEl);
    document.body.appendChild(overlay);
  }

  function refreshPanelIfOpen() {
    const body = document.getElementById("ycb-panel-body");
    if (body) renderPanelBody(body);
  }

  // ---- event wiring --------------------------------------------------------

  // Remember which channel was under the cursor. We capture on BOTH the
  // right-button pointerdown and the contextmenu event (and only overwrite
  // when a channel actually resolves) so the value is reliable by the time
  // the background context-menu click relays the block request.
  let lastRightClickCoords = null;
  function rememberRightClick(e) {
    lastRightClickCoords = { x: e.clientX, y: e.clientY };
    let info = findChannel(e.target);
    if (!info || (!info.handle && !info.name)) {
      // Target was the hover-preview <video> (or another overlay) — look under it.
      info = findChannelAtPoint(e.clientX, e.clientY);
    }
    if (info && (info.handle || info.name)) lastRightClicked = info;
  }
  document.addEventListener("contextmenu", rememberRightClick, true);
  document.addEventListener(
    "pointerdown",
    (e) => {
      if (e.button === 2) rememberRightClick(e);
    },
    true
  );
  document.addEventListener(
    "mousedown",
    (e) => {
      if (e.button === 2) rememberRightClick(e);
    },
    true
  );

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.type === "BLOCK_LAST_RIGHT_CLICKED") {
      // Prefer the value captured at right-click time; fall back to
      // recomputing from the element under the last right-click position.
      let info = lastRightClicked;
      if ((!info || (!info.handle && !info.name)) && lastRightClickCoords) {
        info = findChannelAtPoint(
          lastRightClickCoords.x,
          lastRightClickCoords.y
        );
      }
      if (info && (info.handle || info.name)) {
        openManageModal(info);
      } else {
        toast("Right-click directly on a video to block its channel");
      }
    } else if (msg && msg.type === "OPEN_CONTROL_PANEL") {
      openControlPanel();
    }
    if (sendResponse) sendResponse({ ok: true });
    return true;
  });

  // Lightweight on-screen confirmation.
  let toastTimer = null;
  function toast(text) {
    let el = document.getElementById("ycb-toast");
    if (!el) {
      el = document.createElement("div");
      el.id = "ycb-toast";
      document.body.appendChild(el);
    }
    el.textContent = text;
    el.classList.add("ycb-show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("ycb-show"), 2500);
  }

  // Re-scan as YouTube lazily loads / navigates (SPA).
  const observer = new MutationObserver(() => {
    if (observer._scheduled) return;
    observer._scheduled = true;
    requestAnimationFrame(() => {
      observer._scheduled = false;
      applySettings();
      applyBlocking();
      ensureWatchButton();
      ensureSidebarEntry();
      ensureMastheadButton();
    });
  });

  // YouTube can recycle renderer nodes across SPA navigations, so drop all
  // "checked" markers on navigation and re-evaluate from scratch.
  window.addEventListener("yt-navigate-finish", () => {
    resetChecks();
    applySettings();
    applyBlocking();
    ensureWatchButton();
    ensureSidebarEntry();
    ensureMastheadButton();
  });

  function start() {
    if (document.body) {
      observer.observe(document.documentElement, {
        childList: true,
        subtree: true
      });
      loadAll();
    } else {
      requestAnimationFrame(start);
    }
  }
  start();
})();
