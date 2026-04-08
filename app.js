/**
 * Chilled Koala v2.0.0 — Client Application
 * IP-12 Style Broadcast Console + Radio Automation
 * SPDX-License-Identifier: MIT
 * MIT License — Copyright © 2026 Trajano Roberto
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions: The above copyright
 * notice and this permission notice shall be included in all copies or
 * substantial portions of the Software. THE SOFTWARE IS PROVIDED "AS IS",
 * WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED.
 */

'use strict';

/* ═══════════════════════════════════════════════════════════════════════════
   STATE
═══════════════════════════════════════════════════════════════════════════ */

const S = {
    ws:          null,
    wsReady:     false,
    console:     null,
    stream:      { streaming: false, connecting: false, error: null },
    playlist:    [],
    username:    '',
    primaryUser: null,
    users:       [],
    cfgModal:    { chId: null },
    libDebounce: null,
    isPrimary() { return this.username === this.primaryUser; },
};

/* ═══════════════════════════════════════════════════════════════════════════
   WEBSOCKET — exponential backoff reconnect
═══════════════════════════════════════════════════════════════════════════ */

let _wsRetry = 0;

function connectWS() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws    = new WebSocket(`${proto}://${location.host}`);
    S.ws = ws;

    ws.onopen  = () => {
        S.wsReady = true;
        _wsRetry  = 0;
        // Clock handshake: measure VPS↔PC clock offset so serverNow comparisons
        // are accurate regardless of independent VPS/PC system clocks.
        // Send 3 pings, use the median to filter outliers.
        _clockSync();
    };
    ws.onclose = () => {
        S.wsReady = false;
        const delay = Math.min(1000 * (1 << Math.min(_wsRetry, 5)), 30000);
        _wsRetry++;
        setTimeout(connectWS, delay);
    };
    ws.binaryType = 'arraybuffer';
    ws.onmessage = (e) => {
        // Binary frames = Ogg/Opus monitor audio chunks → feed earphone player
        if (e.data instanceof ArrayBuffer) {
            Monitor.onChunk(e.data);
            return;
        }
        // Text frames = JSON control messages → normal handler
        try { handleMsg(JSON.parse(e.data)); }
        catch (err) { console.error('WS parse error', err); }
    };
    ws.onerror = () => ws.close();
}

// ── VPS↔PC clock offset measurement ─────────────────────────────────────────
// Without this, (Date.now() - serverNow) reflects both WS latency AND clock skew.
// Example: VPS clock 8s ahead of PC → wsLatency reads -8000ms → position 8s behind.
// We measure the offset once on connect (3 pings, median) and subtract it from all
// serverNow comparisons. Result: only true WS one-way latency remains.
let _clockOffset  = 0;   // VPS_clock - PC_clock in ms (positive = VPS ahead)
let _clockSamples = [];
let _lastRttMs        = 0;    // most recent measured round-trip time (ms)
let _pendingLatEarMs  = null; // earphone latency stored while a LAT probe is in-flight
let _lastMicLatResult = null; // { micMs, earMs, totalMs } — most recent probe result

// ── Continuous mic latency tracking ──────────────────────────────────────────
// Active only while Loc Mic 1 (chId=0) or Loc Mic 2 (chId=1) is ON.
// Every 10s: sends a clock ping to refresh _lastRttMs.
// After each pong: recalculates totalMs = earMs + micMs with EWMA smoothing.
// Applies via /api/mic-delay with adjust=true (in-place FIFO tweak, no silence).
let _micTrackTimer    = null; // setInterval ID — null when tracking is inactive
let _micLatEWMA       = null; // EWMA-smoothed total delay (ms) while tracking
let _micTrackLastMs   = 0;    // Date.now() of last adjustment sent to server

function _clockSync() {
    _clockSamples = [];
    _sendClockPing();
}

function _sendClockPing() {
    if (S.ws && S.ws.readyState === WebSocket.OPEN) {
        S.ws.send(JSON.stringify({ type: 'clock:ping', t0: Date.now() }));
    }
}

function _onClockPong(msg) {
    const t2     = Date.now();
    const rtt    = t2 - msg.t0;
    const offset = msg.t1 - (msg.t0 + rtt / 2);   // VPS clock - PC clock
    _clockSamples.push(offset);
    if (_clockSamples.length > 10) _clockSamples.shift();  // cap: keep last 10 only
    if (_clockSamples.length < 5) {
        setTimeout(_sendClockPing, 50);
    } else {
        // Use most recent 5 samples for the median (recent-window, not all-time)
        const recent = _clockSamples.slice(-5);
        const sorted = [...recent].sort((a, b) => a - b);
        _clockOffset = sorted[2];   // median of 5
        _lastRttMs   = rtt;         // most recent RTT — used for mic delay estimate
        console.log(`[clock] offset=${_clockOffset.toFixed(0)}ms rtt=${rtt}ms`);
        // Update mic delay auto-detect suggestion in Settings if panel is visible
        _updateMicDelayAutoHint();
        _updateClockOffsetDisplay();
        // If Loc Mic is ON, apply dynamic delay update with fresh RTT
        _applyDynamicMicDelay();
    }
}

function send(type, payload) {
    if (S.ws && S.ws.readyState === WebSocket.OPEN) {
        S.ws.send(JSON.stringify({ type, payload: payload || {} }));
    }
}

/* ═══════════════════════════════════════════════════════════════════════════
   MESSAGE HANDLER
═══════════════════════════════════════════════════════════════════════════ */

function handleMsg(msg) {
    switch (msg.type) {

        case 'clock:pong':
            _onClockPong(msg);
            break;

        case 'init':
            S.username    = msg.username    || '';
            S.primaryUser = msg.primaryUser || '';
            S.users       = msg.users       || [];
            S.console     = msg.console;
            // Faders always start at bottom on page load — DJ brings them up deliberately
            if (S.console?.channels) {
                S.console.channels.forEach((ch, i) => {
                    ch.fader = 0;
                    send('console:fader', { chId: i, pos: 0 });
                });
            }
            if (S.console) {
                S.console.monitorVolume = 0;
                send('console:monitor', { volume: 0 });
            }
            S.stream      = msg.stream  || S.stream;
            S.playlist    = msg.playlist || [];
            qs('#userDisplay').textContent = S.username;
            if (msg.library) updateLibStatus(msg.library);
            if (msg.config?.icecast) {
                const ic = msg.config.icecast;
                qs('#icecastInfo').textContent = `${ic.server}:${ic.port}${ic.mount}`;
            }
            if (msg.config?.musicPath) {
                const el_ = qs('#settingsMusicPath');
                if (el_) el_.value = msg.config.musicPath;
            }
            if (msg.config?.icecast) {
                const ic = msg.config.icecast;
                const el_s = qs('#settingsIcecastServer');
                const el_p = qs('#settingsIcecastPort');
                const el_m = qs('#settingsIcecastMount');
                if (el_s) el_s.value = ic.server || '';
                if (el_p) el_p.value = ic.port   || '';
                if (el_m) el_m.value = ic.mount  || '';
            }
            S.playlistB = msg.playlistB || [];
            buildAllChannels();
            updateConsoleUI();
            updateStreamUI();
            renderPlaylist();
            renderPlaylistB();
            if (msg.rbState) RB.applyState(msg.rbState);
            updatePrimaryUI();
            // Auto-start PlayerEarphone on login — PGM1 lit blue immediately.
            // We are inside the WS 'init' message handler which is triggered by
            // user action (login button click) → AudioContext can be created.
            PlayerEarphone.start();
            // Sync MON volume immediately after start — _ensureCtx() runs synchronously
            // inside start() so _gain already exists when setVolume() is called here.
            // The block in bindEvents() runs at DOMContentLoaded before S.console exists,
            // so this is the only reliable place to apply the server's stored monitorVolume.
            if (S.console?.monitorVolume !== undefined) {
                PlayerEarphone.setVolume(S.console.monitorVolume / 100);
            }
            _syncMonitorButtons();
            // Start mic path immediately so VU bars are live and DJ can check
            // their mic level before pressing GO LIVE. Awaited so getUserMedia
            // completes before MediaRecorder starts — prevents recording silence.
            startMicCapture().catch(e => console.warn('[init] startMicCapture error:', e.message));
            break;

        case 'console:state':
            S.console = msg.state;
            updateConsoleUI();
            raPlayerSyncToMixer();   // sync audio playback to Player 1 ON/OFF state
            WA.syncToConsole();      // update PGM bus gain nodes (fader levels, ON/OFF, CUE)
            PlayerEarphone.syncConsole(msg.state?.channels); // B: CH5 ON/fader → earphone gain
            // Refresh channel rows in Settings if that tab is open
            if (qs('#tab-settings')?.classList.contains('active')) renderSettingsChannels();
            // Sync continuous tracking: start if any Loc Mic is ON (e.g. page reload while mic live)
            if (_locMicIsOn()) _startMicLatTracking(); else _stopMicLatTracking();
            break;

        case 'stream:started':
            startMicCapture().catch(e => console.warn('[stream:started] startMicCapture error:', e.message));
            S.stream = msg.status || S.stream;
            S.stream.dropped = false;   // clear any prior dropped state on successful (re)connect
            updateStreamUI();
            break;
        case 'stream:stopped':
            stopMicCapture();
            updateMetaBar(null);
            updateRTProgress(0, 0, false, false, true, null);
            S.stream = msg.status || S.stream;
            S.stream.dropped = false;   // explicit DJ stop — not a fault
            updateStreamUI();
            break;
        case 'stream:dropped':
            // Liquidsoap connection lost — mixer is auto-reconnecting.
            // Keep mic capture running: on reconnect, server will replay stream:started.
            updateMetaBar(null);
            updateRTProgress(0, 0, false, false, true, null);
            S.stream = msg.status || S.stream;
            S.stream.dropped = true;
            updateStreamUI();
            showToast('Liquidsoap connection dropped — reconnecting…', 'warn');
            break;
        case 'stream:error':
            stopMicCapture();
            if (msg.status) S.stream = msg.status;
            S.stream.dropped = false;
            updateStreamUI();
            showToast(`Stream error: ${msg.error || 'Connection failed — check DJ credentials and Liquidsoap'}`, 'error');
            break;

        case 'mic:pong': {
            // Binary LAT probe round-trip complete.
            // msg.t0 = Date.now() (browser clock) when probe was sent.
            // RTT/2 used instead of (msg.t1 - msg.t0) to avoid cross-clock error:
            // VPS and browser clocks may differ by _clockOffset; RTT/2 is clock-neutral.
            const micMs   = Math.max(0, Math.round((Date.now() - msg.t0) / 2));
            const earMs   = (_pendingLatEarMs !== null)
                          ? _pendingLatEarMs
                          : Math.round(PlayerEarphone.getAudioDelaySec() * 1000);
            const totalMs = earMs + micMs;
            _pendingLatEarMs  = null;
            _lastMicLatResult = { micMs, earMs, totalMs };
            // Apply measured total delay on server
            fetch('/api/mic-delay', {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify({ ms: totalMs }),
            }).catch(() => {});
            // Update slider in Settings panel if it is open
            const _sl = document.getElementById('micDelaySlider');
            const _dp = document.getElementById('micDelayDisplay');
            if (_sl) _sl.value = totalMs;
            if (_dp) _dp.textContent = totalMs + 'ms';
            _updateMicDelayAutoHint();
            console.log(`[MicLatency] mic=${micMs}ms ear=${earMs}ms total=${totalMs}ms → /api/mic-delay`);
            showToast(`Mic latency: mic ${micMs}ms + ear ${earMs}ms = ${totalMs}ms total`, 'ok', 4000);
            break;
        }

        // ── Latency probe — pilot tone bi-directional measurement ─────────────
        case 'lat:probe': {
            // Server has started injecting 17kHz into earphone output.
            // Start polling AnalyserNode for arrival.
            const { id, t_ear_inject } = msg;
            PlayerEarphone.startEarPilotDetect(id, t_ear_inject, (probeId, earMs) => {
                console.log(`[lat] Ear pilot detected: earMs=${earMs}`);
                send('lat:ear_detected', { id: probeId, earMs });
            });
            break;
        }

        case 'lat:result': {
            // Both mic and ear latencies measured — apply total delay and report.
            const { earMs, micMs, totalMs } = msg;
            _lastMicLatResult = { micMs, earMs, totalMs };
            fetch('/api/mic-delay', {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify({ ms: totalMs }),
            }).catch(() => {});
            const _sl = document.getElementById('micDelaySlider');
            const _dp = document.getElementById('micDelayDisplay');
            if (_sl) _sl.value = totalMs;
            if (_dp) _dp.textContent = totalMs + 'ms';
            _updateMicDelayAutoHint();
            console.log(`[lat] Result applied: mic=${micMs}ms ear=${earMs}ms total=${totalMs}ms`);
            showToast(`Latency measured: mic ${micMs}ms + ear ${earMs}ms = ${totalMs}ms total`, 'ok', 5000);
            break;
        }

        case 'ra:state':
            RA.applyState(msg.state);
            // D: immediately flush earphone buffer when player stops/pauses
            // prevents the seconds-long audio drain after RA stop
            if (msg.state?.stopped || msg.state?.paused) PlayerEarphone.flush();
            break;
        case 'ra:progress':
            RA.applyProgress(msg.state);
            break;
        case 'ra:playlist':
            S.playlist = msg.tracks || [];
            renderPlaylist();
            break;

        case 'rb:state':
            RB.applyState(msg.state);
            break;
        case 'rb:progress':
            RB.applyProgress(msg.state);
            break;
        case 'rb:playlist':
            S.playlistB = msg.tracks || [];
            renderPlaylistB();
            RB.updateUI();   // re-apply .current highlight after rows are rebuilt
            break;

        case 'playlistB:updated':
            S.playlistB = msg.list || [];
            RB.onPlaylistUpdated();
            break;
        case 'playlistB:nowPlaying':
            break;

        case 'guest:list':
            S.guests = msg.guests || [];
            renderGuestPanel();
            break;

        case 'vu:levels':
            applyRealVULevels(msg.levels);
            break;
        case 'guest:ready':
            showToast('WebRTC ready — guests can call at /call', 'info');
            break;

        case 'stream:metadata':
            if (msg.metadata) {
                const mt = qs('#metaTitle');
                const ma = qs('#metaArtist');
                if (mt) mt.value = msg.metadata.title  || '';
                if (ma) ma.value = msg.metadata.artist || '';
            }
            break;

        case 'playlist:updated':
            S.playlist = msg.list || [];
            renderPlaylist();
            RA.onPlaylistUpdated();
            // Refresh meta bar startTime when playlist recalcs
            { const mbStart = qs('#mbStart');
              if (mbStart && !qs('#metaBar')?.classList.contains('hidden')) {
                  const cur = S.playlist.find(t => t.nowPlaying);
                  if (cur) mbStart.textContent = fmtTime(cur.startTime);
              }
            }
            break;

        case 'playlist:nowPlaying':
            if (msg.track) {
                updateMetaBar(msg.track);
                populateTrackMeta(msg.track);
            } else {
                updateMetaBar(null);
                populateTrackMeta(null);
            }
            RA.updateUI();
            break;

        case 'library:ready': {
            // Primary DJ: _startLibraryScan() poll loop handles all UI.
            // This WS message updates observers and re-triggers search.
            updateLibStatus({ indexed: true, indexing: false, count: msg.count });
            const q = qs('#libSearch');
            if (q && q.value.trim()) doLibSearch();
            const res = qs('#libResults');
            if (res && res.querySelector('.lib-warn')) {
                if (msg.count > 0) {
                    res.innerHTML = '<div class="lib-empty">Type to search the music library…</div>';
                    if (q && q.value.trim()) doLibSearch();
                } else {
                    res.innerHTML = '<div class="lib-empty lib-warn">⚠ No files found at the configured path.<br>Check Settings → Music Library Path.</div>';
                }
            }
            break;
        }

        case 'library:indexing': {
            // Broadcast to observers — primary DJ uses poll loop for detailed status.
            updateLibStatus({ indexed: false, indexing: true, count: 0 });
            break;
        }

        case 'console:timer':
            if (msg.data) syncTimer(msg.data);
            break;

        case 'users:list':
            S.users       = msg.users       || [];
            S.primaryUser = msg.primaryUser || '';
            updatePrimaryUI();
            break;

        case 'config:saved':
        case 'config:updated':
            if (msg.musicPath) {
                const el_ = qs('#settingsMusicPath');
                if (el_) el_.value = msg.musicPath;
            }
            showToast('Settings saved', 'ok');
            break;

        case 'error':
            showToast(msg.message || 'Error', 'error');
            break;
    }
}

/* ═══════════════════════════════════════════════════════════════════════════
   PRIMARY / MULTI-USER UI
═══════════════════════════════════════════════════════════════════════════ */

function updatePrimaryUI() {
    const badge   = qs('#primaryBadge');
    const userList = qs('#connectedUsers');

    if (badge) {
        if (S.isPrimary()) {
            badge.textContent  = '★ PRIMARY';
            badge.className    = 'badge badge-primary';
        } else {
            badge.textContent  = `Primary: ${S.primaryUser || '–'}`;
            badge.className    = 'badge badge-observer';
        }
    }

    if (userList) {
        userList.innerHTML = '';
        S.users.forEach(u => {
            const item = el('div', { className: 'user-item' + (u.isPrimary ? ' is-primary' : '') });
            item.appendChild(el('span', { textContent: u.username + (u.isPrimary ? ' ★' : '') }));
            userList.appendChild(item);
        });
    }

    // Disable controls ONLY for non-primary users.
    // NEVER disable during streaming — would break live broadcast controls.
    // Use isPrimary() which is stable — it compares username (set at login, never changes).
    const controlDisabled = !S.isPrimary();
    const controls = qsAll('.primary-only');
    controls.forEach(el_ => {
        // Skip range inputs that are intentionally always disabled (e.g. PGM1 fader)
        if (el_.classList.contains('ch-fader-pgm1')) return;
        el_.disabled = controlDisabled;
        el_.classList.toggle('disabled', controlDisabled);
    });

    if (controlDisabled) {
        const msg = qs('#primaryMsg');
        if (msg) { msg.textContent = `Observer mode — ${S.primaryUser || 'nobody'} has control`; msg.classList.remove('hidden'); }
    } else {
        const msg = qs('#primaryMsg');
        if (msg) msg.classList.add('hidden');
    }
}

/* ═══════════════════════════════════════════════════════════════════════════
   CLOCK
═══════════════════════════════════════════════════════════════════════════ */

function startClock() {
    function tick() {
        const now = new Date();
        qs('#clockDisplay').textContent =
            String(now.getHours()).padStart(2,'0')   + ':' +
            String(now.getMinutes()).padStart(2,'0') + ':' +
            String(now.getSeconds()).padStart(2,'0');
    }
    tick();
    setInterval(tick, 1000);
}

/* ═══════════════════════════════════════════════════════════════════════════
   PLAYER PANEL TEMPLATE
   Single source of truth for Player 1 (ra) and Player 2 (rb) panel HTML.
   Call buildPlayerPanel('ra') and buildPlayerPanel('rb') at DOMContentLoaded
   to inject identical structure into #raLeft and #raLeftB respectively.
   All IDs are derived from the prefix so app.js selectors never need updating.
═══════════════════════════════════════════════════════════════════════════ */
function buildPlayerPanel(p) {
    const isA     = p === 'ra';
    const cid     = n => `${p}${n}`;               // e.g. 'NowTitle' → 'raNowTitle'
    const tmp     = isA ? 'tmp'    : 'tmpB';        // track-meta ID prefix
    const plWrap  = isA ? 'playlistWrap'   : 'playlistBWrap';
    const plTable = isA ? 'playlistTable'  : 'playlistBTable';
    const plBody  = isA ? 'playlistBody'   : 'playlistBBody';
    const clearId = isA ? 'clearPlaylistBtn' : 'clearPlaylistBBtn';
    const metaId  = isA ? 'trackMetaPanel'  : 'trackMetaPanelB';
    const emptyMsg = 'Playlist empty — add tracks from the library →';

    const container = document.getElementById(isA ? 'raLeft' : 'raLeftB');
    if (!container) return;

    container.innerHTML = `
      <div class="ra-transport">

        <div class="ra-now">
          <div class="${p}-now-label">ON AIR</div>
          <div class="ra-now-info">
            <div id="${cid('NowTitle')}"  class="ra-now-title">–</div>
            <div id="${cid('NowArtist')}" class="ra-now-artist">–</div>
          </div>
          <div class="ra-now-time">
            <span id="${cid('TimeElapsed')}" class="ra-time-el">0:00</span>
            <div id="${cid('ProgressBar')}" class="ra-progress">
              <div id="${cid('ProgressFill')}" class="ra-progress-fill"></div>
              <div id="${cid('ProgressHead')}" class="ra-progress-head"></div>
            </div>
            <span id="${cid('TimeRemain')}" class="ra-time-re">-0:00</span>
          </div>
        </div>

        <div class="ra-controls">
          <button id="${cid('BtnPrev')}"  class="ra-btn" title="Previous track">⏮</button>
          <button id="${cid('BtnPlay')}"  class="ra-btn ra-btn-play" title="Play / Pause">▶</button>
          <button id="${cid('BtnStop')}"  class="ra-btn" title="Stop">⏹</button>
          <button id="${cid('BtnNext')}"  class="ra-btn" title="Next track">⏭</button>
          <button id="${cid('BtnBreak')}" class="ra-btn ra-btn-break" title="Stop after current track">⏹|</button>
        </div>

        <div class="ra-cfg">
          <label class="ra-cfg-lbl">XF</label>
          <input type="number" id="${cid('Crossfade')}" class="ra-cfg-in"
                 value="2" min="0" max="30" step="0.5" title="Crossfade (seconds)">
          <label class="ra-cfg-lbl">s</label>
          <button id="${clearId}" class="btn-danger-sm" style="margin-left:10px">✕ Clear</button>
        </div>

      </div>

      <div id="${plWrap}" class="player-pl-wrap">
        <table id="${plTable}" class="player-pl-table">
          <thead>
            <tr>
              <th class="col-num">#</th>
              <th class="col-state">STATE</th>
              <th class="col-track">ARTIST – TITLE</th>
              <th class="col-dur">Dur.</th>
              <th class="col-del"  title="Delete">✕</th>
              <th class="col-stop" title="Stop after this track">⏹|</th>
            </tr>
          </thead>
          <tbody id="${plBody}" class="player-pl-body">
            <tr><td colspan="6" class="pl-empty">${emptyMsg}</td></tr>
          </tbody>
        </table>
      </div>

      <div id="${metaId}" class="track-meta-panel hidden">
        <div class="tmp-header">
          <span class="tmp-icon">♪</span>
          <span class="tmp-title" id="${tmp}TrackTitle">–</span>
          <span class="tmp-badge" id="${tmp}Status"></span>
        </div>
        <div class="tmp-body">
          <div class="tmp-group">
            <div class="tmp-group-lbl">TRACK</div>
            <div class="tmp-row"><span class="tmp-lbl">Title</span>        <span class="tmp-val tmp-bright" id="${tmp}Title">–</span></div>
            <div class="tmp-row"><span class="tmp-lbl">Artist</span>       <span class="tmp-val tmp-cyan"   id="${tmp}Artist">–</span></div>
            <div class="tmp-row"><span class="tmp-lbl">Album Artist</span> <span class="tmp-val"            id="${tmp}AlbumArtist">–</span></div>
            <div class="tmp-row"><span class="tmp-lbl">Album</span>        <span class="tmp-val"            id="${tmp}Album">–</span></div>
            <div class="tmp-row"><span class="tmp-lbl">Genre</span>        <span class="tmp-val"            id="${tmp}Genre">–</span></div>
          </div>
          <div class="tmp-group">
            <div class="tmp-group-lbl">NUMBERING</div>
            <div class="tmp-row"><span class="tmp-lbl">Track №</span>      <span class="tmp-val"            id="${tmp}TrackNum">–</span></div>
            <div class="tmp-row"><span class="tmp-lbl">Disc №</span>       <span class="tmp-val"            id="${tmp}DiscNum">–</span></div>
            <div class="tmp-row"><span class="tmp-lbl">Date</span>         <span class="tmp-val"            id="${tmp}Date">–</span></div>
            <div class="tmp-row"><span class="tmp-lbl">Original Date</span><span class="tmp-val"            id="${tmp}OrigDate">–</span></div>
            <div class="tmp-row"><span class="tmp-lbl">Duration</span>     <span class="tmp-val tmp-amber"  id="${tmp}Duration">–</span></div>
            <div class="tmp-row"><span class="tmp-lbl">LUFS</span>         <span class="tmp-val tmp-amber"  id="${tmp}Lufs">–</span></div>
          </div>
          <div class="tmp-group">
            <div class="tmp-group-lbl">GATO PRETO</div>
            <div class="tmp-row"><span class="tmp-lbl">Album ID</span>     <span class="tmp-val tmp-id"     id="${tmp}AlbumId">–</span></div>
            <div class="tmp-row"><span class="tmp-lbl">Track ID</span>     <span class="tmp-val tmp-id"     id="${tmp}TrackId">–</span></div>
            <div class="tmp-row"><span class="tmp-lbl">Artist ID</span>    <span class="tmp-val tmp-id"     id="${tmp}ArtistId">–</span></div>
            <div class="tmp-row"><span class="tmp-lbl">Status</span>       <span class="tmp-val"            id="${tmp}GpStatus">–</span></div>
          </div>
        </div>
      </div>
    `;
}

