/**
 * Chilled Koala — Earphone AudioWorklet Ring Buffer Processor
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

class PCMRingProc extends AudioWorkletProcessor {
    constructor() {
        super();
        const ringLen   = 529200;   // 44100 * 6s * 2ch (stereo interleaved)
        this._ring      = new Float32Array(ringLen);
        this._w         = 0;
        this._r         = 0;
        this._size      = ringLen;
        this._pre       = 70560;    // 44100 * 0.8s * 2ch — pre-buffer before playback
        this._ready     = false;
        this._fade      = 0.0;      // 0=silent, 1=full volume; ramped to avoid clicks

        this.port.onmessage = (e) => {
            const s = e.data;   // Int16Array
            const n = s.length;
            for (let i = 0; i < n; i++) {
                this._ring[this._w] = s[i] / 32768.0;
                this._w = (this._w + 1) % this._size;
            }
            if (!this._ready) {
                const avail = (this._w - this._r + this._size) % this._size;
                if (avail >= this._pre) {
                    this._ready = true;
                }
            }
        };
    }

    _avail() {
        return (this._w - this._r + this._size) % this._size;
    }

    process(inputs, outputs) {
        const out = outputs[0];
        if (!out || !out[0]) return true;

        const frames  = out[0].length;  // typically 128 at 44100Hz
        const L       = out[0];
        const R       = out.length > 1 ? out[1] : out[0];
        const hasData = this._ready && this._avail() >= frames * 2;

        for (let i = 0; i < frames; i++) {
            // Smooth 3ms fade — eliminates click on start/underrun
            if (hasData) {
                this._fade = Math.min(1.0, this._fade + 0.005);
            } else {
                this._fade = Math.max(0.0, this._fade - 0.005);
            }

            let l = 0.0, r = 0.0;
            if (this._avail() >= 2) {
                l = this._ring[this._r];
                this._r = (this._r + 1) % this._size;
                r = this._ring[this._r];
                this._r = (this._r + 1) % this._size;
            }

            L[i] = l * this._fade;
            R[i] = r * this._fade;
        }

        // Re-arm pre-buffer after ring fully drained (e.g. after reconnect)
        if (!this._ready && this._avail() === 0) {
            this._w = 0;
            this._r = 0;
        }

        return true;  // keep processor alive
    }
}

registerProcessor('ck-ring', PCMRingProc);
