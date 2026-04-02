/**
 * Chilled Koala v2.0.0
 * Stream Ecosystem for AzuraCast — IP-12 Style Console
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
 * KISS: Simple · Secure · Reliable · Bulletproof
 */

'use strict';

const express   = require('express');
const http      = require('http');
const WebSocket = require('ws');
const session   = require('express-session');
const FileStore = require('session-file-store')(session);
const bp        = require('body-parser');
const path      = require('path');
const fs        = require('fs');
const ini       = require('ini');
const crypto    = require('crypto');
const { spawn } = require('child_process');

// ── Build number — single source of truth: package.json ──────────────────────
const BUILD = (() => {
    try { return require('./package.json').build || require('./package.json').version; }
    catch (_) { return 'unknown'; }
})();

// ── Library Rescan Jobs ───────────────────────────────────────────────────────
// Singer Magpie pattern: POST to start → job_id returned immediately.
// Browser polls GET /api/library/reindex/status/:job_id every second.
// No WebSocket involvement — eliminates all WS timing/stuck-flag issues.
const SCAN_JOBS = {};
function _newJobId() { return crypto.randomBytes(8).toString('hex'); }
function _scanJobCleanup() {
    const now = Date.now();
    for (const id of Object.keys(SCAN_JOBS)) {
        const j = SCAN_JOBS[id];
        if (j.status !== 'running' && (now - j.startedAt) > 1800000) delete SCAN_JOBS[id];
    }
}

// ── Config ────────────────────────────────────────────────────────────────────

const CONFIG_FILE = path.join(__dirname, 'config.ini');

function loadConfig() {
    try {
        const raw = fs.readFileSync(CONFIG_FILE, 'utf-8');
        const cfg = ini.parse(raw);
        // The ini parser treats ':' as a key=value separator, which corrupts
        // api_key values like "abc123:def456". Extract it from the raw text instead.
        if (cfg.azuracast) {
            const m = raw.match(/^\s*api_key\s*[=:]\s*"?([^"\r\n]+)"?\s*(?:#.*)?$/m);
            if (m) cfg.azuracast.api_key = m[1].trim();
        }
        console.log('✓ config.ini loaded');
        return cfg;
    } catch (err) {
        console.error('✗ FATAL: Cannot load config.ini:', err.message);
        process.exit(1);
    }
}

function saveConfig() {
    try {
        let out = ini.stringify(config);
        // ini.stringify drops the ':' half of api_key — rewrite it quoted so it
        // survives the next reload. Works whether or not the key contains ':'.
        const apiKey = config.azuracast?.api_key;
        if (apiKey) out = out.replace(/^(api_key\s*=\s*).*$/m, `$1"${apiKey}"`);
        fs.writeFileSync(CONFIG_FILE, out);
    } catch (err) {
        console.error('✗ saveConfig failed:', err.message);
    }
}

let config = loadConfig();

// ── Express ───────────────────────────────────────────────────────────────────

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ noServer: true });   // main DJ WebSocket
const wssTap = new WebSocket.Server({ noServer: true });   // /ws/mon earphone + /ws/djm signalling

app.set('trust proxy', 1);
app.get('/favicon.ico', (req, res) => res.status(204).end());

// ── Session ───────────────────────────────────────────────────────────────────

const IS_HTTPS = String(config.general?.public_url || '').startsWith('https');

const sessionMiddleware = session({
    secret:            config.security.session_secret || 'change-this-secret',
    resave:            false,
    saveUninitialized: false,
    store:             new FileStore({
        path:    path.join(__dirname, 'sessions'),
        ttl:     parseInt(config.security.session_timeout) || 28800,
        retries: 0,
        logFn:   () => {}   // silence file-store debug output
    }),
    cookie: {
        maxAge:   (parseInt(config.security.session_timeout) || 28800) * 1000,
        httpOnly: true,
        secure:   IS_HTTPS,
        sameSite: 'strict'
    }
});

// ── Middleware ────────────────────────────────────────────────────────────────

app.use(bp.json({ limit: '1mb' }));
app.use(bp.urlencoded({ extended: false }));
app.use(sessionMiddleware);

// ── Auth guard ────────────────────────────────────────────────────────────────

const PUBLIC_PATHS = new Set(['/login', '/api/auth/login', '/api/health', '/favicon.ico', '/style.css', '/app.js', '/call.html', '/mediasoup-client.js', '/pcm-player.js', '/earphone-worklet.js', '/mic-capture-worklet.js']);

app.use((req, res, next) => {
    const p = req.path;
    if (PUBLIC_PATHS.has(p))        return next();
    if (req.session?.authenticated) return next();
    if (p.startsWith('/api/'))      return res.status(401).json({ error: 'Not authenticated' });
    return res.redirect('/login');
});

// Serve static files (all at root — flat install, no templates/ subdirectory)
// app.js and style.css: versioned via ?v=BUILD in index.html — cache 1 hour
// Static libs (worklets, pcm-player): never change between deploys — cache 24 hours
// index.html / login.html / call.html: always no-store (contain inline build number)
app.get('/style.css', (req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.sendFile(path.join(__dirname, 'style.css'));
});
app.get('/app.js', (req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.sendFile(path.join(__dirname, 'app.js'));
});
app.get('/pcm-player.js', (req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.sendFile(path.join(__dirname, 'pcm-player.js'));
});
app.get('/earphone-worklet.js', (req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.setHeader('Content-Type', 'application/javascript');
    res.sendFile(path.join(__dirname, 'earphone-worklet.js'));
});
app.get('/mic-capture-worklet.js', (req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.setHeader('Content-Type', 'application/javascript');
    res.sendFile(path.join(__dirname, 'mic-capture-worklet.js'));
});

// ── Modules ───────────────────────────────────────────────────────────────────

const AuthManager      = require('./auth');
const AudioMixer       = require('./mixer');
const { ServerPlayer, taper } = require('./player');
const BroadcastConsole = require('./console');
const LivePlaylist     = require('./playlist');
const MusicLibrary     = require('./library');

const WebRTCGuests     = require('./webrtc');

const auth     = new AuthManager(config);
const mixer    = new AudioMixer(config);
const player1  = new ServerPlayer();   // RA Player 1 — reads FLAC on VPS
const player2  = new ServerPlayer();   // Player 2 — second FLAC player, same library as Player 1
mixer.setPlayers(player1, player2);    // wire consumed-bytes reporting for accurate position

// Periodic playlist-state refresh: updates trackState (playing/mixing/next) in real time
player1.on('progress', () => { raBroadcastPlaylist && raBroadcastPlaylist(); });
player2.on('progress', () => { rbBroadcastPlaylist && rbBroadcastPlaylist(); });
const rtcGuests = new WebRTCGuests();  // WebRTC guest callers → CH8
mixer._rtcGuests = rtcGuests;          // earphone WebRTC feed from mixer tick
const console_ = new BroadcastConsole(config);
const playlist  = new LivePlaylist(config);   // Player 1 playlist
const playlistB = new LivePlaylist(config);   // Player 2 playlist
const library  = new MusicLibrary(config);

// Initialise mediasoup (non-blocking — caller page shows error if not ready)
rtcGuests.init().catch(e => console.error('[webrtc] init error:', e.message));

// Map guestId → WebSocket for direct notification (on-air status, TB state)
const guestWsSessions = new Map();

// Wire guest PCM → mixer slot
rtcGuests.setOnPcm((guestId, chunk) => {
    const slot = rtcGuests.getGuestSlot(guestId);
    if (slot >= 0) mixer.feedGuest(slot, chunk);
});

// Wire DJ mic PCM → mixer mic key (same path as legacy WebSocket binary mic)
// DJ mic sessions are keyed by djMicId; each maps to a mixerKey (mic0/mic1/etc)
const djMicSessions = new Map();  // djMicId → { username, mixerKey }

rtcGuests.setOnDjPcm((djMicId, mixerKey, chunk) => {
    mixer.feedMicPcm(mixerKey, chunk);
});

// ── Server-side RA playback engine ───────────────────────────────────────────
// Replaces browser-side audio playback. Browser sends ra:play/pause/stop/next
// control commands; server plays FLAC via FFmpeg, feeds PCM to AudioMixer.

let _raIdx        = -1;   // current playlist index
let _raPaused     = false;
let _raXfSec      = parseFloat(config.audio?.crossfade_sec ?? 2);
let _raXfTimer    = null;
let _raStopped    = true;
let _raBreakAfter = false;
let _raGeneration = 0;   // prevents double-advance: each onEnd checks its captured gen

// NOTE: Player gain is applied exclusively by mixer._gains['player1'] in real-time.
// FFmpeg always outputs full-scale PCM — no gain baked at spawn time.
// raGetGain() / rbGetGain() removed — gain=1 is passed as a no-op placeholder.

function raPlay(idx, xfade) {
    const tracks = playlist.tracks;
    if (!tracks || idx < 0 || idx >= tracks.length) return;
    const track = tracks[idx];
    _raIdx      = idx;
    _raStopped  = false;
    _raPaused   = false;
    clearTimeout(_raXfTimer);

    // Each play call gets a unique generation ID.
    // The onEnd callback captures it and checks before advancing — this prevents
    // the double-advance bug where _schedRaXfade() fires first (starting the next
    // track and bumping _raIdx) and then the original onEnd also fires and
    // advances again, skipping a track.
    _raGeneration++;
    const myGen = _raGeneration;

    const gain = 1;  // mixer controls gain via _gains['player1'] in real-time

    const onPcm = (chunk) => mixer.feedPlayer1(chunk);
    const onEnd = () => {
        // Ignore stale callbacks — another raPlay() has already taken over
        if (myGen !== _raGeneration) return;
        if (_raStopped || _raPaused) return;
        const next = _raIdx + 1;
        if (_raBreakAfter || tracks[_raIdx]?.stop) {
            _raBreakAfter = false;
            raPause();
            return;
        }
        if (next < tracks.length) {
            raPlay(next, false);
        } else {
            // End of playlist — loop back to start
            raPlay(0, false);
        }
    };

    if (xfade && !_raStopped) {
        player1.crossfadeTo(track, gain, _raXfSec, onPcm, onEnd);
    } else {
        player1.play(track, gain, onPcm, onEnd);
    }

    playlist.setNowPlaying(idx);
    mixer.updateMetadata(track.title || '', track.artist || '');
    _schedRaXfade();

    broadcast({ type: 'ra:state', state: raGetState() });
    raBroadcastPlaylist();
    console.log(`▶ RA [${idx + 1}] ${track.artist} – ${track.title}`);
}

function raPause() {
    _raPaused = true;
    player1.pause();
    clearTimeout(_raXfTimer);
    broadcast({ type: 'ra:state', state: raGetState() });
    raBroadcastPlaylist();
}

function raResume() {
    if (!_raPaused) return;
    _raPaused = false;
    player1.resume();
    _schedRaXfade();
    broadcast({ type: 'ra:state', state: raGetState() });
}

function raStop() {
    _raStopped = true;
    _raPaused  = false;
    _raIdx     = -1;
    clearTimeout(_raXfTimer);
    player1.stop();
    playlist.clearNowPlaying();
    mixer.updateMetadata('', '');
    broadcast({ type: 'ra:state', state: raGetState() });
    raBroadcastPlaylist();
}

function _schedRaXfade() {
    clearTimeout(_raXfTimer);
    const tracks = playlist.tracks;
    const track  = tracks[_raIdx];
    if (!track || !track.duration || _raXfSec <= 0) return;
    const pos    = player1.positionSec();
    const mixMs  = Math.max(0, (track.duration - _raXfSec - pos) * 1000);
    _raXfTimer = setTimeout(() => {
        if (_raStopped || _raPaused) return;
        const next = _raIdx + 1;
        if (_raBreakAfter || tracks[_raIdx]?.stop) return; // let onEnd handle it
        if (next < tracks.length) {
            raPlay(next, true); // crossfade
        } else {
            raPlay(0, true);    // crossfade loop back to start
        }
    }, mixMs);
}

function raGetState() {
    const pl = player1.getState();
    return {
        playing:   !_raStopped && !_raPaused,
        paused:    _raPaused,
        stopped:   _raStopped,
        idx:       _raIdx,
        position:  pl.position,
        duration:  pl.track?.duration || 0,
        track:     pl.track,
        xfSec:     _raXfSec,
        serverNow: Date.now(),   // browser corrects for WS transport latency
    };
}