/* ═══════════════════════════════════════════════════════════════════════════
   RT — CHANNEL STRIPS
═══════════════════════════════════════════════════════════════════════════ */

function buildAllChannels() {
    // RT 1: CH3–CH8 (index 2–7) — Station mix → PGM 1
    // RT 2: CH1–CH2 (index 0–1) — DJ local mics (WebRTC) + PGM 1 input → PGM 2 → Icecast
    const rt1Row = qs('#rt1Channels');
    const rt2Row = qs('#rt2Channels');
    if (!rt1Row || !rt2Row) {
        // Fallback: legacy single-row layout
        const row = qs('#channelRow');
        if (row) { row.innerHTML = ''; for (let i = 0; i < 8; i++) row.appendChild(buildChannel(i)); }
        buildVUMeters();
        startVUSim();
        return;
    }

    rt1Row.innerHTML = '';
    rt2Row.innerHTML = '';

    // RT 1: CH3–CH8 (chId 2–7)
    for (let i = 2; i < 8; i++) rt1Row.appendChild(buildChannel(i));
    // RT 2: PGM 1 input strip — FIRST (station mix feeding into RT 2)
    rt2Row.appendChild(buildPgmVuStrip('PGM 1', 'Station Mix', 'pgm1VuL', 'pgm1VuR', 'rt2Pgm1Vu'));
    // RT 2: CH7–CH8 (chId 0–1)
    for (let i = 0; i < 2; i++) rt2Row.appendChild(buildChannel(i));
    // RT 2: PGM 2 VU strip — last
    rt2Row.appendChild(buildPgmVuStrip('PGM 2', 'ICECAST', 'pgm2VuL', 'pgm2VuR', 'rt2PgmVu'));

    // MONITOR strip — identical ch-strip container, bottom-flush with RT2
    buildMonitorStrip();
    // buildMonitorStrip() calls buildChannel(0) as a scaffold, which overwrites
    // _vuChSegs[0] with the MON strip's detached segment elements.
    // Re-register the real CH7 (chId=0) and CH8 (chId=1) VU segments from the
    // actual DOM strips that were appended to rt2Row above.
    [0, 1].forEach(chId => {
        const strip = qs(`#ch-${chId}`);
        if (!strip) return;
        _vuChSegs[chId] = [];
        strip.querySelectorAll('.ch-vu-side-bar').forEach(bar => {
            _vuChSegs[chId].push(Array.from(bar.querySelectorAll('.ch-vu-seg')));
        });
    });

    // buildVUMeters() MUST run after all strips are appended to the DOM —
    // it queries #pgm1VuL / #pgm2VuL which only exist after buildPgmVuStrip().
    buildVUMeters();

    startVUSim();
}

// MONITOR strip — built with identical ch-strip structure as channel strips (KISS)
function buildPgmVuStrip(label, lcdText, vuLId, vuRId, stripId) {
    const strip = el('div', { className: 'ch-strip ch-strip-pgm-vu', id: stripId });
    strip.appendChild(el('div', { className: 'ch-num', textContent: label }));
    const lcd = el('div', { className: 'ch-name-lcd ch-name-lcd-pgmvu', style: 'cursor:default' });
    lcd.textContent = lcdText;
    strip.appendChild(lcd);
    // VU meters fill remaining height
    const vuWrap = el('div', { className: 'pgm-vu-meters' });
    const colL = el('div', { className: 'pgm-vu-col' });
    const colR = el('div', { className: 'pgm-vu-col' });
    colL.appendChild(el('div', { className: 'seg-meter seg-meter-pgm', id: vuLId }));
    colL.appendChild(el('div', { className: 'pgm-vu-lbl', textContent: 'L' }));
    colR.appendChild(el('div', { className: 'seg-meter seg-meter-pgm', id: vuRId }));
    colR.appendChild(el('div', { className: 'pgm-vu-lbl', textContent: 'R' }));
    vuWrap.appendChild(colL); vuWrap.appendChild(colR);
    strip.appendChild(vuWrap);

    // ALWAYS ON badge — same position as ON/OFF row on channel strips
    const onBadge = el('div', { className: 'ch-pgm1-on ch-onoff-below-fader' });
    onBadge.innerHTML = '<span class="ch-pgm1-on-badge">ALWAYS ON</span>';
    strip.appendChild(onBadge);

    return strip;
}

