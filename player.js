/**
 * Chilled Koala v2.0.0 — Server-Side RA Player Engine
 * Plays FLAC files directly on VPS via FFmpeg.
 * Crossfade via overlapping FFmpeg processes + volume ramp.
 * Streams raw PCM to the Mixer for mixing with mic and other sources.
 *
 * BACKPRESSURE: FFmpeg stdout is paused when the MIXER BUFFER is full
 * and resumed when it drains enough. We check mixer._bufs['player1'].length
 * directly — this is the actual buffer level, with no byte-counter drift.
 * Without backpressure, FFmpeg decodes a full FLAC in milliseconds and exits
 * immediately, causing the playlist to race through every track instantly.
 *
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

// Audio constants — must match mixer.js
const SAMPLE_RATE  = 44100;
const CHANNELS     = 2;
const BYTES_FRAME  = 8 * CHANNELS;   // f64le stereo = 16 bytes per sample

// Backpressure thresholds — checked against the ACTUAL mixer buffer length.
// BUF_HIGH: pause FFmpeg when mixer has this many bytes buffered.
// BUF_LOW:  resume FFmpeg when mixer drains to this level.
// 800ms/400ms: LOW=400ms keeps the buffer well above 0 between bursts.
// OS pipe buffer = ~372ms per burst, fits inside the 400ms LOW cushion.
// Window of 400ms prevents rapid pause/resume cycling.
const BUF_HIGH  = SAMPLE_RATE * BYTES_FRAME * 0.800;   // 800ms — pause FFmpeg
const BUF_LOW   = SAMPLE_RATE * BYTES_FRAME * 0.400;   // 400ms — resume FFmpeg

// Taper: fader pos 0-100 → linear gain
function taper(pos) {
    if (pos <= 0) return 0;
    return Math.pow(pos / 100, 2.5) * 3.162;
}

class ServerPlayer extends EventEmitter {
    constructor() {
        super();
        this._proc       = null;   // active FFmpeg process
        this._procB      = null;   // crossfade outgoing process
        this._playing    = false;
        this._paused     = false;
        this._track      = null;
        this._gain       = 1.0;
        this._startedAt  = null;   // wall clock start (for display only)
        this._seekOffset = 0;      // seconds already elapsed before this play
        this._progTimer  = null;

        // Backpressure state per proc — keyed by proc object
        this._bp = new WeakMap();

        // Byte counting — used only for backpressure, NOT for position
        this._bytesFed      = 0;
        this._bytesConsumed = 0;
        this._duration      = 0;

        // Wall clock position tracking
        this._startedAt_wall = 0;    // Date.now() when current track started (adjusted for seek)
        this._pausedAccum    = 0;    // total ms spent paused this track
        this._pausedAt       = 0;    // Date.now() when pause started
    }

    // Called by mixer each tick to report how many bytes it consumed for this player.
    // We use this to check the ACTUAL mixer buffer level and resume FFmpeg if needed.
    reportConsumed(bytes) {
        this._bytesConsumed += bytes;
        // Resume FFmpeg if it was paused and the actual mixer buffer has drained enough.
        // We check the real buffer level directly — no byte-counter drift.
        if (this._proc) {
            const bp = this._bp.get(this._proc);
            if (bp?.paused) {
                const key = this._mixerBufKey || 'player1';
                const actualBuf = this._mixer?._bufs?.[key]?.length ?? 0;
                if (actualBuf <= BUF_LOW) {
                    bp.paused = false;
                    try { this._proc.stdout.resume(); } catch (_) {}
                }
            }
        }
    }

    // Playback position in seconds.
    //
    // WALL CLOCK — not byte counting.
    //
    // Byte counting (_bytesConsumed / BYTES_FRAME / SAMPLE_RATE) diverges from
    // real time whenever the mixer ticker drifts, the encoder has backpressure,
    // or the VPS scheduler delays a tick. Over several minutes this accumulates
    // to 5-10 seconds of drift vs the audio the DJ actually hears.
    //
    // The wall clock (Date.now() - _startedAt) is the ground truth: it matches
    // exactly what the PC earphone receives, offset only by the fixed network
    // latency (~40-60ms) which is imperceptible and constant.
    //
    // _pausedAccum tracks total time spent paused, so pausing doesn't advance pos.
    positionSec() {
        if (!this._playing) return this._seekOffset;
        if (this._paused)   return (this._pausedAt - this._startedAt_wall - this._pausedAccum) / 1000 + this._seekOffset;
        const wallElapsed = (Date.now() - this._startedAt_wall - this._pausedAccum) / 1000;
        return this._seekOffset + Math.max(0, wallElapsed);
    }

    play(track, gain, onPcm, onEnd) {
        this._killProc(this._proc);
        this._killProc(this._procB);
        this._proc  = null;
        this._procB = null;
        clearInterval(this._progTimer);

        // Clear stale audio from the mixer buffer before resetting byte counters.
        // Without this, old-track bytes still draining from the buffer inflate
        // _bytesConsumed for the NEW track, causing _waitDrain to fire prematurely
        // and cut the tail of the new track short.
        if (this._mixer && this._mixerBufKey) {
            this._mixer._bufs[this._mixerBufKey] = Buffer.alloc(0);
        }

        if (!track?.path) { this._playing = false; return; }

        this._track        = track;
        this._gain         = gain ?? 1.0;
        this._playing      = true;
        this._paused       = false;
        this._seekOffset   = 0;
        this._startedAt    = Date.now();
        this._startedAt_wall = Date.now();
        this._pausedAccum  = 0;
        this._pausedAt     = 0;
        this._duration     = track.duration || 0;
        this._bytesFed     = 0;
        this._bytesConsumed = 0;
        this._playGen      = (this._playGen || 0) + 1;  // invalidate any pending _waitDrain

        this._spawnFFmpeg(track.path, 0, gain, onPcm, onEnd, this._playGen);
    }

    crossfadeTo(track, gain, xfSec, onPcm, onEnd) {
        // Move current proc to outgoing; kill it after xfSec+0.5s
        this._procB = this._proc;
        this._proc  = null;
        const procToKill = this._procB;
        setTimeout(() => { this._killProc(procToKill); if (this._procB === procToKill) this._procB = null; }, (xfSec + 0.5) * 1000);

        this._track        = track;
        this._gain         = gain;
        this._playing      = true;
        this._paused       = false;
        this._seekOffset   = 0;
        this._startedAt    = Date.now();
        this._startedAt_wall = Date.now();
        this._pausedAccum  = 0;
        this._pausedAt     = 0;
        this._duration     = track.duration || 0;
        this._bytesFed     = 0;
        // Offset _bytesConsumed by how many old-track bytes are still in the mixer
        // buffer at crossfade start. As those bytes drain, _bytesConsumed rises back
        // to 0, then tracks only new-track bytes — preventing premature _waitDrain.
        this._bytesConsumed = -(this._mixer?._bufs?.[this._mixerBufKey]?.length ?? 0);
        this._playGen      = (this._playGen || 0) + 1;

        this._spawnFFmpeg(track.path, 0, gain, onPcm, onEnd, this._playGen);
    }

    pause() {
        if (!this._playing || this._paused) return;
        this._paused     = true;
        this._pausedAt   = Date.now();
        this._seekOffset = this.positionSec();
        this._killProc(this._proc);
        this._proc = null;
        clearInterval(this._progTimer);
        this.emit('paused', { position: this._seekOffset });
    }

    resume() {
        if (!this._paused || !this._track) return;
        // Accumulate time spent paused so positionSec() stays accurate
        if (this._pausedAt) this._pausedAccum += Date.now() - this._pausedAt;
        this._pausedAt      = 0;
        this._paused        = false;
        this._bytesFed      = 0;
        this._bytesConsumed = 0;
        this._playGen       = (this._playGen || 0) + 1;
        this._spawnFFmpeg(this._track.path, this._seekOffset, this._gain,
            this._onPcm, this._onEnd, this._playGen);
        this.emit('resumed', { position: this._seekOffset });
    }

    stop() {
        this._playing  = false;
        this._paused   = false;
        this._track    = null;
        this._playGen  = (this._playGen || 0) + 1;  // invalidate any pending _waitDrain
        clearInterval(this._progTimer);
        this._killProc(this._proc);
        this._killProc(this._procB);
        this._proc  = null;
        this._procB = null;
        this.emit('stopped');
    }

    setGain(gain) {
        this._gain = gain;
        this.emit('gainChanged', gain);
    }

    getState() {
        return {
            playing:  this._playing,
            paused:   this._paused,
            track:    this._track,
            position: Math.round(this.positionSec() * 10) / 10,
            gain:     this._gain,
        };
    }

    // ── Internal ──────────────────────────────────────────────────────────────

    _spawnFFmpeg(filePath, seekSec, gain, onPcm, onEnd, gen) {
        // Save callbacks for resume()
        this._onPcm = onPcm;
        this._onEnd = onEnd;

        // NOTE: gain is NOT applied here via FFmpeg -af volume=.
        // Gain is applied in real-time by the mixer tick (mixer.js syncConsole →
        // _gains['player1']), so the DJ can turn CH5 ON/OFF and move the fader
        // at any time without needing to restart the FFmpeg process.
        // -sample_fmt dbl: force FFmpeg to use 64-bit double precision path.
        // FLAC decodes natively to s16/s32 (integer); FFmpeg libswresample then
        // converts s32 → dbl internally before writing f64le to the pipe.
        // This ensures no Float32 intermediate step — maximum precision throughout.
        const args = ['-hide_banner', '-nostats', '-loglevel', 'warning'];
        if (seekSec > 0) args.push('-ss', String(seekSec));
        args.push(
            '-i', filePath,
            '-vn',
            '-f', 'f64le', '-sample_fmt', 'dbl', '-ar', '44100', '-ac', '2',
            'pipe:1'
        );

        const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
        this._proc = proc;
        this._bp.set(proc, { paused: false });

        proc.stdout.on('data', (chunk) => {
            if (proc !== this._proc && proc !== this._procB) return; // fully stale
            if (proc !== this._proc) return; // outgoing — discard, don't feed mixer
            if (onPcm) onPcm(chunk);
            this._bytesFed += chunk.length;

            // Backpressure: pause FFmpeg when the ACTUAL mixer buffer is full.
            // Check _mixer._bufs directly — avoids byte-counter drift that caused
            // the old BUF_HIGH to never trigger (counter advanced even on empty ticks).
            const key = this._mixerBufKey || 'player1';
            const actualBuf = this._mixer?._bufs?.[key]?.length ?? 0;
            if (actualBuf >= BUF_HIGH) {
                const bp = this._bp.get(proc);
                if (bp && !bp.paused) {
                    bp.paused = true;
                    try { proc.stdout.pause(); } catch (_) {}
                }
            }
        });

        proc.stderr.on('data', (d) => {
            const t = d.toString().trim();
            if (t) process.stdout.write(`[player] ${t}\n`);
        });

        proc.on('exit', (code) => {
            if (proc !== this._proc) return; // stale/outgoing — ignore
            this._proc = null;
            clearInterval(this._progTimer);
            if (!this._playing || this._paused) return;

            if (code !== 0) {
                process.stdout.write(`[player] ⚠ FFmpeg exit ${code} on "${filePath}"\n`);
                // Brief delay before advancing to prevent cascade on bad files
                setTimeout(() => { if (gen === this._playGen && onEnd) onEnd(); }, 400);
                return;
            }

            // FFmpeg finished — wait for mixer to drain buffered audio, then fire onEnd.
            this._waitDrain(onEnd, gen);
        });

        // Progress ticker
        clearInterval(this._progTimer);
        this._progTimer = setInterval(() => {
            if (this._playing && !this._paused) {
                this.emit('progress', {
                    position: Math.round(this.positionSec() * 10) / 10,
                    duration: this._track?.duration || 0,
                });
            }
        }, 500);
    }

    _waitDrain(onEnd, gen) {
        // After FFmpeg exits, up to 40ms of audio remains in the mixer buffer.
        // Poll every 20ms (one tick) — drains in 1-2 polls maximum.
        const check = () => {
            if (gen !== this._playGen) return;
            if (!this._playing || this._paused) return;
            const remaining = this._bytesFed - this._bytesConsumed;
            if (remaining <= 0) {
                this.emit('trackEnded', this._track);
                if (onEnd) onEnd();
            } else {
                setTimeout(check, 20);
            }
        };
        setTimeout(check, 20);
    }

    _killProc(proc) {
        if (!proc) return;
        try { proc.stdout.destroy(); } catch (_) {}
        try { proc.kill('SIGTERM'); } catch (_) {}
    }
}

module.exports = { ServerPlayer, taper };