// Broadcast enriched playlist with track state for each row
// States (RadioBOSS model):
//   'played'  — already played, greyed out
//   'playing' — currently on air
//   'mixing'  — in crossfade window (current track fading out)
//   'next'    — immediate next track (cued, will start at mix point)
//   'queued'  — future tracks
function raBroadcastPlaylist() {
    const pl    = player1.getState();
    const pos   = pl.position;
    const dur   = pl.track?.duration || 0;
    const inXf  = dur > 0 && _raXfSec > 0 && pos >= (dur - _raXfSec);
    const tracks = playlist.getList();
    tracks.forEach(t => {
        if (t.index < _raIdx)       t.trackState = 'played';
        else if (t.index === _raIdx) t.trackState = inXf ? 'mixing' : 'playing';
        else if (t.index === _raIdx + 1) t.trackState = inXf ? 'next' : 'queued';
        else                         t.trackState = 'queued';
    });
    broadcast({ type: 'ra:playlist', tracks, xfSec: _raXfSec });
}

// ── Mic session management ───────────────────────────────────────────────────
// Each connected user who sends mic audio gets a sessionId (their WebSocket id).
// Primary DJ's sessions → mic0/mic1. Secondary DJ's sessions → mic2/mic3.
// On primary transfer, mixer.remapMic() is called to swap assignments.
//
// micSessions: Map of sessionId → { username, ws }
const micSessions = new Map();

// Assign mixer keys to mic sessions based on who is primary.
// Primary's mics → mic0, mic1 (CH1, CH2 on RT)
// Secondary's mics → mic2, mic3 (CH3, CH4 on RT)
function remapMicSessions() {
    let primaryIdx = 0;
    let secondaryIdx = 0;

    micSessions.forEach(({ username }, sessionId) => {
        const isPrimary = (username === primaryUser);
        let key;
        if (isPrimary) {
            key = primaryIdx < 2 ? `mic${primaryIdx}` : null;
            primaryIdx++;
        } else {
            key = secondaryIdx < 2 ? `mic${secondaryIdx + 2}` : null;
            secondaryIdx++;
        }
        if (key) mixer.remapMic(sessionId, key);
    });

    // Rebuild gain assignments — include BOTH WS (micSessions) and WebRTC (djMicSessions).
    // Previously only micSessions was iterated, so WebRTC mic gain was always 0.
    const micAssignments = [];
    const seen = new Set();

    const _gainForKey = (key) => {
        const _bySource = console_.channels?.find(c =>
            (c.type === 'mic' || c.type === 'remote') && (c.sourceA || '').toLowerCase() === key);
        const ch = _bySource || console_.channels?.find(c =>
            (c.type === 'mic' || c.type === 'remote') && c.id === parseInt(key.replace('mic', '')));
        return ch ? (ch.on ? taper(ch.fader ?? 80) : 0) : 0;
    };

    micSessions.forEach(({ username }, sessionId) => {
        const key = [...mixer._micMap.entries()].find(([s]) => s === sessionId)?.[1];
        if (!key || seen.has(key)) return;
        seen.add(key);
        micAssignments.push({ key, gain: _gainForKey(key) });
    });

    djMicSessions.forEach(({ mixerKey }) => {
        if (!mixerKey || seen.has(mixerKey)) return;
        seen.add(mixerKey);
        micAssignments.push({ key: mixerKey, gain: _gainForKey(mixerKey) });
    });

    mixer.syncConsole(console_.channels || [], micAssignments);
    rtcGuests.syncConsole(console_.channels || [], mixer);
    const g = mixer._gains || {};
}

// Sync player 1 gain + mic gains when console state changes
function syncMixerFromConsole() {
    // Build mic assignments from current sessions.
    // BOTH paths must be included:
    //   micSessions    — MediaRecorder/WS binary → feedMicChunk → FFmpeg decode → _feedBuf
    //   djMicSessions  — WebRTC mediasoup → feedMicPcm → _feedBuf directly
    // Previously only micSessions was iterated, so WebRTC mic gain was always 0.
    const micAssignments = [];
    const seen = new Set();   // avoid duplicate keys if both paths register same mixerKey

    const _gainForKey = (key) => {
        const _bySource = console_.channels?.find(c =>
            (c.type === 'mic' || c.type === 'remote') && (c.sourceA || '').toLowerCase() === key);
        const ch = _bySource || console_.channels?.find(c =>
            (c.type === 'mic' || c.type === 'remote') && c.id === parseInt(key.replace('mic', '')));
        return ch ? (ch.on ? taper(ch.fader ?? 80) : 0) : 0;
    };

    micSessions.forEach(({ username }, sessionId) => {
        const key = mixer._micMap.get(sessionId);
        if (!key || seen.has(key)) return;
        seen.add(key);
        micAssignments.push({ key, gain: _gainForKey(key) });
    });

    djMicSessions.forEach(({ mixerKey }) => {
        if (!mixerKey || seen.has(mixerKey)) return;
        seen.add(mixerKey);
        micAssignments.push({ key: mixerKey, gain: _gainForKey(mixerKey) });
    });

    mixer.syncConsole(console_.channels || [], micAssignments);
    rtcGuests.syncConsole(console_.channels || [], mixer);
}

// Sync CUE flags from console channels to mixer.
// Maps each channel's sourceA → mixerKey, sets flag true if ch.cue is active.
// Called whenever CUE state changes so the mixer outCue bus stays current.
function _syncCueFlags() {
    const cueMap = {};
    (console_.channels || []).forEach(ch => {
        if (!ch.cue) return;
        const src = (ch.sourceA || '').toLowerCase();
        if (src) cueMap[src] = true;
        // Normalise player_1/player_2 → player1/player2
        if (src === 'player_1') cueMap['player1'] = true;
        if (src === 'player_2') cueMap['player2'] = true;
    });
    mixer.setCueFlags(cueMap);
}

// Progress → broadcast every 250ms.
// serverNow in raGetState() stamps the exact moment position was read.
// Browser corrects: correctedPos = position + (Date.now()-_clockOffset-serverNow)/1000
setInterval(() => {
    if (!_raStopped && !_raPaused) broadcast({ type: 'ra:progress', state: raGetState() });
    if (!_rbStopped && !_rbPaused) broadcast({ type: 'rb:progress', state: rbGetState() });
}, 250);

// ── Player 2 engine (second ServerPlayer, same FLAC library) ────────────────────

let _rbIdx      = -1;
let _rbPaused   = false;
let _rbXfSec    = parseFloat(config.audio?.crossfade_sec ?? 2);   // from config.ini [audio] crossfade_sec
let _rbXfTimer  = null;
let _rbStopped  = true;
let _rbBreakAfter = false;
let _rbGeneration = 0;   // same fix as Player 1 — prevents double-advance on crossfade + onEnd


function rbPlay(idx, xfade) {
    const tracks = playlistB.tracks;
    if (!tracks || idx < 0 || idx >= tracks.length) return;
    const track = tracks[idx];
    _rbIdx     = idx;
    _rbStopped = false;
    _rbPaused  = false;
    clearTimeout(_rbXfTimer);

    _rbGeneration++;
    const myGen = _rbGeneration;

    const gain  = 1;  // mixer controls gain via _gains['player2'] in real-time
    const onPcm = (chunk) => mixer.feedPlayer2(chunk);
    const onEnd = () => {
        if (myGen !== _rbGeneration) return;  // stale — crossfade already advanced
        if (_rbStopped || _rbPaused) return;
        const next = _rbIdx + 1;
        if (_rbBreakAfter || tracks[_rbIdx]?.stop) { _rbBreakAfter = false; rbStop(); return; }
        if (next < tracks.length) rbPlay(next, false);
        else rbPlay(0, false);  // loop back to start
    };

    if (xfade && !_rbStopped) player2.crossfadeTo(track, gain, _rbXfSec, onPcm, onEnd);
    else                       player2.play(track, gain, onPcm, onEnd);

    playlistB.setNowPlaying(idx);
    _schedRbXfade();
    broadcast({ type: 'rb:state', state: rbGetState() });
    rbBroadcastPlaylist();
    console.log(`▶ RB [${idx + 1}] ${track.artist} – ${track.title}`);
}

function rbPause() {
    _rbPaused = true; player2.pause(); clearTimeout(_rbXfTimer);
    broadcast({ type: 'rb:state', state: rbGetState() });
}

function rbResume() {
    if (!_rbPaused) return;
    _rbPaused = false; player2.resume(); _schedRbXfade();
    broadcast({ type: 'rb:state', state: rbGetState() });
}

function rbStop() {
    _rbStopped = true; _rbPaused = false; _rbIdx = -1;
    clearTimeout(_rbXfTimer); player2.stop();
    playlistB.clearNowPlaying();
    broadcast({ type: 'rb:state', state: rbGetState() });
}

function _schedRbXfade() {
    clearTimeout(_rbXfTimer);
    const tracks = playlistB.tracks;
    const track  = tracks[_rbIdx];
    if (!track?.duration || _rbXfSec <= 0) return;
    const pos   = player2.positionSec();
    const mixMs = Math.max(0, (track.duration - _rbXfSec - pos) * 1000);
    _rbXfTimer  = setTimeout(() => {
        if (_rbStopped || _rbPaused) return;
        const next = _rbIdx + 1;
        if (_rbBreakAfter || playlistB.tracks[_rbIdx]?.stop) return;
        if (next < playlistB.tracks.length) rbPlay(next, true);
        else rbPlay(0, true);  // xfade loop
    }, mixMs);
}

function rbGetState() {
    const pl = player2.getState();
    return {
        playing:  !_rbStopped && !_rbPaused,
        paused:   _rbPaused,
        stopped:  _rbStopped,
        idx:      _rbIdx,
        position: pl.position,
        duration: pl.track?.duration || 0,
        track:    pl.track,
        xfSec:    _rbXfSec,
    };
}

function rbBroadcastPlaylist() {
    const pl   = player2.getState();
    const pos  = pl.position;
    const dur  = pl.track?.duration || 0;
    const inXf = dur > 0 && _rbXfSec > 0 && pos >= (dur - _rbXfSec);
    const tracks = playlistB.getList();
    tracks.forEach(t => {
        if (t.index < _rbIdx)            t.trackState = 'played';
        else if (t.index === _rbIdx)      t.trackState = inXf ? 'mixing' : 'playing';
        else if (t.index === _rbIdx + 1)  t.trackState = inXf ? 'next' : 'queued';
        else                              t.trackState = 'queued';
    });
    broadcast({ type: 'rb:playlist', tracks, xfSec: _rbXfSec });
}

// Startup: load library from disk cache (instant, no filesystem scan).
// If cache is absent (first run or after upgrade.sh clears it), the library
// panel shows empty — operator uses Settings → Reindex to build it.
// Cache is saved automatically after every reindex.
const cacheLoaded = library.loadCache();
library.loadCart();
if (cacheLoaded) {
    // Cache loaded — nothing to broadcast yet; browsers get count on WS connect
    console.log(`✓ Library ready from cache (${library.getIndex().length} tracks)`);
} else {
    console.log('📚 No library cache — run Settings → Rescan & Rebuild Cache');
}

// Restore mic delay compensation from config.ini (already loaded into mixer constructor)
if (mixer.getMicDelayMs() > 0) {
    console.log(`✓ Mic delay compensation: ${mixer.getMicDelayMs()}ms (from config.ini)`);
}

// ── Multi-user Primary Control ────────────────────────────────────────────────
// Only the "primary" DJ can operate the console/stream.
// Primary is set to the first user who connects. Any authenticated user can view.
// Current primary can pass control to any connected user.

let primaryUser = null;   // username of current primary DJ

// Map of username → Set of WebSocket connections (same user may have 2 tabs)
const connectedUsers = new Map();

function setPrimary(username) {
    primaryUser = username;
    broadcastUsers();
    // Remap mic sessions: new primary's mics → CH1/CH2, others → CH3/CH4
    remapMicSessions();
}

function getConnectedUserList() {
    const list = [];
    connectedUsers.forEach((sockets, username) => {
        if (sockets.size > 0) {
            list.push({ username, isPrimary: username === primaryUser });
        }
    });
    return list;
}