// MONITOR strip — uses buildChannel(0) as a template so the DOM is
// guaranteed identical to CH 1-8. Label/LCD/handlers swapped after build.
function buildMonitorStrip() {
    const wrap = qs('#monitorStrip');
    if (!wrap) return;
    wrap.innerHTML = '';

    // Build a full CH strip using chId=0 as scaffold
    const strip = buildChannel(0);
    strip.id = 'monStrip';

    // Swap label: "CH 7" → "MON"
    const num = strip.querySelector('.ch-num');
    if (num) num.textContent = 'MON';

    // Swap LCD: blank — section header already says MON, no need to repeat
    const lcd = strip.querySelector('.ch-name-lcd');
    if (lcd) {
        lcd.textContent = '';
        lcd.style.cursor = 'default';
        lcd.id = 'monStatusTxt';
        lcd.onclick = null;
    }

    // Swap fader: sends volume to PlayerEarphone instead of console:fader
    const fader = strip.querySelector('.ch-fader');
    if (fader) {
        fader.id    = 'monVolSlider';
        fader.value = S.console?.monitorVolume ?? 0;
        const f2 = fader.cloneNode(true);
        fader.parentNode.replaceChild(f2, fader);
        f2.addEventListener('input', () => {
            const v = parseInt(f2.value);
            const valEl = qs('#monVolVal');
            if (valEl) valEl.textContent = v;
            PlayerEarphone.setVolume(v / 100);
            send('console:monitor', { volume: v });
        });
    }

    // Label fader value
    const fval = strip.querySelector('.ch-fader-val');
    if (fval) { fval.id = 'monVolVal'; fval.textContent = faderDB(S.console?.monitorVolume ?? 0); }

    // Register VU segments under 'mon' key
    _vuChSegs['mon'] = [];
    strip.querySelectorAll('.ch-vu-side-bar').forEach((bar, col) => {
        bar.id = `mon-vu-${col}`;
        _vuChSegs['mon'].push(Array.from(bar.querySelectorAll('.ch-vu-seg')));
    });

    // Remove the TB/CUE row that buildChannel added (not needed for MON strip)
    const cuetbRow = strip.querySelector('.ch-cuetb-below-fader');
    if (cuetbRow) cuetbRow.remove();

    // Replace ON/OFF row with 3-position rotary source selector: PGM 1 | PGM 2 | CUE
    // ON/OFF buttons removed — PlayerEarphone is always active after login.
    const onoffRow = strip.querySelector('.ch-onoff-below-fader');
    if (onoffRow) {
        // Remove the ON/OFF buttons entirely — earphone is always on after login
        onoffRow.remove();

        // Source selector row — 3 positions: PGM 1 | PGM 2 | CUE
        const rotaryRow = el('div', { className: 'mon-source-row' });
        const rotary    = el('div', { className: 'mon-source-rotary', id: 'monSourceRotary' });

        const sources = [
            { key: 'pgm1', label: 'PGM 1' },
            { key: 'pgm2', label: 'PGM 2' },
            { key: 'cue',  label: 'CUE'   },
        ];
        const curSrc = S.console?.monitorSource || 'pgm1';
        sources.forEach(({ key, label }) => {
            const btn = el('button', {
                className:   `mon-src-btn${key === curSrc ? ' active' : ''}`,
                textContent: label,
                id:          `monSrc-${key}`,
                title:       `Monitor source: ${label}`
            });
            btn.addEventListener('click', () => {
                rotary.querySelectorAll('.mon-src-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                send('console:monitor', { source: key });
                if (S.console) S.console.monitorSource = key;
                // Sidetone only available on PGM 1 — disable when switching away
                if (key !== 'pgm1' && PlayerEarphone.isSidetoneOn()) {
                    PlayerEarphone.disableSidetone();
                    _syncSidetoneBtn();
                }
                _syncMonMicVisibility();
            });
            rotary.appendChild(btn);
        });

        rotaryRow.appendChild(rotary);
        strip.appendChild(rotaryRow);

        // ── MON Mic row — sidetone toggle (PGM 1 only) ──────────────────────
        // Connects Loc Mic 1/2 directly into the earphone AudioContext at 0ms
        // so the DJ hears their own voice like a real console sidetone circuit.
        const micRow = el('div', { className: 'mon-source-row', id: 'monMicRow' });
        const micBtn = el('button', {
            id:          'monMicBtn',
            className:   'mon-src-btn mon-mic-btn',
            textContent: 'MON Mic',
            title:       'Sidetone: hear Loc Mic 1/2 in earphone at 0ms (no server round-trip)',
        });
        micBtn.addEventListener('click', () => {
            if (PlayerEarphone.isSidetoneOn()) {
                PlayerEarphone.disableSidetone();
            } else {
                const stream = WA.getMicStream();
                if (stream) PlayerEarphone.enableSidetone(stream);
                else showToast('Mic not ready — press GO LIVE first', 'warn');
            }
            _syncSidetoneBtn();
        });
        micRow.appendChild(micBtn);
        strip.appendChild(micRow);
        _syncMonMicVisibility();
    }

    wrap.appendChild(strip);
}

// PGM 1 input strip for RT 2 — read-only visual, identical layout to CH strips
// D.2: fader+VU identical to CH 1-8
// D.1: ALWAYS ON badge below fader (where ON/OFF row is on channel strips)

function buildChannel(chId) {
    const ch = S.console?.channels?.[chId] || {};

    // CH display numbers: RT1 shows CH 1–6 (chId 2–7), RT2 shows CH 7–8 (chId 0–1)
    // chId is the internal array index — never changes. Only the label differs.
    const CH_DISPLAY_NUM = { 0: 7, 1: 8, 2: 1, 3: 2, 4: 3, 5: 4, 6: 5, 7: 6 };
    const displayNum = CH_DISPLAY_NUM[chId] ?? (chId + 1);

    const strip = el('div', { className: 'ch-strip', id: `ch-${chId}` });

    // Channel number
    strip.appendChild(el('div', { className: 'ch-num', textContent: `CH ${displayNum}` }));

    // LCD name
    const lcd = el('div', { className: 'ch-name-lcd', textContent: ch.name || `CH ${chId+1}` });
    lcd.title = 'Click to configure channel';
    lcd.addEventListener('click', () => openChConfig(chId));
    strip.appendChild(lcd);

    // TB type detection — used below the fader
    const chType_ = S.console?.channels?.[chId]?.type || '';
    const hasTB_  = (chType_ === 'remote' || chType_ === 'webrtc');

    // Fader + VU side-by-side in one row
    const faderWrap  = el('div', { className: 'ch-fader-wrap' });
    const faderTrack = el('div', { className: 'ch-fader-track' });
    const fader = el('input', {
        type: 'range', className: 'ch-fader primary-only',
        min: 0, max: 100, value: ch.fader ?? 0,
        id: `ch-${chId}-fader`
    });
    let _faderThrottle = null;
    fader.addEventListener('input', () => {
        const pos = parseInt(fader.value);
        updateFaderLabel(chId, pos);
        if (S.console?.channels?.[chId]) S.console.channels[chId].fader = pos;
        WA.syncToConsole();
        clearTimeout(_faderThrottle);
        _faderThrottle = setTimeout(() => send('console:fader', { chId, pos }), 50);
    });
    fader.addEventListener('change', () => {
        clearTimeout(_faderThrottle);
        send('console:fader', { chId, pos: parseInt(fader.value) });
    });
    faderTrack.appendChild(fader);
    faderWrap.appendChild(faderTrack);

    // dB scale
    const scale = el('div', { className: 'ch-fader-scale' });
    ['0','5','10','15','20','25','30','40','50','60','65','∞'].forEach(lbl => {
        const s = el('span', { textContent: lbl });
        if (lbl === '0') s.className = 'unity';
        scale.appendChild(s);
    });
    faderWrap.appendChild(scale);

    // VU bars — two columns, beside fader
    const vuSide = el('div', { className: 'ch-vu-side' });
    _vuChSegs[chId] = [];
    for (let col = 0; col < 2; col++) {
        const bar = el('div', { className: 'ch-vu-side-bar', id: `ch-${chId}-vu-${col}` });
        const segsArr = [];
        for (let s = 0; s < 16; s++) {
            const seg = el('div', { className: 'ch-vu-seg' });
            bar.appendChild(seg); segsArr.push(seg);
        }
        _vuChSegs[chId].push(segsArr);
        vuSide.appendChild(bar);
    }
    faderWrap.appendChild(vuSide);

    strip.appendChild(faderWrap);

    const faderVal = el('div', { className: 'ch-fader-val', id: `ch-${chId}-fval` });
    faderVal.textContent = faderDB(ch.fader ?? 0);
    strip.appendChild(faderVal);

    // ── TB / CUE row — ABOVE ON/OFF (IP-12 layout) ──────────────────────────
    // TB:  talkback — remote/webrtc channels only.  CUE: pre-fader listen — all channels.
    const cuetb = el('div', { className: 'ch-cuetb ch-cuetb-below-fader' });

    // CUE button — all channels, pre-fader listen
    const btnCUE = el('button', {
        className:   'ch-cue-btn primary-only',
        textContent: 'CUE',
        id:          `ch-${chId}-cue`,
        title:       'CUE: pre-fader listen'
    });
    btnCUE.addEventListener('click', () => {
        const cur = !!(S.console?.channels?.[chId]?.cue);
        if (S.console?.channels?.[chId]) S.console.channels[chId].cue = !cur;
        updateConsoleUI();
        send('console:cue', { chId, active: !cur });
    });
    cuetb.appendChild(btnCUE);

    // TB button — remote/webrtc channels only
    if (hasTB_) {
        const btnTB = el('button', {
            className:   'ch-tb-btn primary-only',
            textContent: 'TB',
            id:          `ch-${chId}-tb`,
            title:       'TB: talkback to this channel (off air)'
        });
        btnTB.addEventListener('click', () =>
            send('console:tb', { chId, active: !S.console?.channels?.[chId]?.tb })
        );
        cuetb.appendChild(btnTB);
    } else {
        // Placeholder keeps layout aligned across all strips
        cuetb.appendChild(el('div', { className: 'ch-tb-placeholder' }));
    }
    strip.appendChild(cuetb);

    // ── ON / OFF row ─────────────────────────────────────────────────────────
    const onoff  = el('div', { className: 'ch-onoff ch-onoff-below-fader' });
    const btnOn  = el('button', { className: 'ch-on-btn  primary-only', textContent: 'ON',  id: `ch-${chId}-on`  });
    const btnOff = el('button', { className: 'ch-off-btn primary-only', textContent: 'OFF', id: `ch-${chId}-off` });
    btnOn.addEventListener('click',  () => {
        if (S.console?.channels?.[chId]) S.console.channels[chId].on = true;
        WA.syncToConsole();
        updateConsoleUI();
        send('console:on', { chId, on: true  });
        // Trigger bi-directional latency measurement when Loc Mic 1 (chId=0) or
        // Loc Mic 2 (chId=1) is turned ON — these are the DJ's local mics.
        if (chId === 0 || chId === 1) {
            startLatencyMeasure(chId);  // one-shot pilot-tone precise measurement
            _startMicLatTracking();     // continuous RTT-based dynamic tracking
        }
    });
    btnOff.addEventListener('click', () => {
        if (S.console?.channels?.[chId]) S.console.channels[chId].on = false;
        WA.syncToConsole();
        updateConsoleUI();
        send('console:on', { chId, on: false });
        // Stop continuous tracking only when BOTH Loc Mics are now OFF
        if (chId === 0 || chId === 1) {
            if (!_locMicIsOn()) _stopMicLatTracking();
        }
    });
    onoff.appendChild(btnOn); onoff.appendChild(btnOff);
    strip.appendChild(onoff);

    return strip;
}

/* Update all channel strip classes/states from S.console */
function updateConsoleUI() {
    if (!S.console) return;
    const chs = S.console.channels;
    if (!chs) return;

    chs.forEach((ch, i) => {
        const strip = qs(`#ch-${i}`);
        if (!strip) return;

        // Priority: TB (blue) > CUE (amber) > ON (green)
        strip.classList.toggle('is-tb',  ch.tb);
        strip.classList.toggle('is-cue', ch.cue && !ch.tb);
        strip.classList.toggle('is-on',  ch.on && !ch.tb && !ch.cue);

        const lcd = strip.querySelector('.ch-name-lcd');
        if (lcd) {
            lcd.textContent = ch.name || `CH ${i+1}`;
            // Green when ON, red when OFF — immediate visual feedback
            lcd.classList.toggle('lcd-on',  !!ch.on);
            lcd.classList.toggle('lcd-off', !ch.on);
        }

        const btnA = qs(`#ch-${i}-btnA`);
        const btnB = qs(`#ch-${i}-btnB`);
        if (btnA) { btnA.classList.toggle('active', ch.activeSource === 'A'); btnA.textContent = ch.labelA || 'A'; }
        if (btnB) {
            btnB.classList.toggle('active', ch.activeSource === 'B');
            btnB.disabled    = !ch.sourceB;
            btnB.title       = ch.sourceB ? ch.labelB || 'B' : 'Source B not configured';
            btnB.textContent = ch.labelB || 'B';
        }

        const btnOn  = qs(`#ch-${i}-on`);
        const btnOff = qs(`#ch-${i}-off`);
        if (btnOn)  btnOn.classList.toggle('lit',  ch.on);
        if (btnOff) btnOff.classList.toggle('lit', !ch.on);

        const btnCUE = qs(`#ch-${i}-cue`);
        if (btnCUE) btnCUE.classList.toggle('lit', !!ch.cue);

        const btnTB  = qs(`#ch-${i}-tb`);
        if (btnTB)  btnTB.classList.toggle('lit',  ch.tb);

        const fader = qs(`#ch-${i}-fader`);
        if (fader && fader !== document.activeElement) fader.value = ch.fader ?? 0;
        updateFaderLabel(i, ch.fader ?? 0);
    });

    if (S.console.monitorSource) {
        // Sync rotary source buttons
        const src = S.console.monitorSource;
        document.querySelectorAll('#monSourceRotary .mon-src-btn').forEach(b => {
            b.classList.toggle('active', b.id === `monSrc-${src}`);
        });
    }
    if (S.console.monitorVolume !== undefined) {
        const vol = S.console.monitorVolume;
        const sl  = qs('#monVolSlider');
        if (sl && sl !== document.activeElement) sl.value = vol;
        const valEl = qs('#monVolVal');
        if (valEl) valEl.textContent = vol;
    }
    const hp = S.console.headphoneSource;
    const hpLabel = qs('#hpSrcLabel');
    if (hpLabel) {
        hpLabel.textContent = hp === 'cue' ? 'CUE' : hp === 'tb' ? 'TB' : (S.console.monitorSource === 'offair' ? 'OFF-AIR' : '');
    }
    if (S.console.timer) syncTimer(S.console.timer);
    // Always sync monitor panel to actual PlayerEarphone state last.
    // console.monitorSource may lag or mismatch actual running state after GO LIVE.
    _syncMonitorButtons();
}

/* ── Fader dB label ── */
// faderDB: converts fader position (0-100) to display dB string.
// Matches the actual taper gain law: taper(pos) = (pos/100)^2.5 * 3.162
// True 0dB (unity, gain=1.0) ≈ pos=63. Max +10dB at pos=100. -∞ at pos=0.
function faderDB(pos) {
    pos = parseInt(pos);
    if (pos <= 0) return '−∞';
    const gain = Math.pow(pos / 100, 2.5) * 3.162;
    const db   = 20 * Math.log10(gain);
    if (db >= 10) return '+10';
    if (db >= 0)  return '+' + db.toFixed(1);
    return db.toFixed(1);
}

function updateFaderLabel(chId, pos) {
    const el_ = qs(`#ch-${chId}-fval`);
    if (el_) el_.textContent = faderDB(pos);
}

/* ═══════════════════════════════════════════════════════════════════════════
   VU METERS
═══════════════════════════════════════════════════════════════════════════ */

const _vuChSegs = [];

function buildVUMeters() {
    // PGM 1 small VU (RT1 — station mix)
    ['pgm1VuL', 'pgm1VuR'].forEach((id, col) => {
        const m = qs(`#${id}`);
        if (!m) return;
        m.innerHTML = '';
        const arr = col === 0 ? _pgm1SegsL : _pgm1SegsR;
        arr.length = 0;
        for (let i = 0; i < 30; i++) { arr.push(m.appendChild(el('div', { className: 'seg' }))); }
    });
    // PGM 2 small VU (RT2 — broadcast mix = master level)
    ['pgm2VuL', 'pgm2VuR'].forEach((id, col) => {
        const m = qs(`#${id}`);
        if (!m) return;
        m.innerHTML = '';
        const arr = col === 0 ? _pgm2SegsL : _pgm2SegsR;
        arr.length = 0;
        for (let i = 0; i < 30; i++) { arr.push(m.appendChild(el('div', { className: 'seg' }))); }
    });
}

let _vuTimer = null;

const _pgm1SegsL = [], _pgm1SegsR = [];
const _pgm2SegsL = [], _pgm2SegsR = [];

function startVUSim() {
    if (_vuTimer) clearInterval(_vuTimer);
    _vuTimer = setInterval(tickVU, 80);
}

// Map mixer key → channel index (0-based)
// mic0→CH7(RT2 Loc Mic 1), mic1→CH8(RT2 Loc Mic 2), mic2→CH1(RT1 DJ 1 Mic), mic3→CH2(RT1 DJ 2 Mic)
// player1=CH5, player2=CH6, guest0=CH7, guest1=CH8 (RT1)
const VU_KEY_CH = {
    mic0: 0, mic1: 1, mic2: 2, mic3: 3,
    player1: 4, player2: 5, guest0: 6, guest1: 7
};
// Which keys belong to Mix 1 (RT1 / PGM1) — same as mixer.js MIX1_KEYS
const MIX1_VU_KEYS = new Set(['mic2','mic3','player1','player2','guest0','guest1']);

// Real levels arrive from server every ~100ms
const _realLevels = {};     // chId → level 0.0-1.0
const _vuPeak    = {};     // chId → peak-hold level
const _vuPeakAge = {};     // chId → ms since peak was set
const VU_HOLD_MS  = 300;   // hold peak for 300ms
const VU_DECAY    = 0.18;  // decay per 100ms tick (multiplicative)

function applyRealVULevels(levels) {
    let pgm1Level = 0;  // Mix 1: player1+player2+mic2+mic3+guest0+guest1
    let pgm2Level = 0;  // Mix 2: all sources (Mix1 + mic0 + mic1)
    for (const [key, rms] of Object.entries(levels)) {
        const ch = VU_KEY_CH[key];
        if (ch === undefined) continue;
        // mic0/mic1 VU is driven locally by _tickLocalMicVU() at ~80ms — far faster
        // than the server round-trip (~200ms). Skip server data for these channels.
        if (key === 'mic0' || key === 'mic1') continue;
        const consoleChannel = S.console?.channels?.[ch];
        const isMicKey = (key === 'mic0' || key === 'mic1' || key === 'mic2' || key === 'mic3');

        // ── IP-12 VU bar rules (brochure p.12) ──────────────────────────────
        // CUE active  → pre-fader: raw RMS × 8, fader position ignored
        // ON  active  → post-fader: RMS × 8 × taper(fader), matches what goes to air
        // Both active → CUE takes precedence (pre-fader, IP-12 hardware behaviour)
        // OFF, no CUE → bar dark (level = 0)
        let level = 0;
        const chOn   = consoleChannel?.on   === true;
        const chCue  = consoleChannel?.cue  === true;
        const chFader = consoleChannel?.fader ?? 0;
        // taper: same law as server (pos/100)^2.5 * 3.162, clamped to ×1 for display
        const faderGain = chFader <= 0 ? 0 : Math.min(1.0, Math.pow(chFader / 100, 2.5) * 3.162);

        if (chCue) {
            // Pre-fader: signal visible regardless of ON/OFF or fader position
            level = Math.min(1.2, rms * 8);
        } else if (chOn) {
            // rms from server is already post-fader (vuGain = gain in mixer).
            // Do NOT re-apply faderGain here — that would double-apply the taper.
            level = Math.min(1.2, rms * 8);
        }
        // OFF + no CUE → level stays 0 (bar dark)

        _realLevels[ch] = level;
        // Peak-hold: raise peak instantly, decay slowly after hold period
        const now = Date.now();
        if (level >= (_vuPeak[ch] || 0)) {
            _vuPeak[ch]    = level;
            _vuPeakAge[ch] = now;
        } else if ((now - (_vuPeakAge[ch] || 0)) > VU_HOLD_MS) {
            _vuPeak[ch] = Math.max(level, (_vuPeak[ch] || 0) * (1 - VU_DECAY));
        }
        apply8SegVUArr(ch, _vuPeak[ch] || level);
        if (MIX1_VU_KEYS.has(key)) pgm1Level = Math.min(1.5, pgm1Level + level);
        // PGM2 = PGM1 + mic0 + mic1 (local mics). Add mic contribution only when
        // PGM2 = PGM1 + local mics (post-fader, only when ON + fader > 0)
        // Only add mic contribution when it would actually appear in broadcast mix.
        if (isMicKey) {
            if (consoleChannel?.on === true && (consoleChannel?.fader ?? 0) > 0) {
                pgm2Level = Math.min(1.5, pgm2Level + level);
            }
            // else: mic is OFF or fader at -∞ — contributes nothing to PGM2
        } else {
            pgm2Level = Math.min(1.5, pgm2Level + level);
        }
    }
    // PGM1 and PGM2 driven by actual output bus RMS from server.
    // _mix1rms = real outMix1 buffer RMS (station mix, no local mics)
    // _mix2rms = real out buffer RMS (broadcast mix = Mix1 + mic0 + mic1)
    // This is ground truth — no scale estimates, no background noise inflation.
    const mix1rms = levels._mix1rms ?? pgm1Level;  // fallback to estimate if not present
    const mix2rms = levels._mix2rms ?? pgm2Level;
    const pgm1Display = Math.min(1.5, mix1rms * 8);
    const pgm2Display = Math.min(1.5, mix2rms * 8);
    applySmallMeterArr(_pgm1SegsL, pgm1Display);
    applySmallMeterArr(_pgm1SegsR, pgm1Display);
    applySmallMeterArr(_pgm2SegsL, pgm2Display);
    applySmallMeterArr(_pgm2SegsR, pgm2Display);
    const _monRaw = PlayerEarphone.isActive()
        ? (PlayerEarphone.getLevel() * 6)   // actual output level only — no pgm1Level fallback
        : 0;
    apply8SegVUArr('mon', Math.min(1.5, _monRaw));
}

// Drive mic0 (CH0) and mic1 (CH1) VU bars from the browser-local AnalyserNode.
// Called every ~80ms from tickVU() — replaces the server VU pipeline for local mics,
// cutting latency from ~200ms to <5ms. All other channels still use server RMS.
function _tickLocalMicVU() {
    const rms = WA.getMicLevel();
    [0, 1].forEach(chId => {
        const ch = S.console?.channels?.[chId];
        if (!ch) return;
        const chOn  = ch.on  === true;
        const chCue = ch.cue === true;
        let level = 0;
        if      (chCue) level = Math.min(1.2, rms * 8);
        else if (chOn)  level = Math.min(1.2, rms * 8);
        // OFF + no CUE → level stays 0 (bar dark)
        const now = Date.now();
        if (level >= (_vuPeak[chId] || 0)) {
            _vuPeak[chId]    = level;
            _vuPeakAge[chId] = now;
        } else if ((now - (_vuPeakAge[chId] || 0)) > VU_HOLD_MS) {
            _vuPeak[chId] = Math.max(level, (_vuPeak[chId] || 0) * (1 - VU_DECAY));
        }
        apply8SegVUArr(chId, _vuPeak[chId] || level);
        _realLevels[chId] = level;  // mark as having real data so tickVU doesn't zero bars
    });
}

function tickVU() {
    // mic0/mic1 (CH0/CH1) are driven locally by _tickLocalMicVU() — no server round-trip.
    // All other channels: server VU data via applyRealVULevels() every ~100ms.
    _tickLocalMicVU();
    const hasRealData = Object.keys(_realLevels).length > 0;
    if (!hasRealData) {
        // Zero all channel bars (pre-login, no data yet)
        for (let i = 0; i < 8; i++) apply8SegVUArr(i, 0);
        applySmallMeterArr(_pgm1SegsL, 0); applySmallMeterArr(_pgm1SegsR, 0);
        applySmallMeterArr(_pgm2SegsL, 0); applySmallMeterArr(_pgm2SegsR, 0);
        apply8SegVUArr('mon', 0);
    }
    // When real data is present, server updates (applyRealVULevels) handle channels 2–7.
}

function applySegMeterArr(segs, level) {
    const SEGS = 60;
    const lit = Math.round(Math.min(SEGS, level * 50));
    for (let i = 0; i < SEGS; i++) {
        const seg = segs[i];
        if (!seg) continue;
        const cls = i < lit ? (i >= 55 ? 'seg lit-r' : i >= 40 ? 'seg lit-y' : 'seg lit') : 'seg';
        if (seg.className !== cls) seg.className = cls;
    }
}

// 30-segment small meter for PGM 1 / PGM 2 bus VUs
// Scaling: lit = level * 30, so level=1.0 fills the bar completely —
// same reference point as apply8SegVUArr (level=1.0 → 16/16 segs).
function applySmallMeterArr(segs, level) {
    const SEGS = 30;
    const lit = Math.round(Math.min(SEGS, level * 30));
    for (let i = 0; i < SEGS; i++) {
        const seg = segs[i];
        if (!seg) continue;
        const cls = i < lit ? (i >= 27 ? 'seg lit-r' : i >= 20 ? 'seg lit-y' : 'seg lit') : 'seg';
        if (seg.className !== cls) seg.className = cls;
    }
}

function apply8SegVUArr(chId, level) {
    if (!_vuChSegs[chId]) return;
    const SEGS = 16;
    const lit  = Math.round(Math.min(SEGS, level * SEGS));
    for (let col = 0; col < 2; col++) {
        const segs = _vuChSegs[chId][col];
        if (!segs) continue;
        for (let i = 0; i < SEGS; i++) {
            const seg  = segs[i];
            const cls  = i < lit
                ? (i >= 14 ? 'ch-vu-seg lit-r' : i >= 10 ? 'ch-vu-seg lit-y' : 'ch-vu-seg lit-g')
                : 'ch-vu-seg';
            if (seg.className !== cls) seg.className = cls;
        }
    }
}

/* ═══════════════════════════════════════════════════════════════════════════
   STREAM UI
═══════════════════════════════════════════════════════════════════════════ */

function updateStreamUI() {
    const st    = S.stream;
    const btn   = qs('#goLiveBtn');
    const badge = qs('#streamBadge');
    const encSt = qs('#encoderStatus');
    if (!btn || !badge) return;
    if (st.streaming) {
        badge.className = 'badge badge-live'; badge.textContent = '● LIVE';
        btn.className   = 'btn-golive live';   btn.textContent   = '■ STOP BROADCAST';
        if (encSt) encSt.textContent = 'streaming';
    } else if (st.connecting) {
        badge.className = 'badge badge-conn'; badge.textContent = '● CONNECTING';
        btn.className   = 'btn-golive connecting'; btn.textContent = '… CONNECTING';
        if (encSt) encSt.textContent = 'connecting…';
    } else if (st.dropped) {
        // Liquidsoap TCP link dropped — server is auto-reconnecting.
        // Distinct amber badge so DJ knows broadcast is interrupted but recovery is in progress.
        badge.className = 'badge badge-drop'; badge.textContent = '● DROPPED — RECONNECTING';
        btn.className   = 'btn-golive connecting'; btn.textContent = '… RECONNECTING';
        if (encSt) encSt.textContent = 'reconnecting…';
    } else {
        badge.className = 'badge badge-off'; badge.textContent = '● OFFLINE';
        btn.className   = 'btn-golive';       btn.textContent   = '▶ GO LIVE';
        if (encSt) encSt.textContent = st.error ? 'error' : 'idle';
    }
    // NOTE: Do NOT call Monitor.updateStatus() here.
    // PlayerEarphone and Monitor are independent audio paths.
    // Monitor button state is managed exclusively by _updateMonBtn() in bindEvents().
}

/* ═══════════════════════════════════════════════════════════════════════════
   BROADCAST TIMER
═══════════════════════════════════════════════════════════════════════════ */

let _timerMs = 0, _timerRun = false, _timerLast = null, _timerInt = null;

function syncTimer(data) {
    _timerMs  = data.ms  || 0;
    _timerRun = data.running || false;
    if (_timerRun) {
        _timerLast = Date.now();
        if (!_timerInt) _timerInt = setInterval(tickLocalTimer, 500);
    } else { clearInterval(_timerInt); _timerInt = null; }
    renderTimer();
}

function tickLocalTimer() {
    const now = Date.now();
    _timerMs += now - (_timerLast || now);
    _timerLast = now;
    renderTimer();
}

function renderTimer() {
    const total = Math.round(_timerMs / 1000);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const disp = qs('#timerDisplay');
    const btn  = qs('#timerStartStop');
    if (disp) disp.textContent = `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
    if (btn)  { btn.textContent = _timerRun ? '⏸' : '▶'; btn.classList.toggle('running', _timerRun); }
}

/* ═══════════════════════════════════════════════════════════════════════════
   CHANNEL CONFIG MODAL
═══════════════════════════════════════════════════════════════════════════ */

function openChConfig(chId) {
    if (!S.isPrimary()) { showToast('Observer mode — cannot configure channels', 'warn'); return; }
    const ch = S.console?.channels?.[chId];
    if (!ch) return;
    S.cfgModal.chId = chId;
    qs('#chConfigTitle').textContent = `Configure — CH ${chId + 1}`;
    qs('#cfgName').value   = ch.name    || '';
    qs('#cfgType').value   = ch.type    || 'none';
    qs('#cfgLabelA').value = ch.labelA  || 'A';
    qs('#cfgSrcA').value   = ch.sourceA || '';
    qs('#cfgLabelB').value = ch.labelB  || 'B';
    qs('#cfgSrcB').value   = ch.sourceB || '';
    qs('#chConfigModal').classList.remove('hidden');
    qs('#cfgName').focus();
}

function closeChConfig() {
    qs('#chConfigModal').classList.add('hidden');
    S.cfgModal.chId = null;
}

function saveChConfig() {
    const chId = S.cfgModal.chId;
    if (chId === null) return;
    send('console:chConfig', {
        chId,
        name:    qs('#cfgName').value.trim(),
        type:    qs('#cfgType').value,
        labelA:  qs('#cfgLabelA').value.trim(),
        sourceA: qs('#cfgSrcA').value.trim(),
        labelB:  qs('#cfgLabelB').value.trim(),
        sourceB: qs('#cfgSrcB').value.trim(),
    });
    closeChConfig();
}

/* ═══════════════════════════════════════════════════════════════════════════
   LIBRARY STATUS
═══════════════════════════════════════════════════════════════════════════ */

function updateLibStatus(lib) {
    const st = qs('#libStatus');
    if (!st) return;
    if (lib.indexing) {
        st.textContent = lib.count > 0 ? `scanning… ${lib.count.toLocaleString()}` : 'scanning…';
        st.style.color = 'var(--amber2)';
        return;
    }
    if (lib.indexed && lib.count > 0) {
        st.textContent = `${lib.count.toLocaleString()} tracks`;
        st.style.color = 'var(--green2)';
        return;
    }
    if (lib.indexed && lib.count === 0) {
        st.textContent = 'no files found';
        st.style.color = 'var(--amber2)';
        return;
    }
    st.textContent = 'no cache';
    st.style.color = 'var(--text2)';
}

// ── Library Rescan — Singer Magpie pattern ────────────────────────────────────
// POST to start → server returns job_id immediately (no WS, no stuck flags).
// Poll GET every 1s until status === 'done' or 'error'.
// _libScanStatus preserved so tab switches restore the current text.

async function _startLibraryScan() {
    const statusEl = qs('#settingsReindexStatus');
    const btn      = qs('#settingsReindexBtn');

    function _setStatus(text, cls) {
        _libScanStatus = text;
        if (statusEl) { statusEl.textContent = text; statusEl.className = 'settings-reindex-status ' + cls; }
        updateLibStatus({ indexing: cls === 'indexing', indexed: cls === 'done', count: 0 });
    }

    _setStatus('⏳ Starting scan…', 'indexing');
    if (btn) btn.disabled = true;

    let resp;
    try {
        resp = await apiFetch('/api/library/reindex', 'GET');
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    } catch (e) {
        _setStatus(`✗ Could not start scan: ${e.message}`, 'error');
        if (btn) btn.disabled = false;
        return;
    }

    const data = await resp.json();
    if (!data.success) {
        _setStatus(`✗ ${data.error || 'Scan failed to start'}`, 'error');
        if (btn) btn.disabled = false;
        return;
    }

    const jobId = data.job_id;
    _setStatus('⏳ Scanning…', 'indexing');
    cartLoaded = false;

    // Poll every 2 seconds — up to 1 hour (1800 polls).
    // Each poll uses a 8s AbortController timeout so a stalled HTTP request
    // never freezes the UI — it is treated as a network blip and retried.
    for (let i = 0; i < 1800; i++) {
        await new Promise(r => setTimeout(r, 2000));
        let poll;
        try {
            const ctrl = new AbortController();
            const tid  = setTimeout(() => ctrl.abort(), 8000);
            const pr   = await fetch(`/api/library/reindex/status/${jobId}`, { signal: ctrl.signal });
            clearTimeout(tid);
            if (!pr.ok) {
                _libScanStatus = null;
                _setStatus(`✗ Poll error: HTTP ${pr.status} — check pm2 logs`, 'error');
                if (btn) btn.disabled = false;
                return;
            }
            poll = await pr.json();
        } catch (e) {
            if (e.name === 'AbortError') continue;   // timeout — keep polling
            continue;                                 // network blip — keep polling
        }

        if (!poll.success) {
            _libScanStatus = null;
            _setStatus(`✗ ${poll.error || 'Poll failed'}`, 'error');
            if (btn) btn.disabled = false;
            return;
        }

        if (poll.status === 'running') {
            const n = poll.scanned || 0;
            const txt = n === 0 ? '⏳ Scanning directories…' : `⏳ ${n.toLocaleString()} tracks scanned…`;
            _setStatus(txt, 'indexing');
            updateLibStatus({ indexing: true, indexed: false, count: n });

        } else if (poll.status === 'done') {
            const n = poll.scanned || 0;
            _libScanStatus = null;   // clear preserved status — scan complete
            if (statusEl) {
                statusEl.textContent = `✓ Scan complete — ${n.toLocaleString()} tracks indexed`;
                statusEl.className = 'settings-reindex-status done';
            }
            updateLibStatus({ indexed: true, indexing: false, count: n });
            showToast(`✓ Library scan complete — ${n.toLocaleString()} tracks indexed`, 'ok');
            if (btn) btn.disabled = false;
            return;

        } else if (poll.status === 'error') {
            _libScanStatus = null;
            _setStatus(`✗ Scan error: ${poll.error || 'unknown'}`, 'error');
            showToast('Library scan failed — check pm2 logs', 'warn');
            if (btn) btn.disabled = false;
            return;
        }
    }

    // Timeout
    _libScanStatus = null;
    _setStatus('✗ Scan timed out — check pm2 logs', 'error');
    if (btn) btn.disabled = false;
}

/* ═══════════════════════════════════════════════════════════════════════════
   RA — PLAYLIST
═══════════════════════════════════════════════════════════════════════════ */

// Track the last playlist length + ids we rendered — avoid full rebuild on state-only updates
let _plLastIds = '';

function renderPlaylist() {
    const tbody = qs('#playlistBody');
    if (!tbody) return;

    if (!S.playlist.length) {
        tbody.innerHTML = '<tr><td colspan="6" class="pl-empty">Playlist empty — add tracks from the library →</td></tr>';
        _plLastIds = '';
        return;
    }

    // ── Cascade estimated start times for all queued tracks ───────────────────
    // The server provides startTime only for the current/playing track.
    // We cascade forward: startTime[n+1] = startTime[n] + duration[n] - xfSec
    const xf = RA.getXfSec();
    let cascadeTime = null;
    S.playlist.forEach(t => {
        if (t.startTime) {
            // Server-provided: authoritative for the current track
            cascadeTime = t.startTime + (t.duration || 0) - xf;
        } else if (cascadeTime !== null && (t.trackState === 'queued' || t.trackState === 'next' || !t.trackState)) {
            t._estStart = cascadeTime;
            cascadeTime = cascadeTime + (t.duration || 0) - xf;
        } else {
            t._estStart = null;
        }
    });

    // Build a key: list of _id values in order — changes only when tracks added/removed/reordered
    const newIds = S.playlist.map(t => t._id).join(',');
    const structuralChange = newIds !== _plLastIds;
    _plLastIds = newIds;

    const STATE_LABEL = {
        played:  { label: 'PLAYED',  cls: 'ts-played'  },
        playing: { label: 'ON AIR',  cls: 'ts-playing' },
        mixing:  { label: 'MIXING',  cls: 'ts-mixing'  },
        next:    { label: 'NEXT',    cls: 'ts-next'    },
        queued:  { label: '',        cls: 'ts-queued'  },
    };

    if (structuralChange) {
        // Full rebuild: tracks added, removed, or reordered
        tbody.innerHTML = '';
        S.playlist.forEach((t) => {
            const state = t.trackState || (t.isCurrent ? 'playing' : 'queued');
            const tr  = el('tr');
            tr.className   = `trk-state-${state}`;
            tr.dataset.id  = t._id;
            if (t.stop) tr.classList.add('has-stop');
            const s        = STATE_LABEL[state] || STATE_LABEL.queued;
            const startStr = t.startTime
                ? fmtTime(t.startTime)
                : (t._estStart ? '~' + fmtTime(t._estStart) : '');
            tr.innerHTML = `
              <td class="col-num">${t.index + 1}</td>
              <td class="col-state"><span class="trk-state-badge ${s.cls}">${s.label}</span></td>
              <td class="col-track">
                <div class="trk-main">
                  <span class="trk-artist">${escH(t.artist || '–')}</span>
                  <span class="trk-sep"> – </span>
                  <span class="trk-title">${escH(t.title || 'Unknown')}</span>
                </div>
                <div class="trk-meta">
                  ${startStr ? `<span class="trk-start">${startStr}</span>` : ''}
                  ${t.stop ? `<span class="trk-stop-flag">⏹ STOP</span>` : ''}
                </div>
              </td>
              <td class="col-dur">${fmtDur(t.duration)}</td>
              <td class="col-del"><button class="btn-del" title="Remove from playlist">✕</button></td>
              <td class="col-stop"><button class="btn-stop-mark${t.stop ? ' active' : ''}" title="Stop after this track">⏹</button></td>
            `;
            tr.addEventListener('click', (e) => {
                if (e.target.closest('button')) return;
                RA.play(t.index);
            });
            tr.querySelector('.btn-del').addEventListener('click',       () => send('playlist:remove', { index: t.index }));
            tr.querySelector('.btn-stop-mark').addEventListener('click', () => send('playlist:stop',   { index: t.index }));
            tbody.appendChild(tr);
        });
    } else {
        // State-only update (progress tick every 500ms) — just update badges and row classes
        const rows = tbody.querySelectorAll('tr[data-id]');
        rows.forEach((tr, i) => {
            const t     = S.playlist[i];
            if (!t) return;
            const state = t.trackState || (t.isCurrent ? 'playing' : 'queued');
            const s     = STATE_LABEL[state] || STATE_LABEL.queued;
            const wantCls = `trk-state-${state}${t.stop ? ' has-stop' : ''}`;
            if (tr.className !== wantCls) tr.className = wantCls;
            const badge = tr.querySelector('.trk-state-badge');
            if (badge) {
                const wantBadge = s.cls;
                if (badge.className !== `trk-state-badge ${wantBadge}`) badge.className = `trk-state-badge ${wantBadge}`;
                if (badge.textContent !== s.label) badge.textContent = s.label;
            }
        });
    }
}

function renderNowPlaying(track) {
    const panel = qs('#nowPlayingPanel');
    panel.classList.remove('hidden');
    qs('#npTitle').textContent  = track.title  || '–';
    qs('#npArtist').textContent = track.artist || '–';
    const lines = [];
    if (track.album)        lines.push(`Album:   ${track.album}`);
    if (track.albumartist)  lines.push(`AA:      ${track.albumartist}`);
    if (track.tracknumber)  lines.push(`Track:   ${track.tracknumber}${track.tracktotal ? '/' + track.tracktotal : ''}`);
    if (track.date)         lines.push(`Date:    ${track.date}`);
    if (track.genre)        lines.push(`Genre:   ${track.genre}`);
    if (track.lufs)         lines.push(`LUFS:    ${track.lufs}`);
    qs('#npMeta').textContent = lines.join('\n');
}

/* ═══════════════════════════════════════════════════════════════════════════
   RA — LIBRARY SEARCH
═══════════════════════════════════════════════════════════════════════════ */

function doLibSearch() {
    clearTimeout(S.libDebounce);
    S.libDebounce = setTimeout(async () => {
        const q     = qs('#libSearch').value.trim();
        const field = qs('#libField').value;
        // Guard: if library not indexed, show clear message
        if (!q) {
            // empty query — show browse hint or load all
        }
        try {
            const resp = await apiFetch(`/api/library/search?q=${encodeURIComponent(q)}&field=${field}`);
            if (resp.ok) {
                const tracks = await resp.json();
                if (!tracks.length && q) {
                    // Check if library is indexed
                    const stResp = await apiFetch('/api/library/status');
                    if (stResp.ok) {
                        const st = await stResp.json();
                        if (!st.indexed || st.count === 0) {
                            qs('#libResults').innerHTML = '<div class="lib-empty lib-warn">⚠ Library cache not built — go to Settings → Rescan & Rebuild Cache.</div>';
                            return;
                        }
                    }
                }
                renderLibResults(tracks);
            }
        } catch (err) { console.error('Search error', err); }
    }, 250);
}

function renderLibResults(tracks) {
    const box = qs('#libResults');
    const cnt = qs('#libResultCount');
    if (cnt) cnt.textContent = tracks.length ? `${tracks.length} track${tracks.length !== 1 ? 's' : ''}` : '';
    if (!tracks.length) { box.innerHTML = '<div class="lib-empty">No results.</div>'; return; }
    const frag = document.createDocumentFragment();
    tracks.forEach(t => {
        const row     = el('div', { className: 'lib-track' });
        const info    = el('div', { className: 'lib-track-info' });
        info.appendChild(el('div', { className: 'lib-track-title', textContent: t.title || '–' }));
        info.appendChild(el('div', { className: 'lib-track-sub',   textContent: `${t.artist || '–'}${t.album ? ' · ' + t.album : ''}` }));
        const dur  = el('div', { className: 'lib-track-dur', textContent: fmtDur(t.duration) });
        const btns = el('div', { className: 'lib-track-btns' });
        const btnAdd  = el('button', { className: 'btn-add',  textContent: '+ END',  title: 'Add to end of playlist' });
        const btnNext = el('button', { className: 'btn-next', textContent: '↑ NEXT', title: 'Insert after current track' });
        btnAdd.addEventListener('click',  () => {
            if (btnAdd.disabled) return;
            btnAdd.disabled = true;
            setTimeout(() => { btnAdd.disabled = false; }, 800);
            const evt = S.libraryTarget === 'b' ? 'playlistB:add'        : 'playlist:add';
            send(evt, { path: t.path, title: t.title, artist: t.artist, duration: t.duration });
        });
        btnNext.addEventListener('click', () => {
            if (btnNext.disabled) return;
            btnNext.disabled = true;
            setTimeout(() => { btnNext.disabled = false; }, 800);
            const evt = S.libraryTarget === 'b' ? 'playlistB:insertNext' : 'playlist:insertNext';
            send(evt, { path: t.path, title: t.title, artist: t.artist, duration: t.duration });
        });
        btns.appendChild(btnAdd); btns.appendChild(btnNext);
        row.appendChild(info); row.appendChild(dur); row.appendChild(btns);
        frag.appendChild(row);
    });
    box.innerHTML = '';
    box.appendChild(frag);
}

/* ═══════════════════════════════════════════════════════════════════════════
   RA — CART PANELS
═══════════════════════════════════════════════════════════════════════════ */

let cartLoaded     = false;
let _libScanStatus = null;   // preserved across tab switches while scan is in progress

async function loadCartPanels() {
    if (cartLoaded) return;
    try {
        const resp = await apiFetch('/api/library/cart');
        if (!resp.ok) return;
        const cart = await resp.json();
        cartLoaded = true;
        renderCartList('cartSweeper', cart.sweeper || []);
        renderCartList('cartBumper',  cart.bumper  || []);
        renderCartList('cartTrailer', cart.trailer || []);
        renderCartList('cartSFX',     cart.sfx     || []);
    } catch (err) { console.error('Cart load error', err); }
}

function renderCartList(elId, items) {
    const box = qs(`#${elId}`);
    if (!box) return;
    if (!items.length) { box.innerHTML = '<div class="lib-empty">No items.</div>'; return; }
    box.innerHTML = '';
    items.forEach(item => {
        const row  = el('div', { className: 'cart-item' });
        const name = el('div', { className: 'cart-item-name', textContent: item.name });
        const btns = el('div', { className: 'cart-item-btns' });
        const meta = { path: item.path, title: item.name, artist: item.type, duration: 0 };
        const btnA = el('button', { className: 'btn-add',  textContent: '+ END'  });
        const btnN = el('button', { className: 'btn-next', textContent: '↑ NEXT' });
        btnA.addEventListener('click', () => send('playlist:add',        meta));
        btnN.addEventListener('click', () => send('playlist:insertNext', meta));
        btns.appendChild(btnA); btns.appendChild(btnN);
        row.appendChild(name); row.appendChild(btns);
        box.appendChild(row);
    });
}

/* ═══════════════════════════════════════════════════════════════════════════
   SETTINGS TAB
═══════════════════════════════════════════════════════════════════════════ */

function updateMetaBar(track) {
    const bar = qs('#metaBar');
    if (!bar) return;
    if (!track) { bar.classList.add('hidden'); return; }

    const set = (id, val) => { const e = qs(id); if (e) e.textContent = val || '–'; };

    set('#mbStart',    fmtTime(track.startTime));
    set('#mbTitle',    track.title    || '–');
    set('#mbArtist',   track.artist   || '–');
    set('#mbAlbum',    track.album    || '–');
    set('#mbYear',     track.date     || track.year || '–');
    set('#mbOrigDate', track.originaldate || '–');
    set('#mbGenre',    track.genre    || '–');
    set('#mbDur',      fmtDur(track.duration));

    bar.classList.remove('hidden');
}

// ── RT progress row — mirrors RA progress, shown on the RT tab ───────────────
// Driven by the same RA state that the RA tab uses; always visible on RT when playing.
function updateRTProgress(position, duration, playing, paused, stopped, track) {
    const row    = qs('#rtProgressRow');
    if (!row) return;

    if (stopped || !track) { row.classList.add('hidden'); return; }
    row.classList.remove('hidden');

    // ON AIR label
    const label = qs('#rtOnAirLabel');
    if (label) {
        if (paused)       { label.textContent = 'PAUSED';  label.style.color = 'var(--amber2)'; }
        else if (playing) { label.textContent = 'ON AIR';  label.style.color = 'var(--red2, #f87171)'; }
        else              { label.textContent = 'STOPPED'; label.style.color = 'var(--text3)'; }
    }

    // Title / artist
    const titleEl  = qs('#rtNowTitle');
    const artistEl = qs('#rtNowArtist');
    if (titleEl)  titleEl.textContent  = track.title  || '–';
    if (artistEl) artistEl.textContent = track.artist || '';

    // Progress bar
    const pct  = duration > 0 ? position / duration : 0;
    const fill = qs('#rtProgressFill');
    const head = qs('#rtProgressHead');
    if (fill) fill.style.width = (pct * 100).toFixed(2) + '%';
    if (head) head.style.left  = (pct * 100).toFixed(2) + '%';

    // Times
    const el = qs('#rtTimeElapsed');
    const re = qs('#rtTimeRemain');
    const fmt = (s) => { if (!isFinite(s) || s < 0) return '0:00'; return Math.floor(s/60) + ':' + String(Math.floor(s%60)).padStart(2,'0'); };
    if (el) el.textContent = fmt(position);
    if (re) re.textContent = '-' + fmt(Math.max(0, duration - position));
}

/* ═══════════════════════════════════════════════════════════════════════════
   RA PLAYER ENGINE — RadioBOSS-style autonomous playlist player
   ─────────────────────────────────────────────────────────────────────────
   Philosophy (from RadioBOSS manual):
     • Click a track → starts playing immediately
     • Track ends → next track starts automatically with crossfade
     • Stop marker on a track → playback pauses after that track
     • Transport: Prev | Play/Pause | Stop | Next | Stop-After-Current (⏹|)
     • Crossfade: configurable seconds (default 2s)
     • RA is independent of RT mixer — RT controls channel levels, not play
═══════════════════════════════════════════════════════════════════════════ */

const RA = (() => {
    // ── State (mirrors server ra:state) ──────────────────────────────────────
    let _playing  = false;
    let _paused   = false;
    let _stopped  = true;
    let _idx      = -1;
    let _position = 0;
    let _duration = 0;
    let _xfSec    = 2;
    let _break    = false;

    // ── Smooth interpolation between 500ms server ticks ──────────────────────
    // When a progress update arrives from the server, we record the position
    // and the local high-resolution timestamp. Between server ticks, requestAnimationFrame
    // advances the displayed position smoothly using elapsed local time.
    // This eliminates the visible 500ms "jump" and keeps the timer in sync
    // with the audio (which also plays continuously, not in 500ms steps).
    let _syncPos  = 0;       // server-confirmed position at _syncAt
    let _syncAt   = 0;       // performance.now() when server position was received
    let _rafId    = null;

    function _getInterpolated() {
        if (!_playing || _paused || _stopped) return _position;
        const elapsed = (performance.now() - _syncAt) / 1000;
        return Math.min(_duration, _syncPos + elapsed);
    }

    function _startRaf() {
        if (_rafId) return;
        function _frame() {
            if (!_playing || _paused || _stopped) { _rafId = null; return; }
            _position = _getInterpolated();
            _updateProgressBar();
            _rafId = requestAnimationFrame(_frame);
        }
        _rafId = requestAnimationFrame(_frame);
    }

    function _stopRaf() {
        if (_rafId) { cancelAnimationFrame(_rafId); _rafId = null; }
    }

    // ── Receive server state ─────────────────────────────────────────────────
    function applyState(st) {
        if (!st) return;
        _playing  = !!st.playing;
        _paused   = !!st.paused;
        _stopped  = !!st.stopped;
        _idx      = st.idx ?? -1;
        _duration = st.duration || 0;
        if (st.playing) {
            // Correct position for WS one-way latency using measured clock offset.
            // _clockOffset = VPS_clock - PC_clock. True WS latency (ms) =
            //   (PC Date.now()) - (serverNow + _clockOffset)
            //   = (Date.now() - _clockOffset) - serverNow
            const wsLatency = st.serverNow
                ? Math.max(0, (Date.now() - _clockOffset) - st.serverNow) / 1000
                : 0;
            _position = (st.position || 0) + wsLatency;
            _syncPos  = _position;
            _syncAt   = performance.now();
            _startRaf();
        } else {
            _stopRaf();
            _position = st.position || 0;
        }
        _updateUI();
    }

    function applyProgress(st) {
        if (!st) return;
        _duration = st.duration || 0;

        // Correct for WS one-way latency using measured VPS↔PC clock offset.
        // _clockOffset = VPS_clock - PC_clock (ms). One-way WS latency =
        //   (PC now) - (serverNow + _clockOffset) = (Date.now() - _clockOffset) - serverNow
        const wsLatency = st.serverNow
            ? Math.max(0, (Date.now() - _clockOffset) - st.serverNow) / 1000
            : 0;

        // Subtract audio pipeline delay: the worklet ring buffer holds N ms of audio
        // ahead of the speaker. The position the server reports is what was MIXED now;
        // the DJ hears it _audioDelaySec later. Subtract so timer = what is heard NOW.
        const audioDelay = PlayerEarphone.getAudioDelaySec();
        const corrected  = Math.max(0, (st.position || 0) + wsLatency - audioDelay);

        _syncPos  = corrected;
        _syncAt   = performance.now();
        _position = corrected;

        if (_playing && !_paused && !_stopped) {
            _startRaf();
        } else {
            _updateProgressBar();
        }
    }

    // ── Transport commands → server ──────────────────────────────────────────
    function play(idx) {
        if (idx === undefined) idx = _idx >= 0 ? _idx : 0;
        send('ra:play', { index: idx });
    }
    function pause()  { send('ra:pause',  {}); }
    function stop()   { send('ra:stop',   {}); }
    function prev()   { send('ra:prev',   {}); }
    function next()   { send('ra:next',   {}); }
    function toggleBreak() {
        _break = !_break;
        send('ra:breakAfter', { active: _break });
    }
    function setCrossfade(sec) {
        _xfSec = Math.max(0, parseFloat(sec) || 0);
        send('ra:xfade', { sec: _xfSec });
    }

    // ── Progress bar ─────────────────────────────────────────────────────────
    function _updateProgressBar() {
        const pct  = (_duration > 0) ? _position / _duration : 0;
        const fill = qs('#raProgressFill');
        const head = qs('#raProgressHead');
        const el   = qs('#raTimeElapsed');
        const re   = qs('#raTimeRemain');
        if (fill) fill.style.width = (pct * 100).toFixed(2) + '%';
        if (head) head.style.left  = (pct * 100).toFixed(2) + '%';
        if (el)   el.textContent   = _fmtSec(_position);
        if (re)   re.textContent   = '-' + _fmtSec(Math.max(0, _duration - _position));
        // RT tab: mirror same progress
        const track = S.playlist?.[_idx] || null;
        updateRTProgress(_position, _duration, _playing, _paused, _stopped, track);
    }

    function _fmtSec(s) {
        if (!isFinite(s) || s < 0) return '0:00';
        const m = Math.floor(s / 60);
        return m + ':' + String(Math.floor(s % 60)).padStart(2, '0');
    }

    // ── Transport UI ─────────────────────────────────────────────────────────
    function _updateUI() {
        if (_stopped || _paused) _stopRaf();
        else if (_playing)       _startRaf();
        const playBtn  = qs('#raBtnPlay');
        const breakBtn = qs('#raBtnBreak');
        if (!playBtn) return;

        if (_stopped) {
            playBtn.textContent = '▶'; playBtn.title = 'Play';
            playBtn.classList.remove('is-paused');
        } else if (_paused) {
            playBtn.textContent = '▶'; playBtn.title = 'Resume';
            playBtn.classList.add('is-paused');
        } else {
            playBtn.textContent = '⏸'; playBtn.title = 'Pause';
            playBtn.classList.remove('is-paused');
        }

        if (breakBtn) {
            breakBtn.classList.toggle('active', _break);
            breakBtn.title = _break ? 'Stop after current (ON)' : 'Stop after current';
        }

        // Playlist row highlight
        document.querySelectorAll('#playlistBody tr').forEach((r, i) => {
            r.classList.toggle('current', i === _idx && !_stopped);
        });

        // On Air label
        const tracks   = S.playlist;
        const track    = tracks?.[_idx];
        const titleEl  = qs('#raNowTitle');
        const artistEl = qs('#raNowArtist');
        const label    = qs('.ra-now-label');
        if (titleEl)  titleEl.textContent  = track?.title  || '–';
        if (artistEl) artistEl.textContent = track?.artist || '';
        if (label) {
            label.textContent = _stopped ? 'STOPPED' : _paused ? 'PAUSED' : 'ON AIR';
            label.style.color = _stopped ? 'var(--text3)' : _paused ? 'var(--amber2)' : 'var(--red2, #f87171)';
        }

        _updateProgressBar();
        // RT tab: sync immediately on state change
        const _rtTrack = S.playlist?.[_idx] || null;
        updateRTProgress(_position, _duration, _playing, _paused, _stopped, _rtTrack);
    }

    // Seek by clicking progress bar
    function initSeek() {
        const bar = qs('#raProgressBar');
        if (!bar) return;
        bar.addEventListener('click', (e) => {
            if (_stopped || _duration <= 0) return;
            const rect = bar.getBoundingClientRect();
            const pct  = (e.clientX - rect.left) / rect.width;
            // Seeking not yet supported server-side — show toast
            showToast('Seek not available in server-side mode', 'warn');
        });
    }

    function onPlaylistUpdated() { _updateUI(); }
    function getXfSec() { return _xfSec; }

    return { play, pause, stop, prev, next, toggleBreak, setCrossfade,
             onPlaylistUpdated, initSeek, applyState, applyProgress,
             updateUI: _updateUI, getXfSec };
})();

// ── Player 2 remote control — mirrors RA, same FLAC library ─────────────────
const RB = (() => {
    let _playing = false, _paused = false, _stopped = true;
    let _idx = -1, _position = 0, _duration = 0, _xfSec = 2, _break = false;

    function applyState(st) {
        if (!st) return;
        _playing = !!st.playing; _paused = !!st.paused; _stopped = !!st.stopped;
        _idx = st.idx ?? -1; _duration = st.duration || 0;
        if (st.playing) _position = st.position || 0;
        _updateUI();
    }
    function applyProgress(st) {
        if (!st) return;
        _position = st.position || 0; _duration = st.duration || 0;
        _updateProgressBar();
    }

    function play(idx)  { if (idx === undefined) idx = _idx >= 0 ? _idx : 0; send('rb:play', { index: idx }); }
    function pause()    { send('rb:pause', {}); }
    function stop()     { send('rb:stop', {}); }
    function prev()     { send('rb:prev', {}); }
    function next()     { send('rb:next', {}); }
    function toggleBreak() { _break = !_break; send('rb:breakAfter', { active: _break }); }
    function setCrossfade(sec) { _xfSec = Math.max(0, parseFloat(sec) || 0); send('rb:xfade', { sec: _xfSec }); }

    function _updateProgressBar() {
        const pct  = _duration > 0 ? _position / _duration : 0;
        const fill = qs('#rbProgressFill'); const head = qs('#rbProgressHead');
        const el   = qs('#rbTimeElapsed');  const re   = qs('#rbTimeRemain');
        if (fill) fill.style.width = (pct * 100).toFixed(2) + '%';
        if (head) head.style.left  = (pct * 100).toFixed(2) + '%';
        if (el)   el.textContent   = _fmtSec(_position);
        if (re)   re.textContent   = '-' + _fmtSec(Math.max(0, _duration - _position));
    }
    function _fmtSec(s) {
        if (!isFinite(s) || s < 0) return '0:00';
        return Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0');
    }
    function _updateUI() {
        const playBtn = qs('#rbBtnPlay');
        if (!playBtn) return;
        if (_stopped)      { playBtn.textContent = '▶'; playBtn.classList.remove('is-paused'); }
        else if (_paused)  { playBtn.textContent = '▶'; playBtn.classList.add('is-paused');    }
        else               { playBtn.textContent = '⏸'; playBtn.classList.remove('is-paused'); }
        document.querySelectorAll('#playlistBBody tr').forEach((r, i) => {
            r.classList.toggle('current', i === _idx && !_stopped);
        });
        const track    = S.playlistB?.[_idx];
        const titleEl  = qs('#rbNowTitle');  const artistEl = qs('#rbNowArtist');
        const label    = qs('.rb-now-label');
        if (titleEl)  titleEl.textContent  = track?.title  || '–';
        if (artistEl) artistEl.textContent = track?.artist || '';
        if (label) {
            label.textContent = _stopped ? 'STOPPED' : _paused ? 'PAUSED' : 'ON AIR';
            label.style.color = _stopped ? 'var(--text3)' : _paused ? 'var(--amber2)' : 'var(--red2,#f87171)';
        }
        _updateProgressBar();
    }
    function initSeek() {
        const bar = qs('#rbProgressBar');
        if (bar) bar.addEventListener('click', () => showToast('Seek not available in server-side mode', 'warn'));
    }
    function onPlaylistUpdated() { _updateUI(); renderPlaylistB(); }
    return { play, pause, stop, prev, next, toggleBreak, setCrossfade,
             onPlaylistUpdated, initSeek, applyState, applyProgress, updateUI: _updateUI };
})();

// ── Guest panel renderer ──────────────────────────────────────────────────────
function renderGuestPanel() {
    const panel = qs('#guestPanel');
    if (!panel) return;
    const guests  = S.guests || [];
    const callUrl = `${location.origin}/call`;

    // Always show the call URL with copy button at the top
    const urlRow = `<div class="guest-url-row">
      <span class="guest-url-label">Guest call URL:</span>
      <a class="guest-url-link" href="${callUrl}" target="_blank">${callUrl}</a>
      <button class="btn-copy-url" title="Copy URL to clipboard">⎘ Copy</button>
    </div>`;

    if (!guests.length) {
        panel.innerHTML = urlRow +
            '<div class="guest-empty">No callers connected — send the URL above to your guest</div>';
    } else {
        panel.innerHTML = urlRow + guests.map(g => `
            <div class="guest-row">
              <span class="guest-ch">CH${(g.slot ?? 0) + 7}</span>
              <span class="guest-name">${escH(g.name)}</span>
              <button class="btn-kick" data-id="${escH(g.id)}">✕ Disconnect</button>
            </div>`).join('');
        panel.querySelectorAll('.btn-kick').forEach(btn => {
            btn.addEventListener('click', () => send('guest:kick', { guestId: btn.dataset.id }));
        });
    }

    // Copy URL button
    const copyBtn = panel.querySelector('.btn-copy-url');
    if (copyBtn) {
        copyBtn.addEventListener('click', () => {
            navigator.clipboard.writeText(callUrl).then(() => {
                copyBtn.textContent = '✓ Copied';
                setTimeout(() => { copyBtn.textContent = '⎘ Copy'; }, 2000);
            }).catch(() => {
                // Fallback: select the link text
                const a = panel.querySelector('.guest-url-link');
                if (a) { const r = document.createRange(); r.selectNode(a); window.getSelection().removeAllRanges(); window.getSelection().addRange(r); }
            });
        });
    }
}

// ── Player 2 playlist renderer ────────────────────────────────────────────────
function renderPlaylistB() {
    const tbody = qs('#playlistBBody');
    if (!tbody) return;
    const tracks = S.playlistB || [];
    if (!tracks.length) {
        tbody.innerHTML = '<tr><td colspan="6" class="pl-empty">Player 2 playlist empty — add tracks from the library →</td></tr>';
        return;
    }

    const STATE_LABEL = {
        played:  { label: 'PLAYED',  cls: 'ts-played'  },
        playing: { label: 'ON AIR',  cls: 'ts-playing' },
        mixing:  { label: 'MIXING',  cls: 'ts-mixing'  },
        next:    { label: 'NEXT',    cls: 'ts-next'    },
        queued:  { label: '',        cls: 'ts-queued'  },
    };

    tbody.innerHTML = '';
    tracks.forEach(t => {
        const state = t.trackState || (t.isCurrent ? 'playing' : 'queued');
        const tr    = el('tr');
        tr.className  = `trk-state-${state}`;
        tr.dataset.id = String(t.index);
        if (t.stop) tr.classList.add('has-stop');
        const s        = STATE_LABEL[state] || STATE_LABEL.queued;
        const startStr = t.startTime
            ? fmtTime(t.startTime)
            : (t._estStart ? '~' + fmtTime(t._estStart) : '');
        tr.innerHTML = `
          <td class="col-num">${t.index + 1}</td>
          <td class="col-state"><span class="trk-state-badge ${s.cls}">${s.label}</span></td>
          <td class="col-track">
            <div class="trk-main">
              <span class="trk-artist">${escH(t.artist || '–')}</span>
              <span class="trk-sep"> – </span>
              <span class="trk-title">${escH(t.title || 'Unknown')}</span>
            </div>
            <div class="trk-meta">
              ${startStr ? `<span class="trk-start">${startStr}</span>` : ''}
              ${t.stop ? `<span class="trk-stop-flag">⏹ STOP</span>` : ''}
            </div>
          </td>
          <td class="col-dur">${fmtDur(t.duration)}</td>
          <td class="col-del"><button class="btn-del" title="Remove from playlist">✕</button></td>
          <td class="col-stop"><button class="btn-stop-mark${t.stop ? ' active' : ''}" title="Stop after this track">⏹</button></td>
        `;
        tr.addEventListener('click', (e) => {
            if (e.target.closest('button')) return;
            RB.play(t.index);
            // Show track metadata panel — fetch full track data from library
            const trackData = S.playlistB[t.index];
            if (trackData?.path) {
                apiFetch(`/api/library/track?path=${encodeURIComponent(trackData.path)}`)
                    .then(r => r.ok ? r.json() : null)
                    .then(d => { if (d) populateTrackMetaB(d); else populateTrackMetaB(trackData); })
                    .catch(() => populateTrackMetaB(trackData));
            } else {
                populateTrackMetaB(trackData);
            }
        });
        tr.querySelector('.btn-del').addEventListener('click',       () => send('playlistB:remove', { index: t.index }));
        tr.querySelector('.btn-stop-mark').addEventListener('click', () => send('playlistB:stop',   { index: t.index }));
        tbody.appendChild(tr);
    });
}



// Backwards compat stubs (used by nowPlaying handler — now just update display)
function raPlayerSyncToMixer() {
    // Server-side playback: no browser audio elements. Gain is server-controlled.
}


function populateTrackMeta(track) {
    const panel = qs('#trackMetaPanel');
    if (!panel) return;
    if (!track) { panel.classList.add('hidden'); return; }

    const set = (id, val) => {
        const e = qs(id); if (e) e.textContent = (val !== null && val !== undefined && val !== '') ? val : '–';
    };

    set('#tmpTrackTitle', track.title || '–');
    const badge = qs('#tmpStatus');
    if (badge) { badge.textContent = track.status || ''; badge.style.display = track.status ? '' : 'none'; }

    set('#tmpTitle',       track.title);
    set('#tmpArtist',      track.artist);
    set('#tmpAlbumArtist', track.albumartist);
    set('#tmpAlbum',       track.album);
    set('#tmpGenre',       track.genre);

    const trk = track.tracknumber != null ? (track.tracktotal  ? `${track.tracknumber} / ${track.tracktotal}`  : `${track.tracknumber}`) : '–';
    const dsc = track.discnumber  != null ? (track.disctotal   ? `${track.discnumber} / ${track.disctotal}`    : `${track.discnumber}`)  : '–';
    set('#tmpTrackNum',  trk);
    set('#tmpDiscNum',   dsc);
    set('#tmpDate',      track.date);
    set('#tmpOrigDate',  track.originaldate);
    set('#tmpDuration',  fmtDur(track.duration));
    set('#tmpLufs',      track.lufs ? `${track.lufs} LUFS` : null);

    set('#tmpAlbumId',   track.albumid);
    set('#tmpTrackId',   track.trackid);
    set('#tmpArtistId',  track.artistid);
    set('#tmpGpStatus',  track.status);

    panel.classList.remove('hidden');
}

// Player 2 track metadata panel — identical structure to Player 1
function populateTrackMetaB(track) {
    const panel = qs('#trackMetaPanelB');
    if (!panel) return;
    if (!track) { panel.classList.add('hidden'); return; }

    const set = (id, val) => {
        const e = qs(id); if (e) e.textContent = (val !== null && val !== undefined && val !== '') ? val : '–';
    };

    set('#tmpBTrackTitle', track.title || '–');
    const badge = qs('#tmpBStatus');
    if (badge) { badge.textContent = track.status || ''; badge.style.display = track.status ? '' : 'none'; }

    set('#tmpBTitle',       track.title);
    set('#tmpBArtist',      track.artist);
    set('#tmpBAlbumArtist', track.albumartist);
    set('#tmpBAlbum',       track.album);
    set('#tmpBGenre',       track.genre);

    const trk = track.tracknumber != null ? (track.tracktotal  ? `${track.tracknumber} / ${track.tracktotal}`  : `${track.tracknumber}`) : '–';
    const dsc = track.discnumber  != null ? (track.disctotal   ? `${track.discnumber} / ${track.disctotal}`    : `${track.discnumber}`)  : '–';
    set('#tmpBTrackNum',  trk);
    set('#tmpBDiscNum',   dsc);
    set('#tmpBDate',      track.date);
    set('#tmpBOrigDate',  track.originaldate);
    set('#tmpBDuration',  fmtDur(track.duration));
    set('#tmpBLufs',      track.lufs ? `${track.lufs} LUFS` : null);

    set('#tmpBAlbumId',   track.albumid);
    set('#tmpBTrackId',   track.trackid);
    set('#tmpBArtistId',  track.artistid);
    set('#tmpBGpStatus',  track.status);

    panel.classList.remove('hidden');
}

function checkLibraryOnRAOpen() {
    let _pollTimer = null;

    function _poll() {
        apiFetch('/api/library/status').then(async r => {
            if (!r.ok) return;
            const st  = await r.json();
            const res = qs('#libResults');
            if (!res) { clearTimeout(_pollTimer); return; }

            if (st.indexing) {
                // Actively indexing — show message and keep polling until done
                res.innerHTML = '<div class="lib-empty lib-warn">⏳ Library rescan in progress — please wait.</div>';
                _pollTimer = setTimeout(_poll, 2000);
            } else if (!st.indexed || st.count === 0) {
                // Never indexed or empty — silent, no message, just leave results blank
                clearTimeout(_pollTimer);
            } else {
                // Ready — populate normally, no message needed
                clearTimeout(_pollTimer);
                updateLibStatus(st);
                const searchInput = qs('#libSearch');
                if (searchInput) searchInput.dispatchEvent(new Event('input'));
            }
        }).catch(() => { _pollTimer = setTimeout(_poll, 3000); });
    }

    _poll();
}

// ── Mic Delay Compensation helpers ───────────────────────────────────────────
// JITTER_BUF_MS: must match PlayerEarphone JITTER_BUF constant (700ms).
// Auto-detect formula: delay = RTT/2 + JITTER_BUF_MS
// This is what the DJ's ears experience before hearing PGM1.
const MIC_DELAY_JITTER_MS = 700;

function _calcAutoDelayMs() {
    if (_lastMicLatResult) return _lastMicLatResult.totalMs;  // prefer measured value
    if (_lastRttMs <= 0)   return null;
    return Math.round(_lastRttMs / 2 + MIC_DELAY_JITTER_MS);  // crude fallback until first probe
}

// Update the Settings clock status row with the live WS-measured clock offset.
// Only sets text if the row is blank (doesn't overwrite the HTTP NTP check result).
function _updateClockOffsetDisplay() {
    const el = qs('#settingsClockStatus');
    if (!el) return;
    if (_lastRttMs > 0) {
        const sign = _clockOffset >= 0 ? '+' : '';
        const skewAbs = Math.abs(_clockOffset);
        // Don't overwrite an HTTP NTP check result (those show ✓ / ⚠ / ✗)
        if (el.textContent && /[✓⚠✗]/.test(el.textContent)) return;
        el.textContent = `WS offset ${sign}${Math.round(_clockOffset)}ms  (RTT ${Math.round(_lastRttMs)}ms)`;
        el.className   = skewAbs < 200 ? 'settings-reindex-status done'
                       : skewAbs < 2000 ? 'settings-reindex-status indexing'
                       : 'settings-reindex-status error';
    }
}

// ── Continuous latency tracking helpers ──────────────────────────────────────

function _locMicIsOn() {
    return (S.console?.channels?.[0]?.on === true) ||
           (S.console?.channels?.[1]?.on === true);
}

// Start the 10-second RTT-refresh interval. Idempotent.
function _startMicLatTracking() {
    if (_micTrackTimer) return;
    _micTrackTimer  = setInterval(() => {
        if (!_locMicIsOn()) { _stopMicLatTracking(); return; }
        // Single clock ping — after pong, _applyDynamicMicDelay() fires via _onClockPong
        _sendClockPing();
    }, 10000);
    console.log('[lat] Continuous tracking started');
}

// Stop the interval. Idempotent.
function _stopMicLatTracking() {
    if (!_micTrackTimer) return;
    clearInterval(_micTrackTimer);
    _micTrackTimer  = null;
    _micLatEWMA     = null;
    console.log('[lat] Continuous tracking stopped');
}

// Called from _onClockPong whenever _lastRttMs is freshly updated.
// Only acts when tracking is active and a Loc Mic channel is ON.
// Applies an in-place delay correction if drift > 25ms, rate-limited to 30s.
function _applyDynamicMicDelay() {
    if (!_micTrackTimer || !_locMicIsOn()) return;
    if (!PlayerEarphone.isActive()) return;

    const earMs = Math.round(PlayerEarphone.getAudioDelaySec() * 1000);
    const micMs = _lastRttMs > 0
        ? Math.round(_lastRttMs / 2)
        : (_lastMicLatResult?.micMs || 0);
    const rawMs = earMs + micMs;

    // EWMA smoothing: α=0.3 — dampens short-lived RTT spikes
    _micLatEWMA = (_micLatEWMA === null)
        ? rawMs
        : Math.round(_micLatEWMA * 0.7 + rawMs * 0.3);

    // Threshold: only correct if drift > 25ms
    const currentMs = parseInt(document.getElementById('micDelaySlider')?.value) || 0;
    if (Math.abs(_micLatEWMA - currentMs) < 25) return;

    // Rate-limit: at most one adjustment per 30 seconds
    if (Date.now() - _micTrackLastMs < 30000) return;
    _micTrackLastMs = Date.now();

    // Send with adjust=true → server calls adjustMicDelayMs (in-place, no silence)
    fetch('/api/mic-delay', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ ms: _micLatEWMA, adjust: true }),
    }).catch(() => {});
    const _sl = document.getElementById('micDelaySlider');
    const _dp = document.getElementById('micDelayDisplay');
    if (_sl) _sl.value = _micLatEWMA;
    if (_dp) _dp.textContent = _micLatEWMA + 'ms';
    _lastMicLatResult = { micMs, earMs, totalMs: _micLatEWMA };
    _updateMicDelayAutoHint();
    console.log(`[lat] Dynamic correction: ear=${earMs}ms mic=${micMs}ms smooth=${_micLatEWMA}ms (was ${currentMs}ms)`);
}

