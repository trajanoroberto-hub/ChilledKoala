/**
 * Chilled Koala v2.0.0 — Server-Side Audio Mixer
 * Sources: Player 1 (FLAC), Player 2 (FLAC), Mics (browser WebM), Guests (WebRTC).
 * Applies RT console fader/ON-OFF gain per channel.
 * Outputs Ogg/Opus 320kbps to Liquidsoap via TCP SOURCE protocol.
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

const { EventEmitter } = require('events');
const { spawn }        = require('child_process');
const net              = require('net');
const http             = require('http');
const { taper }        = require('./player');

// PCM format throughout: f64le 44100Hz stereo = 16 bytes/frame
const SAMPLE_RATE  = 44100;
const CHANNELS     = 2;
const BYTES_FRAME  = 8 * CHANNELS; // f64le = 8 bytes per sample
const MIX_INTERVAL = 20;           // ms per mix tick — 20ms is reliable for Node.js setInterval
const FRAMES_TICK  = Math.round(SAMPLE_RATE * MIX_INTERVAL / 1000); // frames per tick
const BYTES_TICK   = FRAMES_TICK * BYTES_FRAME;

class AudioMixer extends EventEmitter {
    constructor(config) {
        super();
        this.config         = config;
        this._streaming     = false;
        this._wantStreaming  = false;
        this._socket        = null;
        this._encoder       = null;   // FFmpeg: PCM stdin → MP3 stdout → TCP socket
        this._micDecoder    = null;   // FFmpeg: WebM/Opus stdin → PCM stdout
        this._reconnTimer   = null;
        this._reconnCount   = 0;
        this.startTime      = null;
        this.error          = null;
        this.metadata       = { title: '', artist: 'Gato Preto Radio' };

        // ── PCM buffers: keyed by channel key string ──────────────────────────
        // Keys: 'player1', 'player2', 'mic0', 'mic1', 'mic2', 'mic3'
        this._bufs  = {};   // key → Buffer
        this._gains = {};   // key → float gain (0-3.162)

        // WebM mic decoders: one per remote/local mic session
        // key → { proc: FFmpegProcess, sessionId: string }
        this._micDecoders = {};

        // Player 2 — second FLAC player
        this._pulseProc = null;

        // Mix ticker
        this._ticker   = null;
        this._mix1Seq  = 0;   // sequence counter stamped into each Mix1 frame header

        // Ticker is started by server.js when the first browser connects (startTicker()).
        // It is stopped when the last browser disconnects (stopTicker()).
        // This ensures zero CPU usage when no one is using the console.

        // Mic channel assignment: sessionId → mixerKey ('mic0'..'mic3')
        // Managed by server.js via assignMic() / releaseMic()
        this._micMap = new Map();   // sessionId → key

        // ── PGM Monitor stream ────────────────────────────────────────────────
        // Encodes the live RT PGM mix to Ogg/Opus 64kbps and serves it to
        // connected browser clients at GET /api/monitor.
        // The encoder is started/stopped by the server based on WebSocket client
        // presence — no clients connected = no FFmpeg process running.
        this._monitorEncoder  = null;   // FFmpeg: PCM stdin → Ogg/Opus stdout
        this._monitorClients  = new Set(); // Set of active HTTP res objects
        this._monitorRunning  = false;  // true while encoder process is alive
        this._monitorInitSeg  = null;   // first WebM cluster (init segment) buffered for late joiners
        this._lastTickAt      = null;   // for drift-compensated PCM frame sizing

        // Monitor source: 'pgm1' (default) or 'cue'
        // 'pgm1' → feed outMix1 to monitor encoder / earphone clients
        // 'cue'  → feed outCue (pre-fader sum of CUE-active channels) instead
        this._monitorSource   = 'pgm1';
        this._cueFlags        = {};    // mixerKey → bool: true when channel has CUE active

        // ── DJ Mic Delay Compensation ─────────────────────────────────────────
        // When the DJ monitors PGM1 through earphones (WebSocket or WebRTC),
        // PGM1 arrives at the DJ's ears with network one-way latency + 700ms
        // jitter buffer. The DJ speaks to what they hear, so mic0/mic1 audio
        // is naturally offset by that amount. We delay mic0/mic1 in the broadcast
        // mix by _micDelayMs so DJ voice aligns with music in the Icecast output.
        // Value is persisted in config.ini [audio] mic_delay_ms.
        // setMicDelayMs(ms) is called from POST /api/mic-delay.
        const savedDelay = parseInt(config?.audio?.mic_delay_ms, 10);
        this._micDelayMs   = (isFinite(savedDelay) && savedDelay >= 0) ? savedDelay : 0;
        this._micDelayBufs = {};       // key → { buf: Buffer, targetBytes: number }
    }

    // ── Channel gain sync from RT console ────────────────────────────────────
    // Called by server.js whenever console state changes.
    // channels: array from console_.channels
    // micAssignments: Map of sessionId → { key, isPrimary }

    syncConsole(channels, micAssignments) {
        if (!Array.isArray(channels)) return;

        this._gains['player1'] = 0;
        this._gains['player2'] = 0;
        this._gains['guest0']  = 0;
        this._gains['guest1']  = 0;

        channels.forEach(ch => {
            const activeSrc = (ch.activeSource === 'B' ? ch.sourceB : ch.sourceA) || '';
            const src = activeSrc.toLowerCase();

            if (src === 'player_1') {
                const g = ch.on ? taper(ch.fader ?? 80) : 0;
                this._gains['player1'] = Math.max(this._gains['player1'] || 0, g);
            }
            if (src === 'player_2') {
                const g = ch.on ? taper(ch.fader ?? 80) : 0;
                this._gains['player2'] = Math.max(this._gains['player2'] || 0, g);
            }
            if (src === 'guest0' || src === 'guest1') {
                const slot  = src === 'guest0' ? 0 : 1;
                const onAir = ch.on && !ch.tb;
                this._gains[src] = onAir ? taper(ch.fader ?? 80) : 0;
                this._guestTB = this._guestTB || {};
                this._guestTB[slot] = !!ch.tb;
            }
        });

        if (micAssignments) {
            micAssignments.forEach(({ key, gain }) => {
                this._gains[key] = gain;
            });
        }
    }

    // Returns TB state per guest slot (for server.js to notify guest page)
    getGuestTB(slot) {
        return !!(this._guestTB?.[slot]);
    }

    // ── Mix 1 tap — DJ earphone path ─────────────────────────────────────────
    // PCM Mix 1 = all sources EXCEPT DJ local mics (mic0, mic1).
    // Produced by _tick() every 20ms as a clock-stable s16le buffer.
    // Sent as binary WS frames to /ws/mix1 → AudioWorklet → DJ earphone.
    // No Opus encoding, no decodeAudioData. Raw PCM → Float32 in audio thread.

    addMix1Client(cb) {
        if (!this._mix1Clients) this._mix1Clients = new Set();
        const wasEmpty = this._mix1Clients.size === 0;
        this._mix1Clients.add(cb);
        // Flush Mix 1 source buffers when first earphone connects (or reconnects
        // after a gap). Prevents stale PCM backlog from flooding the new listener.
        if (wasEmpty) {
            for (const key of AudioMixer.MIX1_KEYS) {
                if (this._bufs[key]) this._bufs[key] = Buffer.alloc(0);
            }
            this._mix1Seq = 0;   // reset seq so worklet sees clean start
            console.log('[mix1] buffers flushed for new earphone connection');
        }
    }

    removeMix1Client(cb) {
        if (!this._mix1Clients) return;
        this._mix1Clients.delete(cb);
    }

    // ── Player 1/2 PCM feed ────────────────────────────────────────────────────

    feedPlayer1(pcmChunk) { this._feedBuf('player1', pcmChunk); }
    feedPlayer2(pcmChunk) { this._feedBuf('player2', pcmChunk); }

    // Called by server.js after players are created, so mixer can report consumption
    setPlayers(player1, player2) {
        this._player1 = player1;
        this._player2 = player2;
        // Give players a back-reference so they can read actual buffer levels
        // for accurate backpressure (avoids byte-counter drift).
        if (player1) { player1._mixer = this; player1._mixerBufKey = 'player1'; }
        if (player2) { player2._mixer = this; player2._mixerBufKey = 'player2'; }
    }
    feedGuest(slot, pcmChunk)    { this._feedBuf(`guest${slot}`, pcmChunk); }  // slot 0=CH7, 1=CH8

    // Feed pre-decoded PCM directly to a mixer key.
    // Used by the WebRTC DJ mic path: mediasoup → FFmpeg RTP → PCM arrives here
    // already decoded (s16le 44100 stereo), bypassing the WebM decoder pipeline.
    feedMicPcm(mixerKey, pcmChunk) { this._feedBuf(mixerKey, pcmChunk); }

    // ── Player 2 PCM feed (redundant section header) ───────────────────────────

    // ── Mic feeds (browser WebM/Opus → PCM) ──────────────────────────────────
    // Each mic session has its own FFmpeg decoder.
    // sessionId: unique string per WebSocket connection (set by server.js)
    // mixerKey:  'mic0' (local CH1) | 'mic1' (local CH2) | 'mic2' (remote CH3) | 'mic3' (remote CH4)

    assignMic(sessionId, mixerKey) {
        if (this._micMap.has(sessionId)) return; // already assigned
        this._micMap.set(sessionId, mixerKey);
        // Flush any pre-registration data — before gain was set, buffer filled
        // with data that would be mixed at gain=0 anyway. Start clean.
        this._bufs[mixerKey] = Buffer.alloc(0);
        if (!this._micDecoders[sessionId]) this._startMicDecoder(sessionId, mixerKey);
        console.log(`[mixer] Mic assigned: session ${sessionId} → ${mixerKey}`);
    }

    releaseMic(sessionId) {
        const key = this._micMap.get(sessionId);
        this._micMap.delete(sessionId);
        const dec = this._micDecoders[sessionId];
        if (dec) {
            try { dec.kill('SIGTERM'); } catch (_) {}
            delete this._micDecoders[sessionId];
        }
        if (key) { this._bufs[key] = Buffer.alloc(0); this._gains[key] = 0; }
        console.log(`[mixer] Mic released: session ${sessionId} (was ${key})`);
    }

    remapMic(sessionId, newKey) {
        const oldKey = this._micMap.get(sessionId);
        if (oldKey === newKey) return;
        this._micMap.set(sessionId, newKey);
        // Move buffered PCM from old key to new key
        if (oldKey && this._bufs[oldKey]) {
            this._bufs[newKey] = this._bufs[oldKey];
            this._bufs[oldKey] = Buffer.alloc(0);
        }
        console.log(`[mixer] Mic remapped: session ${sessionId}: ${oldKey} → ${newKey}`);
    }

    // Called when browser sends raw PCM16 mono 48kHz from AudioWorklet mic capture.
    // No FFmpeg decode needed — just resample 48kHz mono → 44100Hz stereo and feed.
    // Float32 mic feed — converts browser Float32 48kHz mono → Float64 44.1kHz stereo.
    // src: Float32 mono 48kHz (values in [-1, +1]).
    // Resample 48kHz → 44100Hz using linear interpolation, duplicate to stereo,
    // then feed into the mixer buffer as f64le stereo (maximum precision).
    feedMicF32(sessionId, float32Buffer) {
        const key = this._micMap.get(sessionId);
        if (!key) return;
        // src: mono Float32 at 48000Hz
        const src    = new Float32Array(float32Buffer);
        const ratio  = 48000 / 44100;           // ~1.0884
        const outLen = Math.round(src.length / ratio);
        // Output: stereo Float32 at 44100Hz = outLen frames × 2 ch × 4 bytes = outLen * 8 bytes
        const out    = Buffer.allocUnsafe(outLen * 16);  // f64le stereo = 16 bytes/frame
        let srcPhase = this._micPhase?.[sessionId] || 0;
        for (let i = 0; i < outLen; i++) {
            const idx  = Math.floor(srcPhase);
            const frac = srcPhase - idx;
            const s0   = src[Math.min(idx,     src.length - 1)];
            const s1   = src[Math.min(idx + 1, src.length - 1)];
            const s    = s0 + (s1 - s0) * frac;   // linear interp — no quantisation
            out.writeDoubleLE(s, i * 16);            // L
            out.writeDoubleLE(s, i * 16 + 8);        // R (mono → stereo)
            srcPhase += ratio;
        }
        if (!this._micPhase) this._micPhase = {};
        this._micPhase[sessionId] = srcPhase - src.length;
        // Automatic delay compensation for DJ local mics (mic0/mic1).
        // The DJ hears PGM1 through their earphone with ~700ms jitter buffer
        // plus network one-way latency. Their voice is naturally offset by that
        // amount. We delay mic0/mic1 in the broadcast mix by _micDelayMs so
        // voice aligns with music in the Icecast output.
        // _micDelayMs is set automatically from the browser RTT measurement.
        if (this._micDelayMs > 0 && (key === 'mic0' || key === 'mic1')) {
            this._feedBufDelayed(key, out);
        } else {
            this._feedBuf(key, out);
        }
    }

    // Delay line for mic0/mic1: holds _micDelayMs worth of PCM before releasing
    // to _feedBuf. This aligns DJ voice with PGM1 music in the broadcast mix.
    // _micDelayBufs[key] = { buf: Buffer, targetBytes: number }
    _feedBufDelayed(key, chunk) {
        if (!this._micDelayBufs) this._micDelayBufs = {};
        // delayBytes must be a whole number of frames
        const delayBytes = Math.round(this._micDelayMs * SAMPLE_RATE / 1000) * BYTES_FRAME;
        const slot = this._micDelayBufs[key];
        if (!slot || slot.targetBytes !== delayBytes) {
            // (Re)initialise: pre-fill with silence equal to the target delay
            const silence = Buffer.alloc(delayBytes, 0);
            this._micDelayBufs[key] = { buf: Buffer.concat([silence, chunk]), targetBytes: delayBytes };
        } else {
            slot.buf = Buffer.concat([slot.buf, chunk]);
        }
        // Drain everything beyond the delay depth into the real mixer buffer
        const s = this._micDelayBufs[key];
        if (s.buf.length > s.targetBytes) {
            const release = s.buf.slice(0, s.buf.length - s.targetBytes);
            s.buf = s.buf.slice(s.buf.length - s.targetBytes);
            this._feedBuf(key, release);
        }
    }

    feedMicChunk(sessionId, webmChunk) {
        if (!this._micDecoders[sessionId]) {
            const key = this._micMap.get(sessionId);
            if (key) this._startMicDecoder(sessionId, key);
        }
        const dec = this._micDecoders[sessionId];
        if (dec?.stdin?.writable) {
            try { dec.stdin.write(webmChunk); } catch (_) {}
        }
    }

    _startMicDecoder(sessionId, mixerKey) {
        const proc = spawn('ffmpeg', [
            '-hide_banner', '-nostats', '-loglevel', 'warning',
            '-f', 'webm', '-i', 'pipe:0',
            '-f', 'f64le', '-ar', '44100', '-ac', '2',
            'pipe:1'
        ], { stdio: ['pipe', 'pipe', 'pipe'] });

        this._micDecoders[sessionId] = proc;

        proc.stdout.on('data', (chunk) => {
            const key = this._micMap.get(sessionId);
            if (key) this._feedBuf(key, chunk);
        });
        proc.stderr.on('data', (d) => {
            const t = d.toString().trim();
            if (t) process.stdout.write(`[mic-${mixerKey}] ${t}\n`);
        });
        proc.on('exit', () => {
            delete this._micDecoders[sessionId];
            if (this._streaming && this._micMap.has(sessionId)) {
                setTimeout(() => {
                    const key = this._micMap.get(sessionId);
                    if (key) this._startMicDecoder(sessionId, key);
                }, 500);
            }
        });
        console.log(`[mixer] Mic decoder started: session ${sessionId} → ${mixerKey}`);
    }

    // ── Generic buffer feed ───────────────────────────────────────────────────
    // BUF_CAP: hard ceiling on the mixer buffer per source.
    // Backpressure in player.js pauses FFmpeg at BUF_HIGH=800ms, so this cap
    // is a last-resort safety net. Set to 1500ms — above BUF_HIGH=800ms.
    static get BUF_CAP() { return Math.round(44100 * 16 * 1.500); }  // 1500ms ceiling (f64le stereo = 16 bytes/frame)

    _feedBuf(key, chunk) {
        let cur = this._bufs[key];
        if (!cur || cur.length === 0) {
            this._bufs[key] = chunk;
            return;
        }
        cur = Buffer.concat([cur, chunk]);
        if (cur.length > AudioMixer.BUF_CAP) cur = cur.slice(cur.length - AudioMixer.BUF_CAP);
        this._bufs[key] = cur;
    }

    // ── Mix ticker ────────────────────────────────────────────────────────────

    _startTicker() {
        clearInterval(this._ticker);
        this._lastTickAt = Date.now();  // reset drift baseline on (re)start
        this._ticker = setInterval(() => this._tick(), MIX_INTERVAL);
    }

    _stopTicker() {
        clearInterval(this._ticker);
        this._ticker = null;
    }

    // Public API — called by server.js on browser connect/disconnect
    startTicker() {
        if (this._ticker) return; // already running
        this._startTicker();
        console.log('[mixer] Ticker started');
    }

    stopTicker() {
        if (!this._ticker) return; // already stopped
        // Safety: never stop ticker while streaming — stream:stop must be called first
        if (this._wantStreaming || this._streaming) {
            console.warn('[mixer] stopTicker ignored — stream still active');
            return;
        }
        this._stopTicker();
        console.log('[mixer] Ticker stopped');
    }

    _tick() {
        // ── Drift-compensated frame count ────────────────────────────────────
        const now     = Date.now();
        const elapsed = this._lastTickAt ? Math.min(now - this._lastTickAt, MIX_INTERVAL * 3) : MIX_INTERVAL;
        this._lastTickAt = now;
        const frames  = Math.round(SAMPLE_RATE * elapsed / 1000);
        const needed  = frames * BYTES_FRAME;

        const allKeys = Object.keys(this._bufs);

        // Periodic diagnostic: log gains + buffer sizes + mix1 clients every 5 seconds
        this._diagCount = (this._diagCount || 0) + 1;
        if (this._diagCount >= 250) {
            this._diagCount = 0;
            const g = this._gains;
            const b = this._bufs;
            process.stdout.write(
                `[mixer tick] gains: p1=${(g.player1||0).toFixed(3)} p2=${(g.player2||0).toFixed(3)}` +
                ` mic0=${(g.mic0||0).toFixed(3)} mic2=${(g.mic2||0).toFixed(3)}` +
                ` | bufs: p1=${b.player1?.length||0}B p2=${b.player2?.length||0}B mic0=${b.mic0?.length||0}B` +
                ` | mix1keys=[${[...AudioMixer.MIX1_KEYS].join(',')}]` +
                ` | mix1clients=${this._mix1Clients?.size||0} ticker=running\n`
            );
        }

        // ── TWO-MIXER ARCHITECTURE ────────────────────────────────────────────
        //
        // MIX 1 (station mix — earphone source):
        //   player1, player2, mic2, mic3 (remote), guest0, guest1
        //   → outMix1 → /ws/mix1 WS → AudioWorklet → DJ earphone
        //   DJ local mics (mic0/mic1) deliberately excluded — self-monitor is
        //   handled by Web Audio at 0ms. No server round-trip, no echo risk.
        //
        // MIX 2 (broadcast):
        //   outMix1 + mic0 + mic1 (DJ local mics)
        //   → out → Opus encoder → Liquidsoap → Icecast
        //
        // This separation ensures the DJ earphone NEVER contains their own mic
        // via the server path — eliminating the echo/feedback risk entirely.

        const out     = Buffer.alloc(needed, 0);   // full broadcast mix (f64le output)
        const outMix1 = Buffer.alloc(needed, 0);   // station mix (f64le output)

        // Float32 scratch accumulators — accumulate all sources as floats,
        // convert to Int16 once at the end. Eliminates per-source rounding noise.
        const numSamples = needed >> 3;   // Float64 = 8 bytes per sample
        const _fOut  = new Float64Array(numSamples);   // broadcast mix accumulator
        const _fMix1 = new Float64Array(numSamples);   // station mix accumulator
        const _fCue  = new Float64Array(numSamples);   // CUE bus (pre-fader, all CUE-active channels)

        // Step 1: drain ALL buffers at tick rate.
        // reportConsumed tracks actual bytes drained. When buf is empty we still
        // report `needed` so _bytesConsumed stays in sync and FFmpeg resumes.
        // We track p1/p2 consumed separately and report once after the loop.
        //
        let p1Consumed = 0, p2Consumed = 0;

        for (const key of allKeys) {
            const buf = this._bufs[key] || Buffer.alloc(0);

            let chunk, consumed = 0;
            if (buf.length === 0) {
                // Buffer empty — output silence for this channel this tick.
                // MUST still report consumed=needed so _bytesFed-_bytesConsumed
                // converges to 0 after FFmpeg exits — otherwise _waitDrain
                // polls forever and the next track never starts.
                if (key === 'player1') p1Consumed = needed;
                if (key === 'player2') p2Consumed = needed;
                continue;
            }

            if (buf.length >= needed) {
                chunk           = buf.slice(0, needed);
                this._bufs[key] = buf.slice(needed);
                consumed        = needed;
            } else {
                // Zero-pad partial chunk to `needed` bytes so the mix loop never
                // reads silence mid-buffer (avoids tiny glitches at chunk boundaries)
                chunk           = Buffer.alloc(needed, 0);
                buf.copy(chunk, 0, 0, buf.length);
                this._bufs[key] = Buffer.alloc(0);
                consumed        = buf.length;
            }
            if (key === 'player1') p1Consumed = consumed;
            if (key === 'player2') p2Consumed = consumed;

            const gain = this._gains[key] || 0;

            // Accumulate RMS for VU metering.
            // Mic channels (mic0-mic3) are metered pre-fader — DJ sees signal
            // regardless of ON/OFF state, matching hardware console behaviour.
            // Player/guest channels are metered post-fader (only when ON/gain>0).
            const isMicKey = key === 'mic0' || key === 'mic1' || key === 'mic2' || key === 'mic3';
            const doVU = isMicKey ? (chunk.length >= 2) : (gain > 0 && chunk.length >= 2);
            if (doVU) {
                if (!this._vuSum) this._vuSum = {};
                if (!this._vuCnt) this._vuCnt = {};
                // Float32: values already in [-1,+1]. No division by 32768 needed.
                const vuGain = isMicKey ? 1 : gain;
                const vuSamples = Math.min(256, Math.floor(chunk.length / 8));
                let vuSum = 0;
                for (let vi = 0; vi < vuSamples * 8; vi += 8) {
                    const s = chunk.readDoubleLE(vi) * vuGain;
                    vuSum += s * s;
                }
                this._vuSum[key] = (this._vuSum[key] || 0) + vuSum;
                this._vuCnt[key] = (this._vuCnt[key] || 0) + vuSamples;
            }

            if (gain === 0) continue;

            const inMix1 = AudioMixer.MIX1_KEYS.has(key);
            const inCue  = !!(this._cueFlags?.[key]);   // CUE: pre-fader, unity gain

            for (let i = 0; i < needed; i += 8) {
                // Read Float64 — no quantisation, full 64-bit precision
                const sample = chunk.readDoubleLE(i) * gain;

                // Accumulate into float64 scratch arrays (indexed by sample position)
                const si = i >> 3;   // sample index (0-based, 8 bytes per float64)
                _fOut[si]  = (_fOut[si]  || 0) + sample;
                if (inMix1) _fMix1[si] = (_fMix1[si] || 0) + sample;
                // CUE bus: accumulate raw sample at unity gain (pre-fader listen)
                if (inCue) {
                    const rawSample = chunk.readDoubleLE(i);
                    _fCue[si] = (_fCue[si] || 0) + rawSample;
                }
            }
        }

        // CUE output buffer (f64le)
        const outCue = Buffer.alloc(needed, 0);

        // Convert float64 accumulators → Float32 output buffers.
        // _fOut values are in float domain ([-1,+1] per channel, sum of all channels).
        // Soft clamp to ±1.0 to prevent inter-channel summing from exceeding codec range.
        // No /32768 — that was the Int16 era. Float32 is already normalised.
        for (let si = 0; si < numSamples; si++) {
            const i = si << 3;   // 8 bytes per Float64 sample
            if (_fOut[si] !== 0) {
                out.writeDoubleLE(Math.max(-1, Math.min(1, _fOut[si])), i);
            }
            if (_fMix1[si] !== 0) {
                outMix1.writeDoubleLE(Math.max(-1, Math.min(1, _fMix1[si])), i);
            }
            if (_fCue[si] !== 0) {
                outCue.writeDoubleLE(Math.max(-1, Math.min(1, _fCue[si])), i);
            }
            _fOut[si]  = 0;
            _fMix1[si] = 0;
        }

        // Write full broadcast mix to Liquidsoap encoder
        if (this._encoder?.stdin?.writable && !this._encoder.stdin.writableNeedDrain) {
            try { this._encoder.stdin.write(out); } catch (_) {}
        }

        // Write mix1 (station, no DJ mics) directly to earphone WS clients.
        // Report consumed bytes to players for backpressure control
        if (this._player1 && p1Consumed > 0) this._player1.reportConsumed(p1Consumed);
        if (this._player2 && p2Consumed > 0) this._player2.reportConsumed(p2Consumed);

        // Select monitor bus: PGM1 (default) or CUE (pre-fader listen)
        const monBus = this._monitorSource === 'cue' ? outCue : outMix1;

        // Each frame is prefixed with an 8-byte header:
        //   bytes 0-3: uint32 sequence number (wraps at 2^32)
        //   bytes 4-7: uint32 VPS wall-clock ms (low 32 bits of Date.now())
        // Browser uses these to measure clock offset and detect gaps/duplicates.
        if (this._mix1Clients?.size) {
            const pcm    = monBus;
            const header = Buffer.allocUnsafe(8);
            header.writeUInt32LE(this._mix1Seq >>> 0, 0);
            header.writeUInt32LE(Date.now() >>> 0, 4);
            this._mix1Seq++;
            const frame = Buffer.concat([header, pcm]);
            this._mix1Clients.forEach(cb => {
                try { cb(frame); }
                catch (_) { this._mix1Clients.delete(cb); }
            });
        }

        // WebRTC earphone sessions — feed selected monitor bus
        if (this._rtcGuests) {
            this._rtcGuests.getEarphoneIds().forEach(sid => {
                this._rtcGuests.feedEarphone(sid, monBus);
            });
        }

        // Monitor encoder: feed selected monitor bus (PGM1 or CUE).
        if (this._monitorEncoder?.stdin?.writable && !this._monitorEncoder.stdin.writableNeedDrain && this._monitorClients.size > 0) {
            try { this._monitorEncoder.stdin.write(monBus); } catch (_) {}
        }

        // VU metering — RMS was accumulated during drain loop above (_vuSum/_vuCnt)
        this._vuTickCount = (this._vuTickCount || 0) + 1;
        if (this._vuTickCount >= 5) {
            this._vuTickCount = 0;
            const levels = {};
            const VU_KEYS = ['mic0','mic1','mic2','mic3','player1','player2','guest0','guest1'];
            for (const key of VU_KEYS) {
                const sum = this._vuSum?.[key] || 0;
                const cnt = this._vuCnt?.[key] || 0;
                levels[key] = cnt > 0 ? Math.sqrt(sum / cnt) : 0;
            }
            // Add real Mix2 (broadcast) and Mix1 (station) RMS from actual output buffers
            // so PGM1/PGM2 meters reflect truth, not a sum of estimates.
            const _rms = (buf) => {
                let s = 0;
                const n = Math.min(256, Math.floor(buf.length / 8));
                for (let i = 0; i < n; i++) s += buf.readDoubleLE(i*8)**2;
                return n > 0 ? Math.sqrt(s/n) : 0;
            };
            levels._mix1rms = _rms(outMix1);
            levels._mix2rms = _rms(out);
            this._vuSum = {};
            this._vuCnt = {};
            this.emit('levels', levels);
        }
    }

    // ── Connect to Liquidsoap ─────────────────────────────────────────────────

    async start() {
        if (this._wantStreaming) throw new Error('Already streaming');
        this._wantStreaming  = true;
        this._reconnCount    = 0;
        this.error           = null;
        this._connect();
        await new Promise(r => setTimeout(r, 1200));
    }

    async stop() {
        this._wantStreaming = false;
        clearTimeout(this._reconnTimer);
        // Ticker keeps running after stream stop — player buffers must drain.
        // The ticker is stopped by server.js only when ALL browsers disconnect.
        this._killEncoder();
        if (this._micDecoder) {
            try { this._micDecoder.kill('SIGTERM'); } catch (_) {}
            this._micDecoder = null;
        }
        if (this._socket) {
            try { this._socket.destroy(); } catch (_) {}
            this._socket = null;
        }
        this._streaming  = false;
        this.error       = null;
        console.log('✓ Mixer/stream stopped');
        this.emit('stopped');
        // Monitor encoder is managed separately by server.js (startMonitor/stopMonitor).
    }

    _connect() {
        if (!this._wantStreaming) return;

        const dj  = this.config.azuracast_dj;
        const aud = this.config.audio;

        if (!dj?.server || !dj?.port || !dj?.username || !dj?.password) {
            this.error = 'AzuraCast DJ connection not configured';
            this._wantStreaming = false;
            this.emit('error', this.error);
            return;
        }

        this._streaming  = false;

        const mount    = (dj.mount || '/').trim();
        const urlMount = mount.startsWith('/') ? mount : '/' + mount;
        const b64auth  = Buffer.from(`${dj.username}:${dj.password}`).toString('base64');

        console.log(`📡 Mixer connecting → Liquidsoap ${dj.server}:${dj.port}${urlMount}`);

        let errEmitted = false;
        let connTimer  = null;

        const emitErr = (msg) => {
            if (errEmitted) return;
            errEmitted = true;
            clearTimeout(connTimer);
            this.error      = msg;
            this._streaming  = false;
            console.error('✗ Mixer error:', msg);
            this.emit('error', msg);
            this._scheduleReconnect();
        };

        this._socket = new net.Socket();
        // TCP keepalive: detect dead connections within ~15s instead of OS default (~2h).
        // Prevents Liquidsoap idle-timeout from silently dropping the connection.
        this._socket.setKeepAlive(true, 5000);  // start probes after 5s idle
        // Nagle off: send each Ogg chunk immediately, no 200ms buffering delay.
        this._socket.setNoDelay(true);
        // Handle socket-level errors explicitly — prevents EPIPE becoming uncaught exception
        this._socket.on('error', (err) => {
            if (err.code === 'EPIPE' || err.code === 'ECONNRESET') {
                // Expected on Liquidsoap restart or timeout — reconnect handles it
                console.warn(`[socket] ${err.code} — will reconnect`);
            } else {
                console.error(`[socket] ${err.message}`);
            }
        });
        this._socket.connect(parseInt(dj.port), dj.server, () => {
            const handshake = [
                `SOURCE ${urlMount} HTTP/1.0`,
                `Authorization: Basic ${b64auth}`,
                `Content-Type: application/ogg`,
                `ice-name: Chilled Koala Live`,
                `ice-genre: Live`,
                `ice-public: 0`,
                `User-Agent: ChilledKoala/2.1`,
                '', ''
            ].join('\r\n');
            this._socket.write(handshake);
        });

        let headerBuf = '';
        let handshakeDone = false;
        this._socket.on('data', (chunk) => {
            if (handshakeDone) return;
            headerBuf += chunk.toString();
            if (!headerBuf.includes('\n')) return;
            const firstLine = headerBuf.split('\n')[0].trim();
            console.log(`[mixer] Liquidsoap: ${firstLine}`);
            if (firstLine.includes('200') || firstLine.toLowerCase().includes('ok')) {
                handshakeDone   = true;
                this._streaming  = true;
                this.startTime  = Date.now();
                this.error      = null;
                this._reconnCount = 0;
                clearTimeout(connTimer);
                console.log('✓ LIVE — Liquidsoap accepted mixer connection');
                if (this._encoder) {
                    // Reconnect: re-pipe existing running encoder to new socket.
                    // Ogg stream is continuous — no gap from Liquidsoap's perspective.
                    this._encoder.stdout.on('error', (e) => {
                        console.warn(`[encoder stdout] pipe error: ${e.message}`);
                    });
                    this._encoder.stdout.pipe(this._socket, { end: false });
                    console.log('[mixer] Encoder re-piped to new socket (no stream gap)');
                } else {
                    // Fresh connect: start encoder for the first time
                    this._startEncoder(aud);
                }
                // Do NOT call _startTicker() — already running.
                this.emit('started');
            } else if (firstLine.includes('401') || firstLine.includes('403')) {
                emitErr('Liquidsoap rejected credentials — check DJ settings');
                this._socket.destroy();
            } else {
                emitErr(`Liquidsoap error: ${firstLine}`);
                this._socket.destroy();
            }
        });

        this._socket.on('error', (err) => {
            emitErr(err.code === 'ECONNREFUSED'
                ? `Connection refused — Liquidsoap on ${dj.server}:${dj.port}?`
                : `TCP error: ${err.message}`);
        });

        this._socket.on('close', () => {
            if (this._streaming && this._wantStreaming) {
                console.log('⚠ Mixer TCP closed — reconnecting (encoder kept alive)');
                this._streaming  = false;
                // Detach encoder from dead socket — DO NOT kill it.
                // Encoder keeps receiving PCM ticks (silence or audio) so the
                // internal Ogg stream stays continuous, ready to re-pipe on reconnect.
                this._detachEncoder();
                this._socket = null;
                this.emit('dropped');
                this._scheduleReconnect();
            }
        });

        connTimer = setTimeout(() => {
            if (!this._streaming && !errEmitted) {
                emitErr(`Liquidsoap did not respond within 8s`);
                this._socket?.destroy();
            }
        }, 8000);
    }

    // ── PGM Monitor stream ────────────────────────────────────────────────────
    // Encodes the live RT PGM mix → Ogg/Opus 64kbps, pushed to HTTP clients.
    // The encoder only runs while at least one browser WebSocket is connected.
    // Called by server.js via startMonitor() / stopMonitor() on WS connect/disconnect.

    startMonitor() {
        if (this._monitorRunning) return; // already running
        this._monitorRunning = true;

        // Low-latency WebM/Opus encoder for DJ earphone monitor.
        // Priority is minimum latency, not quality — the DJ needs to hear what is
        // happening NOW so they can mix mic with the track in real time.
        //
        // Key settings:
        //   -application lowdelay   Opus encoder mode optimised for real-time monitoring
        //   -vbr off / -cbr 1       CBR — no lookahead buffering for VBR decisions
        //   -frame_duration 20      20ms Opus frames (shortest practical)
        //   -compression_level 0    Zero encode CPU — lowest algorithmic delay
        const proc = spawn('ffmpeg', [
            '-hide_banner', '-nostats', '-loglevel', 'warning',
            '-f', 'f64le', '-ar', '44100', '-ac', '2', '-i', 'pipe:0',
            '-acodec', 'libopus',
            '-sample_fmt', 'flt',           // Opus requires flt/s16; convert from f64le
            '-b:a', '128k',
            '-vbr', 'off',
            '-application', 'audio',
            '-compression_level', '1',
            '-frame_duration', '20',
            '-f', 'webm',
            'pipe:1'
        ], { stdio: ['pipe', 'pipe', 'pipe'] });

        this._monitorEncoder = proc;

        let _initBuf = Buffer.alloc(0);
        let _initDone = false;
        proc.stdout.on('data', (chunk) => {
            // Buffer the WebM init segment (first ~few KB until we see a media cluster).
            // New clients receive _monitorInitSeg before live chunks so the browser
            // can decode mid-stream without needing to connect from the beginning.
            if (!_initDone) {
                _initBuf = Buffer.concat([_initBuf, chunk]);
                // WebM Cluster element ID = 0x1F43B675 — marks start of audio data.
                // Everything before the first cluster is the init segment.
                const clusterMagic = Buffer.from([0x1F, 0x43, 0xB6, 0x75]);
                const idx = _initBuf.indexOf(clusterMagic);
                if (idx > 0) {
                    this._monitorInitSeg = _initBuf.slice(0, idx);
                    _initDone = true;
                    // Send init + first cluster chunk to already-waiting clients
                    this._monitorClients.forEach(cb => {
                        try { cb(_initBuf); } catch (_) { this._monitorClients.delete(cb); }
                    });
                    _initBuf = Buffer.alloc(0);
                } else if (_initBuf.length > 65536) {
                    // Safety: if init segment not found after 64KB, just flush as-is
                    this._monitorInitSeg = _initBuf;
                    _initDone = true;
                    this._monitorClients.forEach(cb => {
                        try { cb(_initBuf); } catch (_) { this._monitorClients.delete(cb); }
                    });
                    _initBuf = Buffer.alloc(0);
                }
                // else: still accumulating init segment, don't send yet
                return;
            }
            this._monitorClients.forEach(cb => {
                try { cb(chunk); } catch (_) { this._monitorClients.delete(cb); }
            });
        });

        // Without these handlers, a broken pipe on browser disconnect raises an
        // uncaught 'error' event which Node turns into a process crash (6700+ restarts).
        proc.stdout.on('error', (e) => {
            console.warn(`[monitor-enc] stdout pipe error: ${e.message}`);
        });
        proc.stdin.on('error', (e) => {
            console.warn(`[monitor-enc] stdin pipe error: ${e.message}`);
        });

        proc.stderr.on('data', (d) => {
            const t = d.toString().trim();
            if (t) process.stdout.write(`[monitor-enc] ${t}\n`);
        });

        proc.on('exit', (code) => {
            this._monitorEncoder  = null;
            this._monitorRunning  = false;
            this._monitorInitSeg  = null;
            this._monitorClients.clear();
            if (code !== null && code !== 0) {
                console.warn(`[monitor-enc] exited with code ${code}`);
            }
        });

        console.log('[monitor-enc] started (browser connected)');
    }

    stopMonitor() {
        if (!this._monitorRunning) return;
        this._monitorRunning = false;
        if (this._monitorEncoder) {
            try { this._monitorEncoder.stdin.end(); } catch (_) {}
            try { this._monitorEncoder.kill('SIGTERM'); } catch (_) {}
            this._monitorEncoder = null;
        }
        console.log('[monitor-enc] stopped (no browsers connected)');
    }

    // Monitor clients: Set of callback functions (chunk: Buffer) => void
    // Each callback is the primary DJ's WebSocket send function.
    addMonitorClient(cb) {
        // Send buffered init segment immediately so browser can decode from here
        if (this._monitorInitSeg) {
            try { cb(this._monitorInitSeg); } catch (_) { return; }
        }
        this._monitorClients.add(cb);
    }

    removeMonitorClient(cb) {
        this._monitorClients.delete(cb);
    }

    _startEncoder(aud) {
        // FFmpeg: raw PCM stdin → Ogg/Opus stdout → TCP socket → Liquidsoap
        const bitrate = aud?.bitrate || 320;
        const title  = this.metadata.title  || '';
        const artist = this.metadata.artist || 'Gato Preto Radio';
        this._encoder = spawn('ffmpeg', [
            '-hide_banner', '-nostats', '-loglevel', 'warning',
            '-f', 'f64le', '-ar', '44100', '-ac', '2', '-i', 'pipe:0',
            '-acodec', 'libopus',
            '-sample_fmt', 'flt',           // Opus requires flt/s16; convert from f64le
            '-b:a', `${bitrate}k`,
            '-vbr', 'on',
            '-compression_level', '6',
            '-frame_duration', '20',
            '-metadata', `title=${title}`,
            '-metadata', `artist=${artist}`,
            '-metadata', `comment=Gato Preto Radio Live`,
            '-f', 'ogg',
            'pipe:1'
        ], { stdio: ['pipe', 'pipe', 'pipe'] });

        // Pipe encoder output to Liquidsoap socket.
        // Add error handler — without it, a broken pipe raises an uncaught 'error'
        // event on the stream which Node turns into SIGPIPE → process crash.
        this._encoder.stdout.on('error', (e) => {
            console.warn(`[encoder stdout] pipe error: ${e.message}`);
        });
        this._encoder.stdout.pipe(this._socket, { end: false });

        this._encoder.stderr.on('data', (d) => {
            const t = d.toString().trim();
            if (t) process.stdout.write(`[encoder] ${t}\n`);
        });

        this._encoder.stdin.on('error', (e) => {
            // stdin EPIPE: FFmpeg exited while we were writing — exit handler will restart it
            console.warn(`[encoder stdin] ${e.message}`);
        });

        this._encoder.on('exit', (code, signal) => {
            console.log(`[encoder exit] code=${code} signal=${signal}`);
            this._encoder = null;
            if (this._streaming && this._wantStreaming && this._socket?.writable) {
                // Encoder crashed during active stream — restart and re-pipe to existing socket
                console.log('[encoder] Restarting → re-piping to existing socket');
                this._startEncoder(aud);
            } else if (this._wantStreaming) {
                this._scheduleReconnect();
            }
        });

        console.log(`[mixer] Encoder started → Ogg/Opus ${bitrate}kbps cl=6 → Liquidsoap`);
    }

    _killEncoder() {
        // Full kill — used only on explicit stop(). Ends the Ogg stream.
        if (this._encoder) {
            try { this._encoder.stdin.end(); }   catch (_) {}
            try { this._encoder.kill('SIGTERM'); } catch (_) {}
            this._encoder = null;
        }
    }

    _detachEncoder() {
        // Detach encoder stdout from the current socket WITHOUT killing FFmpeg.
        // Used during reconnect: encoder keeps running (Ogg stream stays continuous),
        // we just connect its stdout to the new socket when reconnect succeeds.
        if (this._encoder && this._socket) {
            try { this._encoder.stdout.unpipe(this._socket); } catch (_) {}
        }
    }

    _scheduleReconnect() {
        if (!this._wantStreaming) return;
        clearTimeout(this._reconnTimer);

        // Reconnect strategy: fast retries first, then slow.
        // Keeping the gap to Liquidsoap as short as possible prevents AutoDJ fallback flicker.
        //   attempts 1-3:  50ms  — covers transient TCP glitches
        //   attempts 4-6:  1s    — covers brief network interruptions
        //   attempts 7+:   5s    — long-term issues; keep trying until explicit stop()
        // maxReconnect is removed — we retry forever while _wantStreaming is true.
        // Only mixer.stop() (explicit DJ action or browser close) ends the stream.
        this._reconnCount++;
        const delay = this._reconnCount <= 3 ? 50
                    : this._reconnCount <= 6 ? 1000
                    : 5000;
        console.log(`↻ Reconnect attempt ${this._reconnCount} in ${delay}ms`);
        this._reconnTimer = setTimeout(() => this._connect(), delay);
    }

    updateMetadata(title, artist) {
        this.metadata = { title: title || '', artist: artist || 'Gato Preto Radio' };
        if (this._streaming) {
            this._sendMetadataToIcecast();
            this._sendMetadataToAzuraCast();
        }
        this.emit('metadataUpdated', this.metadata);
    }

    // Path 1: Icecast /admin/metadata — updates ICY metadata on the SOURCE mount (/live)
    // This is read by some players directly from the Icecast source stream.
    _sendMetadataToIcecast() {
        const ic   = this.config.icecast;
        const song = [this.metadata.artist, this.metadata.title].filter(Boolean).join(' - ');
        // Send to both /live (source mount) and the listener mount
        const mounts = [ic.mount, ic.listener_mount].filter(Boolean);
        mounts.forEach(mount => {
            const opts = {
                hostname: ic.server === 'localhost' ? '127.0.0.1' : ic.server,
                port:     parseInt(ic.port),
                path:     `/admin/metadata?mount=${encodeURIComponent(mount)}&mode=updinfo&song=${encodeURIComponent(song)}`,
                method:   'GET',
                headers: { 'Authorization': 'Basic ' + Buffer.from(`source:${ic.password}`).toString('base64') }
            };
            const req = http.request(opts, (res) => {
                if (res.statusCode !== 200)
                    process.stdout.write(`[metadata] Icecast ${mount} → HTTP ${res.statusCode}\n`);
            });
            req.on('error', () => {});
            req.setTimeout(3000, () => req.destroy());
            req.end();
        });
    }

    // Path 2: AzuraCast station API — updates NowPlaying for all mounts including /radio.aac1
    // This is what the iOS app (and AzuraCast public pages) read.
    // Requires azuracast_api_key in config.ini [azuracast] section.
    _sendMetadataToAzuraCast() {
        const az  = this.config.azuracast;
        if (!az?.api_key || !az?.station_id) return; // not configured — skip silently
        const song   = [this.metadata.artist, this.metadata.title].filter(Boolean).join(' - ');
        const body   = JSON.stringify({ song_id: null, artist: this.metadata.artist, title: this.metadata.title });
        const opts = {
            hostname: az.server || '127.0.0.1',
            port:     parseInt(az.port || 80),
            path:     `/api/station/${az.station_id}/nowplaying`,
            method:   'POST',
            headers: {
                'X-API-Key':      az.api_key,
                'Content-Type':   'application/json',
                'Content-Length': Buffer.byteLength(body),
            }
        };
        // Use https if configured
        const mod = (az.https === 'true') ? require('https') : http;
        const req = mod.request(opts, (res) => {
            if (res.statusCode !== 200)
                process.stdout.write(`[metadata] AzuraCast API → HTTP ${res.statusCode}\n`);
        });
        req.on('error', () => {});
        req.setTimeout(3000, () => req.destroy());
        req.write(body);
        req.end();
        process.stdout.write(`[metadata] → AzuraCast: ${song}\n`);
    }

    // ── Status ────────────────────────────────────────────────────────────────

    isStreaming()  { return this._streaming; }
    isConnecting() { return !this._streaming && this._wantStreaming; }
    getError()     { return this.error; }

    // Switch monitor/earphone source: 'pgm1' (Mix 1, default) or 'cue' (pre-fader CUE bus)
    setMonitorSource(src) {
        if (src === 'pgm1' || src === 'cue') {
            this._monitorSource = src;
        }
    }

    // Update which channel keys have CUE active (pre-fader listen).
    // cueMap: object keyed by mixerKey (e.g. 'player1', 'mic0') → bool
    setCueFlags(cueMap) {
        this._cueFlags = cueMap || {};
    }

    // ── Mic Delay Compensation ────────────────────────────────────────────────
    // Sets delay (ms) applied to mic0/mic1 before they enter PGM2 broadcast mix.
    // Persisted in config.ini [audio] mic_delay_ms via server.js saveConfig().
    // Auto-detected value = RTT/2 + 700ms (jitter buffer), sent by browser on connect.
    setMicDelayMs(ms) {
        const clamped = Math.max(0, Math.min(2000, Math.round(ms)));
        this._micDelayMs = clamped;
        // Keep config reference in sync so saveConfig() persists the value
        if (this.config.audio) this.config.audio.mic_delay_ms = String(clamped);
        // Clear delay buffers so old stale data doesn't bleed through on change
        this._micDelayBufs = {};
        console.log(`[mixer] mic delay compensation set to ${clamped}ms`);
    }

    getMicDelayMs() { return this._micDelayMs || 0; }

    getStatus() {
        const ic = this.config.icecast;
        return {
            streaming:  this._streaming,
            connecting: this.isConnecting(),
            error:      this.error,
            uptime:     this.startTime ? Math.round((Date.now() - this.startTime) / 1000) : 0,
            metadata:   this.metadata,
            icecast:    { server: ic.server, port: ic.port, mount: ic.mount },
        };
    }
}

module.exports = AudioMixer;

// Sources included in PCM Mix 1 (station mix → DJ earphone).
// mic0/mic1 (DJ local mics) are deliberately excluded — they go only to Mix 2 (broadcast).
// Self-monitoring of DJ mic is handled by Web Audio at 0ms in the browser.
AudioMixer.MIX1_KEYS = new Set(['player1','player2','mic2','mic3','guest0','guest1']);