function broadcastUsers() {
    const msg = JSON.stringify({
        type:        'users:list',
        users:       getConnectedUserList(),
        primaryUser: primaryUser,
    });
    wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(msg); });
}

function isPrimary(ws) {
    return ws._username === primaryUser;
}

// ── Event → broadcast wiring ─────────────────────────────────────────────────

mixer.on('started',         () => broadcast({ type: 'stream:started', status: mixer.getStatus() }));
mixer.on('stopped',         () => { console.log(`[${new Date().toISOString()}] ⏹ Stream STOPPED`); broadcast({ type: 'stream:stopped', status: mixer.getStatus() }); });
mixer.on('dropped',         () => { console.log(`[${new Date().toISOString()}] ⚠ Stream DROPPED (Liquidsoap connection lost)`); broadcast({ type: 'stream:dropped', status: mixer.getStatus() }); });
mixer.on('error',      (e)  => broadcast({ type: 'stream:error',   error: e, status: mixer.getStatus() }));
mixer.on('metadataUpdated', (m) => broadcast({ type: 'stream:metadata', metadata: m }));

console_.on('stateChange', (s) => {
    broadcast({ type: 'console:state', state: s });
    syncMixerFromConsole();
    _syncCueFlags();
});

playlist.on('updated',    (l)  => broadcast({ type: 'playlist:updated', list: l }));
playlist.on('nowPlaying', (t) => {
    broadcast({ type: 'playlist:nowPlaying', track: t });
    if (t) mixer.updateMetadata(t.title || '', t.artist || '');
});

// Real VU levels from mixer → broadcast to all connected DJs
mixer.on('levels', (levels) => {
    broadcast({ type: 'vu:levels', levels });
});

playlistB.on('updated',    (l)  => broadcast({ type: 'playlistB:updated', list: l }));
playlistB.on('nowPlaying', (t)  => broadcast({ type: 'playlistB:nowPlaying', track: t }));

rtcGuests.on('guestList',   (list) => broadcast({ type: 'guest:list', guests: list }));
rtcGuests.on('ready',       ()     => broadcast({ type: 'guest:ready' }));
rtcGuests.on('guestStatus', ({ guestId, slot, onAir, inTB }) => {
    // Notify the specific guest's WebSocket so their page updates
    const ws = guestWsSessions.get(guestId);
    if (ws?.readyState === 1) {
        ws.send(JSON.stringify({ type: 'guest:onAir', payload: { onAir, inTB, slot, ch: slot + 7 } }));
    }
    // Also broadcast to DJ for guest panel display
    broadcast({ type: 'guest:status', guestId, onAir, inTB, slot, ch: slot + 7 });
});

// ── WebSocket heartbeat ───────────────────────────────────────────────────────

const WS_PING_INTERVAL = 30000;

setInterval(() => {
    wss.clients.forEach(ws => {
        if (ws.isAlive === false) { ws.terminate(); return; }
        ws.isAlive = false;
        ws.ping();
    });
    wssTap.clients.forEach(ws => {
        if (ws.isAlive === false) { ws.terminate(); return; }
        ws.isAlive = false;
        ws.ping();
    });
}, WS_PING_INTERVAL);

// ── WebSocket ─────────────────────────────────────────────────────────────────

wss.on('connection', (ws, req) => {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    sessionMiddleware(req, {}, () => {
        if (!req.session?.authenticated) {
            ws.close(1008, 'Not authenticated');
            return;
        }

        const username = req.session.username;
        ws._username   = username;

        // Track connection
        if (!connectedUsers.has(username)) connectedUsers.set(username, new Set());
        connectedUsers.get(username).add(ws);

        // First browser connected — start mixer ticker and monitor encoder
        if (wss.clients.size === 1) {
            mixer.startTicker();  // resume mix ticker (was stopped when last browser left)
            mixer.startMonitor(); // start PGM monitor FFmpeg encoder
        }

        // Sync mixer gains from current console state immediately on connect.
        // Without this, _gains stays {} (all zero) until the DJ moves a fader or
        // toggles a channel — the monitor encoder would output silence until then.
        syncMixerFromConsole();


        // First user to connect becomes primary automatically
        if (!primaryUser) setPrimary(username);

        console.log(`✓ WS [${username}] primary=${primaryUser}`);

        // Full state snapshot on connect
        safeSend(ws, {
            type:        'init',
            console:     console_.getState(),
            stream:      mixer.getStatus(),
            playlistB:   playlistB.getList(),
            rbState:     rbGetState(),
            guests:      rtcGuests.getGuestList(),
            playlist:    playlist.getList(),
            library:     { indexed: library.isReady(), count: library.getIndex().length, path: library.musicPath },
            config: {
                version:   config.general.app_version,
                musicPath: library.musicPath,
                icecast: {
                    server:            config.icecast.server,
                    port:              config.icecast.port,
                    mount:             config.icecast.mount,
                    listener_mount:    config.icecast.listener_mount || config.icecast.mount,
                    https:             config.icecast.https,
                    // public_stream_url: URL the DJ browser fetches for earphone monitoring.
                    // icecast.server=127.0.0.1 is VPS-internal — unreachable from PC browser.
                    // Set this to the public AzuraCast stream URL in config.ini [icecast].
                    public_stream_url: config.icecast.public_stream_url || '',
                }
            },
            username,
            primaryUser,
            users:       getConnectedUserList(),
        });

        // Notify all clients of new user list
        broadcastUsers();

        // Register as monitor client AFTER sending init.
        // The browser's init handler calls Monitor.start() synchronously,
        // setting _active=true. Binary WebM chunks then arrive while _active=true
        // and are queued correctly — including the critical WebM init segment.
        const _monCb = (chunk) => {
            if (ws.readyState === ws.constructor.OPEN) {
                try { ws.send(chunk, { binary: true }); } catch (_) {}
            }
        };
        ws._monitorCb = _monCb;
        mixer.addMonitorClient(_monCb);

        ws.on('message', async (raw, isBinary) => {
            try {
                if (isBinary) {
                    // Binary message = mic audio chunk (WebM/Opus) from browser MediaRecorder → mixer
                    // Register mic session on first binary frame from this WebSocket.
                    // Session registration used to live in the (now-removed) stream:audioChunk
                    // JSON handler — moved here so it works with the binary-only mic path.
                    if (!ws._micSessionId) {
                        const uname = ws._username;
                        const sid   = `mic_${uname}_${Date.now()}`;
                        ws._micSessionId = sid;
                        micSessions.set(sid, { username: uname, ws });
                        // Assign mixer key: primary → mic0/mic1, secondary → mic2/mic3
                        const isPrim = (uname === primaryUser);
                        let pCount = 0, sCount = 0;
                        micSessions.forEach((s, id) => {
                            if (id === sid) return;
                            if (s.username === primaryUser) pCount++; else sCount++;
                        });
                        const key = isPrim
                            ? (pCount < 2 ? `mic${pCount}` : null)
                            : (sCount < 2 ? `mic${sCount + 2}` : null);
                        if (key) {
                            mixer.assignMic(sid, key);
                            syncMixerFromConsole();   // apply current fader/ON gain immediately
                            console.log(`[mic] Registered ${uname} → ${key}`);
                        }
                    }
                    // Detect PCM16 raw frames (from AudioWorklet) vs WebM (from MediaRecorder).
                    // AudioWorklet sends a 4-byte magic prefix 'PCM\0' followed by Int16 mono data.
                    // All other binary = WebM from MediaRecorder → FFmpeg decoder path.
                    const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
                    // Detect Float32 frames (F32\0 magic) from AudioWorklet vs WebM from MediaRecorder.
                    // F32\0 = 0x46 0x33 0x32 0x00 — Float32 mono 48kHz from mic-capture-worklet.js
                    if (buf.length >= 4 && buf[0] === 0x46 && buf[1] === 0x33 && buf[2] === 0x32 && buf[3] === 0x00) {
                        const f32Buf = buf.slice(4);
                        const ab = f32Buf.buffer.slice(f32Buf.byteOffset, f32Buf.byteOffset + f32Buf.byteLength);
                        mixer.feedMicF32(ws._micSessionId, ab);
                    } else {
                        mixer.feedMicChunk(ws._micSessionId, raw);
                    }
                    return;
                }
                await handleWS(ws, JSON.parse(raw));
            } catch (err) {
                console.error('WS handler error:', err.message);
                safeSend(ws, { type: 'error', message: err.message });
            }
        });

        ws.on('error', (e) => console.error('WS error:', e.message));

        ws.on('close', () => {
            const sockets = connectedUsers.get(username);
            if (sockets) {
                sockets.delete(ws);
                if (sockets.size === 0) connectedUsers.delete(username);
            }
            // Release mic session if this WS had one
            const wsId = ws._micSessionId;
            if (wsId) {
                micSessions.delete(wsId);
                mixer.releaseMic(wsId);
            }
            // If primary disconnected while streaming → stop stream immediately
            if (primaryUser === username && mixer.isStreaming()) {
                console.log(`⚠ Primary [${username}] browser closed — stopping stream`);
                raStop();
                mixer.stop();
            }
            // If primary disconnected, auto-pass to next connected user
            if (primaryUser === username && connectedUsers.size > 0) {
                const next = connectedUsers.keys().next().value;
                setPrimary(next);   // also triggers remapMicSessions()
                console.log(`✓ Primary auto-passed to [${next}]`);
            } else if (connectedUsers.size === 0) {
                primaryUser = null;
            }
            // Remove this WS from monitor clients
            if (ws._monitorCb) mixer.removeMonitorClient(ws._monitorCb);

            broadcastUsers();
            console.log(`✓ WS closed [${username}]`);
            // Last browser disconnected — shut everything down.
            // AzuraCast AutoDJ takes over Liquidsoap/Icecast automatically.
            if (wss.clients.size === 0) {
                mixer.stopMonitor();  // kill monitor FFmpeg
                mixer.stopTicker();   // stop mix ticker — nothing to mix
                console.log('⏹ No browsers connected — mixer idle');
            }
        });
    });
});