function _updateMicDelayAutoHint() {
    const hintEl  = document.getElementById('micDelayAutoHint');
    const autoBtn = document.getElementById('micDelayAutoBtn');
    if (!hintEl) return;
    if (_lastMicLatResult) {
        const { micMs, earMs, totalMs } = _lastMicLatResult;
        hintEl.textContent = `Measured ✓  mic ${micMs}ms + ear ${earMs}ms = ${totalMs}ms`;
        if (autoBtn) { autoBtn.disabled = false; autoBtn.textContent = '↺ Measure Again'; }
    } else {
        const suggested = _lastRttMs > 0
            ? Math.round(_lastRttMs / 2 + MIC_DELAY_JITTER_MS) : null;
        if (suggested === null) {
            hintEl.textContent = 'Not yet measured — click Measure or start earphone';
            if (autoBtn) { autoBtn.disabled = false; autoBtn.textContent = '⟳ Measure Now'; }
        } else {
            hintEl.textContent = `Estimated: RTT ${_lastRttMs}ms/2 + ${MIC_DELAY_JITTER_MS}ms = ${suggested}ms — click Measure for accuracy`;
            if (autoBtn) { autoBtn.disabled = false; autoBtn.textContent = '⟳ Measure Now'; }
        }
    }
}

// ── Bi-directional pilot-tone latency measurement ─────────────────────────
// Triggered when Loc Mic 1/2 ON button is pressed (chId 0 or 1).
// Both directions are measured simultaneously using inaudible 17kHz sine tones:
//   browser → mic worklet injects pilot → server Goertzel detects (mic latency)
//   server  → injects pilot into outMix1 → browser AnalyserNode detects (ear latency)
// VPS wall clock is used as single reference via _clockOffset correction.
function startLatencyMeasure(chId) {
    if (!S.ws || S.ws.readyState !== WebSocket.OPEN) return;
    if (!PlayerEarphone.isActive()) {
        showToast('Start earphone first to measure latency', 'warn');
        return;
    }
    const sent = WA.injectMicBurst();
    if (!sent) {
        showToast('Mic not active — press ON first, then mic will be measured', 'warn');
        return;
    }
    // t_mic_inject_vps: browser time corrected to VPS clock domain
    const t_mic_inject_vps = Date.now() + _clockOffset;
    send('lat:start', { chId, t_mic_inject_vps });
    console.log(`[lat] Measurement started: chId=${chId} t_mic=${t_mic_inject_vps}`);
    showToast('Latency measurement started — keep mic active…', 'ok', 2500);
}

