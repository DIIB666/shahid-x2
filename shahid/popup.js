/* ============================================================================
 * Shahid Speed Controller — popup.js
 * - Renders speed buttons, shows live status from the content script,
 *   persists choice in chrome.storage.local.
 * - Never claims success when no accessible video exists: shows a clear
 *   compatibility message instead.
 * ========================================================================== */

'use strict';

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5];
const STORAGE_KEY = 'shahidSpeed';
const DEFAULT_SPEED = 1;

const els = {
  grid: document.getElementById('speedGrid'),
  current: document.getElementById('currentSpeed'),
  status: document.getElementById('status'),
  hero: document.getElementById('btnHero'),
  toggle: document.getElementById('btnToggle'),
  dot: document.getElementById('liveDot')
};

let selectedSpeed = DEFAULT_SPEED;

/** Format 2 -> "2×", 1.25 -> "1.25×". */
function fmt(s) {
  return `${s}×`;
}

function setStatus(kind, text) {
  els.status.className = `status ${kind}`;
  els.status.textContent = text;
}

function setDot(state) {
  els.dot.classList.remove('on', 'off');
  if (state === 'on') els.dot.classList.add('on');
  if (state === 'off') els.dot.classList.add('off');
}

/** Highlight the active speed everywhere (grid + hero + big readout). */
function renderSelection(speed) {
  selectedSpeed = speed;
  els.current.textContent = fmt(speed);
  els.current.classList.remove('pop');
  // Force reflow so the pop animation replays on every change.
  void els.current.offsetWidth;
  els.current.classList.add('pop');
  els.grid.querySelectorAll('.speed').forEach((b) => {
    b.classList.toggle('active', Number(b.dataset.speed) === speed);
  });
  els.hero.classList.toggle('active', speed === 2);
}

/** Build the 8 speed buttons once. */
function buildGrid() {
  els.grid.innerHTML = '';
  for (const s of SPEEDS) {
    const b = document.createElement('button');
    b.className = 'speed' + (s === 2 ? ' hero-speed' : '');
    b.dataset.speed = String(s);
    b.textContent = fmt(s);
    b.title = s === 2 ? 'Recommended: 2x speed' : `Set speed to ${fmt(s)}`;
    b.addEventListener('click', () => setSpeed(s));
    els.grid.appendChild(b);
  }
}

/** Get the active tab (popup context). */
async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs && tabs[0];
}

/** True when the URL looks like a Shahid watch page. */
function isShahidUrl(url) {
  if (!url) return false;
  try {
    const u = new URL(url);
    return (
      u.hostname.endsWith('shahid.mbc.net') ||
      u.hostname.endsWith('shahid.net')
    );
  } catch {
    return false;
  }
}

/** Ask the content script in `tabId` for its status. Null if unreachable. */
async function queryStatus(tabId) {
  try {
    return await chrome.tabs.sendMessage(tabId, { type: 'GET_STATUS' });
  } catch {
    return null; // no content script in this tab/frame (e.g. chrome:// pages)
  }
}

/** Persist + send the new speed to the page, then refresh status text. */
async function setSpeed(speed) {
  renderSelection(speed);
  try {
    await chrome.storage.local.set({ [STORAGE_KEY]: speed });
  } catch {
    /* non-fatal */
  }
  const tab = await getActiveTab();
  if (!tab || !tab.id) {
    setStatus('warn', `Saved ${fmt(speed)}. Open a Shahid video tab to apply it.`);
    return;
  }
  if (!isShahidUrl(tab.url)) {
    setStatus(
      'warn',
      `Saved ${fmt(speed)}. This tab is not a Shahid page — open shahid.mbc.net and play a video.`
    );
    return;
  }
  let res = null;
  try {
    res = await chrome.tabs.sendMessage(tab.id, { type: 'SET_SPEED', speed });
  } catch {
    res = null;
  }
  if (!res) {
    setStatus(
      'warn',
      `Saved ${fmt(speed)}, but could not reach the page. Reload the Shahid tab and try again.`
    );
    setDot('off');
    return;
  }
  describeStatus(res, speed);
  setDot('on');
}

/** Turn a content-script status object into human-friendly popup text. */
function describeStatus(res, requestedSpeed) {
  const want = requestedSpeed ?? res.desiredSpeed ?? selectedSpeed;
  if (!res.found) {
    setStatus(
      'warn',
      `No compatible video found on this page. Start playback first — if the player uses a protected element, speed control may be unavailable. Saved preference: ${fmt(want)}.`
    );
    return;
  }
  const actual = Number(res.actualSpeed);
  const matches =
    Number.isFinite(actual) && Math.abs(actual - want) < 0.05;
  if (res.protectedPlayer || !matches) {
    const shown = Number.isFinite(actual) ? fmt(actual) : 'unknown';
    setStatus(
      'bad',
      `Player did not accept ${fmt(want)} (current: ${shown}). This title may use a protected player that blocks playbackRate changes. We did not bypass anything — try another title or HTML5 episode.`
    );
    return;
  }
  const extra = res.count > 1 ? ` (${res.count} videos synced)` : '';
  setStatus('good', `Playing at ${fmt(want)} on this tab${extra}. Speed will persist across episodes.`);
}

/** Toggle helper for the ghost button: 1x <-> 2x. */
async function toggle1x2x() {
  const next = Math.abs(selectedSpeed - 2) < 0.001 ? 1 : 2;
  await setSpeed(next);
}

/** Initial load: paint saved speed, then ask the page for the truth. */
async function init() {
  buildGrid();
  // 1) Saved preference first (instant paint, works even off-Shahid).
  try {
    const out = await chrome.storage.local.get(STORAGE_KEY);
    const v = Number(out && out[STORAGE_KEY]);
    renderSelection(SPEEDS.includes(v) ? v : DEFAULT_SPEED);
  } catch {
    renderSelection(DEFAULT_SPEED);
  }

  els.hero.addEventListener('click', () => setSpeed(2));
  els.toggle.addEventListener('click', toggle1x2x);

  // 2) Live page status.
  setStatus('info', 'Checking page…');
  const tab = await getActiveTab();
  if (!tab) {
    setStatus('warn', 'Could not read the active tab.');
    setDot('off');
    return;
  }
  if (!isShahidUrl(tab.url)) {
    setStatus(
      'info',
      `Saved speed: ${fmt(selectedSpeed)}. Open shahid.mbc.net, start a video, then reopen this popup to control it.`
    );
    setDot('off');
    return;
  }
  const res = await queryStatus(tab.id);
  if (!res) {
    setStatus(
      'warn',
      `Could not reach the Shahid tab (content script not loaded). Reload the page and reopen the popup. Saved: ${fmt(selectedSpeed)}.`
    );
    setDot('off');
    return;
  }
  setDot('on');
  // If the page reports a different desired speed (e.g. set via shortcut),
  // adopt it so popup + page stay in sync.
  if (SPEEDS.includes(Number(res.desiredSpeed))) {
    renderSelection(Number(res.desiredSpeed));
  }
  describeStatus(res);
}

document.addEventListener('DOMContentLoaded', init);
