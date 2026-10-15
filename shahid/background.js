/* ============================================================================
 * Shahid Speed Controller — background.js (MV3 service worker)
 * - Sets a default speed on install.
 * - Handles the keyboard shortcut (toggle 1x <-> 2x).
 * - Shows a small action badge with the current speed.
 * No network calls, no analytics, no DRM interaction.
 * ========================================================================== */

'use strict';

const STORAGE_KEY = 'shahidSpeed';
const SUPPORTED_SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5];
const DEFAULT_SPEED = 1;

function fmt(s) {
  // Badge text must be <= 4 chars, so "1.25x" -> "1.25", "0.75x" -> ".75".
  const t = `${s}x`;
  return t.length <= 4 ? t : t.slice(0, 4);
}

/** Update the toolbar badge to reflect the saved speed. */
async function refreshBadge(speed) {
  try {
    let v = speed;
    if (v === undefined) {
      const out = await chrome.storage.local.get(STORAGE_KEY);
      v = Number(out && out[STORAGE_KEY]);
      if (!SUPPORTED_SPEEDS.includes(v)) v = DEFAULT_SPEED;
    }
    await chrome.action.setBadgeText({ text: fmt(v) });
    await chrome.action.setBadgeBackgroundColor({ color: '#7c3aed' });
    await chrome.action.setTitle({ title: `Shahid Speed Controller (${v}x)` });
  } catch {
    /* badge is cosmetic — ignore */
  }
}

chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === 'install') {
    try {
      const out = await chrome.storage.local.get(STORAGE_KEY);
      if (out[STORAGE_KEY] === undefined) {
        await chrome.storage.local.set({ [STORAGE_KEY]: DEFAULT_SPEED });
      }
    } catch {
      /* ignore */
    }
  }
  await refreshBadge();
});

chrome.runtime.onStartup.addListener(() => refreshBadge());

// Keep badge in sync when popup or shortcut changes the speed.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[STORAGE_KEY]) {
    const v = Number(changes[STORAGE_KEY].newValue);
    if (SUPPORTED_SPEEDS.includes(v)) refreshBadge(v);
  }
});

/** Toggle between 1x and 2x for the active tab. */
async function toggle1x2x() {
  let current = DEFAULT_SPEED;
  try {
    const out = await chrome.storage.local.get(STORAGE_KEY);
    const v = Number(out && out[STORAGE_KEY]);
    if (SUPPORTED_SPEEDS.includes(v)) current = v;
  } catch {
    /* use default */
  }
  const next = Math.abs(current - 2) < 0.001 ? 1 : 2;
  try {
    await chrome.storage.local.set({ [STORAGE_KEY]: next });
  } catch {
    /* ignore */
  }
  await refreshBadge(next);

  // Push to the active tab's content script (best-effort).
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs && tabs[0];
    if (tab && tab.id) {
      await chrome.tabs.sendMessage(tab.id, { type: 'SET_SPEED', speed: next });
    }
  } catch {
    /* tab may not have the content script (e.g. chrome://) — badge+storage still updated */
  }
}

chrome.commands.onCommand.addListener((command) => {
  if (command === 'toggle-1x-2x') {
    toggle1x2x();
  }
});