// Send a LAT probe and wait for mic:pong to complete the measurement.
// Can be called manually (Measure button) or automatically (earphone jitter fill).
function measureMicLatency() {
    if (!S.ws || S.ws.readyState !== WebSocket.OPEN) {
        showToast('Not connected — cannot measure mic latency', 'warn');
        return;
    }
    _pendingLatEarMs = Math.round(PlayerEarphone.getAudioDelaySec() * 1000);
    const sent = WA.injectLatencyProbe();
    if (sent) {
        showToast('Latency probe sent — result in ~1s…', 'ok', 2000);
    } else {
        showToast('Mic not active — start earphone first', 'warn');
        _pendingLatEarMs = null;
    }
}

function populateSettingsFields() {
    // Restore live scan status if a rescan is in progress — do not overwrite with stale data
    const stEl = qs('#settingsReindexStatus');
    if (_libScanStatus && stEl) {
        stEl.textContent = _libScanStatus;
        stEl.className = 'settings-reindex-status indexing';
    } else {
        // Show current library status from server
        apiFetch('/api/library/status').then(async r => {
            if (!r.ok) return;
            const st = await r.json();
            if (!stEl) return;
            if (st.indexing) {
                stEl.textContent = _libScanStatus || '⏳ Rescanning…';
                stEl.className = 'settings-reindex-status indexing';
            } else if (st.indexed && st.count > 0) {
                stEl.textContent = `✓ Scan complete — ${st.count.toLocaleString()} tracks indexed`;
                stEl.className = 'settings-reindex-status done';
            } else if (st.indexed && st.count === 0) {
                stEl.textContent = '⚠ No files found — check music path';
                stEl.className = 'settings-reindex-status error';
            } else {
                stEl.textContent = 'No cache — run Rescan & Rebuild Cache';
                stEl.className = 'settings-reindex-status';
            }
        }).catch(() => {});
    }

    // Fill settings inputs with current values from server config
    apiFetch('/api/config').then(async r => {
        if (!r.ok) return;
        const cfg = await r.json();
        if (cfg.paths?.music_library_path) {
            const el_ = qs('#settingsMusicPath');
            if (el_ && !el_.value) el_.value = cfg.paths.music_library_path;
        }
        if (cfg.icecast) {
            const el_s = qs('#settingsIcecastServer');
            const el_p = qs('#settingsIcecastPort');
            const el_m = qs('#settingsIcecastMount');
            if (el_s && !el_s.value) el_s.value = cfg.icecast.server || '';
            if (el_p && !el_p.value) el_p.value = cfg.icecast.port   || '';
            if (el_m && !el_m.value) el_m.value = cfg.icecast.mount  || '';
        }
        if (cfg.azuracast_dj) {
            const dj_s = qs('#settingsDJServer');
            const dj_p = qs('#settingsDJPort');
            const dj_m = qs('#settingsDJMount');
            if (dj_s && !dj_s.value) dj_s.value = cfg.azuracast_dj.server || '';
            if (dj_p && !dj_p.value) dj_p.value = cfg.azuracast_dj.port   || '8005';
            if (dj_m && !dj_m.value) dj_m.value = cfg.azuracast_dj.mount  || '/';
        }
        // Load mic delay compensation value
        const slider  = document.getElementById('micDelaySlider');
        const display = document.getElementById('micDelayDisplay');
        if (slider && cfg.micDelayMs !== undefined) {
            slider.value = cfg.micDelayMs;
            if (display) display.textContent = cfg.micDelayMs + 'ms';
        }
        _updateMicDelayAutoHint();
        _updateClockOffsetDisplay();
    }).catch(() => {});

    // Render channel rows from current console state
    renderSettingsChannels();

    // Guest call URL — use current page origin so it works on any deployment
    const callUrl = `${location.origin}/call`;
    const urlEl   = qs('#guestCallUrl');
    const copyBtn = qs('#guestCallCopy');
    const openBtn = qs('#guestCallOpen');
    if (urlEl)   urlEl.value    = callUrl;
    if (openBtn) openBtn.href   = callUrl;
    if (copyBtn) copyBtn.addEventListener('click', () => {
        navigator.clipboard.writeText(callUrl).then(() => {
            copyBtn.textContent = '✓ Copied!';
            setTimeout(() => { copyBtn.textContent = '📋 Copy Link'; }, 2000);
        }).catch(() => {
            // Fallback for browsers that block clipboard without user gesture context
            urlEl.select();
            document.execCommand('copy');
            copyBtn.textContent = '✓ Copied!';
            setTimeout(() => { copyBtn.textContent = '📋 Copy Link'; }, 2000);
        });
    });
}

function openGoLiveModal() {
    // Pre-fill username from session; load DJ server from config
    const userEl = qs('#goLiveUser');
    const passEl = qs('#goLivePass');
    if (userEl) userEl.value = S.username || '';
    if (passEl) passEl.value = '';

    // Show DJ server address
    apiFetch('/api/config').then(async r => {
        if (!r.ok) return;
        const cfg = await r.json();
        const srv = qs('#goLiveDJServer');
        if (srv) {
            const dj = cfg.azuracast_dj || {};
            const host = dj.server || '?';
            const displayHost = (host === 'localhost' || host === '127.0.0.1') ? 'AzuraCast (local)' : host;
            srv.textContent = `${displayHost}:${dj.port || 8005}${dj.mount || '/'}`;
        }
    }).catch(() => {});

    qs('#goLiveError')?.classList.add('hidden');
    qs('#goLiveModal')?.classList.remove('hidden');
    setTimeout(() => qs('#goLivePass')?.focus(), 100);
}

function renderSettingsChannels() {
    const container = qs('#settingsChRows');
    if (!container) return;
    const channels = S.console?.channels;
    if (!channels) return;
    container.innerHTML = '';
    channels.forEach((ch, i) => {
        const row = document.createElement('div');
        row.className = 'settings-ch-row';
        row.innerHTML = `
            <div class="settings-ch-num">CH ${i + 1}</div>
            <input type="text"
                   class="settings-ch-in"
                   id="settingsCh${i}Name"
                   value="${(ch.name || '').replace(/"/g, '&quot;')}"
                   placeholder="CH ${i + 1} name"
                   maxlength="20">
            <input type="text"
                   class="settings-ch-in"
                   id="settingsCh${i}SrcA"
                   value="${(ch.sourceA || '').replace(/"/g, '&quot;')}"
                   placeholder="e.g. hw:1,0 or default">
        `;
        container.appendChild(row);
    });
}

function bindSettingsEvents() {
    qs('#settingsReindexBtn')?.addEventListener('click', async () => {
        if (!S.isPrimary()) { showToast('Primary DJ only — cannot rescan library', 'warn'); return; }
        await _startLibraryScan();
    });

    qs('#settingsClockCheckBtn')?.addEventListener('click', async () => {
        const statusEl = qs('#settingsClockStatus');
        const detailEl = qs('#settingsClockDetail');
        if (statusEl) { statusEl.textContent = '⏳ Checking…'; statusEl.className = 'settings-reindex-status indexing'; }
        if (detailEl) detailEl.style.display = 'none';

        try {
            const t0 = Date.now();
            const r  = await apiFetch('/api/clock');
            const t2 = Date.now();
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            const d = await r.json();

            const rtt       = t2 - t0;
            const oneWay    = rtt / 2;
            // Estimated clock offset: VPS time vs PC time
            const clockSkew = d.serverNow - (t0 + oneWay);
            const skewAbs   = Math.abs(clockSkew);
            const skewSign  = clockSkew >= 0 ? '+' : '';
            const ntpOk     = d.ntpSync === 'yes';
            const pcNtpOk   = Math.abs(new Date() - new Date()) === 0;  // always true; PC NTP checked via skew

            let verdict, cls;
            if (!ntpOk) {
                verdict = '⚠ VPS NTP not synced — timer drift likely';
                cls = 'settings-reindex-status error';
            } else if (skewAbs < 200) {
                verdict = `✓ Clocks in sync (skew: ${skewSign}${clockSkew.toFixed(0)}ms)`;
                cls = 'settings-reindex-status done';
            } else if (skewAbs < 2000) {
                verdict = `⚠ Minor skew: ${skewSign}${clockSkew.toFixed(0)}ms — acceptable`;
                cls = 'settings-reindex-status indexing';
            } else {
                verdict = `✗ Large skew: ${skewSign}${clockSkew.toFixed(0)}ms — check NTP on both VPS and PC`;
                cls = 'settings-reindex-status error';
            }

            if (statusEl) { statusEl.textContent = verdict; statusEl.className = cls; }
            if (detailEl) {
                detailEl.innerHTML =
                    `VPS time: ${d.isoTime}<br>` +
                    `PC  time: ${new Date().toISOString()}<br>` +
                    `VPS NTP synced: ${d.ntpSync} &nbsp;|&nbsp; NTP enabled: ${d.ntpEnabled}<br>` +
                    `VPS timezone: ${d.timezone}<br>` +
                    `Round-trip: ${rtt}ms &nbsp;|&nbsp; Est. one-way: ${oneWay.toFixed(0)}ms &nbsp;|&nbsp; Clock offset: ${skewSign}${clockSkew.toFixed(0)}ms`;
                detailEl.style.display = 'block';
            }
        } catch (err) {
            if (statusEl) { statusEl.textContent = `✗ Check failed: ${err.message}`; statusEl.className = 'settings-reindex-status error'; }
        }
    });

    qs('#settingsNtpSyncBtn')?.addEventListener('click', async () => {
        if (!S.isPrimary()) { showToast('Primary DJ only', 'warn'); return; }
        const btn      = qs('#settingsNtpSyncBtn');
        const statusEl = qs('#settingsNtpSyncStatus');
        if (btn)      { btn.disabled = true; btn.textContent = '⏳ Syncing…'; }
        if (statusEl) { statusEl.textContent = '⏳ Requesting NTP sync from VPS…'; statusEl.className = 'settings-reindex-status indexing'; statusEl.style.display = ''; }
        try {
            const r = await apiFetch('/api/admin/ntp-sync', { method: 'POST' });
            const d = await r.json();
            if (d.ok) {
                if (statusEl) {
                    statusEl.textContent = `✓ VPS clock synced via ${d.method} — ${d.output || 'ok'}`;
                    statusEl.className   = 'settings-reindex-status done';
                }
                showToast('VPS NTP sync complete — click Check Clock Sync to verify', 'ok', 4000);
                // Auto-refresh the clock check detail panel
                setTimeout(() => qs('#settingsClockCheckBtn')?.click(), 800);
            } else {
                // Show error + the exact sudoers fix command the operator must run
                let msg = `✗ Sync failed: ${d.error}`;
                if (statusEl) { statusEl.textContent = msg; statusEl.className = 'settings-reindex-status error'; }
                // Display the fix command in the detail panel so the operator can copy it
                const detailEl = qs('#settingsClockDetail');
                if (detailEl && d.fix) {
                    detailEl.innerHTML =
                        `<strong>Permission denied</strong> — VPS process user: <code>${d.processUser || '?'}</code><br><br>` +
                        `Run <strong>once</strong> on the VPS as root to grant permission:<br>` +
                        `<code style="user-select:all;display:block;margin-top:4px;padding:4px;background:rgba(0,0,0,.3);border-radius:4px">${d.fix}</code>` +
                        `<br>Then click <em>Sync VPS Clock Now</em> again.`;
                    detailEl.style.display = 'block';
                }
                showToast('VPS NTP sync — permission denied. See Settings for fix.', 'error', 6000);
            }
        } catch (err) {
            if (statusEl) { statusEl.textContent = `✗ Request error: ${err.message}`; statusEl.className = 'settings-reindex-status error'; }
            showToast(`NTP sync error: ${err.message}`, 'error');
        } finally {
            if (btn) { btn.disabled = false; btn.textContent = '⏱ Sync VPS Clock Now'; }
        }
    });

    qs('#settingsMicDiagBtn')?.addEventListener('click', async () => {
        const btn = qs('#settingsMicDiagBtn');
        const out = qs('#settingsMicDiagOut');
        if (!out) return;
        if (btn) btn.textContent = '⏳ Running…';
        out.style.display = 'block';
        out.textContent   = 'Fetching…';
        try {
            const r = await apiFetch('/api/diag/mic');
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            const d = await r.json();

            // Colour-coded summary
            let txt = `=== MIC DIAGNOSTIC — ${new Date().toLocaleTimeString()} ===\n\n`;
            txt += `Primary user : ${d.primaryUser}\n\n`;

            txt += `── Buffer / Gain / RMS ──────────────────\n`;
            ['mic0','mic1','mic2','mic3'].forEach(k => {
                const m = d.mic[k];
                const bufOk  = m.bufBytes > 0;
                const gainOk = m.gain > 0;
                const rmsOk  = m.lastRMS > 0;
                const flag   = (!bufOk && !gainOk) ? ' ← NO DATA' : (!gainOk ? ' ← GAIN=0 (channel OFF?)' : '');
                txt += `${k.padEnd(5)} buf=${String(m.bufBytes).padStart(6)}B  gain=${String(m.gain).padStart(7)}  rms=${String(m.lastRMS).padStart(10)}${flag}\n`;
            });

            txt += `\n── WebSocket mic sessions (MediaRecorder) ──\n`;
            if (d.wsSessions.length === 0) {
                txt += '  (none) — browser has not sent binary mic audio yet\n';
            } else {
                d.wsSessions.forEach(s => {
                    txt += `  ${s.username} → ${s.mixerKey}  decoder=${s.decoderLive ? 'LIVE' : 'DEAD'}  sid=${s.sessionId}\n`;
                });
            }

            txt += `\n── WebRTC DJ mic sessions (mediasoup) ──────\n`;
            if (d.rtcSessions.length === 0) {
                txt += '  (none) — no WebRTC mic pipeline active\n';
            } else {
                d.rtcSessions.forEach(s => {
                    txt += `  ${s.username} → ${s.mixerKey}  id=${s.djMicId}\n`;
                });
            }

            txt += `\n── Hint ─────────────────────────────────────\n  ${d.hint}\n`;
            out.textContent = txt;
        } catch (err) {
            out.textContent = `Error: ${err.message}`;
        } finally {
            if (btn) btn.textContent = '🔍 Run Mic Diagnostic';
        }
    });

    // ── Live Mic Level Monitor ────────────────────────────────────────────────
    // Opens its own getUserMedia stream (independent of WebRTC path) so it
    // works even before WebRTC connects. Shows RMS, dB, peak and a bar graph
    // updating every 100ms so the DJ can verify mic signal while speaking.
    let _micLevelTimer = null;
    let _micLevelStream = null;
    let _micLevelCtx = null;

    function _stopMicLevelMonitor() {
        if (_micLevelTimer) { clearInterval(_micLevelTimer); _micLevelTimer = null; }
        if (_micLevelStream) { _micLevelStream.getTracks().forEach(t => t.stop()); _micLevelStream = null; }
        if (_micLevelCtx) { try { _micLevelCtx.close(); } catch(_) {} _micLevelCtx = null; }
        const panel = qs('#settingsMicLevelPanel');
        if (panel) panel.style.display = 'none';
        const btn = qs('#settingsMicLevelBtn');
        if (btn) btn.textContent = '🎚 Live Mic Level';
    }

    qs('#settingsMicLevelStop')?.addEventListener('click', _stopMicLevelMonitor);

    qs('#settingsMicLevelBtn')?.addEventListener('click', async () => {
        // Toggle off if already running
        if (_micLevelTimer) { _stopMicLevelMonitor(); return; }

        const btn    = qs('#settingsMicLevelBtn');
        const panel  = qs('#settingsMicLevelPanel');
        const elRMS  = qs('#micLevelRMS');
        const elDB   = qs('#micLevelDB');
        const elPeak = qs('#micLevelPeak');
        const elBar  = qs('#micLevelBar');
        const elHint = qs('#micLevelHint');
        const elDev  = qs('#micLevelDevice');
        if (!panel) return;

        if (btn) btn.textContent = '⏳ Requesting mic…';

        try {
            // Reuse the existing Web Audio mic stream if available — opening a new
            // getUserMedia triggers Windows Exclusive Mode and kills the WebRTC stream.
            // Fall back to a new stream only if WA hasn't captured one yet.
            let stream = WA.getMicStream();
            let ownStream = false;
            if (!stream) {
                stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
                ownStream = true;
            }
            _micLevelStream = ownStream ? stream : null; // only stop it if we opened it

            // Show device name
            const track = stream.getAudioTracks()[0];
            if (elDev) elDev.textContent = track?.label || 'unknown device';

            // Build analyser
            const ctx      = new AudioContext();
            _micLevelCtx   = ctx;
            const source   = ctx.createMediaStreamSource(stream);
            const analyser = ctx.createAnalyser();
            analyser.fftSize          = 2048;
            analyser.smoothingTimeConstant = 0.1;
            source.connect(analyser);

            const buf = new Float32Array(analyser.fftSize);
            let peakRMS = 0;
            let silentFrames = 0;

            panel.style.display = 'block';
            if (btn) btn.textContent = '⏹ Stop Monitor';

            _micLevelTimer = setInterval(() => {
                analyser.getFloatTimeDomainData(buf);

                // Compute RMS
                let sum = 0;
                for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
                const rms = Math.sqrt(sum / buf.length);
                if (rms > peakRMS) peakRMS = rms;

                const db  = rms > 0.000001 ? 20 * Math.log10(rms) : -Infinity;
                const pdb = peakRMS > 0.000001 ? 20 * Math.log10(peakRMS) : -Infinity;

                // Bar: map −60dB→0dB to 0%→100%
                const barPct = Math.max(0, Math.min(100, (db + 60) / 60 * 100));
                const barColour = db > -10 ? '#ff4444' : db > -20 ? '#ffaa00' : '#00e676';

                if (elRMS)  elRMS.textContent  = rms.toFixed(6);
                if (elDB)   elDB.textContent   = isFinite(db) ? db.toFixed(1) + ' dB' : '−∞';
                if (elPeak) elPeak.textContent = isFinite(pdb) ? pdb.toFixed(1) + ' dB' : '−∞';
                if (elBar)  { elBar.style.width = barPct + '%'; elBar.style.background = barColour; }

                // Hint
                if (rms < 0.0001) {
                    silentFrames++;
                    if (silentFrames > 10 && elHint)
                        elHint.textContent = '⚠ Signal very weak or silent — check mic jack and speak loudly';
                } else if (rms < 0.01) {
                    silentFrames = 0;
                    if (elHint) elHint.textContent = '⚠ Signal present but very quiet (< −40 dB) — raise PC mic level or boost';
                } else if (rms < 0.1) {
                    silentFrames = 0;
                    if (elHint) elHint.textContent = '✓ Good signal level — mic is working correctly';
                } else {
                    silentFrames = 0;
                    if (elHint) elHint.textContent = '✓ Strong signal — excellent mic level';
                }
            }, 100);

        } catch (err) {
            if (btn) btn.textContent = '🎚 Live Mic Level';
            showToast(`Mic access denied: ${err.message}`, 'error');
        }
    });

    // ── Mic Delay Compensation ────────────────────────────────────────────────
    const micDelaySlider  = document.getElementById('micDelaySlider');
    const micDelayDisplay = document.getElementById('micDelayDisplay');
    const micDelayApply   = document.getElementById('micDelayApply');
    const micDelayAutoBtn = document.getElementById('micDelayAutoBtn');

    if (micDelaySlider && micDelayDisplay) {
        micDelaySlider.addEventListener('input', () => {
            micDelayDisplay.textContent = micDelaySlider.value + 'ms';
        });
    }

    if (micDelayApply) {
        micDelayApply.addEventListener('click', async () => {
            if (!S.isPrimary()) { showToast('Primary DJ only', 'warn'); return; }
            const ms = parseInt(micDelaySlider?.value || 0, 10);
            try {
                const r = await apiFetch('/api/mic-delay', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ms }) });
                if (r.ok) {
                    showToast(`Mic delay set to ${ms}ms — saved`, 'ok');
                } else {
                    showToast('Failed to set mic delay', 'error');
                }
            } catch (e) {
                showToast('Error: ' + e.message, 'error');
            }
        });
    }

    if (micDelayAutoBtn) {
        micDelayAutoBtn.addEventListener('click', () => {
            if (!S.isPrimary()) { showToast('Primary DJ only', 'warn'); return; }
            measureMicLatency();
        });
    }

    qs('#settingsSaveBtn')?.addEventListener('click', () => {
        if (!S.isPrimary()) { showToast('Observer mode — cannot change settings', 'warn'); return; }
        const musicPath       = qs('#settingsMusicPath').value.trim();
        const icecastServer   = qs('#settingsIcecastServer').value.trim();
        const icecastPort     = qs('#settingsIcecastPort').value.trim();
        const icecastMount    = qs('#settingsIcecastMount').value.trim();
        const icecastPassword = qs('#settingsIcecastPassword').value.trim();
        if (!musicPath) { showToast('Music path cannot be empty', 'error'); return; }

        const djServer = qs('#settingsDJServer')?.value.trim();
        const djPort   = qs('#settingsDJPort')?.value.trim();
        const djMount  = qs('#settingsDJMount')?.value.trim();

        // Save main settings + DJ connection
        send('config:save', { musicPath, icecastServer, icecastPort, icecastMount, icecastPassword, djServer, djPort, djMount });

        // Save each channel's name and source address
        const channels = S.console?.channels || [];
        channels.forEach((ch, i) => {
            const nameEl = qs(`#settingsCh${i}Name`);
            const srcEl  = qs(`#settingsCh${i}SrcA`);
            if (!nameEl && !srcEl) return;
            const newName = nameEl?.value.trim() || ch.name;
            const newSrcA = srcEl?.value.trim()  ?? ch.sourceA;
            // Only send if something changed
            if (newName !== ch.name || newSrcA !== ch.sourceA) {
                send('console:chConfig', {
                    chId:    i,
                    name:    newName,
                    sourceA: newSrcA,
                    sourceB: ch.sourceB,
                    labelA:  ch.labelA,
                    labelB:  ch.labelB,
                    type:    ch.type,
                });
            }
        });

        showToast('Settings saved', 'ok');
    });
}

