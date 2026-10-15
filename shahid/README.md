# Shahid Speed Controller

A Manifest V3 Chrome extension that controls HTML5 video playback speed on Shahid
(`shahid.mbc.net` / `shahid.net`).

Speeds: **0.5×, 0.75×, 1×, 1.25×, 1.5×, 1.75×, 2×, 2.5×** — with **2×** as the
hero button. Includes a **1× ⇄ 2× keyboard shortcut**, auto-apply across episodes /
SPA navigation, and a premium dark-purple popup.

> No DRM bypass. No Widevine/subscription/auth bypass. No downloading, decrypting,
> or extracting video. If the player uses a protected or inaccessible video
> element, the popup says so instead of claiming success. No data leaves your
> browser.

## Project structure

```
shahid/                      ← extension root (load THIS folder in Chrome)
├── manifest.json            ← MV3 manifest, minimal permissions, Shahid-only hosts
├── popup.html               ← popup markup
├── popup.css                ← dark + purple Shahid-inspired theme
├── popup.js                 ← popup logic (render, storage, messaging)
├── content.js               ← video detection, playbackRate control, SPA handling
├── background.js            ← service worker: defaults, shortcut, badge
├── icons/
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
└── README.md
```

### How it works

- `content.js` runs at `document_idle` on Shahid pages (`all_frames: true` so
  iframe players are covered).
- On load it reads `shahidSpeed` from `chrome.storage.local` (default `1`).
- It finds every `<video>` and sets `video.playbackRate` (+ `defaultPlaybackRate`).
- A single `MutationObserver` watches for dynamically inserted players; delegated
  `play` / `canplay` / `loadedmetadata` listeners + history-API wrapping + URL
  polling re-apply the speed when Shahid changes episodes without a full reload.
- Duplicate observers/listeners are prevented with `observerAttached`,
  `listenersAttached`, `urlCheckAttached` flags and a `WeakSet` of wired videos.
- A `ratechange` guard re-applies once (after 400 ms) if the player resets the
  rate — without entering an infinite loop.
- `popup.js` ↔ `content.js` protocol: `{type: 'GET_STATUS'}` /
  `{type: 'SET_SPEED', speed}`. The popup always shows the **actual**
  `video.playbackRate` and warns when the player rejects the requested speed.
- `background.js` sets the default on install, handles `Alt+Shift+S` toggle, and
  shows a badge (`2x`, `1x`, …).

### Permissions (minimal)

- `storage` — remember your speed.
- `host_permissions`: `https://*.shahid.mbc.net/*`, `https://*.shahid.net/*` only.
- No `tabs`, no `webRequest`, no remote code, no analytics.

## Installation (Load unpacked — exact steps)

1. Open Chrome and go to:
   ```
   chrome://extensions
   ```
2. Enable **Developer mode** (toggle, top-right).
3. Click **Load unpacked**.
4. Select the extension root folder — the one containing `manifest.json`:
   ```
   C:\Users\PC\Desktop\shahid
   ```
   (Do NOT select a subfolder like `icons/`.)
5. Confirm **Shahid Speed Controller** appears with its purple icon and no errors.
6. (Optional) Pin it: click the puzzle-piece toolbar icon → pin
   **Shahid Speed Controller**.

### Verify the install

- On `chrome://extensions` the extension shows **Version 1.0.0**, Manifest V3.
- Click **Details** → **Permissions**: only storage + Shahid site access.
- The toolbar button shows a badge (`1x` by default).

## Usage

1. Go to https://shahid.mbc.net and start any video.
2. Click the extension icon. The popup shows the current speed.
3. Click the big **2×** button (or any speed chip `0.5× … 2.5×`).
4. Use **⇄ Toggle 1× / 2×** or press **Alt + Shift + S** anywhere on Shahid.
5. Navigate to the next episode — the saved speed is re-applied automatically.

### Change the keyboard shortcut

1. Go to `chrome://extensions/shortcuts`.
2. Find **Shahid Speed Controller → Toggle playback speed between 1x and 2x**.
3. Set any combo (e.g. `Ctrl+Shift+S` / `Alt+S`).

## Checks (no build step — pure HTML/CSS/JS)

Validate JSON + JS syntax (Node.js required, already used for icon generation):

```powershell
node -e "JSON.parse(require('fs').readFileSync('manifest.json','utf8')); console.log('manifest.json: valid JSON')"
node --check content.js
node --check popup.js
node --check background.js
```

Expected: `manifest.json: valid JSON` and no output (exit 0) for each `--check`.

Manual test checklist (on a Shahid page with an accessible HTML5 `<video>`):

- [ ] Click `1×`, video slows/resets; popup reads `Current speed 1×`, status green.
- [ ] Click hero `2×`, video speeds up; popup reads `2×`.
- [ ] Try `0.5×`, `1.5×`, `2.5×` — each applies.
- [ ] Reload page — saved speed is re-applied.
- [ ] Next episode (SPA, no full reload) — saved speed persists.
- [ ] Press `Alt+Shift+S` — toggles `1× ⇄ 2×`.
- [ ] Open popup on a non-video Shahid page — clear “No compatible video found” message.
- [ ] Open popup on a non-Shahid tab — “Open shahid.mbc.net…” guidance.

## Troubleshooting — 2× does not work

Work through this order:

1. **Are you on a supported page?**
   URL must be `shahid.mbc.net` or `shahid.net`. The popup says
   “This tab is not a Shahid page” otherwise.

2. **Is a video actually playing?**
   Open the popup *after* pressing Play. If it says “No compatible video found”,
   the player hasn't mounted a `<video>` yet — wait for playback, then reopen.

3. **Reload the tab.**
   After installing/enabling, existing Shahid tabs need one reload so the content
   script injects. Then reopen the popup.

4. **Protected / custom player.**
   If the popup says “Player did not accept 2× (current: 1×)… protected player”,
   the title uses a player that ignores `playbackRate`. This extension will not
   bypass it. Try another series/movie or live channel — support varies by title.

5. **Check the real rate in DevTools.**
   On the Shahid tab press `Ctrl+Shift+J` and run:
   ```js
   [...document.querySelectorAll('video')].map(v => ({
     rate: v.playbackRate, src: (v.currentSrc || '').slice(0, 80)
   }))
   ```
   - Empty array → no accessible `<video>` (protected/iframe-blocked player).
   - `rate: 1` after requesting `2` → player is resetting the rate.

6. **Shortcut not firing?**
   Another extension may claim `Alt+Shift+S`. Go to `chrome://extensions/shortcuts`
   and assign a free combo. Test with the popup buttons first to isolate the issue.

7. **Multiple frames / ad player.**
   Pre-roll ads sometimes expose a separate `<video>`. The extension syncs all
   found videos; status shows the count (“2 videos synced”).

8. **Still stuck?**
   Disable other Shahid/video extensions, reload, and retry. If the title plays
   only via a DRM-locked player, speed control is technically impossible without
   breaking protection — which this extension deliberately never does.

## Privacy

- `chrome.storage.local` only. No cookies, no fetch/XHR, no external servers.
- Source is fully auditable: `content.js`, `popup.js`, `background.js`.

## Notes for reviewers

- `playbackRate` changes are standard HTML5 and do not circumvent DRM, Widevine,
  subscriptions, or authentication.
- `all_frames: true` exists only to reach same-origin player iframes on Shahid's
  own domains — still bounded by `host_permissions`.