async function handleWS(ws, msg) {
    const { type, payload = {} } = msg;

    // ── Primary-only guard for control operations ─────────────────────────────
    // Every operation that changes server state requires primary DJ.
    // Secondary/remote users can only observe — they cannot control playback,
    // stream, console, playlist, library, config, or kick guests.
    const controlOps = new Set([
        // Console
        'console:on','console:cue','console:tb','console:fader','console:source',
        'console:monitor','console:hostCh','console:chConfig',
        'console:timer:start','console:timer:stop','console:timer:reset',
        // Stream
        'stream:start','stream:stop','stream:metadata',
        // Player 1 playlist
        'playlist:add','playlist:insertNext','playlist:remove',
        'playlist:stop','playlist:setNow','playlist:clear',
        // Player 1 transport
        'ra:play','ra:pause','ra:stop','ra:next','ra:prev','ra:xfade','ra:breakAfter',
        // Player 2 playlist
        'playlistB:add','playlistB:insertNext','playlistB:remove',
        'playlistB:stop','playlistB:clear',
        // Player 2 transport
        'rb:play','rb:pause','rb:stop','rb:next','rb:prev','rb:xfade','rb:breakAfter',
        // Library + config
        'library:reindex','config:save',
        // Guest management
        'guest:kick',
    ]);

    if (controlOps.has(type) && !isPrimary(ws)) {
        safeSend(ws, { type: 'error', message: 'Primary DJ only.' });
        return;
    }

    switch (type) {

        // ── Clock sync — browser sends t0, server echoes with t1 ─────────────
        // Browser computes RTT = Date.now()-t0, one-way = RTT/2
        // clockOffset = serverT1 - (t0 + RTT/2) = skew between VPS and PC clocks
        // Used to correct serverNow timestamps in ra:progress so displayed
        // position matches audio regardless of VPS/PC clock difference.
        case 'clock:ping':
            safeSend(ws, { type: 'clock:pong', t0: msg.t0, t1: Date.now() });
            break;

        // ── Primary handoff ───────────────────────────────────────────────────
        case 'users:passControl': {
            // Only current primary can pass control
            if (!isPrimary(ws)) {
                safeSend(ws, { type: 'error', message: 'Only primary DJ can pass control.' });
                break;
            }
            const target = payload.username;
            if (!connectedUsers.has(target)) {
                safeSend(ws, { type: 'error', message: `User ${target} is not connected.` });
                break;
            }
            setPrimary(target);
            console.log(`✓ Control passed: [${ws._username}] → [${target}]`);
            break;
        }

        // ── Console ──────────────────────────────────────────────────────────
        // NOTE: syncMixerFromConsole() is called after every action that changes
        // gain routing — ON/OFF, fader, source, cue. Without this the mixer keeps
        // the gain snapshot from the initial connect-time sync (all channels OFF = 0).
        case 'console:on':
            console_.setOn(payload.chId, payload.on);
            syncMixerFromConsole();
            break;
        case 'console:cue':
            console_.setCue(payload.chId, payload.active);
            syncMixerFromConsole();
            // Push updated CUE flags to mixer so outCue bus reflects current state
            _syncCueFlags();
            break;
        case 'console:tb':
            console_.setTB(payload.chId, payload.active);
            syncMixerFromConsole();
            break;
        case 'console:fader':
            console_.setFader(payload.chId, payload.pos);
            syncMixerFromConsole();
            break;
        case 'console:source':
            console_.setSource(payload.chId, payload.source);
            syncMixerFromConsole();
            break;
        case 'console:monitor':
            console_.setMonitor(payload.source, payload.volume);
            // Switch mixer monitor bus: 'pgm1' → outMix1, 'cue' → outCue
            if (payload.source) mixer.setMonitorSource(payload.source);
            break;
        case 'console:hostCh':   console_.setHostChannel(payload.chId);                  break;
        case 'console:chConfig':
            console_.setChannelConfig(payload.chId, payload);
            saveConfig();
            syncMixerFromConsole();
            break;
        case 'console:timer:start': console_.timerStart(); break;
        case 'console:timer:stop':  console_.timerStop();  break;
        case 'console:timer:reset': console_.timerReset(); break;

        // ── Stream ───────────────────────────────────────────────────────────
        case 'stream:start': {
            if (!mixer.isStreaming() && !mixer.isConnecting()) {
                if (!config.azuracast_dj) config.azuracast_dj = {};
                if (payload.username) config.azuracast_dj.username = payload.username;
                if (payload.password) config.azuracast_dj.password = payload.password;
                syncMixerFromConsole();
                // Player 2 plays via serverPlayer (player2) — no capture needed
                await mixer.start();
            }
            break;
        }
        case 'stream:stop':
            raStop();
            await mixer.stop();
            break;
        case 'stream:metadata':
            mixer.updateMetadata(payload.title, payload.artist);
            break;

        // ── RA Player (server-side) ───────────────────────────────────────────
        case 'ra:play':
            raPlay(payload.index ?? 0, false);
            break;
        case 'ra:pause':
            _raPaused ? raResume() : raPause();
            break;
        case 'ra:stop':
            raStop();
            break;
        case 'ra:next': {
            const nxt = _raIdx + 1;
            if (nxt < playlist.tracks.length) raPlay(nxt, false);
            break;
        }
        case 'ra:prev': {
            const prv = Math.max(0, _raIdx - 1);
            raPlay(prv, false);
            break;
        }
        case 'ra:xfade':
            _raXfSec = Math.max(0, parseFloat(payload.sec) || 0);
            if (!_raStopped && !_raPaused) _schedRaXfade();
            break;
        case 'ra:breakAfter':
            _raBreakAfter = !!payload.active;
            broadcast({ type: 'ra:state', state: raGetState() });
            break;

        // ── Player 2 controls ───────────────────────────────────────────────────
        case 'rb:play':
            rbPlay(payload.index ?? 0, false);
            break;
        case 'rb:pause':
            _rbPaused ? rbResume() : rbPause();
            break;
        case 'rb:stop':
            rbStop();
            break;
        case 'rb:next': {
            const nxtB = _rbIdx + 1;
            if (nxtB < playlistB.tracks.length) rbPlay(nxtB, false);
            break;
        }
        case 'rb:prev': {
            const prvB = Math.max(0, _rbIdx - 1);
            rbPlay(prvB, false);
            break;
        }
        case 'rb:xfade':
            _rbXfSec = Math.max(0, parseFloat(payload.sec) || 0);
            if (!_rbStopped && !_rbPaused) _schedRbXfade();
            break;
        case 'rb:breakAfter':
            _rbBreakAfter = !!payload.active;
            broadcast({ type: 'rb:state', state: rbGetState() });
            break;

        // ── Player 2 playlist management ──────────────────────────────────────
        case 'playlistB:add': {
            const tb = library.getTrack(payload.path) || payload;
            if (payload.path && !library.isPathAllowed(payload.path)) {
                safeSend(ws, { type: 'error', message: 'Path not in allowed library.' });
                break;
            }
            playlistB.addTrack(tb);
            break;
        }
        case 'playlistB:insertNext': {
            const tb = library.getTrack(payload.path) || payload;
            if (payload.path && !library.isPathAllowed(payload.path)) {
                safeSend(ws, { type: 'error', message: 'Path not in allowed library.' });
                break;
            }
            playlistB.insertNext(tb);
            break;
        }
        case 'playlistB:remove':   playlistB.removeTrack(payload.index);  break;
        case 'playlistB:stop':     playlistB.toggleStop(payload.index);   break;
        case 'playlistB:clear':    playlistB.clear();                      break;

        // ── WebRTC guest management (primary only) ────────────────────────────
        case 'guest:kick':
            rtcGuests.disconnectGuest(payload.guestId);
            break;

        // ── Playlist ─────────────────────────────────────────────────────────
        case 'playlist:add': {
            const t = library.getTrack(payload.path) || payload;
            if (payload.path && !library.isPathAllowed(payload.path)) {
                safeSend(ws, { type: 'error', message: 'Path not in allowed library.' });
                break;
            }
            playlist.addTrack(t);
            break;
        }
        case 'playlist:insertNext': {
            const t = library.getTrack(payload.path) || payload;
            if (payload.path && !library.isPathAllowed(payload.path)) {
                safeSend(ws, { type: 'error', message: 'Path not in allowed library.' });
                break;
            }
            playlist.insertNext(t);
            break;
        }
        case 'playlist:remove':   playlist.removeTrack(payload.index);  break;
        case 'playlist:stop':     playlist.toggleStop(payload.index);   break;
        case 'playlist:setNow':
            if (payload.index === -1) playlist.clearNowPlaying();
            else playlist.setNowPlaying(payload.index);
            break;
        case 'playlist:clear':    playlist.clear();                      break;

        // ── Library ──────────────────────────────────────────────────────────
        case 'library:reindex':
            // Primary DJ sends this from the button click.
            // Actual scan runs via REST job (POST /api/library/reindex).
            // WS case kept for compatibility — triggers the same job and
            // broadcasts library:indexing so observers see scan started.
            {
                _scanJobCleanup();
                const jid = _newJobId();
                SCAN_JOBS[jid] = { status: 'running', scanned: 0, error: null, startedAt: Date.now() };
                broadcast({ type: 'library:indexing', path: library.musicPath, jobId: jid });
                setImmediate(async () => {
                    try {
                        await library.rescan((scanned) => {
                            if (SCAN_JOBS[jid]) SCAN_JOBS[jid].scanned = scanned;
                        });
                        await library.loadCart();
                        if (SCAN_JOBS[jid]) SCAN_JOBS[jid].status = 'done';
                        broadcast({ type: 'library:ready', count: library.getIndex().length });
                    } catch (err) {
                        if (SCAN_JOBS[jid]) { SCAN_JOBS[jid].status = 'error'; SCAN_JOBS[jid].error = err.message; }
                    }
                });
            }
            break;

        // ── Settings ─────────────────────────────────────────────────────────
        case 'config:save': {
            const { musicPath, icecastServer, icecastPort, icecastMount, icecastPassword,
                    listenerMount, djServer, djPort, djMount } = payload;
            if (musicPath)       { config.paths.music_library_path = musicPath; library.setMusicPath(musicPath); }
            if (icecastServer)   config.icecast.server         = icecastServer;
            if (icecastPort)     config.icecast.port           = String(icecastPort);
            if (icecastMount)    config.icecast.mount          = icecastMount;
            if (icecastPassword) config.icecast.password       = icecastPassword;
            if (listenerMount)       config.icecast.listener_mount    = listenerMount;
            if (payload.publicStreamUrl) config.icecast.public_stream_url = payload.publicStreamUrl;
            if (!config.azuracast_dj) config.azuracast_dj = {};
            if (djServer) config.azuracast_dj.server = djServer;
            if (djPort)   config.azuracast_dj.port   = String(djPort);
            if (djMount)  config.azuracast_dj.mount  = djMount;
            saveConfig();
            const ic = config.icecast;
            safeSend(ws, { type: 'config:saved', config: {
                musicPath: library.musicPath,
                icecast: { server: ic.server, port: ic.port, mount: ic.mount, listener_mount: ic.listener_mount || ic.mount, public_stream_url: ic.public_stream_url || '' }
            }});
            broadcast({ type: 'config:updated', musicPath: library.musicPath });
            break;
        }

        default:
            safeSend(ws, { type: 'error', message: `Unknown: ${type}` });
    }
}

// ── REST API ──────────────────────────────────────────────────────────────────

function auth_(req, res, next) {
    return req.session?.authenticated ? next() : res.status(401).json({ error: 'Not authenticated' });
}

// Primary-only guard for REST endpoints.
// Any authenticated user can read data; only primary DJ can change it.
function primaryOnly(req, res, next) {
    if (!req.session?.authenticated)
        return res.status(401).json({ error: 'Not authenticated' });
    // If no primary DJ is connected yet (server just restarted, WS not yet open),
    // allow any authenticated user — matches the WS "first to connect becomes primary" rule.
    if (primaryUser && req.session.username !== primaryUser)
        return res.status(403).json({ error: 'Primary DJ only.' });
    next();
}

// Login / logout
app.get('/login', (req, res) => {
    if (req.session?.authenticated) return res.redirect('/');
    res.sendFile(path.join(__dirname, 'login.html'));
});

app.post('/api/auth/login', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password)
        return res.status(400).json({ success: false, error: 'Credentials required' });
    try {
        const ok = await auth.authenticate(username, password);
        if (ok) {
            req.session.authenticated = true;
            req.session.username      = username;
            return res.json({ success: true, username });
        }
        res.status(401).json({ success: false, error: 'Invalid username or password' });
    } catch (_) {
        res.status(500).json({ success: false, error: 'Authentication error' });
    }
});

app.post('/api/auth/logout', (req, res) => {
    req.session.destroy(() => res.json({ success: true }));
});

app.get('/api/auth/status', (req, res) => {
    res.json({ authenticated: !!req.session?.authenticated, username: req.session?.username || null });
});

// Health
app.get('/api/health', (req, res) => {
    const uptimeSec = Math.round(process.uptime());
    const h = Math.floor(uptimeSec / 3600);
    const m = Math.floor((uptimeSec % 3600) / 60);
    const s = uptimeSec % 60;
    const uptimeFmt = `${String(h).padStart(2,'0')}h ${String(m).padStart(2,'0')}m ${String(s).padStart(2,'0')}s`;

    const data = {
        status:          'ok',
        app:             'Chilled Koala',
        version:         config.general.app_version || '2.0.0',
        build:           BUILD,
        streaming:       mixer.isStreaming(),
        libraryIndexed:  library.isReady(),
        libraryTracks:   library.getIndex().length,
        libraryPath:     library.musicPath,
        uptime:          uptimeFmt,
        primaryUser:     primaryUser || '(none)',
        connectedUsers:  getConnectedUserList(),
    };

    // Always pretty-print — human readable in terminal and browser
    res.setHeader('Content-Type', 'application/json');
    res.send(JSON.stringify(data, null, 2) + '\n');
});

// Users (who is connected / who is primary)
app.get('/api/users', auth_, (req, res) => {
    res.json({ users: getConnectedUserList(), primaryUser });
});