/* ═══════════════════════════════════════════════════════════════════════════
   TABS
═══════════════════════════════════════════════════════════════════════════ */

function initTabs() {
    qsAll('.tab').forEach(tab => {
        tab.addEventListener('click', () => {
            qsAll('.tab').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            const id = tab.dataset.tab;
            qsAll('.tab-panel').forEach(p => {
                p.classList.toggle('active', p.id === `tab-${id}`);
                p.classList.toggle('hidden', p.id !== `tab-${id}`);
            });
            if (id === 'ra') { loadCartPanels(); checkLibraryOnRAOpen(); }
            if (id === 'settings') populateSettingsFields();
            if (id === 'playlist' && !PlaylistBuilder.isLoaded()) PlaylistBuilder.loadTree();
            // When switching BACK to RT, the consoleWrap was display:none and its
            // px height is stale (all flex children had clientHeight=0 while hidden).
            // Re-trigger the resize init so the fader-wrap flex:1 fills correctly.
            if (id === 'rt') {
                const wrap = document.getElementById('consoleWrap');
                if (wrap) {
                    // Force a reflow then snap to the correct height
                    void wrap.offsetHeight;
                    window.dispatchEvent(new Event('resize'));
                }
            }
        });
    });

    qsAll('.sel-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            qsAll('.sel-tab').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            const id = tab.dataset.sel;
            qsAll('.sel-panel').forEach(p => {
                const show = p.id === `selPanel-${id}`;
                p.classList.toggle('active', show);
                p.classList.toggle('hidden', !show);
            });
        });
    });
}

/* ═══════════════════════════════════════════════════════════════════════════
   EVENT BINDING
═══════════════════════════════════════════════════════════════════════════ */


// ═══════════════════════════════════════════════════════════════════════════
// RT WEB AUDIO ENGINE — PGM Bus
// ═══════════════════════════════════════════════════════════════════════════
//
// SIGNAL FLOW:
//
//  Mic (getUserMedia)
//    └──→ _chGains[id] ──┬──→ _pgmBus ──→ _streamDest ──→ MediaRecorder ──→ WebSocket ──→ server
//                        └──→ _ctx.destination  (self-monitor: immediate, gated by fader/ON)
//
//  Server monitor stream (WebSocket WebM/Opus chunks)
//    └──→ Monitor.decodeAudioData() ──→ AudioBufferSourceNode ──→ _ctx.destination
//
// SELF-MONITORING PHILOSOPHY (KISS):
//   The mic self-monitor path goes through _chGains[id] — the same GainNode
//   that controls capture level. CH1 OFF or fader=0 → gain=0 → silence in
//   BOTH the stream AND the earphone. No leak. No separate delay path.
//
//   The mic self-monitor is immediate (0ms delay). The server monitor stream
//   carrying Player 1 arrives ~300ms later. This is the correct design:
//
//   - DJ hears their own voice immediately and naturally (like a hardware console)
//   - DJ hears Player 1 with ~300ms latency (server round-trip)
//   - 300ms offset between mic and track is imperceptible when speaking over music
//   - No artificial delay on mic = no unnatural "hearing yourself late" feeling
//   - This matches how every professional FM studio headphone monitor works
//
//   A DJ speaking over a track does not need sample-accurate mic/track sync.
//   They need: (1) hear their voice clearly, (2) hear the track level, (3) adjust fader.
//   All three work fine with a 300ms monitor stream offset.

const WA = (() => {
    let _ctx          = null;
    let _pgmBus       = null;   // GainNode → _streamDest (MediaRecorder → server)
    let _streamDest   = null;   // MediaStreamDestination → MediaRecorder → WebSocket
    let _recorder     = null;
    let _streaming    = false;
    let _workletNode   = null;
    let _workletSource = null;

    const _chGains    = {};     // channelId → GainNode (post-fader, gated by ON/OFF)
    const _micNodes   = {};     // channelId → MediaStreamSourceNode
    let   _micStream  = null;
    let   _micStreamPromise = null;  // guards concurrent getUserMedia calls
    let   _micAnalyser = null;  // AnalyserNode on raw mic stream — local VU at ~0ms latency

    function _taper(f) {
        if (f <= 0) return 0;
        return Math.pow(f / 100, 2.5) * 3.162;
    }

    function _ensureCtx() {
        if (_ctx) return true;
        try {
            _ctx        = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000, latencyHint: 'interactive' });
            _pgmBus     = _ctx.createGain(); _pgmBus.gain.value = 1;
            _streamDest = _ctx.createMediaStreamDestination();
            _pgmBus.connect(_streamDest);      // PGM → server capture only
            console.log(`[WA] AudioContext created sampleRate=${_ctx.sampleRate}`);
            return true;
        } catch (e) {
            console.error('[WA] AudioContext failed:', e.message);
            return false;
        }
    }

    function syncToConsole() {
        if (!S.console?.channels) return;
        if (!_ensureCtx()) return;
        if (_ctx.state === 'suspended') _ctx.resume();

        S.console.channels.forEach((ch) => {
            const id    = ch.id;
            const onPgm = ch.on && (ch.bus === 'pgm' || !ch.bus);
            const gain  = onPgm ? _taper(ch.fader ?? 80) : 0;

            // Create gain node on first use.
            // mic channel gain node connects ONLY to _pgmBus → _streamDest → server.
            // Local mics (CH1/CH2) MUST NOT connect to _ctx.destination — that is the
            // same physical output as the PlayerEarphone (Mix 1). Connecting mics directly
            // to destination would leak local mic audio into the earphone regardless of
            // the server-side Mix 1 / Mix 2 separation.
            // Self-monitoring of local mics is NOT done here — the DJ hears themselves
            // naturally (room acoustics) or via a dedicated monitor speaker, not earphone.
            if (!_chGains[id]) {
                _chGains[id] = _ctx.createGain();
                _chGains[id].gain.value = 0;
                _chGains[id].connect(_pgmBus);
                // NOTE: No _ctx.destination connection for mic channels.
                // Previous builds had: if (ch.type === 'mic') _chGains[id].connect(_ctx.destination)
                // That caused Local Mic 1/2 to bleed directly into the earphone output.
            }

            _chGains[id].gain.setTargetAtTime(gain, _ctx.currentTime, 0.05);

            if (ch.type === 'mic') {
                // ── Sidetone gating: mute sidetone when ALL mic channels are OFF ─
                // Binary gate: fixed 0.75 when any mic is ON, 0 when all are OFF.
                // Fader position controls broadcast level but NOT sidetone (the MON
                // Mic button is the sidetone on/off — fader shouldn't silence it).
                {
                    const _anyMicOn = S.console.channels.some(
                        c => c.type === 'mic' && c.on);
                    PlayerEarphone.setSidetoneGain(_anyMicOn ? 0.75 : 0);
                }

                if (!_micNodes[id]) {
                    (async () => {
                        try {
                            if (!_micStream) {
                                // Guard against race: multiple mic channels init simultaneously.
                                // Without this, each channel sees _micStream===null and calls
                                // getUserMedia independently, creating multiple streams.
                                if (!_micStreamPromise) {
                                    _micStreamPromise = navigator.mediaDevices.getUserMedia({
                                        audio: {
                                            echoCancellation:   true,
                                            noiseSuppression:   true,
                                            autoGainControl:    true,
                                            channelCount:       1,
                                            sampleRate:         48000,
                                        },
                                        video: false,
                                    });
                                }
                                _micStream = await _micStreamPromise;
                                const track = _micStream.getAudioTracks()[0];
                                if (track) {
                                    const s = track.getSettings();
                                    console.log(`[WA] Mic permission granted — label="${track.label}" muted=${track.muted} echoCancellation=${s.echoCancellation}`);
                                }
                            }
                            if (_micNodes[id]) return;
                            const node = _ctx.createMediaStreamSource(_micStream);
                            _micNodes[id] = node;
                            node.connect(_chGains[id]); // one connection → gain → PGM + destination
                            console.log(`[WA] Mic → CH${id + 1} connected`);
                        } catch (e) {
                            console.warn(`[WA] Mic access denied CH${id + 1}:`, e.message);
                            showToast('Microphone access denied — check browser permissions', 'warn');
                        }
                    })();
                }
                return;
            }
        });
    }

    // Return instantaneous RMS level of the local mic stream (0.0–1.0).
    // Creates the AnalyserNode lazily the first time it is called after getUserMedia
    // resolves. Called every ~80ms from tickVU() — bypasses the server VU pipeline
    // entirely, cutting mic VU latency from ~200ms to <5ms.
    function getMicLevel() {
        if (!_ctx || !_micStream) return 0;
        if (!_micAnalyser) {
            try {
                const src = _ctx.createMediaStreamSource(_micStream);
                _micAnalyser = _ctx.createAnalyser();
                _micAnalyser.fftSize = 256;
                _micAnalyser.smoothingTimeConstant = 0;  // no smoothing — raw RMS per tick
                src.connect(_micAnalyser);
                // Deliberately NOT connected to _ctx.destination — analysis only,
                // no audio playback (that would cause feedback through the earphone).
            } catch (_) { return 0; }
        }
        const buf = new Float32Array(_micAnalyser.frequencyBinCount);
        _micAnalyser.getFloatTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
        return Math.sqrt(sum / buf.length);
    }

    function getCtx()    { return _ctx; }
    function ensureCtx() { _ensureCtx(); return _ctx; }

    function getMicStream() { return _micStream; }

    function startCapture() {
        if (_streaming) return;
        if (!_ensureCtx()) return;
        if (_ctx.state === 'suspended') _ctx.resume();

        const _doStart = async () => {
            if (_streaming) return;
            if (!_micStream || _micStream.getAudioTracks().length === 0) {
                setTimeout(_doStart, 200);
                return;
            }
            try {
                // Load AudioWorklet mic capture processor
                // This is the state-of-the-art approach: raw PCM16 over WebSocket,
                // no Opus encoding, no DTX, no VAD, no echo suppression side effects.
                await _ctx.audioWorklet.addModule('/mic-capture-worklet.js');
                const workletNode = new AudioWorkletNode(_ctx, 'mic-capture-processor');

                // Connect mic stream → AudioWorklet (NOT to _pgmBus — bypass Web Audio echo suppression)
                const source = _ctx.createMediaStreamSource(_micStream);
                source.connect(workletNode);
                // Do NOT connect workletNode to _ctx.destination — mic must not play back

                // PCM frames from worklet → WebSocket binary
                workletNode.port.onmessage = (e) => {
                    if (S.ws?.readyState === WebSocket.OPEN) {
                        S.ws.send(e.data);
                    }
                };

                workletNode.port.postMessage('start');
                _streaming = true;
                _workletNode = workletNode;
                _workletSource = source;
                console.log('[WA] Capture started (AudioWorklet Float32) sampleRate=' + _ctx.sampleRate);
            } catch (e) {
                console.error('[WA] AudioWorklet capture failed:', e.message, '— falling back to MediaRecorder');
                _startMediaRecorderCapture();
            }
        };

        // Wait for getUserMedia to resolve
        let _micWait = 0;
        const _waitForMic = () => {
            if ((_micStream && _micStream.getAudioTracks().length > 0) || _micWait >= 12) {
                _doStart();
            } else {
                _micWait++;
                setTimeout(_waitForMic, 250);
            }
        };
        _waitForMic();
    }

    function _startMediaRecorderCapture() {
        // Fallback if AudioWorklet fails
        const rawStream = _micStream;
        if (!rawStream) return;
        const mimeType =
            MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' :
            MediaRecorder.isTypeSupported('audio/webm')             ? 'audio/webm' :
                                                                      'audio/ogg;codecs=opus';
        try {
            _recorder = new MediaRecorder(rawStream, { mimeType, audioBitsPerSecond: 128000 });
            _recorder.ondataavailable = (e) => {
                if (e.data?.size > 0 && S.ws?.readyState === WebSocket.OPEN) S.ws.send(e.data);
            };
            _recorder.onerror = (e) => console.error('[WA] MediaRecorder error:', e.error);
            _recorder.start(20);
            _streaming = true;
            console.log('[WA] Capture started (MediaRecorder fallback) →', mimeType);
        } catch (e) {
            console.error('[WA] Capture failed:', e.message);
        }
    }

    function stopCapture() {
        if (!_streaming) return;
        // Stop AudioWorklet path
        if (_workletNode) {
            try { _workletNode.port.postMessage('stop'); } catch (_) {}
            try { _workletNode.disconnect(); }            catch (_) {}
            _workletNode = null;
        }
        if (_workletSource) {
            try { _workletSource.disconnect(); } catch (_) {}
            _workletSource = null;
        }
        // Stop MediaRecorder fallback path
        try { _recorder?.stop(); } catch (_) {}
        _recorder  = null;
        _streaming = false;
        console.log('[WA] Capture stopped');
    }

    // Send a latency probe binary frame over the mic WS path.
    // Frame format: 'LAT\0' (4 bytes) + Date.now() as Float64 big-endian (8 bytes) = 12 bytes.
    // Travels the exact same path as AudioWorklet PCM frames — measures true mic path latency.
    // Server detects it, replies with mic:pong before routing to mixer.
    function injectLatencyProbe() {
        if (!S.ws || S.ws.readyState !== WebSocket.OPEN) return false;
        const buf  = new ArrayBuffer(12);
        const view = new DataView(buf);
        view.setUint8(0, 0x4C); view.setUint8(1, 0x41); // 'LA'
        view.setUint8(2, 0x54); view.setUint8(3, 0x00); // 'T\0'
        view.setFloat64(4, Date.now(), false);           // t0 big-endian
        S.ws.send(buf);
        return true;
    }

    // Inject an inaudible 17kHz sine burst into the AudioWorklet mic stream.
    // The server detects arrival via Goertzel filter — measures one-way mic latency.
    // Burst: 2400 samples at 48kHz = 50ms — long enough for Goertzel, short enough to be inaudible.
    function injectMicBurst() {
        if (!_workletNode) return false;
        try {
            _workletNode.port.postMessage({
                type:       'inject',
                samples:    2400,
                amplitude:  0.08,
                freq:       17000,
                sampleRate: 48000,
            });
            return true;
        } catch (_) { return false; }
    }

    return { syncToConsole, startCapture, stopCapture, getCtx, ensureCtx, getMicStream, getMicLevel, injectLatencyProbe, injectMicBurst };
})();


// Single source of truth for monitor panel button state.
// Always reflects PlayerEarphone.isActive() — not Monitor (Opus WebM) state.
// Call this any time something might have overwritten the button classes.
function _syncMonitorButtons() {
    const dot = qs('#monStatusDot');
    const txt = qs('#monStatusTxt');
    if (dot) dot.classList.toggle('active', PlayerEarphone.isActive());
    if (txt) {
        txt.classList.toggle('lcd-on',  PlayerEarphone.isActive());
        txt.classList.toggle('lcd-off', !PlayerEarphone.isActive());
    }
    // Sync rotary source buttons to current console state
    const src = S.console?.monitorSource || 'pgm1';
    document.querySelectorAll('#monSourceRotary .mon-src-btn').forEach(b => {
        b.classList.toggle('active', b.id === `monSrc-${src}`);
    });
    _syncSidetoneBtn();
    _syncMonMicVisibility();
}

function _syncSidetoneBtn() {
    const btn = qs('#monMicBtn');
    if (btn) btn.classList.toggle('active', PlayerEarphone.isSidetoneOn());
}

// Show MON Mic (sidetone) row only when PGM 1 is selected.
// On PGM 2 and CUE the sidetone is unavailable — disable it automatically.
function _syncMonMicVisibility() {
    const src = S.console?.monitorSource || 'pgm1';
    const row = qs('#monMicRow');
    if (row) row.style.display = (src === 'pgm1') ? '' : 'none';
}

// startMicCapture — called at login ('init') and on stream:started.
// Acquires getUserMedia here (inside the user-gesture call chain) before
// WA.startCapture() to prevent the race where MediaRecorder starts before
// the mic track is connected to _pgmBus → _streamDest (records silence).
async function startMicCapture() {
    // Step 1: ensure AudioContext and mic permission are obtained NOW,
    // while we are still in the user-gesture call stack (login → WS init).
    WA.syncToConsole();  // creates AudioContext + _chGains + triggers getUserMedia

    // Step 2: wait for getUserMedia to resolve (up to 5s).
    // Without this wait, MediaRecorder starts before the mic track is connected
    // to _pgmBus → _streamDest, so it records silence.
    await new Promise(resolve => {
        let waited = 0;
        const check = () => {
            if (WA.getMicStream()) return resolve();
            waited += 100;
            if (waited >= 5000) {
                console.warn('[startMicCapture] getUserMedia timeout — proceeding without mic stream');
                return resolve();
            }
            setTimeout(check, 100);
        };
        check();
    });

    // Step 3: start MediaRecorder on PGM bus (mic → _pgmBus → _streamDest → WS)
    WA.startCapture();

    // Step 3b: connect sidetone — local mic into earphone at 0ms (no server round-trip).
    // Reuses the same getUserMedia stream already captured for broadcast.
    // If sidetone toggle is ON (default), the DJ immediately hears their own voice.
    const _st = WA.getMicStream();
    if (_st && PlayerEarphone.isActive()) {
        PlayerEarphone.enableSidetone(_st);
        _syncSidetoneBtn();
    }

    console.log('[startMicCapture] AudioWorklet/MediaRecorder path active');
}

function stopMicCapture() {
    WA.stopCapture();
}

function bindEvents() {
    qs('#logoutBtn').addEventListener('click', async () => {
        await apiFetch('/api/auth/logout', 'POST');
        location.href = '/login';
    });

    qs('#goLiveBtn').addEventListener('click', () => {
        if (!S.isPrimary()) { showToast('Observer mode — cannot control stream', 'warn'); return; }
        if (S.stream.connecting) return;  // belt+suspenders — CSS also blocks via pointer-events:none
        if (S.stream.streaming) {
            send('stream:stop', {});
        } else {
            openGoLiveModal();
        }
    });


    // ── GO LIVE modal — confirm credentials before connecting
    qs('#goLiveConfirm').addEventListener('click', () => {
        const user = qs('#goLiveUser').value.trim();
        const pass = qs('#goLivePass').value;
        const err  = qs('#goLiveError');
        if (!user || !pass) {
            err.textContent = 'Username and password are required.';
            err.classList.remove('hidden');
            return;
        }
        err.classList.add('hidden');
        qs('#goLiveModal').classList.add('hidden');

        // Show connecting state immediately — don't wait for server round-trip.
        // This prevents a confusing window where the button stays GO LIVE for 1-8s.
        S.stream.connecting = true;
        S.stream.streaming  = false;
        updateStreamUI();

        // Pre-warm AudioContext + mic permission NOW, inside this user gesture.
        // This ensures getUserMedia completes BEFORE stream:started arrives (~1-8s later).
        // If mic permission was already granted, this is instant and idempotent.
        WA.syncToConsole();

        send('stream:start', { username: user, password: pass });
    });

    qs('#goLivePass').addEventListener('keydown', e => {
        if (e.key === 'Enter') qs('#goLiveConfirm').click();
    });

    qs('#goLiveModalClose').addEventListener('click', () => qs('#goLiveModal').classList.add('hidden'));
    qs('#goLiveCancel').addEventListener('click',     () => qs('#goLiveModal').classList.add('hidden'));



    // MONITOR panel — event listeners are wired in buildMonitorStrip() (called from buildAllChannels)
    // Volume slider also wired there. Restore volume from console state after build.
    if (S.console?.monitorVolume !== undefined) {
        PlayerEarphone.setVolume(S.console.monitorVolume / 100);
        const sl = qs('#monVolSlider');
        if (sl) { sl.value = S.console.monitorVolume; const vv = qs('#monVolVal'); if (vv) vv.textContent = S.console.monitorVolume; }
    }

    qs('#timerStartStop')?.addEventListener('click', () => {
        if (_timerRun) send('console:timer:stop', {});
        else           send('console:timer:start', {});
    });
    qs('#timerReset')?.addEventListener('click', () => send('console:timer:reset', {}));

    qs('#clearPlaylistBtn').addEventListener('click', () => {
        if (!S.playlist.length) return;
        if (confirm('Clear the entire playlist?')) { RA.stop(); send('playlist:clear', {}); }
    });

    // ── RA Transport buttons ────────────────────────────────────────────────
    qs('#raBtnPrev')?.addEventListener('click',  () => RA.prev());
    qs('#raBtnPlay')?.addEventListener('click',  () => RA.pause());   // toggles play/pause
    qs('#raBtnStop')?.addEventListener('click',  () => RA.stop());
    qs('#raBtnNext')?.addEventListener('click',  () => RA.next());
    qs('#raBtnBreak')?.addEventListener('click', () => RA.toggleBreak());

    // Crossfade seconds input
    qs('#raCrossfade')?.addEventListener('change', (e) => RA.setCrossfade(e.target.value));

    // Init seek bar and set initial crossfade from config
    RA.initSeek();
    fetch('/api/config').then(r => r.json()).then(cfg => {
        const xf = cfg?.audio?.crossfade_duration;
        if (xf) {
            const sec = parseFloat(xf) / 1000;
            const inp = qs('#raCrossfade');
            if (inp) inp.value = sec;
            RA.setCrossfade(sec);
        }
    }).catch(() => {});

    // ── Player 2 tab switching ──────────────────────────────────────────────
    document.querySelectorAll('.ra-player-tab').forEach(btn => {
        btn.addEventListener('click', () => {
            const player = btn.dataset.player;   // 'a' or 'b'
            document.querySelectorAll('.ra-player-tab').forEach(b => b.classList.toggle('active', b === btn));
            const panelA = qs('#raLeft');
            const panelB = qs('#raLeftB');
            if (panelA) panelA.classList.toggle('hidden', player === 'b');
            if (panelB) panelB.classList.toggle('hidden', player === 'a');
            S.libraryTarget = player;   // + END / ↑ NEXT route to correct playlist
        });
    });

    // ── Player 2 transport buttons ──────────────────────────────────────────
    qs('#rbBtnPrev')?.addEventListener('click',  () => RB.prev());
    qs('#rbBtnPlay')?.addEventListener('click',  () => RB.pause());   // toggles play/pause
    qs('#rbBtnStop')?.addEventListener('click',  () => RB.stop());
    qs('#rbBtnNext')?.addEventListener('click',  () => RB.next());
    qs('#rbBtnBreak')?.addEventListener('click', () => RB.toggleBreak());
    qs('#rbCrossfade')?.addEventListener('change', (e) => RB.setCrossfade(e.target.value));
    RB.initSeek();

    qs('#clearPlaylistBBtn')?.addEventListener('click', () => {
        if (!S.playlistB?.length) return;
        if (confirm('Clear Player 2 playlist?')) { RB.stop(); send('playlistB:clear', {}); }
    });

    qs('#libSearch').addEventListener('input',  doLibSearch);
    qs('#libField').addEventListener('change',  doLibSearch);

    qs('#chConfigClose').addEventListener('click',  closeChConfig);
    qs('#cfgCancel').addEventListener('click',      closeChConfig);
    qs('#cfgSave').addEventListener('click',        saveChConfig);
    qs('#cfgName').addEventListener('keydown', e => { if (e.key === 'Enter') saveChConfig(); });
    qs('#chConfigModal').addEventListener('click', (e) => { if (e.target === qs('#chConfigModal')) closeChConfig(); });
}

