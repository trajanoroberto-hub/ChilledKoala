/**
 * Chilled Koala v2.0.0 — Broadcast Console State Engine
 * Emulates Wheatstone IP-12 Digital Radio Table
 *
 * Features per IP-12 brochure + functional spec:
 *   8 channels · A/B source selector · ON/OFF (guarded) · CUE (PFL)
 *   Momentary TB (talkback) · 100mm fader -∞ to +10dB logarithmic
 *   Single Program Bus · Mix-Minus per guest channel
 *   Monitor section: PGM / OFF-AIR, HP volume, CUE > TB > Monitor priority
 *   Built-in timer (start/stop/reset)
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

// fader position 0–100 → dB
// 0   = -∞
// 85  = 0 dB  (unity)
// 100 = +10 dB
function faderToDB(pos) {
    if (pos <= 0)   return -Infinity;
    if (pos >= 100) return 10;
    if (pos <= 85)  return (pos / 85) * 60 - 60;   // -60..0
    return ((pos - 85) / 15) * 10;                  //   0..+10
}

class BroadcastConsole extends EventEmitter {
    constructor(config) {
        super();
        this.config          = config;
        this.channels        = this._initChannels();
        // Monitor defaults — read from [monitor] section of config.ini
        const mon = config.monitor || {};
        this.monitorSource   = mon.source === 'pgm' ? 'pgm1' : (mon.source || 'pgm1');  // normalise legacy 'pgm' → 'pgm1'
        this.monitorVolume   = parseInt(mon.volume) || 80;   // 0–100
        this.hostChannelIdx  = 0;       // which ch is the host mic (for TB mix-minus)

        // Built-in broadcast timer
        this.timer = {
            running:   false,
            startedAt: null,   // Date.now() when last started
            elapsed:   0,      // accumulated ms before last pause
        };
    }

    // ── Init ─────────────────────────────────────────────────────────────────

    _initChannels() {
        const channels = [];
        const c = this.config.channels || {};

        for (let i = 0; i < 8; i++) {
            const n = i + 1;
            const get = (key, def) => {
                const v = c[`ch${n}_${key}`];
                return (v !== undefined && v !== '') ? v : def;
            };

            channels.push({
                id:           i,
                name:         get('name',     `CH ${n}`),
                type:         get('type',     'none'),
                sourceA:      get('source_a', ''),
                sourceB:      get('source_b', ''),
                labelA:       get('label_a',  'A'),
                labelB:       get('label_b',  'B'),
                activeSource: 'A',
                on:           get('on', 'false') === 'true',
                cue:          false,
                tb:           false,
                fader:        parseInt(get('volume', 0)) || 0,
                level:        0,       // 0–1 (set by VU simulation)
            });
        }
        return channels;
    }

    // ── Getters ──────────────────────────────────────────────────────────────

    getState() {
        return {
            channels:        this.channels,
            monitorSource:   this.monitorSource,
            monitorVolume:   this.monitorVolume,
            hostChannelIdx:  this.hostChannelIdx,
            pgmChannels:     this._pgmChannels().map(c => c.id),
            tbChannels:      this._tbChannels().map(c => c.id),
            headphoneSource: this._headphoneSource(),
            timer:           this._timerState(),
        };
    }

    _pgmChannels()  { return this.channels.filter(c => c.on && c.fader > 0); }
    _cueChannels()  { return this.channels.filter(c => c.cue); }
    _tbChannels()   { return this.channels.filter(c => c.tb); }

    // Headphone priority: TB > monitor source
    // CUE removed — not applicable in this architecture.
    // TB valid only on: remote (CH3/CH4), webrtc (CH7/CH8)
    _headphoneSource() {
        if (this._tbChannels().length > 0) return 'tb';
        return this.monitorSource;
    }

    // Types that support TB
    _tbAllowed(ch) {
        return ch.type === 'remote' || ch.type === 'webrtc';
    }

    // Mix-minus: PGM minus the guest's own channel
    getMixMinus(chId) {
        return this._pgmChannels()
            .filter(c => c.id !== chId)
            .map(c => c.id);
    }

    // Mix-minus with TB: add host mic feed
    getMixMinusTB(chId) {
        const base = this.getMixMinus(chId);
        const host = this.channels[this.hostChannelIdx];
        if (host && host.id !== chId && !base.includes(host.id)) {
            base.push(host.id);
        }
        return base;
    }

    // ── Channel Operations ────────────────────────────────────────────────────

    setOn(chId, on) {
        const ch = this._ch(chId);
        if (!ch) return;
        ch.on = !!on;
        this._fire('on', { chId, on: ch.on });
    }

    setCue(chId, active) {
        const ch = this._ch(chId);
        if (!ch) return;
        ch.cue = !!active;
        this._fire('cue', { chId, cue: ch.cue });
    }

    setTB(chId, active) {
        const ch = this._ch(chId);
        if (!ch) return;
        // TB only valid for remote mics (CH3/CH4) and WebRTC guests (CH7/CH8)
        if (!this._tbAllowed(ch)) return;
        ch.tb = !!active;
        this._fire('tb', { chId, tb: ch.tb });
    }

    setFader(chId, pos) {
        const ch = this._ch(chId);
        if (!ch) return;
        ch.fader = Math.max(0, Math.min(100, Math.round(pos)));
        this._fire('fader', { chId, fader: ch.fader, db: faderToDB(ch.fader) });
    }

    setSource(chId, source) {
        const ch = this._ch(chId);
        if (!ch) return;
        // Only allow B if sourceB is configured
        if (source === 'B' && !ch.sourceB) return;
        ch.activeSource = (source === 'B') ? 'B' : 'A';
        this._fire('source', { chId, activeSource: ch.activeSource });
    }

    setChannelConfig(chId, data) {
        const ch = this._ch(chId);
        if (!ch) return;
        if (data.name    !== undefined) ch.name    = String(data.name   || '').trim() || ch.name;
        if (data.type    !== undefined) ch.type    = data.type;
        if (data.sourceA !== undefined) ch.sourceA = data.sourceA;
        if (data.sourceB !== undefined) ch.sourceB = data.sourceB;
        if (data.labelA  !== undefined) ch.labelA  = String(data.labelA || '').trim() || 'A';
        if (data.labelB  !== undefined) ch.labelB  = String(data.labelB || '').trim() || 'B';
        // Persist to config object so saveConfig() writes it
        this._persistChannel(chId);
        this._fire('chConfig', { chId, channel: ch });
    }

    setMonitor(source, volume) {
        if (source !== undefined) {
            // Accept legacy 'pgm'/'offair' and new 'pgm1'/'cue'
            // pgm2 excluded: PGM2 = PGM1 + Loc Mics — hearing own voice at 880ms delay
            const valid = ['pgm', 'pgm1', 'cue', 'offair'];
            if (valid.includes(source)) {
                // Normalise legacy 'pgm' → 'pgm1'
                this.monitorSource = source === 'pgm' ? 'pgm1' : source;
                if (this.config.monitor) this.config.monitor.source = this.monitorSource;
            }
        }
        if (volume !== undefined) {
            this.monitorVolume = Math.max(0, Math.min(100, Math.round(volume)));
            if (this.config.monitor) this.config.monitor.volume = this.monitorVolume;
        }
        this._fire('monitor', { source: this.monitorSource, volume: this.monitorVolume });
    }

    setHostChannel(chId) {
        if (chId >= 0 && chId < 8) {
            this.hostChannelIdx = chId;
            this._fire('hostCh', { chId });
        }
    }

    // ── Timer ─────────────────────────────────────────────────────────────────

    timerStart() {
        if (this.timer.running) return;
        this.timer.running   = true;
        this.timer.startedAt = Date.now();
        this._fire('timer', this._timerState());
    }

    timerStop() {
        if (!this.timer.running) return;
        this.timer.elapsed  += Date.now() - this.timer.startedAt;
        this.timer.running   = false;
        this.timer.startedAt = null;
        this._fire('timer', this._timerState());
    }

    timerReset() {
        this.timer.running   = false;
        this.timer.startedAt = null;
        this.timer.elapsed   = 0;
        this._fire('timer', this._timerState());
    }

    _timerState() {
        let ms = this.timer.elapsed;
        if (this.timer.running && this.timer.startedAt) {
            ms += Date.now() - this.timer.startedAt;
        }
        return { running: this.timer.running, ms };
    }

    // ── Persistence ───────────────────────────────────────────────────────────

    _persistChannel(chId) {
        const ch = this.channels[chId];
        if (!ch || !this.config.channels) return;
        const n   = chId + 1;
        const c   = this.config.channels;
        c[`ch${n}_name`]     = ch.name;
        c[`ch${n}_type`]     = ch.type;
        c[`ch${n}_source_a`] = ch.sourceA;
        c[`ch${n}_source_b`] = ch.sourceB;
        c[`ch${n}_label_a`]  = ch.labelA;
        c[`ch${n}_label_b`]  = ch.labelB;
        c[`ch${n}_volume`]   = ch.fader;
        c[`ch${n}_on`]       = String(!!ch.on);
    }

    persistAllFaders() {
        for (let i = 0; i < 8; i++) {
            const ch = this.channels[i];
            const n  = i + 1;
            if (this.config.channels) {
                this.config.channels[`ch${n}_volume`] = ch.fader;
                this.config.channels[`ch${n}_on`]     = String(!!ch.on);
            }
        }
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    _ch(id) { return (id >= 0 && id < 8) ? this.channels[id] : null; }

    _fire(event, data) {
        this.emit(event, data);
        this.emit('stateChange', this.getState());
    }
}

module.exports = BroadcastConsole;