// ── Mic diagnostic ────────────────────────────────────────────────────────────
// Returns real-time status of every mic channel: session registered, decoder
// running, bytes in buffer, current gain, and last VU RMS level.
// Use: curl http://localhost:3100/api/diag/mic  OR  Settings tab → Mic Diag button
app.get('/api/diag/mic', auth_, (req, res) => {
    const micKeys = ['mic0', 'mic1', 'mic2', 'mic3'];
    const report  = {};

    micKeys.forEach(key => {
        report[key] = {
            bufBytes:     mixer._bufs[key]?.length ?? 0,
            gain:         Number((mixer._gains[key] ?? 0).toFixed(4)),
            lastRMS:      Number((mixer._vuSum?.[key] ?? 0).toFixed(6)),
        };
    });

    // MediaRecorder sessions (WS binary path)
    const wsSessions = [];
    micSessions.forEach(({ username }, sid) => {
        const key = mixer._micMap.get(sid);
        wsSessions.push({
            sessionId:   sid,
            username,
            mixerKey:    key || '(unmapped)',
            decoderLive: !!(mixer._micDecoders?.[sid]),
        });
    });

    // WebRTC DJ mic sessions (mediasoup path)
    const rtcSessions = [];
    djMicSessions.forEach(({ username, mixerKey }, djMicId) => {
        rtcSessions.push({ djMicId, username, mixerKey });
    });

    const data = {
        primaryUser,
        mic:         report,
        wsSessions,
        rtcSessions,
        hint: (wsSessions.length === 0 && rtcSessions.length === 0)
            ? 'No mic sessions registered — browser has not sent any audio yet. Check getUserMedia permission and DJMicRTC / MediaRecorder status in browser console.'
            : report.mic0.gain === 0
            ? 'Sessions registered but gain=0 — check syncMixerFromConsole includes djMicSessions (fixed build 302+).'
            : report.mic0.bufBytes === 0
            ? 'Gain is set but buffer empty — audio not arriving. Check WebRTC / MediaRecorder in browser console.'
            : 'mic0 receiving audio OK',
    };

    res.setHeader('Content-Type', 'application/json');
    res.send(JSON.stringify(data, null, 2) + '\n');
});

// Library
app.get('/api/library/search',  auth_, (req, res) => res.json(library.search(req.query.q, req.query.field)));
app.get('/api/library/cart',    auth_, (req, res) => res.json(library.getCart()));
app.get('/api/library/status',  auth_, (req, res) => res.json({ indexed: library.isReady(), indexing: library.isIndexing(), count: library.getIndex().length, path: library.musicPath }));
app.get('/api/library/tree',    auth_, (req, res) => res.json(library.getTree()));

// ── Mic Delay Compensation ────────────────────────────────────────────────────
// POST /api/mic-delay  { ms: number }
// Sets the delay applied to mic0/mic1 before entering the broadcast mix.
// Persisted to config.ini immediately.
app.post('/api/mic-delay', primaryOnly, (req, res) => {
    const ms = parseInt(req.body?.ms, 10);
    if (isNaN(ms) || ms < 0 || ms > 2000) {
        return res.status(400).json({ error: 'ms must be 0–2000' });
    }
    mixer.setMicDelayMs(ms);
    if (!config.audio) config.audio = {};
    config.audio.mic_delay_ms = String(ms);
    saveConfig();
    console.log(`[mic-delay] set to ${ms}ms — saved to config.ini`);
    res.json({ ok: true, micDelayMs: ms });
});

// Audio file streaming — for browser-side Player 1 playback
// ── Guest caller public page ──────────────────────────────────────────────────
app.get('/call', (req, res) => {
    res.sendFile(path.join(__dirname, 'call.html'));
});

// Serve pre-built mediasoup-client browser bundle (bundled with browserify at build time)
// This file is shipped inside the zip — no runtime npm dependency needed.
app.get('/mediasoup-client.js', (req, res) => {
    const bundlePath = path.join(__dirname, 'mediasoup-client.js');
    res.setHeader('Content-Type', 'application/javascript');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    require('fs').createReadStream(bundlePath).pipe(res);
});

// ── /api/monitor  — DJ earphone: Ogg/Opus chunked HTTP stream ────────────────
// Replaces the broken /ws/mon PCM+AudioWorklet path.
// Browser simply does: <audio src="/api/monitor"> — native decoding, no glue code.
// Server pipes the existing _monitorEncoder Ogg output directly to this response.
app.get('/api/monitor', (req, res) => {
    if (!req.session?.authenticated) return res.status(401).end();

    res.setHeader('Content-Type', 'audio/webm; codecs=opus');
    res.setHeader('Cache-Control', 'no-cache, no-store');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();   // send HTTP headers immediately — don't wait for first chunk

    // Ensure encoder is running (starts on first browser WS connect, but be safe)
    mixer.startMonitor();

    let _closed = false;
    const cleanup = () => {
        if (_closed) return;
        _closed = true;
        mixer.removeMonitorClient(cb);
        try { res.end(); } catch (_) {}
        console.log('[monitor] client disconnected');
    };

    const cb = (chunk) => {
        if (_closed) return;
        try {
            const ok = res.write(chunk);
            // If write buffer full, drain before next chunk (prevents memory growth)
            if (!ok) res.once('drain', () => {});
        } catch (_) { cleanup(); }
    };

    mixer.addMonitorClient(cb);
    req.on('close',   cleanup);
    req.on('aborted', cleanup);
    console.log('[monitor] client connected from', req.socket?.remoteAddress);
});

// ── Guest WebSocket signalling endpoint /ws/guest ─────────────────────────────
// Separate from the main /ws endpoint (guests are not authenticated DJ users)
const guestSignalPath = '/ws/guest';

// ── WebSocket upgrade routing ─────────────────────────────────────────────────
// /ws/djm    DJ mic WebRTC signalling
// /ws/mon      DJ earphone — raw PCM Mix 1 (station sources, no DJ mics)
//               AudioWorklet receives s16le frames every 20ms (clock-stable tick)
// /ws/guest     Guest caller WebRTC signalling
// /             Main DJ control (JSON) + binary legacy monitor frames