/* ═══════════════════════════════════════════════════════════════════════════
   UTILITIES
═══════════════════════════════════════════════════════════════════════════ */

function qs(sel)    { return document.querySelector(sel); }
function qsAll(sel) { return document.querySelectorAll(sel); }

function el(tag, props) {
    const e = document.createElement(tag);
    if (props) Object.entries(props).forEach(([k, v]) => {
        if (k === 'dataset') Object.entries(v).forEach(([dk, dv]) => e.dataset[dk] = dv);
        else if (k in e) e[k] = v;
        else e.setAttribute(k, v);
    });
    return e;
}

function escH(str) {
    return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function fmtDur(sec) {
    sec = Math.round(sec || 0);
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
    return `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
}

function fmtTime(iso) {
    if (!iso) return '–';
    try {
        const d = new Date(iso);
        return String(d.getHours()).padStart(2,'0') + ':' + String(d.getMinutes()).padStart(2,'0') + ':' + String(d.getSeconds()).padStart(2,'0');
    } catch (_) { return '–'; }
}

async function apiFetch(url, method = 'GET', body) {
    const opts = { method, headers: { 'Content-Type': 'application/json' } };
    if (body) opts.body = JSON.stringify(body);
    const resp = await fetch(url, opts);
    if (resp.status === 401) location.href = '/login';
    return resp;
}

let _toastTimer = null;
function showToast(msg, type = 'info') {
    let t = qs('#toast');
    if (!t) {
        t = el('div', { id: 'toast' });
        t.style.cssText = 'position:fixed;bottom:20px;right:20px;z-index:999;background:#1a2030;border:1px solid #323d52;border-radius:6px;padding:10px 16px;font-size:12px;max-width:320px;transition:opacity .3s;box-shadow:0 4px 12px rgba(0,0,0,.4)';
        document.body.appendChild(t);
    }
    t.textContent    = msg;
    t.style.borderColor = type === 'error' ? '#dc2626' : type === 'warn' ? '#d97706' : type === 'ok' ? '#16a34a' : '#323d52';
    t.style.color       = type === 'error' ? '#ef4444' : type === 'warn' ? '#f59e0b' : type === 'ok' ? '#22c55e' : '#d0d8e8';
    t.style.opacity  = '1';
    clearTimeout(_toastTimer);
    _toastTimer = setTimeout(() => { t.style.opacity = '0'; }, 4000);
}

/* ═══════════════════════════════════════════════════════════════════════════
   INIT
═══════════════════════════════════════════════════════════════════════════ */


// ── PlayerEarphone — DJ Earphone via WebSocket PCM ──────────────────────────
//
// Jitter-buffered Web Audio scheduler. Proven working since v273.
//
// WS frames → Float32 queue → rAF drain → AudioBufferSourceNode.start(when)
// JITTER_BUF=1.0s: larger than RTT (365ms) so queue never runs dry.
// SCHED_AHEAD=0.5s: keeps 500ms scheduled ahead of currentTime.
// CHUNK_SEC=0.2s: merge 10 WS frames (20ms each) into one 200ms AudioBuffer.
//   → 5 AudioBufferSourceNode creates/sec instead of 50.
//   → 10x less GC pressure = fewer GC-induced glitches.
//   Uses Float32Array.slice() (copy, never a view) to avoid memory corruption.
// rAF loop: never throttled when audio is active.

const PlayerEarphone = (() => {
    const SR          = 44100;
    const CHANNELS    = 2;
    // Adaptive jitter buffer (Jacktrip / Sonobus approach):
    //   MIN_BUF   — lowest latency target; used when network is stable
    //   MAX_BUF   — ceiling; never worse than old fixed 700ms path
    //   SCHED_AHEAD — pre-schedule this far ahead on the AudioContext timeline.
    //                 Does NOT add latency (audio is already playing by then).
    //                 Must be > worst-case rAF delay (tab-switch: ~200ms).
    //   CHUNK_SEC — AudioBuffer size; smaller = finer scheduling granularity
    const MIN_BUF     = 0.080;   // 80ms (~4 server ticks)
    const MAX_BUF     = 0.400;   // 400ms ceiling
    const SCHED_AHEAD = 0.300;   // 300ms lookahead — survives rAF throttle / tab-switch
    const CHUNK_SEC   = 0.040;   // 40ms chunks = 2× server tick

    let _ctx        = null;
    let _gain       = null;
    let _analyser   = null;
    let _ws         = null;
    let _active     = false;
    let _volume     = 0.80;
    let _schedTime  = 0;
    let _started    = false;
    let _rafId      = null;
    let _queue      = [];       // Float32Array chunks, one per WS frame

    // ── Adaptive jitter buffer state ──────────────────────────────────────────
    let _targetBuf     = 0.150;  // current target depth (adapts between MIN_BUF..MAX_BUF)
    let _jitterEWMA    = 0.040;  // EWMA of inter-frame arrival jitter (seconds)
    let _lastArrivalMs = 0;      // performance.now() at last _enqueue() call
    let _lastFrame     = null;   // PLC: last scheduled frame (for packet loss concealment)

    // ── Sidetone — browser-local mic self-monitoring (0ms, no server round-trip) ─
    let _sideSource = null;     // MediaStreamSource node (mic stream in earphone AudioContext)
    let _sideGain   = null;     // GainNode controlling sidetone level
    let _sidetoneOn = false;    // true when sidetone is connected

    // ── Pilot tone detection — for latency measurement ──────────────────────
    // High-resolution AnalyserNode (fftSize=4096) tapped from _gain output.
    // Detects the 17kHz pilot that the server injects into outMix1.
    let _pilotAnalyser  = null;
    let _earPilotSearch = null;  // { probeId, t_ear_inject_vps, onDetected } | null
    let _pilotRafId     = null;

    function _ensureCtx() {
        if (_ctx) return;
        _ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: SR });
        _gain     = _ctx.createGain();
        _gain.gain.value = _volume;
        _analyser = _ctx.createAnalyser();
        _analyser.fftSize = 256;
        _gain.connect(_analyser);
        _analyser.connect(_ctx.destination);
        // Parallel high-res AnalyserNode for pilot tone detection (doesn't add latency)
        _pilotAnalyser = _ctx.createAnalyser();
        _pilotAnalyser.fftSize = 4096;
        _pilotAnalyser.smoothingTimeConstant = 0;  // instant response
        _gain.connect(_pilotAnalyser);
    }

    function _queuedSecs() {
        let n = 0;
        for (const f of _queue) n += f.length;
        return n / CHANNELS / SR;
    }

    function _drain() {
        if (!_ctx || !_active || !_started) return;
        const target    = _ctx.currentTime + SCHED_AHEAD;
        const chunkSamp = Math.round(SR * CHUNK_SEC) * CHANNELS;
        const critSamp  = Math.round(SR * 0.040)    * CHANNELS;  // 40ms — critical minimum

        while (_schedTime < target) {
            // Count queued samples
            let avail = 0;
            for (const f of _queue) avail += f.length;
            if (avail === 0) {
                // ── Packet Loss Concealment ──────────────────────────────────
                // Network dropout: instead of hard silence, fade out the last known
                // audio frame. Eliminates clicks/pops on brief packet gaps.
                // Only applied once per dropout (then _lastFrame is cleared).
                if (_lastFrame && (_schedTime - _ctx.currentTime) < 0.060) {
                    const plc = new Float32Array(_lastFrame.length);
                    for (let i = 0; i < plc.length; i++) {
                        // Linear fade from 50% → 0% over the frame duration
                        plc[i] = _lastFrame[i] * (0.5 * (1 - i / plc.length));
                    }
                    _scheduleF32(plc);
                    _lastFrame = null;   // one PLC frame per dropout, then silence
                }
                break;
            }

            // Use full chunk if available, otherwise use whatever we have
            // if schedTime is critically close to currentTime (< 40ms headroom)
            const headroom = _schedTime - _ctx.currentTime;
            const needed   = (avail >= chunkSamp || headroom < 0.040) ? Math.min(avail, chunkSamp) : chunkSamp;
            if (avail < needed) break;

            // Merge frames into one clean Float32Array copy (never a view)
            const chunk = new Float32Array(needed);
            let pos = 0;
            while (pos < needed && _queue.length > 0) {
                const f    = _queue[0];
                const take = Math.min(f.length, needed - pos);
                chunk.set(f.slice(0, take), pos);
                pos += take;
                if (take === f.length) {
                    _queue.shift();
                } else {
                    _queue[0] = f.slice(take);  // .slice = copy, safe across event loop ticks
                }
            }
            _scheduleF32(chunk);
        }
    }

    function _scheduleF32(f32) {
        _lastFrame = f32;   // save for Packet Loss Concealment
        const nFrames  = f32.length / CHANNELS;
        const abuf     = _ctx.createBuffer(CHANNELS, nFrames, SR);
        const L = abuf.getChannelData(0);
        const R = abuf.getChannelData(1);
        for (let i = 0; i < nFrames; i++) {
            L[i] = f32[i * 2];
            R[i] = f32[i * 2 + 1];
        }
        const src = _ctx.createBufferSource();
        src.buffer = abuf;
        src.connect(_gain);
        src.start(_schedTime);
        _schedTime += abuf.duration;
    }

    function _rafLoop() {
        if (!_active || !_started) return;
        _drain();
        _rafId = requestAnimationFrame(_rafLoop);
    }

    function _enqueue(abuf) {
        if (!_ctx || !_active) return;
        // outMix1 is f64le (Float64, stereo interleaved, values in [-1,+1]).
        // Convert Float64 → Float32 for Web Audio (natively Float32).
        const f64  = new Float64Array(abuf);
        const f32  = new Float32Array(f64.length);
        for (let i = 0; i < f64.length; i++) f32[i] = f64[i];
        _queue.push(f32);

        // ── Adaptive jitter measurement (Jacktrip / VOIP style) ───────────────
        // Server sends one frame every 20ms. Measure actual inter-frame arrival
        // intervals and track variance via EWMA. Grow _targetBuf when jitter is
        // high; shrink back toward MIN_BUF when the network is stable.
        const nowMs = performance.now();
        if (_lastArrivalMs > 0) {
            const intervalSec = (nowMs - _lastArrivalMs) / 1000;
            const devSec      = Math.abs(intervalSec - 0.020);   // deviation from 20ms ideal
            // Very slow adaptation (α=0.03) so occasional outliers don't spike the buffer
            _jitterEWMA = _jitterEWMA * 0.97 + devSec * 0.03;
            // Target = 4× jitter + 40ms safety floor, clamped to [MIN_BUF, MAX_BUF]
            _targetBuf  = Math.max(MIN_BUF, Math.min(MAX_BUF, _jitterEWMA * 4 + 0.040));
        }
        _lastArrivalMs = nowMs;

        if (!_started && _queuedSecs() >= _targetBuf) {
            _schedTime = _ctx.currentTime + 0.02;
            _started   = true;
            _rafLoop();
            const bufMs = Math.round(_targetBuf * 1000);
            const earMs = Math.round(getAudioDelaySec() * 1000);
            console.log('[PE] jitter buffer full (' + bufMs + 'ms buf + ' +
                        Math.round(SCHED_AHEAD * 1000) + 'ms sched + ' +
                        Math.round((_ctx?.baseLatency || 0) * 1000) + 'ms hw' +
                        ' = ' + earMs + 'ms earphone latency' +
                        ', jitter≈' + Math.round(_jitterEWMA * 1000) + 'ms) — sending LAT probe…');
            // Kick off latency probe: binary LAT\0 frame travels same path as mic PCM.
            // mic:pong handler adds mic one-way latency and posts total to /api/mic-delay.
            _pendingLatEarMs = earMs;
            WA.injectLatencyProbe();
        }
    }

    async function _startWS() {
        _ensureCtx();
        if (_ctx.state === 'suspended') await _ctx.resume();
        _schedTime = 0; _started = false; _queue = [];
        _lastFrame = null; _lastArrivalMs = 0; _targetBuf = 0.150;
        cancelAnimationFrame(_rafId); _rafId = null;

        const proto = location.protocol === 'https:' ? 'wss' : 'ws';
        _ws = new WebSocket(`${proto}://${location.host}/ws/mon`);
        _ws.binaryType = 'arraybuffer';
        _ws.onopen  = () => {
            // Reset adaptive state on each (re)connect so we re-learn jitter quickly
            _jitterEWMA    = 0.040;
            _lastArrivalMs = 0;
            _targetBuf     = 0.150;   // start conservative, adapts down once measurements arrive
            console.log('[PE] /ws/mon connected — adaptive jitter buffer [' +
                        Math.round(MIN_BUF*1000) + '–' + Math.round(MAX_BUF*1000) + 'ms] active');
        };
        _ws.onerror = () => _ws.close();
        _ws.onclose = () => {
            cancelAnimationFrame(_rafId); _rafId = null;
            if (_active) { console.warn('[PE] WS closed — reconnect 1s'); setTimeout(_startWS, 1000); }
        };
        _ws.onmessage = (ev) => {
            if (!_active) return;
            if (ev.data.byteLength <= 8) return;
            _enqueue(ev.data.slice(8));
        };
    }

    async function start() {
        if (_active) return;
        _active = true;
        try { await _startWS(); }
        catch(e) { console.error('[PE] start failed:', e.message); _active = false; }
    }

    function stop() {
        if (!_active) return;
        _active = false; _started = false; _queue = [];
        cancelAnimationFrame(_rafId); _rafId = null;
        try { _ws?.close(); } catch(_) {}
        _ws = null;
        console.log('[PE] stopped');
    }

    function setVolume(v) {
        _volume = Math.max(0, Math.min(1, v));
        if (_gain && _ctx) _gain.gain.setTargetAtTime(_volume, _ctx.currentTime, 0.01);
    }

    function getVolume()  { return _volume; }
    function isActive()   { return _active; }
    function flush()      { }
    function resumeCtx()  { _ctx?.resume(); }

    function getLevel() {
        if (!_analyser || !_active) return 0;
        const buf = new Uint8Array(_analyser.frequencyBinCount);
        _analyser.getByteTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) { const s = (buf[i]-128)/128; sum += s*s; }
        return Math.sqrt(sum / buf.length);
    }

    // Total earphone pipeline latency (seconds):
    //   _targetBuf   — frames waiting in the queue (adaptive jitter buffer)
    //   SCHED_AHEAD  — audio scheduled this far ahead on AudioContext timeline;
    //                  in steady state _schedTime ≈ ctx.currentTime + SCHED_AHEAD,
    //                  so the frame dequeued NOW plays SCHED_AHEAD seconds later
    //   baseLatency  — AudioContext hardware output latency (~10ms)
    // Used by track-position display and auto-calibration of server mic delay.
    function getAudioDelaySec() {
        return _targetBuf + SCHED_AHEAD + (_ctx ? (_ctx.baseLatency || 0) : 0);
    }
    function syncConsole()      { }

    // ── Sidetone — local mic fed directly into earphone AudioContext ───────────
    // Routes the DJ's own mic stream into the earphone at 0ms latency (Web Audio
    // local processing — no server round-trip). Mirrors real console sidetone.
    // Must be called after _ensureCtx() has created _ctx and _gain.
    function enableSidetone(micStream) {
        if (!micStream || !_ctx) return;
        disableSidetone();   // clean up any previous connection
        try {
            _sideSource = _ctx.createMediaStreamSource(micStream);
            _sideGain   = _ctx.createGain();
            _sideGain.gain.value = 0.75;   // -2.5 dB — slightly below PGM1 so music isn't masked
            _sideSource.connect(_sideGain);
            _sideGain.connect(_gain);      // through earphone volume control
            _sidetoneOn = true;
            console.log('[PE] Sidetone enabled — mic self-monitoring active (0ms)');
        } catch (e) {
            console.warn('[PE] Sidetone failed:', e.message);
        }
    }

    function disableSidetone() {
        _sidetoneOn = false;
        if (_sideGain)   { try { _sideGain.disconnect();   } catch (_) {} _sideGain   = null; }
        if (_sideSource) { try { _sideSource.disconnect(); } catch (_) {} _sideSource = null; }
    }

    function setSidetoneGain(v) {
        if (_sideGain && _ctx) _sideGain.gain.setTargetAtTime(
            Math.max(0, Math.min(1.5, v)), _ctx.currentTime, 0.05);
    }

    function isSidetoneOn() { return _sidetoneOn; }

    // ── 17kHz pilot detection for ear latency measurement ────────────────────
    // Called by startLatencyMeasure() when server sends lat:probe.
    // Polls _pilotAnalyser every rAF (~16ms) for a 17kHz bin spike.
    // onDetected(probeId, earMs) called once when detected.
    function startEarPilotDetect(probeId, t_ear_inject_vps, onDetected) {
        if (_earPilotSearch) {
            // Cancel previous search if still running
            cancelAnimationFrame(_pilotRafId);
            _pilotRafId     = null;
            _earPilotSearch = null;
        }
        _earPilotSearch = { probeId, t_ear_inject_vps, onDetected };
        _pollPilot();
    }

    function _pollPilot() {
        if (!_earPilotSearch || !_pilotAnalyser || !_active) {
            _earPilotSearch = null;
            return;
        }
        const freqBuf = new Float32Array(_pilotAnalyser.frequencyBinCount);
        _pilotAnalyser.getFloatFrequencyData(freqBuf);
        // Bin for 17kHz at SR=44100, fftSize=4096:
        //   bin = round(17000 × 4096 / 44100) = round(1578.9) = 1579
        const bin       = Math.round(17000 * _pilotAnalyser.fftSize / SR);
        const threshold = -40;  // dBFS — pilot at 0.08 amplitude is ~-24 dBFS
        if (freqBuf[bin] > threshold) {
            const t_now_vps = Date.now() + _clockOffset;
            const earMs     = Math.max(0, Math.round(t_now_vps - _earPilotSearch.t_ear_inject_vps));
            const { probeId, onDetected } = _earPilotSearch;
            cancelAnimationFrame(_pilotRafId);
            _pilotRafId     = null;
            _earPilotSearch = null;
            console.log(`[PE] Ear pilot detected: bin=${bin} dBFS=${freqBuf[bin].toFixed(1)} earMs=${earMs}`);
            onDetected(probeId, earMs);
            return;
        }
        _pilotRafId = requestAnimationFrame(_pollPilot);
    }

    return { start, stop, setVolume, getVolume, isActive, flush, resumeCtx,
             getLevel, getAudioDelaySec, syncConsole,
             enableSidetone, disableSidetone, setSidetoneGain, isSidetoneOn,
             startEarPilotDetect };
})();

// ── Browser Monitor — server PGM mix via WebSocket WebM/Opus ─────────────────
// Server sends WebM/Opus 64kbps chunks as WebSocket binary frames (20ms each).
// Each chunk is decoded via AudioContext.decodeAudioData() and scheduled on the
// Web Audio clock using AudioBufferSourceNode.start(when).
//
// WHY NOT MSE:
//   MSE (MediaSource / SourceBuffer) accumulates a growing browser-managed buffer.
//   currentTime drifts behind the live edge. Seeking causes audible decoder resets.
//   Rate nudging is slow. Result: 1-4s latency, frequent interruptions.
//
// WHY Web Audio scheduling:
//   Each decoded chunk is placed precisely on the AudioContext timeline back-to-back.
//   Scheduler maintains a 200ms lookahead — just enough to prevent gaps.
//   Total latency: network RTT (~60ms) + encode (~20ms) + schedule buffer (~200ms)
//   = ~280-400ms. Gapless. No seeking. No rate nudging. No buffer drift.

const Monitor = (() => {
    let _ctx         = null;   // shared AudioContext from WA
    let _gainNode    = null;   // GainNode — volume control for monitor output
    let _active      = false;
    let _volume      = 0.8;

    // Scheduler state
    let _nextPlayAt  = 0;      // AudioContext.currentTime when next chunk should play
    let _decoding    = 0;      // in-flight decodeAudioData count (backpressure)

    function _ensureCtx() {
        if (_ctx) return true;
        // Reuse WA's AudioContext if available — same audio graph, no extra context
        _ctx = WA.ensureCtx();
        if (!_ctx) return false;
        _gainNode = _ctx.createGain();
        _gainNode.gain.value = _volume;
        _gainNode.connect(_ctx.destination);
        _nextPlayAt = 0;
        return true;
    }

    // Decode one incoming WebM/Opus chunk and schedule it for playback.
    // Uses the Web Audio clock for sample-accurate back-to-back placement.
    function _scheduleChunk(arrayBuffer) {
        if (!_active || !_ctx) return;
        if (_decoding > 8) return; // too many in flight — drop (network burst)

        _decoding++;
        _ctx.decodeAudioData(
            arrayBuffer,
            (audioBuffer) => {
                _decoding--;
                if (!_active) return;

                // Place chunk immediately after previous chunk on the timeline.
                // If we've fallen behind real time (starvation), jump to now + tiny gap.
                const now = _ctx.currentTime;
                if (_nextPlayAt < now + 0.01) {
                    _nextPlayAt = now + 0.05; // 50ms gap after starvation — avoids click
                }

                const src = _ctx.createBufferSource();
                src.buffer = audioBuffer;
                src.connect(_gainNode);
                src.start(_nextPlayAt);
                _nextPlayAt += audioBuffer.duration;
            },
            (err) => {
                _decoding--;
                // Decode error: usually a partial/corrupt WebM chunk at stream start.
                // Silently discard — next chunk will be clean.
                console.warn('[Monitor] decode error (expected at stream start):', err?.message || err);
            }
        );
    }

    function _teardown() {
        _nextPlayAt = 0;
        _decoding   = 0;
        // _gainNode stays connected — reused on next start()
    }

    // Called by WS message handler for every binary frame.
    function onChunk(arrayBuffer) {
        if (!_active) return;
        if (!_ensureCtx()) return;
        _scheduleChunk(arrayBuffer.slice(0)); // slice to own the buffer (WS reuses it)
    }

    function start() {
        _active = true;
        if (!_ensureCtx()) return;
        if (_ctx.state === 'suspended') _ctx.resume();
        _nextPlayAt = 0;  // reset scheduler — first chunk sets the timeline
        console.log('[Monitor] started');
    }

    function stop() {
        _active = false;
        _teardown();
        console.log('[Monitor] stopped');
    }

    function setVolume(v) {
        _volume = Math.max(0, Math.min(1, v / 100));
        if (_gainNode) _gainNode.gain.setTargetAtTime(_volume, _ctx?.currentTime || 0, 0.05);
    }

    function setUrl() {}  // no-op — kept for API compat

    function _updateStatus() {
        const dot = document.getElementById('monStatusDot');
        const txt = document.getElementById('monStatusTxt');
        const pgm = document.getElementById('monPGM');
        const off = document.getElementById('monOFF');
        if (dot) dot.classList.toggle('active', _active);
        if (txt) txt.textContent = _active ? 'PGM 1' : 'CLICK ON';
        if (pgm) pgm.classList.toggle('lit', _active);
        if (off) off.classList.toggle('lit', !_active);
    }

    function stopAudio() { stop(); }
    function toggle(on)  { on ? start() : stop(); }
    function isActive()  { return _active; }

    function startWithUI() { start(); setTimeout(_updateStatus, 100); }
    function stopWithUI()  { stop();  _updateStatus(); }

    function getVolume() { return _volume; }
    return { setUrl, onChunk, start: startWithUI, stop: stopWithUI, stopAudio, setVolume, getVolume, toggle, isActive, updateStatus: _updateStatus };
})();

/* ═══════════════════════════════════════════════════════════════════════════
   PLAYLIST BUILDER
   Tree browser (Genre → SubGenre → Artist → Album → Tracks) on left.
   Built playlist with drag-to-reorder on right. Export as M3U.
═══════════════════════════════════════════════════════════════════════════ */

