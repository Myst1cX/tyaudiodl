// ==UserScript==
// @name         TY Audio Downloader
// @namespace    ty-audio-downloader
// @version      1.5.5
// @description  Detect and download Teach Yourself's MP3 free resources from Library
// @author       Myst1cX 
// @match        https://library.teachyourself.com/*
// @grant        GM_download
// @grant        GM_registerMenuCommand
// @run-at       document-start
// @inject-into  page
// @noframes
// @homepageURL  https://github.com/Myst1cX/tyaudiodl/
// @supportURL   https://github.com/Myst1cX/tyaudiodl/issues
// @updateURL    https://raw.githubusercontent.com/Myst1cX/tyaudiodl/main/ty-audio-downloader.user.js
// @downloadURL  https://raw.githubusercontent.com/Myst1cX/tyaudiodl/main/ty-audio-downloader.user.js
// ==/UserScript==

(() => {
    'use strict';

    const SIGN_ENDPOINT = 'https://lambda-http.papertrell.com/api/GetSignedURL';

    const tracks = new Map();

    let host = null;        // plain element appended to <body>; carries no visual styling of its own
    let shadowRoot = null;  // closed-off tree the panel actually lives in
    let panel = null;
    let listEl = null;
    let statusEl = null;

    let running = false;
    let stopRequested = false;

    // Handles for whatever is currently in flight, so Stop can reach in and
    // cancel it immediately instead of waiting for it to finish.
    let currentAbortController = null; // aborts the in-progress signing fetch
    let currentDownloadHandle = null;  // aborts the in-progress GM_download, if the manager supports it

    // =========================================================
    // HELPERS
    // =========================================================

    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

    function cleanUrl(url) {
        if (!url || typeof url !== 'string') return url;
        try {
            return decodeURIComponent(url)
                .replace(/\\u0026/g, '&')
                .replace(/\\u003d/g, '=')
                .replace(/\\\//g, '/');
        } catch {
            return url;
        }
    }

    function isAudioUrl(url) {
        if (!url || typeof url !== 'string') return false;
        const u = cleanUrl(url);
        return /^https:\/\/cdn77\.papertrell\.com\//i.test(u) && /\.mp3(?:[?#]|$)/i.test(u);
    }

    function filenameFromUrl(url) {
        try {
            const pathname = new URL(url).pathname;
            const filename = pathname.substring(pathname.lastIndexOf('/') + 1);
            return decodeURIComponent(filename) || 'audio.mp3';
        } catch {
            return 'audio.mp3';
        }
    }

    function addTrack(url, source = 'detected') {
        url = cleanUrl(url);
        if (!isAudioUrl(url)) return;
        if (tracks.has(url)) return;

        const track = {
            url,
            name: filenameFromUrl(url),
            selected: false,
            state: 'ready',
            source,
            signedUrl: null,
            error: null
        };

        tracks.set(url, track);
        console.log('[Teach Yourself Downloader] Found:', track.name);

        render();
        updateSelectionButtons();
    }

    // =========================================================
    // DETECTION
    // =========================================================

    // Deliberately narrow: detection is tied directly to actual playback.
    // The player uses a real <audio> element, so the reliable signal is
    // the element's own 'play' event plus its currentSrc — not network
    // interception (fetch/XHR never see this request; the browser's media
    // pipeline issues it natively) and not resource-timing/script-scanning
    // (which surface any mp3 URL the page merely knows about, playable or
    // not — the original source of the "random track" problem).
    document.addEventListener('play', event => {
        try {
            const el = event.target;
            if (!el || !el.currentSrc) return;
            if (isAudioUrl(el.currentSrc)) addTrack(el.currentSrc, 'play');
        } catch {}
    }, true); // capture phase: 'play' doesn't bubble

    // =========================================================
    // SIGNING
    // =========================================================

    async function getSignedUrl(unsignedUrl, signal) {
        const requestUrl = SIGN_ENDPOINT + '?expiry=30&url=' + encodeURIComponent(unsignedUrl);

        console.log('[Teach Yourself Downloader] Signing:', unsignedUrl);

        const response = await fetch(requestUrl, {
            method: 'GET',
            credentials: 'omit',
            headers: { 'Accept': '*/*' },
            signal
        });

        if (!response.ok) {
            throw new Error(`Signing failed: HTTP ${response.status}`);
        }

        const data = await response.json();
        console.log('[Teach Yourself Downloader] Sign response:', data);

        if (data && data.success === true && typeof data.signed_url === 'string' && data.signed_url.length > 0) {
            return data.signed_url;
        }

        throw new Error('Signing failed: no signed_url returned');
    }

    // =========================================================
    // DOWNLOAD
    // =========================================================

    function downloadTrack(track) {
        return new Promise((resolve, reject) => {
            try {
                const handle = GM_download({
                    url: track.signedUrl,
                    name: track.name,
                    saveAs: false,

                    onload: () => {
                        currentDownloadHandle = null;
                        console.log('[Teach Yourself Downloader] Downloaded:', track.name);
                        resolve();
                    },

                    onerror: error => {
                        currentDownloadHandle = null;
                        console.error('[Teach Yourself Downloader] Download error:', error);
                        reject(new Error(error?.error || error?.details || 'Download failed'));
                    },

                    ontimeout: () => {
                        currentDownloadHandle = null;
                        reject(new Error('Download timed out'));
                    },

                    onabort: () => {
                        currentDownloadHandle = null;
                        reject(new Error('Download aborted'));
                    }
                });

                // Some userscript managers (Tampermonkey, notably) return a
                // handle with an abort() method here. Store it so Stop can
                // reach in and cancel the in-progress download directly. If
                // the manager doesn't support this, currentDownloadHandle
                // just stays a plain object/undefined and Stop's abort call
                // on it is a harmless no-op below.
                currentDownloadHandle = handle || null;

            } catch (error) {
                reject(error);
            }
        });
    }

    // =========================================================
    // SELECTION
    // =========================================================

    function selectAll() {
        tracks.forEach(track => {
            if (track.state !== 'done') track.selected = true;
        });
        render();
        updateSelectionButtons();
        status(`${getSelectedCount()} track(s) selected.`);
    }

    function clearSelection() {
        tracks.forEach(track => { track.selected = false; });
        render();
        updateSelectionButtons();
        status('Selection cleared.');
    }

    function invertSelection() {
        tracks.forEach(track => {
            if (track.state !== 'done') track.selected = !track.selected;
        });
        render();
        updateSelectionButtons();
        status(`${getSelectedCount()} track(s) selected.`);
    }

    function getSelectedCount() {
        return [...tracks.values()].filter(track => track.selected).length;
    }

    function updateSelectionButtons() {
        if (!panel) return;

        const all = panel.querySelector('#ty-all');
        const clear = panel.querySelector('#ty-clear');
        const invert = panel.querySelector('#ty-invert');

        const selectable = [...tracks.values()].filter(track => track.state !== 'done');
        const selected = selectable.filter(track => track.selected);

        const hasSelectable = selectable.length > 0;

        all.disabled = running || !hasSelectable;
        clear.disabled = running || !hasSelectable;
        invert.disabled = running || !hasSelectable;
    }

    // =========================================================
    // GUI
    // =========================================================

    function createPanel() {
        if (panel) return;

        // Host lives in the page's light DOM (so it can position:fixed
        // against the viewport like before), but attachShadow gives it a
        // separate tree that page-authored CSS selectors simply cannot
        // match into — the boundary blocks descendant/child/attribute
        // selectors from the outside, not just class-name collisions.
        // `all: initial` on the host, set inline for highest specificity,
        // also stops ambient inherited properties (font, color, line-height,
        // etc.) from the page from leaking across that boundary and
        // seeding our shadow tree's inheritance.
        host = document.createElement('div');
        host.id = 'ty-audio-downloader-host';
        host.style.all = 'initial';
        document.body.appendChild(host);
        shadowRoot = host.attachShadow({ mode: 'open' });

        panel = document.createElement('div');
        panel.id = 'ty-audio-downloader';

        panel.innerHTML = `
            <div class="ty-header">
                <div class="ty-title">
                    <strong>Teach Yourself Audio</strong>
                    <span id="ty-count">0 tracks</span>
                </div>
                <button id="ty-close" class="icon-button" title="Close">×</button>
            </div>

            <div class="ty-toolbar">
                <button id="ty-all">Select all</button>
                <button id="ty-clear">Clear</button>
                <button id="ty-invert">Invert</button>
            </div>

            <div class="ty-settings">
                <label class="ty-delay-label">
                    <span>Delay between downloads</span>
                    <select id="ty-delay">
                        <option value="5000">5 sec</option>
                        <option value="10000" selected>10 sec</option>
                        <option value="20000">20 sec</option>
                        <option value="30000">30 sec</option>
                        <option value="60000">60 sec</option>
                    </select>
                </label>
            </div>

            <div id="ty-status">Waiting for audio...</div>

            <div id="ty-list"></div>

            <div class="ty-bottom">
                <button id="ty-download" class="primary">
                    Download selected <span id="ty-download-count">(0)</span>
                </button>
                <button id="ty-stop" class="danger" disabled>Stop</button>
            </div>
        `;

        shadowRoot.appendChild(panel);

        listEl = panel.querySelector('#ty-list');
        statusEl = panel.querySelector('#ty-status');

        panel.querySelector('#ty-close').addEventListener('click', () => {
            panel.style.display = 'none';
        });

        panel.querySelector('#ty-all').addEventListener('click', selectAll);
        panel.querySelector('#ty-clear').addEventListener('click', clearSelection);
        panel.querySelector('#ty-invert').addEventListener('click', invertSelection);
        panel.querySelector('#ty-download').addEventListener('click', downloadSelected);
        panel.querySelector('#ty-stop').addEventListener('click', hardStop);

        panel.querySelector('#ty-delay').addEventListener('change', () => {
            const seconds = Number(panel.querySelector('#ty-delay').value) / 1000;
            status(`Download delay set to ${seconds} second(s).`);
        });

        addStyles(shadowRoot);

        render();
        updateSelectionButtons();
    }

    function status(text) {
        if (statusEl) statusEl.textContent = text;
    }

    // =========================================================
    // HARD STOP
    // =========================================================

    function hardStop() {
        if (!running || stopRequested) return;

        stopRequested = true;

        // Cancel whatever is in flight *right now* rather than waiting for
        // it to finish. Signing is always cancellable (it's our own
        // fetch call). The actual file download is only cancellable if the
        // userscript manager's GM_download implementation returns an
        // abort()-capable handle — if it doesn't, that single in-flight
        // file may still land, but nothing after it ever will.
        if (currentAbortController) {
            try { currentAbortController.abort(); } catch {}
        }
        if (currentDownloadHandle && typeof currentDownloadHandle.abort === 'function') {
            try { currentDownloadHandle.abort(); } catch {}
        }

        status('Stopping…');
    }

    // =========================================================
    // RENDER
    // =========================================================

    function render() {
        if (!listEl) return;

        listEl.innerHTML = '';

        const sorted = [...tracks.values()].sort((a, b) =>
            a.name.localeCompare(b.name, undefined, { numeric: true })
        );

        const count = panel.querySelector('#ty-count');
        const downloadCount = panel.querySelector('#ty-download-count');

        count.textContent = `${sorted.length} track${sorted.length === 1 ? '' : 's'}`;
        downloadCount.textContent = `(${getSelectedCount()})`;

        if (!sorted.length) {
            const empty = document.createElement('div');
            empty.className = 'ty-empty';
            empty.textContent = 'No MP3 URLs detected yet.';
            listEl.appendChild(empty);
            return;
        }

        for (const track of sorted) {
            const row = document.createElement('label');
            row.className = 'ty-track ' + (
                track.state === 'done' ? 'done' :
                track.state === 'error' ? 'error' :
                track.state === 'stopped' ? 'stopped' : ''
            );

            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.checked = track.selected;
            checkbox.disabled = running || track.state === 'done';
            checkbox.addEventListener('change', () => {
                track.selected = checkbox.checked;
                render();
                updateSelectionButtons();
            });

            const name = document.createElement('span');
            name.className = 'ty-name';
            name.textContent = track.name;

            const state = document.createElement('span');
            state.className = 'ty-state';

            switch (track.state) {
                case 'done':
                    state.textContent = 'Downloaded';
                    break;
                case 'signing':
                    state.textContent = 'Signing…';
                    break;
                case 'downloading':
                    state.textContent = 'Downloading…';
                    break;
                case 'stopped':
                    state.textContent = 'Stopped';
                    break;
                case 'error':
                    state.textContent = 'Error';
                    state.title = track.error || '';
                    break;
                default:
                    state.textContent = track.selected ? 'Selected' : '';
            }

            row.appendChild(checkbox);
            row.appendChild(name);
            row.appendChild(state);

            listEl.appendChild(row);
        }

        updateSelectionButtons();
    }

    // =========================================================
    // DOWNLOAD SELECTED
    // =========================================================

    async function downloadSelected() {
        if (running) return;

        const selected = [...tracks.values()].filter(track =>
            track.selected && track.state !== 'done'
        );

        if (!selected.length) {
            status('Nothing selected.');
            return;
        }

        running = true;
        stopRequested = false;

        const downloadButton = panel.querySelector('#ty-download');
        const stopButton = panel.querySelector('#ty-stop');

        downloadButton.disabled = true;
        stopButton.disabled = false;

        let completed = 0;

        try {
            for (const track of selected) {
                if (stopRequested) {
                    track.state = 'stopped';
                    continue;
                }

                try {
                    // -----------------------------------------
                    // FRESH SIGNING (cancellable)
                    // -----------------------------------------
                    track.state = 'signing';
                    track.error = null;
                    render();

                    status(`Signing ${completed + 1}/${selected.length}: ${track.name}`);

                    currentAbortController = new AbortController();
                    track.signedUrl = await getSignedUrl(track.url, currentAbortController.signal);
                    currentAbortController = null;

                    if (stopRequested) {
                        track.state = 'stopped';
                        render();
                        continue;
                    }

                    // -----------------------------------------
                    // DOWNLOAD (best-effort cancellable)
                    // -----------------------------------------
                    track.state = 'downloading';
                    render();

                    status(`Downloading ${completed + 1}/${selected.length}: ${track.name}`);

                    await downloadTrack(track);

                    track.state = 'done';
                    completed++;
                    render();

                    // -----------------------------------------
                    // HUMAN-SPEED DELAY
                    // -----------------------------------------
                    // Read the delay fresh here (rather than once at the
                    // top of the run) so that changing the dropdown mid-
                    // batch takes effect immediately, without needing to
                    // Stop and restart.
                    const currentDelay = Number(panel.querySelector('#ty-delay').value);
                    if (completed < selected.length && !stopRequested && currentDelay > 0) {
                        status(`Downloaded ${completed}/${selected.length}. Waiting ${currentDelay / 1000}s...`);
                        await sleep(currentDelay);
                    }

                } catch (error) {
                    currentAbortController = null;

                    if (stopRequested) {
                        // This track was cancelled by the user, not a real
                        // failure — leave it re-triable rather than marking
                        // it as an error.
                        track.state = 'stopped';
                        track.error = null;
                    } else {
                        track.state = 'error';
                        track.error = error?.message || String(error);
                        console.error('[Teach Yourself Downloader]', track.name, error);
                    }

                    render();
                }
            }

        } finally {
            currentAbortController = null;
            currentDownloadHandle = null;

            const wasStopped = stopRequested;

            running = false;
            stopRequested = false;

            downloadButton.disabled = false;
            stopButton.disabled = true;

            const done = [...tracks.values()].filter(track => track.state === 'done').length;
            const remaining = tracks.size - done;

            status(
                wasStopped
                    ? `Stopped. ${done} downloaded, ${remaining} remaining.`
                    : `Finished. ${done} downloaded, ${remaining} remaining.`
            );

            render();
            updateSelectionButtons();
        }
    }

    // =========================================================
    // STYLES
    // =========================================================

    function addStyles(root) {
        const style = document.createElement('style');

        style.textContent = `
            /* Belt-and-suspenders: the shadow boundary already keeps page
               selectors out, but reset :host too in case the page ever
               targets the host element itself (e.g. by tag name). */
            :host { all: initial; }

            #ty-audio-downloader {
                position: fixed;
                top: 20px;
                right: 20px;
                width: 470px;
                max-height: 80vh;
                z-index: 2147483647;
                background: #181818;
                color: #eee;
                border: 1px solid #444;
                border-radius: 10px;
                box-shadow: 0 10px 40px rgba(0,0,0,.5);
                font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
                font-size: 14px;
                overflow: hidden;
            }

            #ty-audio-downloader * { box-sizing: border-box; }

            /* HEADER */
            #ty-audio-downloader .ty-header {
                display: flex;
                align-items: center;
                justify-content: space-between;
                padding: 12px 14px;
                background: #222;
                border-bottom: 1px solid #3a3a3a;
            }
            #ty-audio-downloader .ty-title { display: flex; align-items: center; gap: 9px; }
            #ty-audio-downloader .ty-title strong { font-size: 15px; }
            #ty-audio-downloader #ty-count { color: #888; font-size: 11px; }
            #ty-audio-downloader .icon-button {
                border: 0;
                background: transparent;
                color: #aaa;
                font-size: 22px;
                cursor: pointer;
                padding: 0 4px;
            }
            #ty-audio-downloader .icon-button:hover { color: white; }

            /* GENERAL BUTTONS */
            #ty-audio-downloader button {
                background: #292929;
                color: #eee;
                border: 1px solid #555;
                border-radius: 5px;
                padding: 7px 10px;
                cursor: pointer;
                transition: background .12s, border-color .12s;
            }
            #ty-audio-downloader button:hover:not(:disabled) { background: #383838; }

            #ty-audio-downloader button:active:not(:disabled) { transform: translateY(1px); }
            #ty-audio-downloader button:disabled { opacity: .4; cursor: default; }

            /* TOOLBAR */
            #ty-audio-downloader .ty-toolbar {
                display: flex;
                gap: 6px;
                padding: 9px 10px;
                border-bottom: 1px solid #292929;
            }

            /* SETTINGS */
            #ty-audio-downloader .ty-settings { padding: 10px; }
            #ty-audio-downloader .ty-delay-label {
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 12px;
                color: #aaa;
                font-size: 12px;
            }
            #ty-audio-downloader select {
                background: #292929;
                color: #eee;
                border: 1px solid #555;
                border-radius: 5px;
                padding: 6px 9px;
                cursor: pointer;
            }

            /* STATUS */
            #ty-audio-downloader #ty-status {
                padding: 8px 10px;
                color: #aaa;
                border-top: 1px solid #333;
                border-bottom: 1px solid #333;
                font-size: 12px;
            }

            /* TRACK LIST */
            #ty-audio-downloader #ty-list { max-height: 45vh; overflow-y: auto; }
            #ty-audio-downloader .ty-track {
                display: flex;
                align-items: center;
                gap: 8px;
                padding: 8px 10px;
                border-bottom: 1px solid #292929;
                cursor: pointer;
            }
            #ty-audio-downloader .ty-track:hover { background: #242424; }
            #ty-audio-downloader .ty-track.done { opacity: .5; }
            #ty-audio-downloader .ty-track.error { background: rgba(150,40,40,.15); }
            #ty-audio-downloader .ty-track.stopped { background: rgba(150,150,60,.12); }
            #ty-audio-downloader .ty-name {
                flex: 1;
                min-width: 0;
                overflow: hidden;
                white-space: nowrap;
                text-overflow: ellipsis;
            }
            #ty-audio-downloader .ty-state { color: #999; font-size: 11px; white-space: nowrap; }
            #ty-audio-downloader .ty-track input { width: 15px; height: 15px; cursor: pointer; }
            #ty-audio-downloader .ty-empty { padding: 20px; text-align: center; color: #888; }

            /* BOTTOM */
            #ty-audio-downloader .ty-bottom {
                display: flex;
                gap: 7px;
                padding: 10px;
                border-top: 1px solid #333;
            }
            #ty-audio-downloader #ty-download { flex: 1; font-weight: 600; }

            /* Primary (Download): softened from stark white so it doesn't
               blow out against the dark panel. */
            #ty-audio-downloader .primary {
                background: #d7d7d7;
                color: #111;
                border-color: #d7d7d7;
            }
            #ty-audio-downloader .primary:hover:not(:disabled) { background: #ffffff; }

            /* Danger (Stop): given an actual reddish fill instead of just a
               reddish border tint, so it reads clearly as the destructive
               action at a glance. */
            #ty-audio-downloader .danger {
                background: rgba(190,60,60,.18);
                border-color: #a34f4f;
                color: #ffbdbd;
            }
            #ty-audio-downloader .danger:hover:not(:disabled) { background: rgba(190,60,60,.28); }
        `;

        root.appendChild(style);
    }

    // =========================================================
    // INITIALIZATION
    // =========================================================

    function init() {
        if (document.body) {
            createPanel();
        } else {
            requestAnimationFrame(init);
        }
    }

    GM_registerMenuCommand('Open Teach Yourself Audio Downloader', () => {
        if (!panel) createPanel();
        panel.style.display = 'block';
        render();
        updateSelectionButtons();
    });

    init();

})();