server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, `http://${req.headers.host}`);

    // ── DJ Mic WebRTC signalling (/ws/djm) ────────────────────────────────
    // Authenticated DJs connect here to send their mic via WebRTC instead of
    // MediaRecorder. Latency: ~30-80ms vs ~270-320ms with MediaRecorder.
    // Protocol mirrors the guest /ws/guest flow but routes to mixer mic0/mic1.
    if (url.pathname === '/ws/djm') {
        sessionMiddleware(req, {}, async () => {
            if (!req.session?.authenticated) {
                socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
                socket.destroy();
                return;
            }

            const username = req.session.username;
            wssTap.handleUpgrade(req, socket, head, (ws) => {
                ws.isAlive = true;
                ws.on('pong', () => { ws.isAlive = true; });

                // Assign a mixer key based on primary/secondary status
                const isPrim = (username === primaryUser);
                let pCount = 0, sCount = 0;
                djMicSessions.forEach(({ username: u }) => {
                    if (u === primaryUser) pCount++; else sCount++;
                });
                const mixerKey = isPrim
                    ? (pCount < 2 ? `mic${pCount}` : null)
                    : (sCount < 2 ? `mic${sCount + 2}` : null);

                if (!mixerKey) {
                    ws.close(1008, 'No mixer key available');
                    return;
                }

                const djMicId = `djmic_${username}_${Date.now()}`;
                djMicSessions.set(djMicId, { username, mixerKey });

                // Inform the browser that WebRTC is ready and what mixer key was assigned
                ws.send(JSON.stringify({ type: 'djmic:ready', mixerKey }));

                // DO NOT call mixer.assignMic() here — that spawns a WebM FFmpeg decoder
                // which is only for the MediaRecorder/WS binary path.
                // The WebRTC path calls feedMicPcm() directly with pre-decoded PCM via
                // rtcGuests._onDjPcm callback. Gain is applied by syncMixerFromConsole()
                // which now includes djMicSessions in its gain assignments (build 302).
                syncMixerFromConsole();
                console.log(`[djmic] ${username} → ${mixerKey} (WebRTC path)`);

                const send_ = (type, payload) => {
                    try { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type, payload: payload || {} })); }
                    catch (_) {}
                };

                ws.on('message', async (raw) => {
                    let msg;
                    try { msg = JSON.parse(raw); } catch { return; }
                    const { type, payload = {} } = msg;
                    try {
                        switch (type) {
                            case 'djmic:rtpCapabilities': {
                                const caps = await rtcGuests.getRtpCapabilities();
                                send_('djmic:rtpCapabilities', caps);
                                break;
                            }
                            case 'djmic:createTransport': {
                                const announcedIp = config.webrtc?.announced_ip || req.socket.localAddress;
                                rtcGuests._announcedIp = announcedIp;
                                const params = await rtcGuests.createDjMicTransport(djMicId);
                                send_('djmic:createTransport', params);
                                break;
                            }
                            case 'djmic:connectTransport':
                                await rtcGuests.connectDjMicTransport(djMicId, payload.dtlsParameters);
                                send_('djmic:connectTransport', {});
                                break;
                            case 'djmic:produce': {
                                const producerId = await rtcGuests.acceptDjMicProducer(
                                    djMicId, payload.kind, payload.rtpParameters, mixerKey
                                );
                                send_('djmic:produce', { producerId });
                                // WebRTC active — tell browser to stop MediaRecorder for this mic
                                send_('djmic:active', { mixerKey });
                                console.log(`[djmic] ${username} → ${mixerKey} WebRTC pipeline live`);
                                break;
                            }
                        }
                    } catch (err) {
                        console.error(`[djmic] ${type} error:`, err.message);
                        send_('error', { message: err.message });
                    }
                });

                ws.on('close', () => {
                    rtcGuests.disconnectDjMic(djMicId);
                    // DO NOT call mixer.releaseMic() — WebRTC path never called assignMic()
                    djMicSessions.delete(djMicId);
                    syncMixerFromConsole();   // recompute gains now this session is gone
                    console.log(`[djmic] ${username} disconnected (${mixerKey})`);
                });

                ws.on('error', () => {
                    rtcGuests.disconnectDjMic(djMicId);
                    djMicSessions.delete(djMicId);
                    syncMixerFromConsole();
                });
            });
        });
        return;
    }

    // ── DJ Earphone WebRTC signalling (/ws/ear) ──────────────────────────────
    // Mirror of /ws/djm but in reverse: server produces audio, browser consumes.
    // Flow: outMix1 PCM → FFmpeg RTP → mediasoup PlainTransport producer
    //       → mediasoup route → WebRtcTransport → browser mediasoup-client consumer
    //       → RTCPeerConnection track → Web Audio GainNode → DJ earphone
    if (url.pathname === '/ws/ear') {
        sessionMiddleware(req, {}, () => {
            if (!req.session?.authenticated) {
                socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
                socket.destroy(); return;
            }
            wssTap.handleUpgrade(req, socket, head, async (ws) => {
                const username  = req.session.username;
                const sessionId = `ear_${username}_${Date.now()}`;
                const send_ = (type, payload) => {
                    try { ws.send(JSON.stringify({ type, payload })); } catch (_) {}
                };
                const pending_ = {};
                function resolve_(type, payload) {
                    if (pending_[type]) {
                        const p = pending_[type]; delete pending_[type];
                        if (payload?.error) p.rej(new Error(payload.error));
                        else p.res(payload);
                    }
                }

                ws.on('message', async (raw) => {
                    let msg; try { msg = JSON.parse(raw); } catch { return; }
                    const { type, payload = {} } = msg;

                    // Resolve any pending browser→server RPCs first
                    resolve_(type, payload);

                    console.log(`[ear] msg: type=${type} session=${sessionId.slice(-8)}`);
                    try {
                        switch (type) {
                            case 'ear:getRtpCapabilities': {
                                if (!rtcGuests.isReady()) throw new Error('mediasoup not ready');
                                const announcedIp = config.webrtc?.announced_ip || req.socket.localAddress;
                                console.log(`[ear] createEarphoneTransport ip=${announcedIp}`);
                                const tParams = await rtcGuests.createEarphoneTransport(sessionId, announcedIp);
                                console.log(`[ear] transport created id=${tParams.id}`);
                                // IMPORTANT: respond with SAME type so browser _rpc() resolves correctly
                                send_('ear:getRtpCapabilities', {
                                    routerRtpCapabilities: tParams.rtpCapabilities,
                                    transportParams:       tParams,
                                });
                                break;
                            }
                            case 'ear:connectTransport':
                                await rtcGuests.connectEarphoneTransport(sessionId, payload.dtlsParameters);
                                send_('ear:connectTransport', {});  // same type = resolves correctly
                                break;
                            case 'ear:consume': {
                                const consumerParams = await rtcGuests.startEarphoneStream(sessionId);
                                send_('ear:consume', consumerParams);  // same type = resolves correctly
                                break;
                            }
                        }
                    } catch (e) {
                        console.error('[ear] ERROR:', e.message);
                        send_('ear:error', { message: e.message });
                    }
                });

                ws.on('close', () => { rtcGuests.disconnectEarphone(sessionId); });
                ws.on('error', () => { rtcGuests.disconnectEarphone(sessionId); });
                console.log(`[ear] ${username} connected (${sessionId.slice(-8)})`);
            });
        });
        return;
    }

    if (url.pathname === '/ws/mon') {
        console.log('[mix1] upgrade request from', req.socket?.remoteAddress, 'cookie=', !!req.headers?.cookie);
        sessionMiddleware(req, {}, () => {
            console.log('[mix1] session check: authenticated=', req.session?.authenticated, 'user=', req.session?.username);
            if (!req.session?.authenticated) {
                console.log('[mix1] REJECTED — not authenticated');
                socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
                socket.destroy();
                return;
            }

            wssTap.handleUpgrade(req, socket, head, (ws) => {
                ws.isAlive = true;
                ws.on('pong', () => { ws.isAlive = true; });

                const mix1Cb = (pcmBuf) => {
                    if (ws.readyState === WebSocket.OPEN) {
                        try { ws.send(pcmBuf, { binary: true }); } catch (_) {}
                    }
                };

                mixer.addMix1Client(mix1Cb);
                console.log('[mix1] Earphone WS opened');

                ws.on('close', () => { mixer.removeMix1Client(mix1Cb); console.log('[mix1] Earphone WS closed'); });
                ws.on('error', () => { mixer.removeMix1Client(mix1Cb); });
            });
        });
        return;
    }

    if (url.pathname === '/ws/guest') {
        wss.handleUpgrade(req, socket, head, (ws) => {
            // Tag as guest connection
            ws._isGuest = true;
            const guestId = `g_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
            ws._guestId   = guestId;

            // Register guest in WebRTC engine
            rtcGuests.setGuestName(guestId, 'Guest');

            guestWsSessions.set(guestId, ws);
            ws.send(JSON.stringify({ type: 'guest:welcome', payload: { guestId } }));
            console.log(`[guest] Connected: ${guestId}`);

            ws.on('message', async (raw) => {
                let msg;
                try { msg = JSON.parse(raw); } catch { return; }
                const { type, payload = {} } = msg;

                try {
                    switch (type) {
                        case 'guest:name':
                            rtcGuests.setGuestName(guestId, payload.name || 'Guest');
                            break;
                        case 'guest:rtpCapabilities': {
                            const caps = await rtcGuests.getRtpCapabilities();
                            ws.send(JSON.stringify({ type: 'guest:rtpCapabilities', payload: caps }));
                            break;
                        }
                        case 'guest:createTransport': {
                            const announcedIp = config.webrtc?.announced_ip || req.socket.localAddress;
                            rtcGuests._announcedIp = announcedIp;
                            const params = await rtcGuests.createTransport(guestId);
                            ws.send(JSON.stringify({ type: 'guest:createTransport', payload: params }));
                            break;
                        }
                        case 'guest:connectTransport':
                            await rtcGuests.connectTransport(guestId, payload.dtlsParameters);
                            ws.send(JSON.stringify({ type: 'guest:connectTransport', payload: {} }));
                            break;
                        case 'guest:produce': {
                            const announcedIp = config.webrtc?.announced_ip || req.socket.localAddress;
                            const producerId = await rtcGuests.acceptProducer(
                                guestId, payload.transportId,
                                payload.kind, payload.rtpParameters, announcedIp
                            );
                            ws.send(JSON.stringify({ type: 'guest:produce', payload: { producerId } }));
                            break;
                        }
                        case 'guest:leave':
                            rtcGuests.disconnectGuest(guestId);
                            ws.close();
                            break;
                    }
                } catch (err) {
                    console.error(`[guest] ${type} error:`, err.message);
                    ws.send(JSON.stringify({ type: 'error', message: err.message }));
                }
            });

            ws.on('close', () => {
                guestWsSessions.delete(guestId);
                rtcGuests.disconnectGuest(guestId);
                console.log(`[guest] Disconnected: ${guestId}`);
            });
        });
        return;
    }

    // All other paths (including '/') → main DJ WebSocket
    sessionMiddleware(req, {}, () => {
        if (!req.session?.authenticated) {
            socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
            socket.destroy();
            return;
        }
        wss.handleUpgrade(req, socket, head, (ws) => {
            wss.emit('connection', ws, req);
        });
    });
});

app.get('/api/audio', auth_, (req, res) => {
    const filePath = req.query.path;
    if (!filePath)                      return res.status(400).json({ error: 'path required' });
    if (!library.isPathAllowed(filePath)) return res.status(403).json({ error: 'path not allowed' });
    const fs_   = require('fs');
    if (!fs_.existsSync(filePath))      return res.status(404).json({ error: 'file not found' });

    const stat = fs_.statSync(filePath);
    const ext  = path.extname(filePath).toLowerCase();
    const mime = ext === '.flac' ? 'audio/flac'
               : ext === '.mp3'  ? 'audio/mpeg'
               : ext === '.ogg'  ? 'audio/ogg'
               : ext === '.wav'  ? 'audio/wav'
               : 'audio/flac';

    // Support range requests for browser audio seeking
    const range = req.headers.range;
    if (range) {
        const [startStr, endStr] = range.replace(/bytes=/, '').split('-');
        const start = parseInt(startStr, 10);
        const end   = endStr ? parseInt(endStr, 10) : stat.size - 1;
        const chunkSize = end - start + 1;
        res.writeHead(206, {
            'Content-Range':  `bytes ${start}-${end}/${stat.size}`,
            'Accept-Ranges':  'bytes',
            'Content-Length': chunkSize,
            'Content-Type':   mime,
        });
        fs_.createReadStream(filePath, { start, end }).pipe(res);
    } else {
        res.writeHead(200, {
            'Content-Length': stat.size,
            'Content-Type':   mime,
            'Accept-Ranges':  'bytes',
        });
        fs_.createReadStream(filePath).pipe(res);
    }
});

// ── Player direct PCM stream — low-latency DJ earphone ───────────────────────
// Streams raw s16le 44100Hz stereo PCM from Player 1 or 2 directly to the
// browser as a chunked HTTP WAV stream.
//
// WHY THIS IS FASTER THAN THE SERVER MONITOR PATH:
//   Server monitor: FFmpeg PCM → mix bus tick (20ms) → Opus encoder → WebSocket → browser
//   This endpoint: FFmpeg PCM → HTTP write → browser (zero encode, zero mix-bus delay)
//
// Latency comparison:
//   Server monitor path:  mix_tick(20ms) + Opus_encode(20ms) + network + browser_decode
//                         = ~300-400ms total
//   This direct path:     network(40-100ms) + browser_decode(20-50ms)
// Latency diagnostics
app.get('/api/latency', auth_, (req, res) => {
    res.json({
        note:              'All times in milliseconds (build 12)',
        earphone_mix1:     '~76-106ms  (PCM Mix1 → /ws/mon → AudioWorklet ring buffer)',
        earphone_latency:  '~40-60ms network + ~46ms ring buffer = ~76-106ms total',
        mic_self_monitor:  '0ms        (Web Audio direct, gated by channel ON/fader)',
        mic_to_vps_webrtc: '~30-80ms   (WebRTC Opus/UDP, build 10)',
        mic_to_vps_old:    '~270-320ms (MediaRecorder fallback, if WebRTC unavailable)',
        broadcast_chain:   'PCM Mix2 (Mix1+mics) → Opus → Liquidsoap → Icecast',
        mix1_sources:      'player1, player2, mic2, mic3, guest0, guest1 (no DJ mics)',
        mix2_sources:      'Mix1 + mic0 + mic1 (DJ local mics, WebRTC)',
    });
});

// ── Audio Quality Diagnostic ─────────────────────────────────────────────────
// GET /api/audio-quality
// Measures:
//   1. FLAC source quality: runs FFmpeg astats filter on the current track
//      to get RMS level, peak level, dynamic range, and DC offset.
//   2. Mixer buffer stats: current p1 buffer depth and backpressure state.
//   3. WS delivery stats: mix1 client count and tick rate.
app.get('/api/audio-quality', auth_, (req, res) => {
    const { execFile } = require('child_process');
    const track = player1.getState?.()?.track;
    const bufP1 = mixer._bufs?.player1?.length || 0;
    const SR = 44100, BF = 4;

    const deliveryStats = {
        p1_buffer_bytes:  bufP1,
        p1_buffer_ms:     Math.round(bufP1 / BF / SR * 1000),
        mix1_clients:     mixer._mix1Clients?.size || 0,
        mixer_gains:      {
            player1: (mixer._gains?.player1 || 0).toFixed(3),
            player2: (mixer._gains?.player2 || 0).toFixed(3),
        },
        backpressure: {
            buf_high_ms: 800,
            buf_low_ms:  400,
            note: 'FFmpeg pauses at 800ms, resumes at 400ms',
        },
        transport: 'WebSocket binary s16le PCM 44100Hz stereo → pcm-player Web Audio',
    };

    if (!track?.path) {
        return res.json({ source: null, delivery: deliveryStats,
            note: 'No track playing — start Player 1 to measure FLAC source quality' });
    }

    // Run FFmpeg with astats filter on first 10 seconds of the track.
    // astats reports: RMS level, peak level, dynamic range, DC offset per channel.
    const args = [
        '-hide_banner', '-nostats', '-loglevel', 'info',
        '-t', '10',
        '-i', track.path,
        '-af', 'astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-',
        '-f', 'null', '-'
    ];

    execFile('ffmpeg', args, { timeout: 15000 }, (err, stdout, stderr) => {
        // astats output goes to stderr when output is null
        const output = stderr || '';
        const lines = output.split('\n');

        // Parse key metrics from astats output
        const extract = (pattern) => {
            const m = output.match(pattern);
            return m ? parseFloat(m[1]) : null;
        };

        // Look for summary lines in astats verbose output
        const rmsMatch   = output.match(/RMS level dB:\s*([-\d.]+)/);
        const peakMatch  = output.match(/Peak level dB:\s*([-\d.]+)/);
        const dynMatch   = output.match(/Dynamic range:\s*([-\d.]+)/);
        const dcMatch    = output.match(/DC offset:\s*([-\d.]+)/);
        const flatMatch  = output.match(/Flat factor:\s*([-\d.]+)/);
        const noiseMatch = output.match(/Noise floor dB:\s*([-\d.]+)/);

        const rms  = rmsMatch  ? parseFloat(rmsMatch[1])  : null;
        const peak = peakMatch ? parseFloat(peakMatch[1]) : null;
        const dyn  = dynMatch  ? parseFloat(dynMatch[1])  : null;
        const dc   = dcMatch   ? parseFloat(dcMatch[1])   : null;

        // Quality assessment
        let quality = 'unknown';
        let notes = [];
        if (rms !== null) {
            if (rms > -3)  { quality = 'clipping_risk'; notes.push('RMS too hot — risk of clipping'); }
            else if (rms > -12) { quality = 'excellent';  notes.push('Healthy broadcast level'); }
            else if (rms > -20) { quality = 'good';       notes.push('Good dynamic range'); }
            else if (rms > -30) { quality = 'quiet';      notes.push('Track is quiet — fader may need raising'); }
            else               { quality = 'very_quiet';  notes.push('Very quiet source'); }
        }
        if (peak !== null && peak > -0.5) notes.push('Peak near 0dBFS — possible clipping in source');
        if (dyn  !== null && dyn < 3)     notes.push('Very low dynamic range — may be heavily compressed');
        if (dc   !== null && Math.abs(dc) > 0.01) notes.push('DC offset detected — source may have recording issue');

        res.json({
            source: {
                path:       track.path,
                title:      track.title || '–',
                artist:     track.artist || '–',
                duration_s: track.duration || 0,
                measured_s: 10,
                rms_dbfs:   rms,
                peak_dbfs:  peak,
                dynamic_range_db: dyn,
                dc_offset:  dc,
                quality_assessment: quality,
                notes,
            },
            delivery: deliveryStats,
            tip: 'For best earphone quality: p1_buffer_ms should cycle between 400ms–800ms steadily with no 0ms dips.',
        });
    });
});

// Clock sync endpoint — returns server time and NTP synchronisation status.
// Browser uses this to check whether VPS and PC are both NTP-synchronised.
// If both use NTP, their Date.now() values are within ~50ms of each other,
// making the clock:ping/pong correction unnecessary (but still applied).
// If NTP is not synced, the timer drift can reach several seconds — operator
// must run: systemctl restart systemd-timesyncd && timedatectl set-ntp true
app.get('/api/clock', auth_, (req, res) => {
    const { execFile } = require('child_process');
    execFile('timedatectl', ['show', '--no-pager'], { timeout: 2000 }, (err, stdout) => {
        const now = Date.now();
        let ntpSync = null;
        let ntpService = null;
        let timeZone = null;
        if (!err && stdout) {
            for (const line of stdout.split('\n')) {
                if (line.startsWith('NTPSynchronized=')) ntpSync = line.split('=')[1]?.trim();
                if (line.startsWith('NTP='))             ntpService = line.split('=')[1]?.trim();
                if (line.startsWith('Timezone='))        timeZone = line.split('=')[1]?.trim();
            }
        }
        res.json({
            serverNow:    now,
            ntpSync:      ntpSync  || 'unknown',
            ntpEnabled:   ntpService || 'unknown',
            timezone:     timeZone || 'unknown',
            isoTime:      new Date(now).toISOString(),
        });
    });
});

// ── Library Rescan — Singer Magpie pattern ───────────────────────────────────
// GET  /api/library/reindex              — start scan, return job_id immediately
// GET  /api/library/reindex/status/:id  — poll for {status, scanned, error}
//
// Using GET (not POST) so Cloudflare Tunnel and any reverse proxy never
// blocks the request based on method or missing body.

app.get('/api/library/reindex', primaryOnly, (req, res) => {
    _scanJobCleanup();
    const jid = _newJobId();
    SCAN_JOBS[jid] = { status: 'running', scanned: 0, error: null, startedAt: Date.now() };
    res.json({ success: true, job_id: jid });
    broadcast({ type: 'library:indexing', path: library.musicPath, jobId: jid });
    setImmediate(async () => {
        try {
            await library.rescan((scanned) => {
                if (SCAN_JOBS[jid]) SCAN_JOBS[jid].scanned = scanned;
            });
            await library.loadCart();
            if (SCAN_JOBS[jid]) { SCAN_JOBS[jid].status = 'done'; SCAN_JOBS[jid].scanned = library.getIndex().length; }
            broadcast({ type: 'library:ready', count: library.getIndex().length });
        } catch (err) {
            console.error('✗ Library rescan error:', err.message);
            if (SCAN_JOBS[jid]) { SCAN_JOBS[jid].status = 'error'; SCAN_JOBS[jid].error = err.message; }
        }
    });
});

app.get('/api/library/reindex/status/:id', primaryOnly, (req, res) => {
    const job = SCAN_JOBS[req.params.id];
    if (!job) return res.json({ success: false, error: 'Job not found' });
    res.json({ success: true, status: job.status, scanned: job.scanned, error: job.error });
});

// /api/monitor HTTP endpoint removed.
// Monitor audio is now delivered over the existing authenticated WebSocket
// as binary Ogg/Opus frames (type: 'monitor:chunk').
// This bypasses Cloudflare Tunnel buffering which silences HTTP chunked streams.

// Stream
app.get('/api/stream/status',   auth_, (req, res) => res.json(mixer.getStatus()));

// ── Mixer diagnostic — shows live gains and buffer sizes ─────────────────────
// Open /api/mixer/diag in a browser tab to diagnose audio path issues.
app.get('/api/mixer/diag', auth_, (req, res) => {
    const gains  = mixer._gains  || {};
    const bufs   = mixer._bufs   || {};
    const chs    = console_?.channels || [];
    const chInfo = chs.map(c => ({
        id: c.id, name: c.name, on: c.on, fader: c.fader,
        src: c.activeSource === 'B' ? c.sourceB : c.sourceA
    }));
    res.json({
        tickerRunning: !!mixer._ticker,
        mix1Clients:   mixer._mix1Clients?.size || 0,
        gains,
        bufs: Object.fromEntries(Object.entries(bufs).map(([k,v]) => [k, v?.length || 0])),
        channels: chInfo,
    });
});

app.post('/api/stream/start', primaryOnly, async (req, res) => {
    try {
        if (!mixer.isStreaming() && !mixer.isConnecting()) await mixer.start();
        res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/api/stream/stop', primaryOnly, async (req, res) => {
    try { await mixer.stop();    res.json({ success: true }); }
    catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/api/stream/metadata', primaryOnly, (req, res) => {
    mixer.updateMetadata(req.body.title, req.body.artist);
    res.json({ success: true });
});

// Console
app.get('/api/console/state', auth_, (req, res) => res.json(console_.getState()));

app.post('/api/console/channel/:id', primaryOnly, (req, res) => {
    const chId = parseInt(req.params.id);
    if (isNaN(chId) || chId < 0 || chId > 7) return res.status(400).json({ error: 'Invalid channel' });
    console_.setChannelConfig(chId, req.body);
    saveConfig();
    res.json({ success: true });
});

// Config
app.get('/api/config', auth_, (req, res) => {
    const ic = config.icecast;
    const dj = config.azuracast_dj || {};
    res.json({
        icecast:      { server: ic.server, port: ic.port, mount: ic.mount, listener_mount: ic.listener_mount || ic.mount, public_stream_url: ic.public_stream_url || '' },
        paths:        { music_library_path: config.paths.music_library_path },
        audio:        config.audio,
        monitor:      { source: config.monitor?.source || 'pgm', volume: config.monitor?.volume || 80 },
        azuracast_dj: { server: dj.server || '', port: dj.port || '8005', mount: dj.mount || '/', username: dj.username || '' },
        micDelayMs:   mixer.getMicDelayMs(),
    });
});

app.post('/api/config/icecast', primaryOnly, (req, res) => {
    const { server, port, mount, password } = req.body;
    if (server)   config.icecast.server   = server;
    if (port)     config.icecast.port     = String(port);
    if (mount)    config.icecast.mount    = mount;
    if (password) config.icecast.password = password;
    saveConfig();
    res.json({ success: true });
});

app.post('/api/config/library', primaryOnly, (req, res) => {
    const { path: p } = req.body;
    if (!p) return res.status(400).json({ error: 'path required' });
    config.paths.music_library_path = p;
    library.setMusicPath(p);
    saveConfig();
    res.json({ success: true, note: 'Run Rescan & Rebuild Cache to apply new path' });
});

// Playlist
app.get('/api/playlist', auth_, (req, res) => res.json(playlist.getList()));

// ── AzuraCast proxy ───────────────────────────────────────────────────────────
// ── AzuraCast direct-DB helpers (via Docker MariaDB) ─────────────────────────
// Reads credentials from /var/azuracast/azuracast.env (present on AzuraCast VPS).
// Falls back gracefully when not available (non-VPS dev environments).
let _azDBCfg = undefined;
function _getAzDBCfg() {
    if (_azDBCfg !== undefined) return _azDBCfg;
    try {
        const raw = fs.readFileSync('/var/azuracast/azuracast.env', 'utf-8');
        const cfg = {};
        raw.split('\n').forEach(l => { const m = l.match(/^([A-Z_]+)\s*=\s*(.+)$/); if (m) cfg[m[1]] = m[2].trim(); });
        _azDBCfg = { user: cfg.MYSQL_USER || 'azuracast', pass: cfg.MYSQL_PASSWORD || '', db: cfg.MYSQL_DATABASE || 'azuracast' };
        console.log('✓ AzuraCast DB config loaded');
    } catch { _azDBCfg = null; }
    return _azDBCfg;
}

// Execute SQL against the AzuraCast MariaDB inside Docker.
// Returns raw tab-separated stdout string; throws on error.
function _azDB(sql) {
    const db = _getAzDBCfg();
    if (!db) return Promise.reject(new Error('AzuraCast DB not available (not on AzuraCast VPS)'));
    return new Promise((resolve, reject) => {
        const child = spawn('docker', [
            'exec', '-i', '-e', `MYSQL_PWD=${db.pass}`,
            'azuracast', 'mariadb', `-u${db.user}`, db.db,
            '--batch', '--skip-column-names'
        ]);
        let out = '', err = '';
        child.stdout.on('data', d => out += d);
        child.stderr.on('data', d => err += d);
        child.on('close', code => {
            if (code !== 0) reject(new Error(err.split('\n').find(l => l.trim()) || `DB exit ${code}`));
            else resolve(out.trim());
        });
        child.on('error', reject);
        child.stdin.write(sql + '\n');
        child.stdin.end();
    });
}

// Parse tab-separated DB output into array of objects.
function _azDBRows(raw, cols) {
    if (!raw) return [];
    return raw.split('\n').filter(l => l).map(line => {
        const vals = line.split('\t');
        if (!cols) return vals;
        const obj = {};
        cols.forEach((c, i) => { obj[c] = vals[i] !== undefined ? vals[i] : null; });
        return obj;
    });
}

// Escape a string value for embedding in a SQL single-quoted literal.
function _sqlEsc(s) {
    return String(s || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\x00/g, '').replace(/\n/g, '\\n').replace(/\r/g, '\\r');
}

// Follows one HTTP→HTTPS redirect automatically (nginx on port 80 redirects to HTTPS).
function _azRequest(opts, data, resolve, reject) {
    const mod = opts._https ? require('https') : http;
    const req = mod.request(opts, (res_) => {
        if (res_.statusCode >= 300 && res_.statusCode < 400 && res_.headers.location && !opts._redirected) {
            res_.resume();
            const loc = new URL(res_.headers.location);
            const isHttps = loc.protocol === 'https:';
            const rOpts = { ...opts,
                _redirected: true, _https: isHttps,
                hostname: loc.hostname,
                port: parseInt(loc.port || (isHttps ? 443 : 80)),
                path: loc.pathname + (loc.search || ''),
            };
            if (data) rOpts.headers = { ...opts.headers, 'Content-Length': Buffer.byteLength(data) };
            return _azRequest(rOpts, data, resolve, reject);
        }
        let buf = '';
        res_.on('data', d => buf += d);
        res_.on('end', () => {
            try { resolve({ status: res_.statusCode, body: JSON.parse(buf) }); }
            catch { resolve({ status: res_.statusCode, body: buf }); }
        });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => req.destroy());
    if (data) req.write(data);
    req.end();
}

function _azFetch(method, path_, body) {
    return new Promise((resolve, reject) => {
        const az   = config.azuracast || {};
        const data = body ? JSON.stringify(body) : null;
        const useHttps = az.https === 'true';
        const opts = {
            _https:             useHttps,
            hostname:           az.server || '127.0.0.1',
            port:               parseInt(az.port || (useHttps ? 443 : 80)),
            path:               path_,
            method,
            headers: {
                'X-API-Key':    az.api_key || '',
                'Content-Type': 'application/json',
                ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
            },
            rejectUnauthorized: false,
        };
        _azRequest(opts, data, resolve, reject);
    });
}

// GET /api/azuracast/playlists — list all AzuraCast playlists for station
app.get('/api/azuracast/playlists', auth_, async (req, res) => {
    const az = config.azuracast || {};
    if (!az.api_key || !az.station_id)
        return res.status(503).json({ error: 'AzuraCast not configured — set api_key and station_id in config.ini [azuracast]' });
    try {
        const r = await _azFetch('GET', `/api/station/${az.station_id}/playlists`);
        res.status(r.status).json(r.body);
    } catch (e) {
        res.status(503).json({ error: e.message });
    }
});

// POST /api/azuracast/playlist/push — push folders and/or tracks to a playlist
// Body: { playlistId: number, folders: [absPath,...], tracks: [{path,duration,...},...] }
app.post('/api/azuracast/playlist/push', primaryOnly, async (req, res) => {
    const az = config.azuracast || {};
    if (!az.api_key || !az.station_id)
        return res.status(503).json({ error: 'AzuraCast not configured' });
    const { playlistId, folders = [], tracks = [] } = req.body;
    if (!playlistId) return res.status(400).json({ error: 'playlistId required' });

    // Station media root = one directory above music_library_path
    // e.g. /mnt/data/.../media/Music → /mnt/data/.../media/
    const musicLibPath = (config.paths?.music_library_path || '').replace(/\\/g, '/').replace(/\/$/, '');
    const stationRoot  = musicLibPath.includes('/') ? musicLibPath.slice(0, musicLibPath.lastIndexOf('/') + 1) : '';

    function toRelPath(absPath) {
        const p = (absPath || '').replace(/\\/g, '/');
        return (stationRoot && p.startsWith(stationRoot)) ? p.slice(stationRoot.length) : p;
    }

    const results = [];

    // Folders: use PUT /api/station/{id}/playlist/{id}/apply-to
    // This registers a persistent folder→playlist link; AzuraCast auto-picks up new files on media sync
    if (folders.length > 0) {
        try {
            const relFolders = folders.map(toRelPath).filter(Boolean);
            const r = await _azFetch('PUT',
                `/api/station/${az.station_id}/playlist/${parseInt(playlistId)}/apply-to`,
                { directories: relFolders });
            results.push({ type: 'folders', folders: relFolders, status: r.status,
                message: r.body?.message || null });
            process.stdout.write(`[azuracast] folder apply-to playlist=${playlistId} [${relFolders.join(', ')}] → HTTP ${r.status} ${r.body?.message || ''}\n`);
        } catch (e) {
            results.push({ type: 'folders', folders: folders.map(toRelPath), status: 0, error: e.message });
        }
    }

    // Individual tracks: M3U import — POST /api/station/{id}/playlist/{id}/import
    if (tracks.length > 0) {
        try {
            const filePaths = tracks.map(t => toRelPath(t.path)).filter(Boolean);
            const m3u = '#EXTM3U\n' + filePaths.map(p => `#EXTINF:-1,\n${p}`).join('\n') + '\n';
            const boundary = 'CKBoundary' + Date.now();
            const form = Buffer.from(
                `--${boundary}\r\n` +
                `Content-Disposition: form-data; name="playlist_file"; filename="tracks.m3u"\r\n` +
                `Content-Type: audio/x-mpegurl\r\n\r\n` +
                `${m3u}\r\n--${boundary}--\r\n`
            );
            const r = await new Promise((resolve, reject) => {
                const useHttps = az.https === 'true';
                const opts = {
                    _https:           useHttps,
                    hostname:         az.server || '127.0.0.1',
                    port:             parseInt(az.port || (useHttps ? 443 : 80)),
                    path:             `/api/station/${az.station_id}/playlist/${parseInt(playlistId)}/import`,
                    method:           'POST',
                    headers: {
                        'X-API-Key':  az.api_key || '',
                        'Content-Type': `multipart/form-data; boundary=${boundary}`,
                        'Content-Length': form.length,
                    },
                    rejectUnauthorized: false,
                };
                _azRequest(opts, form, resolve, reject);
            });
            const matched = r.body?.message?.match(/(\d+) of (\d+)/);
            results.push({ type: 'tracks', files: filePaths.length,
                matched: matched ? parseInt(matched[1]) : null, status: r.status });
            process.stdout.write(`[azuracast] tracks push playlist=${playlistId} (${filePaths.length} tracks) → HTTP ${r.status} ${r.body?.message || ''}\n`);
        } catch (e) {
            results.push({ type: 'tracks', status: 0, error: e.message });
        }
    }

    const ok = results.length > 0 && results.every(r => r.status >= 200 && r.status < 300);
    res.status(ok ? 200 : 502).json({ ok, results });
});

