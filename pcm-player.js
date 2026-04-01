/**
 * pcm-player — MIT License
 * Original: https://github.com/samirkumardas/pcm-player  (321 stars)
 * Author: Samir Das
 * SPDX-License-Identifier: MIT
 *
 * Included in Chilled Koala v2.0.0 (MIT) by Trajano Roberto.
 * Minor additions: .analyserNode exposed, .getLevel() helper.
 */
(function (global, factory) {
  typeof exports === 'object' && typeof module !== 'undefined' ? module.exports = factory() :
  typeof define === 'function' && define.amd ? define(factory) :
  (global = global || self, global.PCMPlayer = factory());
}(this, (function () { 'use strict';

  class PCMPlayer {
    constructor(option) {
      this.init(option);
    }

    init(option) {
      const defaultOption = {
        inputCodec: 'Int16',
        channels: 1,
        sampleRate: 8000,
        flushTime: 1000,
        fftSize: 2048
      };

      this.option = Object.assign({}, defaultOption, option);
      this.samples = new Float32Array();
      this.interval = setInterval(this.flush.bind(this), this.option.flushTime);
      this.convertValue = this.getConvertValue();
      this.typedArray = this.getTypedArray();
      this.initAudioContext();
      this.bindAudioContextEvent();
    }

    getConvertValue() {
      const inputCodecs = {
        'Int8': 128, 'Int16': 32768, 'Int32': 2147483648, 'Float32': 1
      };
      if (!inputCodecs[this.option.inputCodec])
        throw new Error('wrong codec. use one of: Int8, Int16, Int32, Float32');
      return inputCodecs[this.option.inputCodec];
    }

    getTypedArray() {
      const typedArrays = {
        'Int8': Int8Array, 'Int16': Int16Array, 'Int32': Int32Array, 'Float32': Float32Array
      };
      if (!typedArrays[this.option.inputCodec])
        throw new Error('wrong codec. use one of: Int8, Int16, Int32, Float32');
      return typedArrays[this.option.inputCodec];
    }

    initAudioContext() {
      this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      this.gainNode = this.audioCtx.createGain();
      this.gainNode.gain.value = 1.0;
      this.gainNode.connect(this.audioCtx.destination);
      this.startTime = this.audioCtx.currentTime;
      this.analyserNode = this.audioCtx.createAnalyser();
      this.analyserNode.fftSize = this.option.fftSize;
      this.gainNode.connect(this.analyserNode);
    }

    static isTypedArray(data) {
      return (data.byteLength && data.buffer && data.buffer.constructor == ArrayBuffer)
          || data.constructor == ArrayBuffer;
    }

    isSupported(data) {
      if (!PCMPlayer.isTypedArray(data)) throw new Error('feed() requires ArrayBuffer or TypedArray');
      return true;
    }

    feed(data) {
      this.isSupported(data);
      data = this.getFormattedValue(data);
      const tmp = new Float32Array(this.samples.length + data.length);
      tmp.set(this.samples, 0);
      tmp.set(data, this.samples.length);
      this.samples = tmp;
    }

    getFormattedValue(data) {
      // IMPORTANT: if data is a TypedArray view with a non-zero byteOffset (e.g.
      // new Int16Array(arraybuffer, 8)), we must use the slice() method to get a
      // fresh buffer starting at the correct offset — NOT data.buffer, which points
      // to the full underlying ArrayBuffer from byte 0 (would re-read the WS header
      // as audio, causing noise bursts).
      let typed;
      if (data.constructor === ArrayBuffer) {
        typed = new this.typedArray(data);
      } else if (data instanceof this.typedArray) {
        typed = data; // already correct type, byteOffset already applied
      } else {
        // Different typed array type — use slice to get a correctly-offset copy
        typed = new this.typedArray(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
      }
      const float32 = new Float32Array(typed.length);
      for (let i = 0; i < typed.length; i++) {
        float32[i] = typed[i] / this.convertValue;
      }
      return float32;
    }

    volume(volume) {
      this.gainNode.gain.value = volume;
    }

    // RMS level from analyser — 0..1
    getLevel() {
      if (!this.analyserNode) return 0;
      const buf = new Uint8Array(this.analyserNode.frequencyBinCount);
      this.analyserNode.getByteTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) { const s = (buf[i] - 128) / 128; sum += s * s; }
      return Math.sqrt(sum / buf.length);
    }

    destroy() {
      if (this.interval) clearInterval(this.interval);
      this.samples = null;
      this.audioCtx.close();
      this.audioCtx = null;
    }

    flush() {
      if (!this.samples || !this.samples.length) return;
      const self = this;
      const bufferSource = this.audioCtx.createBufferSource();
      if (typeof this.option.onended === 'function') {
        bufferSource.onended = (event) => self.option.onended(bufferSource, event);
      }
      const length = this.samples.length / this.option.channels;
      const audioBuffer = this.audioCtx.createBuffer(
        this.option.channels, length, this.option.sampleRate
      );

      for (let channel = 0; channel < this.option.channels; channel++) {
        const audioData = audioBuffer.getChannelData(channel);
        let offset = channel;
        let decrement = 50;
        for (let i = 0; i < length; i++) {
          audioData[i] = this.samples[offset];
          // 50-sample fade-in to eliminate click at chunk start
          if (i < 50) audioData[i] = (audioData[i] * i) / 50;
          // 50-sample fade-out to eliminate click at chunk end
          if (i >= (length - 51)) audioData[i] = (audioData[i] * decrement--) / 50;
          offset += this.option.channels;
        }
      }

      if (this.startTime < this.audioCtx.currentTime) {
        this.startTime = this.audioCtx.currentTime;
      }
      bufferSource.buffer = audioBuffer;
      bufferSource.connect(this.gainNode);
      bufferSource.connect(this.analyserNode);
      bufferSource.start(this.startTime);
      this.startTime += audioBuffer.duration;
      this.samples = new Float32Array();
    }

    async pause() { await this.audioCtx.suspend(); }
    async continue() { await this.audioCtx.resume(); }

    bindAudioContextEvent() {
      if (typeof this.option.onstatechange === 'function') {
        this.audioCtx.onstatechange = (event) => {
          this.audioCtx && this.option.onstatechange(this.audioCtx, event, this.audioCtx.state);
        };
      }
    }
  }

  return PCMPlayer;
})));
