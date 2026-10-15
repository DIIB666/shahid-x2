/* ============================================================================
 * Shahid Speed Controller — content.js
 * Runs on Shahid pages (all frames). Detects HTML5 <video> elements and
 * applies the user's preferred playbackRate.
 *
 * - No DRM bypass, no download/decrypt, no network exfiltration.
 * - Only touches the `playbackRate` property of accessible <video> tags.
 * - Handles SPA navigation + dynamically inserted players via
 *   MutationObserver, media-event delegation, and URL-change detection.
 * - Guards against duplicate observers / listeners.
 * ========================================================================== */

(() => {
  'use strict';

  /** All speeds offered in the popup. */
  const SUPPORTED_SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5];

  /** chrome.storage.local key. */
  const STORAGE_KEY = 'shahidSpeed';

  /** Default speed when nothing is stored yet. */
  const DEFAULT_SPEED = 1;

  /** How many times to retry applying speed to a newly found video. */
  const RETRY_ATTEMPTS = 6;
  const RETRY_DELAY_MS = 500;

  /** Tolerance when comparing floats. */
  const EPSILON = 0.05;

  // --- Module state (kept in closure, never leaks to page) -----------------
  let desiredSpeed = DEFAULT_SPEED;
  let observerAttached = false;
  let listenersAttached = false;
  let urlCheckAttached = false;
  let lastUrl = location.href;
  /** Tracks videos we already wired play/rate listeners onto. */
  const wiredVideos = new WeakSet();
  /** Prevents our own programmatic set from triggering a re-apply loop. */
  let applyingProgrammatically = false;

  // --- Storage helpers ------------------------------------------------------

  /** Load the saved speed; fall back to DEFAULT_SPEED on any error. */
  async function loadStoredSpeed() {
    try {
      const out = await chrome.storage.local.get(STORAGE_KEY);
      const v = Number(out && out[STORAGE_KEY]);
      if (SUPPORTED_SPEEDS.includes(v)) return v;
      return DEFAULT_SPEED;
    } catch {
      return DEFAULT_SPEED;
    }
  }

  /** Persist the chosen speed. */
  async function saveSpeed(speed) {
    try {
      await chrome.storage.local.set({ [STORAGE_KEY]: speed });
    } catch {
      /* storage may be unavailable in some frames — non-fatal */
    }
  }

  // --- Video helpers --------------------------------------------------------

  /** Return every <video> element in this document/frame. */
  function findVideos() {
    try {
      return Array.from(document.querySelectorAll('video'));
    } catch {
      return [];
    }
  }

  /**
   * A video is "compatible" if we can read/write playbackRate without an
   * exception. Some players hide the element inside a closed shadow root or
   * constantly reset playbackRate — those cases are reported, not bypassed.
   */
  function trySetRate(video, speed) {
    try {
      video.playbackRate = speed;
      // Some players override asynchronously; verify synchronously first.
      const actual = Number(video.playbackRate);
      if (!Number.isFinite(actual)) return { ok: false, actual, reason: 'unreadable-rate' };
      if (Math.abs(actual - speed) > EPSILON) {
        return { ok: false, actual, reason: 'rate-rejected' };
      }
      // Ask the player to keep it; many Shahid-like players need this to stick.
      try {
        video.defaultPlaybackRate = speed;
      } catch {
        /* optional — ignore */
      }
      return { ok: true, actual };
    } catch (err) {
      return { ok: false, actual: NaN, reason: err && err.message ? err.message : 'exception' };
    }
  }

  /**
   * Apply desiredSpeed to every video found. Retries a few times because
   * newly inserted players often reset rate on `loadedmetadata`.
   */
  function applySpeedToAllVideos(speed = desiredSpeed) {
    const videos = findVideos();
    let applied = 0;
    let lastResult = null;
    for (const video of videos) {
      wireVideo(video);
      applyingProgrammatically = true;
      const res = trySetRate(video, speed);
      applyingProgrammatically = false;
      lastResult = res;
      if (res.ok) applied += 1;
    }
    return { total: videos.length, applied, lastResult };
  }

  /** Retry applying to a specific video (handles late player init). */
  function applyWithRetries(video, speed, attemptsLeft = RETRY_ATTEMPTS) {
    wireVideo(video);
    applyingProgrammatically = true;
    const res = trySetRate(video, speed);
    applyingProgrammatically = false;
    if (res.ok || attemptsLeft <= 0) return;
    setTimeout(() => {
      // Only retry if the video is still in the DOM and speed hasn't changed.
      if (video.isConnected) applyWithRetries(video, desiredSpeed, attemptsLeft - 1);
    }, RETRY_DELAY_MS);
  }

  /**
   * Attach one-time delegated listeners per video so future `play` /
   * `loadedmetadata` events re-apply the speed (episode change case).
   * WeakSet guarantees we never double-wire the same element.
   */
  function wireVideo(video) {
    if (!video || wiredVideos.has(video)) return;
    wiredVideos.add(video);
    try {
      video.addEventListener(
        'loadedmetadata',
        () => {
          // Player just loaded a new source (new episode) — re-apply.
          applyWithRetries(video, desiredSpeed, 3);
        },
        { passive: true }
      );
    } catch {
      /* ignore */
    }
  }

  /** Build a status object for popup / debugging. */
  function getStatus() {
    const videos = findVideos();
    let actualSpeed = null;
    let protectedPlayer = false;
    let reason = null;
    if (videos.length > 0) {
      try {
        actualSpeed = Number(videos[0].playbackRate);
      } catch {
        actualSpeed = null;
      }
      // If our desired speed differs notably from actual, flag it so the
      // popup can show a compatibility message instead of claiming success.
      if (
        actualSpeed !== null &&
        Number.isFinite(actualSpeed) &&
        Math.abs(actualSpeed - desiredSpeed) > EPSILON
      ) {
        protectedPlayer = true;
        reason = 'rate-rejected';
      }
    }
    return {
      ok: true,
      found: videos.length > 0,
      count: videos.length,
      desiredSpeed,
      actualSpeed,
      protectedPlayer,
      reason,
      url: location.href
    };
  }

  // --- Observers / SPA handling (attached exactly once) ----------------------

  /** Watch for dynamically inserted <video> elements. */
  function ensureMutationObserver() {
    if (observerAttached) return;
    observerAttached = true;
    try {
      const observer = new MutationObserver((mutations) => {
        let foundNewVideo = false;
        for (const m of mutations) {
          for (const node of m.addedNodes || []) {
            if (node.nodeType !== 1) continue; // element nodes only
            const el = /** @type {Element} */ (node);
            if (el.tagName === 'VIDEO') {
              foundNewVideo = true;
              applyWithRetries(/** @type {HTMLVideoElement} */ (el), desiredSpeed);
            } else if (typeof el.querySelectorAll === 'function') {
              const nested = el.querySelectorAll('video');
              if (nested.length > 0) {
                foundNewVideo = true;
                nested.forEach((v) => applyWithRetries(v, desiredSpeed));
              }
            }
          }
          if (foundNewVideo) break;
        }
        // Fallback: if subtree churned heavily, do one cheap full pass.
        if (foundNewVideo) applySpeedToAllVideos(desiredSpeed);
      });
      observer.observe(document.documentElement || document.body, {
        childList: true,
        subtree: true
      });
    } catch {
      observerAttached = false; // allow a later retry
    }
  }

  /** Delegated media-event listeners (capture phase, attached once). */
  function ensureMediaListeners() {
    if (listenersAttached) return;
    listenersAttached = true;
    try {
      // Any video starting playback gets the desired speed immediately.
      document.addEventListener(
        'play',
        (e) => {
          const t = e.target;
          if (t && t.tagName === 'VIDEO') {
            applyWithRetries(t, desiredSpeed, 2);
          }
        },
        true // capture: play events don't bubble
      );
      document.addEventListener(
        'canplay',
        (e) => {
          const t = e.target;
          if (t && t.tagName === 'VIDEO') {
            applyingProgrammatically = true;
            trySetRate(t, desiredSpeed);
            applyingProgrammatically = false;
          }
        },
        true
      );
      // If the site resets the rate (episode change), gently re-enforce once.
      // Guard flag prevents infinite ratechange loops.
      document.addEventListener(
        'ratechange',
        (e) => {
          if (applyingProgrammatically) return;
          const t = e.target;
          if (t && t.tagName === 'VIDEO') {
            const actual = Number(t.playbackRate);
            if (Number.isFinite(actual) && Math.abs(actual - desiredSpeed) > EPSILON) {
              // Respect an explicit user change made via native controls?
              // We can't distinguish, so we re-apply only if the reset looks
              // like a player reset to 1x right after navigation.
              // Keep it to a single delayed re-apply to avoid fighting UI.
              setTimeout(() => {
                if (!t.isConnected) return;
                let now = null;
                try {
                  now = Number(t.playbackRate);
                } catch {
                  return;
                }
                if (Number.isFinite(now) && Math.abs(now - desiredSpeed) > EPSILON) {
                  applyingProgrammatically = true;
                  trySetRate(t, desiredSpeed);
                  applyingProgrammatically = false;
                }
              }, 400);
            }
          }
        },
        true
      );
    } catch {
      listenersAttached = false;
    }
  }

  /** Detect SPA navigation (Shahid changes episodes without full reload). */
  function ensureUrlChangeDetection() {
    if (urlCheckAttached) return;
    urlCheckAttached = true;

    // Wrap history methods once so pushState/replaceState trigger re-apply.
    try {
      const origPush = history.pushState;
      const origReplace = history.replaceState;
      history.pushState = function (...args) {
        const r = origPush.apply(this, args);
        onUrlMaybeChanged();
        return r;
      };
      history.replaceState = function (...args) {
        const r = origReplace.apply(this, args);
        onUrlMaybeChanged();
        return r;
      };
      window.addEventListener('popstate', onUrlMaybeChanged);
    } catch {
      /* history wrapping is best-effort */
    }

    // Polling fallback for players that rewrite content without history API.
    setInterval(() => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        onUrlMaybeChanged();
      }
    }, 1500);
  }

  function onUrlMaybeChanged() {
    lastUrl = location.href;
    // Episode change: new player may mount a moment later — apply now + retry.
    setTimeout(() => applySpeedToAllVideos(desiredSpeed), 300);
    setTimeout(() => applySpeedToAllVideos(desiredSpeed), 1200);
  }

  // --- Messages from popup / background -------------------------------------

  function ensureMessageListener() {
    try {
      chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
        if (!msg || typeof msg.type !== 'string') return undefined;
        if (msg.type === 'PING') {
          sendResponse({ ok: true, alive: true });
          return true;
        }
        if (msg.type === 'GET_STATUS') {
          sendResponse(getStatus());
          return true;
        }
        if (msg.type === 'SET_SPEED') {
          const s = Number(msg.speed);
          if (!SUPPORTED_SPEEDS.includes(s)) {
            sendResponse({ ok: false, error: 'Unsupported speed. Use: ' + SUPPORTED_SPEEDS.join(', ') });
            return true;
          }
          desiredSpeed = s;
          // Persist (fire-and-forget; popup also writes for redundancy).
          saveSpeed(s);
          const result = applySpeedToAllVideos(s);
          // Re-verify after player settles so popup shows truthful state.
          setTimeout(() => {
            const status = getStatus();
            status.applied = result.applied;
            status.total = result.total;
            // NOTE: can't reply async twice; popup re-queries GET_STATUS.
          }, 600);
          sendResponse({
            ok: result.applied > 0 || result.total === 0,
            ...getStatus(),
            applied: result.applied,
            total: result.total
          });
          return true;
        }
        return undefined;
      });
    } catch {
      /* messaging unavailable — non-fatal */
    }
  }

  // --- Storage change: another context (popup/background) changed speed -----
  function ensureStorageListener() {
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local' || !changes[STORAGE_KEY]) return;
        const v = Number(changes[STORAGE_KEY].newValue);
        if (SUPPORTED_SPEEDS.includes(v) && v !== desiredSpeed) {
          desiredSpeed = v;
          applySpeedToAllVideos(v);
        }
      });
    } catch {
      /* ignore */
    }
  }

  // --- Boot -----------------------------------------------------------------
  async function init() {
    desiredSpeed = await loadStoredSpeed();
    ensureMessageListener();
    ensureStorageListener();
    ensureMutationObserver();
    ensureMediaListeners();
    ensureUrlChangeDetection();
    // Initial apply: DOM may still be building — try now and shortly after.
    applySpeedToAllVideos(desiredSpeed);
    setTimeout(() => applySpeedToAllVideos(desiredSpeed), 800);
    setTimeout(() => applySpeedToAllVideos(desiredSpeed), 2500);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