// Root
app.get('/', (req, res) => {
    if (!req.session?.authenticated) return res.redirect('/login');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    // Inject current build number into asset URLs — guarantees browser loads
    // the latest JS/CSS after every deploy, even if index.html was cached.
    const build = BUILD;
    try {
        let html = require('fs').readFileSync(path.join(__dirname, 'index.html'), 'utf8');
        html = html.replace(/app\.js\?v=\d+/g,   `app.js?v=${build}`);
        html = html.replace(/style\.css\?v=\d+/g, `style.css?v=${build}`);
        res.setHeader('Content-Type', 'text/html');
        res.send(html);
    } catch (e) {
        res.sendFile(path.join(__dirname, 'index.html'));
    }
});

// GET /api/azuracast/playlist/:playlistId/contents
// Returns folders (with dynamic link + track count) and individual tracks in the playlist.
app.get('/api/azuracast/playlist/:playlistId/contents', auth_, async (req, res) => {
    const az = config.azuracast || {};
    if (!az.station_id) return res.status(503).json({ error: 'AzuraCast not configured' });
    const playlistId = parseInt(req.params.playlistId);
    if (!playlistId) return res.status(400).json({ error: 'Invalid playlist ID' });
    const sid = parseInt(az.station_id);
    try {
        // Folders with dynamic link + track count
        const fRaw = await _azDB(
            `SELECT spf.path,
                (SELECT COUNT(*) FROM station_playlist_media spm
                 JOIN station_media sm ON spm.media_id=sm.id
                 WHERE spm.playlist_id=${playlistId}
                 AND sm.path LIKE CONCAT('${_sqlEsc('')}', spf.path, '/%')) AS cnt
             FROM station_playlist_folders spf
             WHERE spf.station_id=${sid} AND spf.playlist_id=${playlistId}
             ORDER BY spf.path;`
        );
        const folders = _azDBRows(fRaw, ['path', 'count'])
            .map(r => ({ path: r.path, count: parseInt(r.count) || 0 }));

        // Individual tracks: in playlist_media but NOT under any folder link
        const tRaw = await _azDB(
            `SELECT sm.path
             FROM station_playlist_media spm
             JOIN station_media sm ON spm.media_id=sm.id
             WHERE spm.playlist_id=${playlistId}
             AND NOT EXISTS (
                 SELECT 1 FROM station_playlist_folders spf
                 WHERE spf.station_id=${sid} AND spf.playlist_id=${playlistId}
                 AND sm.path LIKE CONCAT(spf.path, '/%')
             )
             ORDER BY sm.path
             LIMIT 500;`
        );
        const tracks = _azDBRows(tRaw).map(r => r[0]).filter(Boolean);

        // Total track count
        const totRaw = await _azDB(
            `SELECT COUNT(*) FROM station_playlist_media WHERE playlist_id=${playlistId};`
        );
        const total = parseInt((totRaw || '0').split('\t')[0]) || 0;

        res.json({ playlistId, total, folders, tracks });
    } catch (e) {
        res.status(502).json({ error: e.message });
    }
});