const PlaylistBuilder = (() => {
    let _tree        = [];       // full tree from /api/library/tree
    let _playlist    = [];       // [{name, path, duration, artist, title, album}]
    let _dragIdx     = null;     // drag-and-drop source index
    let _loaded      = false;

    // ── Tree loading ──────────────────────────────────────────────────────────
    async function loadTree() {
        const statusEl = document.getElementById('pbStatus');
        if (statusEl) { statusEl.textContent = '⏳ Loading library tree…'; statusEl.className = 'pb-status loading'; }
        try {
            const r = await apiFetch('/api/library/tree');
            if (!r.ok) throw new Error('HTTP ' + r.status);
            _tree = await r.json();
            _loaded = true;
            if (statusEl) { statusEl.textContent = ''; statusEl.className = 'pb-status'; }
            renderTree();
        } catch (e) {
            if (statusEl) { statusEl.textContent = '✗ Failed to load tree: ' + e.message; statusEl.className = 'pb-status error'; }
        }
    }

    // ── Tree rendering ────────────────────────────────────────────────────────
    function renderTree() {
        const container = document.getElementById('pbTree');
        if (!container) return;
        if (_tree.length === 0) {
            container.innerHTML = '<div class="pb-empty">Library not scanned — run Rescan in Settings first.</div>';
            return;
        }
        container.innerHTML = '';
        _tree.forEach(genreNode => {
            container.appendChild(buildNode(genreNode, 0));
        });
    }

    function buildNode(node, depth) {
        const wrap = document.createElement('div');
        wrap.className = 'pb-node';
        wrap.dataset.depth = depth;

        if (node.isTrack) {
            // Track leaf — checkbox + name + duration
            const row = document.createElement('div');
            row.className = 'pb-track-row';
            row.style.paddingLeft = (depth * 16 + 8) + 'px';
            const dur = node.duration ? _fmtDur(node.duration) : '';

            const chk = document.createElement('input');
            chk.type      = 'checkbox';
            chk.className = 'pb-track-chk';
            chk.title     = 'Add individual track to playlist';
            chk.checked   = !!_playlist.find(p => !p.isFolder && p.path === node.path);
            chk.addEventListener('change', (e) => {
                e.stopPropagation();
                if (chk.checked) {
                    addTrack(node);
                } else {
                    const idx = _playlist.findIndex(p => !p.isFolder && p.path === node.path);
                    if (idx !== -1) { _playlist.splice(idx, 1); renderPlaylistBuilder(); }
                }
            });

            row.innerHTML =
                `<span class="pb-track-icon">♪</span>` +
                `<span class="pb-track-name" title="${_esc(node.path)}">${_esc(node.name.replace(/\.flac$/i,''))}</span>` +
                `<span class="pb-track-dur">${dur}</span>`;
            row.insertBefore(chk, row.firstChild);
            row.addEventListener('click', (e) => {
                if (e.target === chk) return;
                chk.checked = !chk.checked;
                chk.dispatchEvent(new Event('change'));
            });
            wrap.appendChild(row);
            return wrap;
        }

        // Folder node — collapsible
        const header = document.createElement('div');
        header.className = 'pb-folder-row';
        header.style.paddingLeft = (depth * 16 + 4) + 'px';

        // Checkbox to select/deselect entire folder
        const chk = document.createElement('input');
        chk.type  = 'checkbox';
        chk.className = 'pb-folder-chk';
        chk.title = 'Add all tracks in this folder';
        chk.addEventListener('change', (e) => {
            e.stopPropagation();
            if (chk.checked) {
                addFolder(node);
            } else {
                const idx = _playlist.findIndex(p => p.isFolder && p.path === node.path);
                if (idx !== -1) { _playlist.splice(idx, 1); renderPlaylistBuilder(); }
            }
        });

        const arrow = document.createElement('span');
        arrow.className = 'pb-arrow';
        arrow.textContent = '▶';

        const label = document.createElement('span');
        label.className = 'pb-folder-label';
        label.textContent = node.name;

        const count = document.createElement('span');
        count.className = 'pb-folder-count';
        const trackCount = _countTracks(node);
        count.textContent = trackCount + (trackCount === 1 ? ' track' : ' tracks');

        header.appendChild(chk);
        header.appendChild(arrow);
        header.appendChild(label);
        header.appendChild(count);

        const children = document.createElement('div');
        children.className = 'pb-children hidden';

        if (node.children && node.children.length > 0) {
            node.children.forEach(child => {
                children.appendChild(buildNode(child, depth + 1));
            });
        }

        header.addEventListener('click', (e) => {
            if (e.target === chk) return;
            const open = !children.classList.contains('hidden');
            children.classList.toggle('hidden', open);
            arrow.textContent = open ? '▶' : '▼';
            arrow.classList.toggle('open', !open);
        });

        wrap.appendChild(header);
        wrap.appendChild(children);
        return wrap;
    }

    function _collectTracks(node) {
        if (node.isTrack) return [node];
        const out = [];
        (node.children || []).forEach(c => out.push(..._collectTracks(c)));
        return out;
    }

    function _countTracks(node) {
        return _collectTracks(node).length;
    }

    function _totalDuration(node) {
        return _collectTracks(node).reduce((sum, t) => sum + (t.duration || 0), 0);
    }

    // ── Playlist management ───────────────────────────────────────────────────
    function addFolder(node) {
        if (_playlist.find(p => p.isFolder && p.path === node.path)) {
            showToast('Folder already in playlist', 'warn');
            return;
        }
        _playlist.push({
            isFolder:      true,
            name:          node.name,
            path:          node.path,
            trackCount:    _countTracks(node),
            totalDuration: _totalDuration(node),
        });
        renderPlaylistBuilder();
    }

    function addTrack(node) {
        // Prevent duplicates
        if (_playlist.find(p => p.path === node.path)) {
            showToast('Track already in playlist', 'warn');
            return;
        }
        _playlist.push({
            name:     node.name.replace(/\.flac$/i, ''),
            path:     node.path,
            duration: node.duration || 0,
            artist:   node.artist   || '',
            title:    node.title    || node.name.replace(/\.flac$/i, ''),
            album:    node.album    || '',
        });
        renderPlaylistBuilder();
    }

    function removeTrack(idx) {
        _playlist.splice(idx, 1);
        renderPlaylistBuilder();
    }

    function clearPlaylist() {
        _playlist = [];
        renderPlaylistBuilder();
    }

    // ── Playlist render ───────────────────────────────────────────────────────
    function renderPlaylistBuilder() {
        const tbody   = document.getElementById('pbPlaylistBody');
        const totalEl = document.getElementById('pbTotal');
        if (!tbody) return;

        if (_playlist.length === 0) {
            tbody.innerHTML = '<tr><td colspan="5" class="pb-pl-empty">Playlist empty — add tracks or folders from the tree ←</td></tr>';
            if (totalEl) totalEl.textContent = '';
            return;
        }

        tbody.innerHTML = '';
        let totalSec = 0;
        _playlist.forEach((t, i) => {
            totalSec += t.isFolder ? (t.totalDuration || 0) : (t.duration || 0);
            const tr = document.createElement('tr');
            tr.className = t.isFolder ? 'pb-pl-row pb-pl-folder' : 'pb-pl-row';
            tr.draggable = true;
            tr.dataset.idx = i;
            const titleCell = t.isFolder
                ? `📁 <strong>${_esc(t.name)}</strong> <span class="pb-folder-track-count">(${t.trackCount} track${t.trackCount === 1 ? '' : 's'})</span>`
                : _esc(t.artist ? t.artist + ' – ' + t.title : t.name);
            const durCell = t.isFolder
                ? (t.totalDuration ? _fmtDur(t.totalDuration) : '–')
                : (t.duration ? _fmtDur(t.duration) : '–');
            tr.innerHTML =
                `<td class="pb-pl-num">${i + 1}</td>` +
                `<td class="pb-pl-drag" title="Drag to reorder">⠿</td>` +
                `<td class="pb-pl-title">${titleCell}</td>` +
                `<td class="pb-pl-dur">${durCell}</td>` +
                `<td class="pb-pl-del"><button class="pb-del-btn" data-idx="${i}" title="Remove">✕</button></td>`;

            // Drag-and-drop reorder
            tr.addEventListener('dragstart', (e) => {
                _dragIdx = i;
                tr.classList.add('pb-dragging');
                e.dataTransfer.effectAllowed = 'move';
            });
            tr.addEventListener('dragend', () => {
                tr.classList.remove('pb-dragging');
                _dragIdx = null;
                document.querySelectorAll('.pb-pl-row').forEach(r => r.classList.remove('pb-drag-over'));
            });
            tr.addEventListener('dragover', (e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                document.querySelectorAll('.pb-pl-row').forEach(r => r.classList.remove('pb-drag-over'));
                tr.classList.add('pb-drag-over');
            });
            tr.addEventListener('drop', (e) => {
                e.preventDefault();
                if (_dragIdx === null || _dragIdx === i) return;
                const moved = _playlist.splice(_dragIdx, 1)[0];
                _playlist.splice(i, 0, moved);
                renderPlaylistBuilder();
            });

            tr.querySelector('.pb-del-btn').addEventListener('click', () => removeTrack(i));
            tbody.appendChild(tr);
        });

        const folderCount = _playlist.filter(t => t.isFolder).length;
        const trackCount  = _playlist.filter(t => !t.isFolder).length;
        const parts = [];
        if (folderCount) parts.push(`${folderCount} folder${folderCount === 1 ? '' : 's'}`);
        if (trackCount)  parts.push(`${trackCount} track${trackCount === 1 ? '' : 's'}`);
        if (totalEl) totalEl.textContent = parts.join(', ') + ` — total ${_fmtDur(totalSec)}`;
    }

    // ── Push to AzuraCast ────────────────────────────────────────────────────
    async function pushToAzuraCast() {
        if (_playlist.length === 0) { showToast('Playlist is empty', 'warn'); return; }
        const panel = document.getElementById('pbPushPanel');
        if (!panel) return;
        const isOpen = !panel.classList.contains('hidden');
        panel.classList.toggle('hidden', isOpen);
        if (isOpen) return; // toggled closed

        const sel    = document.getElementById('pbPushSelect');
        const status = document.getElementById('pbPushStatus');
        sel.innerHTML = '<option>Loading…</option>';
        sel.disabled  = true;
        status.textContent = '';
        status.className   = 'pb-push-status';

        try {
            const r = await apiFetch('/api/azuracast/playlists');
            if (!r.ok) {
                const e = await r.json().catch(() => ({}));
                status.textContent = '✗ ' + (e.error || 'Failed — set api_key in config.ini [azuracast]');
                status.className   = 'pb-push-status error';
                return;
            }
            const lists = await r.json();
            sel.innerHTML = '';
            lists.forEach(pl => {
                const opt = document.createElement('option');
                opt.value       = pl.id;
                opt.textContent = pl.name;
                sel.appendChild(opt);
            });
            sel.disabled = false;
        } catch (e) {
            status.textContent = '✗ ' + e.message;
            status.className   = 'pb-push-status error';
        }
    }

    async function doPush() {
        const sel    = document.getElementById('pbPushSelect');
        const status = document.getElementById('pbPushStatus');
        const playlistId = parseInt(sel?.value);
        if (!playlistId) return;

        const folders = _playlist.filter(t =>  t.isFolder).map(t => t.path);
        const tracks  = _playlist.filter(t => !t.isFolder);

        status.textContent = '⏳ Pushing to AzuraCast…';
        status.className   = 'pb-push-status loading';

        try {
            const r    = await apiFetch('/api/azuracast/playlist/push', 'POST', { playlistId, folders, tracks });
            const data = await r.json();
            if (data.ok) {
                status.textContent = '✓ Pushed successfully';
                status.className   = 'pb-push-status ok';
                showToast('Pushed to AzuraCast', 'ok');
            } else {
                const detail = (data.results || []).map(x => `${x.type}: HTTP ${x.status}`).join(', ');
                status.textContent = '✗ ' + (detail || 'Push failed — check AzuraCast API key');
                status.className   = 'pb-push-status error';
            }
        } catch (e) {
            status.textContent = '✗ ' + e.message;
            status.className   = 'pb-push-status error';
        }
    }

    // ── M3U export ────────────────────────────────────────────────────────────
    function exportM3U() {
        if (_playlist.length === 0) { showToast('Playlist is empty', 'warn'); return; }
        const tracks = _playlist.filter(t => !t.isFolder);
        if (tracks.length === 0) { showToast('No individual tracks to export — folders are added via AzuraCast batch assign', 'warn'); return; }
        let m3u = '#EXTM3U\n';
        tracks.forEach(t => {
            const sec = Math.round(t.duration || 0);
            const display = t.artist ? `${t.artist} - ${t.title}` : t.name;
            m3u += `#EXTINF:${sec},${display}\n${t.path}\n`;
        });
        const blob = new Blob([m3u], { type: 'audio/x-mpegurl' });
        const url  = URL.createObjectURL(blob);
        const a    = document.createElement('a');
        a.href     = url;
        a.download = 'playlist.m3u';
        document.body.appendChild(a);
        a.click();
        setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1000);
        showToast('M3U exported — import into AzuraCast via Playlists → Import', 'ok');
    }

    // ── Helpers ───────────────────────────────────────────────────────────────
    function _fmtDur(sec) {
        const s = Math.round(sec);
        const h = Math.floor(s / 3600);
        const m = Math.floor((s % 3600) / 60);
        const ss = s % 60;
        if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(ss).padStart(2,'0')}`;
        return `${m}:${String(ss).padStart(2,'0')}`;
    }

    function _esc(s) {
        return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }

    // ── View AzuraCast Playlist Contents ─────────────────────────────────────
    async function openViewPanel() {
        const panel   = document.getElementById('pbViewPanel');
        const isOpen  = !panel.classList.contains('hidden');
        panel.classList.toggle('hidden', isOpen);
        if (isOpen) return;

        const sel    = document.getElementById('pbViewSelect');
        const status = document.getElementById('pbViewStatus');
        const contents = document.getElementById('pbViewContents');
        sel.innerHTML = '<option>Loading…</option>';
        sel.disabled  = true;
        status.textContent = '';
        contents.classList.add('hidden');

        try {
            const r = await apiFetch('/api/azuracast/playlists');
            if (!r.ok) { status.textContent = '✗ Cannot load playlists'; status.className = 'pb-push-status error'; return; }
            const lists = await r.json();
            sel.innerHTML = '';
            lists.forEach(pl => {
                const opt = document.createElement('option');
                opt.value = pl.id; opt.textContent = pl.name;
                sel.appendChild(opt);
            });
            sel.disabled = false;
        } catch (e) {
            status.textContent = '✗ ' + e.message; status.className = 'pb-push-status error';
        }
    }

    async function loadAzContents() {
        const sel      = document.getElementById('pbViewSelect');
        const status   = document.getElementById('pbViewStatus');
        const contents = document.getElementById('pbViewContents');
        const playlistId = parseInt(sel?.value);
        if (!playlistId) return;

        status.textContent = '⏳ Loading…';
        status.className   = 'pb-push-status loading';
        contents.classList.add('hidden');
        contents.innerHTML = '';

        try {
            const r    = await apiFetch(`/api/azuracast/playlist/${playlistId}/contents`);
            const data = await r.json();
            if (!r.ok) { status.textContent = '✗ ' + (data.error || 'Failed'); status.className = 'pb-push-status error'; return; }

            status.textContent = `${data.total} track${data.total === 1 ? '' : 's'} total`;
            status.className   = 'pb-push-status ok';

            if (data.total === 0 || (data.folders.length === 0 && data.tracks.length === 0)) {
                contents.innerHTML = '<div class="pb-view-empty">Playlist is empty</div>';
                contents.classList.remove('hidden');
                return;
            }

            // Render folder groups and individual tracks
            const ul = document.createElement('ul');
            ul.className = 'pb-view-list';

            if (false) {
                contents.innerHTML = '<div class="pb-view-empty">Playlist is empty</div>';
                contents.classList.remove('hidden');
                return;
            }

            if (data.folders.length > 0) {
                const hdr = document.createElement('div');
                hdr.className = 'pb-view-section-hdr';
                hdr.textContent = `Folders (${data.folders.length})`;
                contents.appendChild(hdr);
            }

            data.folders.forEach(f => {
                const li = document.createElement('li');
                li.className = 'pb-view-folder-row';
                li.innerHTML =
                    `<span class="pb-view-icon">📁</span>` +
                    `<span class="pb-view-path" title="${_esc(f.path)}">${_esc(f.path.split('/').pop())}</span>` +
                    `<span class="pb-view-full-path">${_esc(f.path)}</span>` +
                    `<span class="pb-view-count">${f.count} track${f.count === 1 ? '' : 's'}</span>` +
                    `<button class="pb-view-del-btn" title="Remove folder from playlist">✕ Remove</button>`;
                li.querySelector('.pb-view-del-btn').addEventListener('click', () =>
                    removeAzFolder(playlistId, f.path, f.count, li));
                ul.appendChild(li);
            });

            if (data.tracks.length > 0) {
                const hdr = document.createElement('div');
                hdr.className = 'pb-view-section-hdr';
                hdr.textContent = `Individual Tracks (${data.tracks.length}${data.tracks.length === 500 ? '+' : ''})`;
                contents.appendChild(hdr);
                data.tracks.forEach(p => {
                    const li = document.createElement('li');
                    li.className = 'pb-view-track-row';
                    const fname = p.split('/').pop();
                    li.innerHTML =
                        `<span class="pb-view-icon">🎵</span>` +
                        `<span class="pb-view-path" title="${_esc(p)}">${_esc(fname)}</span>` +
                        `<span class="pb-view-full-path">${_esc(p)}</span>` +
                        `<button class="pb-view-del-btn" title="Remove track from playlist">✕</button>`;
                    li.querySelector('.pb-view-del-btn').addEventListener('click', () =>
                        removeAzTracks(playlistId, [p], li));
                    ul.appendChild(li);
                });
            }

            contents.appendChild(ul);
            contents.classList.remove('hidden');
        } catch (e) {
            status.textContent = '✗ ' + e.message; status.className = 'pb-push-status error';
        }
    }

    async function removeAzTracks(playlistId, paths, rowEl) {
        rowEl.classList.add('pb-view-removing');
        const status = document.getElementById('pbViewStatus');
        try {
            const r    = await apiFetch(`/api/azuracast/playlist/${playlistId}/remove`, 'POST',
                { type: 'tracks', paths });
            const data = await r.json();
            if (data.ok) {
                rowEl.remove();
                status.textContent = `✓ Track removed (${data.remaining} remain)`;
                status.className   = 'pb-push-status ok';
            } else {
                rowEl.classList.remove('pb-view-removing');
                status.textContent = '✗ ' + (data.error || 'Remove failed');
                status.className   = 'pb-push-status error';
            }
        } catch (e) {
            rowEl.classList.remove('pb-view-removing');
            status.textContent = '✗ ' + e.message;
            status.className   = 'pb-push-status error';
        }
    }

    async function removeAzFolder(playlistId, folderPath, count, rowEl) {
        if (!confirm(`Remove "${folderPath.split('/').pop()}" (${count} tracks) from this AzuraCast playlist?\n\nThis cannot be undone.`)) return;

        const status = document.getElementById('pbViewStatus');
        rowEl.classList.add('pb-view-removing');
        status.textContent = `⏳ Removing ${count} tracks…`;
        status.className   = 'pb-push-status loading';

        try {
            const r    = await apiFetch(`/api/azuracast/playlist/${playlistId}/remove`, 'POST',
                { type: 'folder', path: folderPath });
            const data = await r.json();
            if (data.ok) {
                rowEl.remove();
                status.textContent = `✓ Removed ${data.removed} tracks (${data.remaining} remain)`;
                status.className   = 'pb-push-status ok';
                showToast(`Removed ${data.removed} tracks from playlist`, 'ok');
            } else {
                rowEl.classList.remove('pb-view-removing');
                status.textContent = '✗ ' + (data.error || 'Remove failed');
                status.className   = 'pb-push-status error';
            }
        } catch (e) {
            rowEl.classList.remove('pb-view-removing');
            status.textContent = '✗ ' + e.message;
            status.className   = 'pb-push-status error';
        }
    }

    // ── Public ────────────────────────────────────────────────────────────────
    function init() {
        document.getElementById('pbExportBtn')?.addEventListener('click', exportM3U);
        document.getElementById('pbClearBtn')?.addEventListener('click', () => {
            if (_playlist.length === 0) return;
            if (confirm('Clear playlist?')) clearPlaylist();
        });
        document.getElementById('pbRefreshBtn')?.addEventListener('click', loadTree);
        document.getElementById('pbPushBtn')?.addEventListener('click', pushToAzuraCast);
        document.getElementById('pbViewBtn')?.addEventListener('click', openViewPanel);
        document.getElementById('pbViewLoadBtn')?.addEventListener('click', loadAzContents);
        document.getElementById('pbViewCloseBtn')?.addEventListener('click', () => {
            document.getElementById('pbViewPanel')?.classList.add('hidden');
        });
        document.getElementById('pbViewSelect')?.addEventListener('change', loadAzContents);
        document.getElementById('pbPushConfirmBtn')?.addEventListener('click', doPush);
        document.getElementById('pbPushCancelBtn')?.addEventListener('click', () => {
            document.getElementById('pbPushPanel')?.classList.add('hidden');
        });
    }

    return { init, loadTree, isLoaded: () => _loaded };
})();

document.addEventListener('DOMContentLoaded', () => {
    // Build both player panels from the shared template before any event binding.
    buildPlayerPanel('ra');   // → #raLeft   (Player 1)
    buildPlayerPanel('rb');   // → #raLeftB  (Player 2)

    // Bootstrap Web Audio on first user gesture (browser policy requires this).
    // After init, all RA audio routes through the RT PGM bus — not directly to speakers.
    const _initWAOnGesture = () => {
        WA.syncToConsole();           // creates WA AudioContext + connects all sources
        document.removeEventListener('click',   _initWAOnGesture);
        document.removeEventListener('keydown', _initWAOnGesture);
    };
    document.addEventListener('click',   _initWAOnGesture);
    document.addEventListener('keydown', _initWAOnGesture);
    startClock();
    initTabs();
    bindEvents();
    bindSettingsEvents();
    PlaylistBuilder.init();
    connectWS();

    // ── Console resize handle ─────────────────────────────────────────────────
    // Drag the grippy bar between the now-playing bar and the console to resize.
    // Min height: 378px (~100mm at 96dpi).
    // Max height: viewport - 10mm (38px) bottom gap - bars above console.
    (function initConsoleResize() {
        const handle = document.getElementById('consoleResizeHandle');
        const wrap   = document.getElementById('consoleWrap');
        if (!handle || !wrap) return;

        const MIN_H = 378;   // ~100mm at 96dpi

        function maxH() {
            const wrapTop = wrap.getBoundingClientRect().top;
            return Math.max(MIN_H, window.innerHeight - wrapTop - 38); // 38px = ~10mm
        }

        // Set initial height so flex:1 is replaced by explicit px
        function initHeight() {
            const h = Math.min(maxH(), Math.max(MIN_H, wrap.clientHeight));
            wrap.style.height    = h + 'px';
            wrap.style.flex      = 'none';
            wrap.style.maxHeight = maxH() + 'px';
        }
        // Slight delay so layout has settled
        setTimeout(initHeight, 100);

        // Track what fraction of available vertical space the console occupies.
        // When the window resizes, restore that same fraction — so the console
        // grows AND shrinks proportionally instead of locking at the old px value.
        let _heightFraction = null;  // 0..1, set on first meaningful resize

        window.addEventListener('resize', () => {
            const mh = maxH();
            wrap.style.maxHeight = mh + 'px';

            const currentH = parseInt(wrap.style.height) || wrap.clientHeight;

            if (_heightFraction === null) {
                // First resize — compute fraction from current state
                _heightFraction = currentH / mh;
            }

            // Restore the same fraction of the new available height
            const targetH = Math.round(mh * _heightFraction);
            const newH    = Math.min(mh, Math.max(MIN_H, targetH));
            wrap.style.height = newH + 'px';
        });

        // Update fraction whenever the user manually drags the handle
        handle.addEventListener('pointerup', () => {
            const mh       = maxH();
            const currentH = parseInt(wrap.style.height) || wrap.clientHeight;
            _heightFraction = Math.min(1, currentH / Math.max(1, mh));
        });

        let _startY = 0, _startH = 0;

        handle.addEventListener('pointerdown', (e) => {
            e.preventDefault();
            handle.classList.add('dragging');
            handle.setPointerCapture(e.pointerId);
            _startY = e.clientY;
            _startH = wrap.clientHeight;
        });

        handle.addEventListener('pointermove', (e) => {
            if (!handle.classList.contains('dragging')) return;
            const delta = e.clientY - _startY;
            const newH  = Math.min(maxH(), Math.max(MIN_H, _startH + delta));
            wrap.style.height = newH + 'px';
        });

        handle.addEventListener('pointerup', () => {
            handle.classList.remove('dragging');
        });
    })();
});
