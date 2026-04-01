/**
 * Chilled Koala — Mic Capture AudioWorklet (Float32 edition)
 * Runs on the dedicated audio rendering thread.
 * Sends mic audio as raw Float32 frames over MessagePort → WebSocket.
 *
 * Format: 4-byte magic 'F32\0' + Float32Array (mono 48kHz samples)
 * Frame size: 960 samples × 4 bytes + 4 magic = 3844 bytes per 20ms
 *
 * SPDX-License-Identifier: MIT
 * Copyright © 2026 Trajano Roberto
 */

class MicCaptureProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this._bufSize = 960;
        this._buf     = new Float32Array(this._bufSize);
        this._pos     = 0;
        this._active  = true;
        this.port.onmessage = (e) => {
            if (e.data === 'stop')  this._active = false;
            if (e.data === 'start') this._active = true;
        };
    }

    process(inputs) {
        if (!this._active) return true;
        const channel = inputs[0]?.[0];
        if (!channel || channel.length === 0) return true;
        for (let i = 0; i < channel.length; i++) {
            this._buf[this._pos++] = Math.max(-1, Math.min(1, channel[i]));
            if (this._pos >= this._bufSize) {
                const magic = new Uint8Array([0x46, 0x33, 0x32, 0x00]);
                const pcm   = new Uint8Array(this._buf.buffer.slice(0, this._bufSize * 4));
                const frame = new Uint8Array(4 + pcm.length);
                frame.set(magic, 0);
                frame.set(pcm, 4);
                this.port.postMessage(frame.buffer, [frame.buffer]);
                this._buf = new Float32Array(this._bufSize);
                this._pos = 0;
            }
        }
        return true;
    }
}

registerProcessor('mic-capture-processor', MicCaptureProcessor);