// POST /api/azuracast/playlist/:playlistId/remove
// Body: { type:'folder', path:'Music/_PublicDomain/Pop' }
//    or { type:'tracks', paths:['Music/...', ...] }
// Removes the folder LINK (dynamic assignment) AND the track entries simultaneously.
app.post('/api/azuracast/playlist/:playlistId/remove', primaryOnly, async (req, res) => {
    const az = config.azuracast || {};
    if (!az.station_id) return res.status(503).json({ error: 'AzuraCast not configured' });
    const playlistId = parseInt(req.params.playlistId);
    const { type, path: folderPath, paths: trackPaths } = req.body;
    if (!playlistId) return res.status(400).json({ error: 'Invalid playlist ID' });
    if (type !== 'folder' && type !== 'tracks') return res.status(400).json({ error: 'type must be folder or tracks' });
    const sid = parseInt(az.station_id);
    try {
        let removed = 0;
        if (type === 'folder') {
            const fp = _sqlEsc((folderPath || '').replace(/\\/g, '/').replace(/\/$/, ''));
            if (!fp) return res.status(400).json({ error: 'path required' });
            // 1. Remove the persistent folder→playlist link
            await _azDB(
                `DELETE FROM station_playlist_folders
                 WHERE station_id=${sid} AND playlist_id=${playlistId} AND path='${fp}';`
            );
            // 2. Remove track entries for files in this folder
            const delRaw = await _azDB(
                `DELETE spm FROM station_playlist_media spm
                 JOIN station_media sm ON spm.media_id=sm.id
                 WHERE spm.playlist_id=${playlistId}
                 AND sm.path LIKE '${fp}/%';
                 SELECT ROW_COUNT();`
            );
            removed = parseInt((delRaw || '0').split('\n').pop()) || 0;
            process.stdout.write(`[azuracast] removed folder link "${fp}" from playlist ${playlistId} (${removed} tracks)\n`);
        } else {
            // Individual tracks: delete by exact path match
            const pathList = (trackPaths || [])
                .map(p => `'${_sqlEsc(p.replace(/\\/g, '/'))}'`)
                .join(',');
            if (!pathList) return res.status(400).json({ error: 'paths required' });
            const delRaw = await _azDB(
                `DELETE spm FROM station_playlist_media spm
                 JOIN station_media sm ON spm.media_id=sm.id
                 WHERE spm.playlist_id=${playlistId}
                 AND sm.path IN (${pathList});
                 SELECT ROW_COUNT();`
            );
            removed = parseInt((delRaw || '0').split('\n').pop()) || 0;
            process.stdout.write(`[azuracast] removed ${removed} individual tracks from playlist ${playlistId}\n`);
        }

        // Get remaining count
        const remRaw = await _azDB(
            `SELECT COUNT(*) FROM station_playlist_media WHERE playlist_id=${playlistId};`
        );
        const remaining = parseInt((remRaw || '0').split('\t')[0]) || 0;
        res.json({ ok: true, removed, remaining });
    } catch (e) {
        res.status(502).json({ error: e.message });
    }
});

// ── Broadcast & helpers ───────────────────────────────────────────────────────

function broadcast(msg) {
    const data = JSON.stringify(msg);
    wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(data); });
}

function safeSend(ws, msg) {
    try { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg)); } catch (_) {}
}

// ── Start ─────────────────────────────────────────────────────────────────────

const PORT = parseInt(config.general.port) || 3100;
const VPS  = config.general.vps_ip || 'localhost';

// Disable server-level timeouts — library scans can take many minutes.
// Individual route timeouts (ffmpeg, timedatectl) are set per-request.
server.headersTimeout  = 0;   // no limit (default 60s would kill long polls)
server.requestTimeout  = 0;   // no limit
server.keepAliveTimeout = 65000;   // 65s — just above Cloudflare's 60s idle limit

server.listen(PORT, () => {
    const ic = config.icecast;
    console.log('\n╔══════════════════════════════════════════════════════════╗');
    console.log('║         🐨  CHILLED KOALA  v2.0.0  🐨                   ║');
    console.log('║        Stream Ecosystem for AzuraCast · Gato Preto       ║');
    console.log('╠══════════════════════════════════════════════════════════╣');
    console.log(`║  Server  : http://${VPS}:${PORT}`.padEnd(59) + '║');
    console.log(`║  Local   : http://localhost:${PORT}`.padEnd(59) + '║');
    console.log(`║  Icecast : ${ic.server}:${ic.port}${ic.mount}`.padEnd(59) + '║');
    console.log(`║  Library : ${library.musicPath}`.padEnd(59) + '║');
    console.log('╚══════════════════════════════════════════════════════════╝\n');
    console.log('✓ Authenticate with AzuraCast SFTP credentials');
});

// ── Shutdown ──────────────────────────────────────────────────────────────────

let shuttingDown = false;

async function shutdown(sig) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n🛑 ${sig} — shutting down…`);
    console_.persistAllFaders();
    saveConfig();
    try { await mixer.stop();    } catch (_) {}
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 4000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

// SIGPIPE: suppress default crash behaviour.
// Without this, writing to a closed Liquidsoap socket kills the entire Node process.
// We handle broken pipes individually on each stream's error event instead.
process.on('SIGPIPE', () => {});

process.on('uncaughtException', (err) => {
    // EPIPE is a broken pipe — socket closed under us. Log and continue; do NOT exit.
    // All other uncaught exceptions are fatal.
    if (err.code === 'EPIPE') { console.warn('⚠ EPIPE suppressed:', err.message); return; }
    console.error('✗ UNCAUGHT:', err);
    process.exit(1);
});
process.on('unhandledRejection', (err) => { console.error('✗ UNHANDLED:', err); process.exit(1); });

module.exports = { app, server };
