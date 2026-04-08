/**
 * Chilled Koala v2.0.0 — WebRTC Engine
 * Handles both guest callers (CH7/CH8) and DJ mic (CH1/CH2).
 *
 * GUEST CALLERS:  /ws/guest → mediasoup → PCM → mixer CH7/CH8
 * DJ MIC (WebRTC): /ws/dj-mic → mediasoup → PCM → mixer mic0/mic1
 *
 * WHY WebRTC FOR DJ MIC:
 *   MediaRecorder (old): 250ms chunks → WebSocket → FFmpeg decode  = ~270-320ms
 *   WebRTC (new):        Opus 20ms frames → UDP/SRTP → FFmpeg RTP  = ~30-80ms
 *   Improvement: 4-8× lower latency on the PCM mix bus.
 *
 * AUDIO PATH (DJ mic):
 *   Browser mic → getUserMedia → mediasoup-client → Opus/RTP/SRTP → UDP
 *   VPS mediasoup → PlainTransport → FFmpeg (SDP/RTP) → s16le PCM → mixer mic0
 *
 * Same mediasoup worker and router handle both guests and DJ mic sessions.
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
const mediasoup        = require('mediasoup');

const SAMPLE_RATE  = 44100;
const CHANNELS     = 2;

class WebRTCGuests extends EventEmitter {
    constructor() {
        super();
        this._worker    = null;
        this._router    = null;
        this._guests    = new Map(); // guestId → guest session
        this._djMics    = new Map(); // djMicId → DJ mic session
        this._slots     = [null, null];
        this._ready     = false;
        this._onPcm       = null;   // callback(guestId, slot, chunk) for guests
        this._onDjPcm     = null;   // callback(djMicId, mixerKey, chunk) for DJ mic
        this._earphones   = new Map(); // sessionId → earphone session (server→browser audio)
        this._gains     = [0, 0];
        this._announcedIp = null;
        this._workerRestarts = 0;   // consecutive crash count — drives exponential backoff
    }

    // ── Initialise mediasoup worker ───────────────────────────────────────────

    async init() {
        try {
            this._worker = await mediasoup.createWorker({
                logLevel:   'warn',
                rtcMinPort: 40000,
                rtcMaxPort: 40099,
            });

            this._worker.on('died', (error) => {
                this._ready = false;
                const attempt = ++this._workerRestarts;
                // Exponential backoff: 1s, 2s, 4s, 8s, 16s … capped at 30s
                const delayMs = Math.min(30000, 1000 * Math.pow(2, attempt - 1));
                const pid     = this._worker?.pid ?? '?';
                // mediasoup passes an Error on unexpected exit; log every available field
                const reason  = error instanceof Error
                    ? `${error.message} (code=${error.code ?? '?'} signal=${error.signal ?? '?'})`
                    : (error != null ? String(error) : 'no reason provided');
                console.error(
                    `[webrtc] mediasoup worker died` +
                    ` | pid=${pid}` +
                    ` | reason: ${reason}` +
                    ` | crash #${attempt}` +
                    ` | retrying in ${delayMs}ms`
                );
                setTimeout(() => this.init(), delayMs);
            });

            this._router = await this._worker.createRouter({
                mediaCodecs: [
                    {
                        kind:      'audio',
                        mimeType:  'audio/opus',
                        clockRate: 48000,
                        channels:  2,
                    }
                ]
            });

            this._ready          = true;
            this._workerRestarts = 0;   // clean startup — reset backoff counter
            console.log('[webrtc] mediasoup ready — RTP ports 40000-40099');
            this.emit('ready');
        } catch (err) {
            console.error('[webrtc] mediasoup init failed:', err.message);
            this._ready = false;
        }
    }

    isReady() { return this._ready; }

    // ── Guest session lifecycle ───────────────────────────────────────────────

    // Called by server.js when guest sends guest:join via WebSocket
    // Returns { rtpCapabilities } for the guest to send back
    async getRtpCapabilities() {
        if (!this._ready) throw new Error('WebRTC not initialised');
        return this._router.rtpCapabilities;
    }

    // Called when guest sends guest:createTransport
    // Returns transport params for the guest browser
    async createTransport(guestId) {
        if (!this._ready) throw new Error('WebRTC not initialised');

        // Assign slot on first transport creation
        if (!this._guests.has(guestId)) {
            this._guests.set(guestId, { transport: null, consumer: null, ffmpeg: null, name: 'Guest', slot: -1 });
        }
        if (this._guests.get(guestId).slot === -1) {
            const slot = this._assignSlot(guestId);
            if (slot === -1) throw new Error('Both guest channels (CH7 and CH8) are occupied');
        }

        const transport = await this._router.createWebRtcTransport({
            listenIps:       [{ ip: '0.0.0.0', announcedIp: null }], // announcedIp set from config
            enableUdp:       true,
            enableTcp:       true,
            preferUdp:       true,
            initialAvailableOutgoingBitrate: 800000,
        });

        this._guests.get(guestId).transport = transport;

        transport.on('dtlsstatechange', (state) => {
            if (state === 'closed') this._cleanupGuest(guestId);
        });

        return {
            id:             transport.id,
            iceParameters:  transport.iceParameters,
            iceCandidates:  transport.iceCandidates,
            dtlsParameters: transport.dtlsParameters,
        };
    }

    // Called when guest sends guest:connectTransport
    async connectTransport(guestId, dtlsParameters) {
        const g = this._guests.get(guestId);
        if (!g?.transport) throw new Error('No transport for guest');
        await g.transport.connect({ dtlsParameters });
    }

    // Called when guest sends guest:produce (their mic track)
    // Returns producerId; starts RTP → FFmpeg → PCM pipeline
    async consume(guestId, producerId, rtpParameters, announcedIp) {
        if (!this._ready) throw new Error('WebRTC not initialised');
        const g = this._guests.get(guestId);
        if (!g?.transport) throw new Error('No transport for guest');

        // Create a PlainTransport to receive RTP from mediasoup → FFmpeg
        const plainTransport = await this._router.createPlainTransport({
            listenIp:  { ip: '127.0.0.1' },
            rtcpMux:   false,
            comedia:   false,
        });

        // mediasoup will send RTP to FFmpeg on this port
        const ffmpegRtpPort  = plainTransport.tuple.localPort;
        const ffmpegRtcpPort = plainTransport.rtcpTuple?.localPort;

        // Create consumer on the plain transport
        const consumer = await plainTransport.consume({
            producerId,
            rtpCapabilities: this._router.rtpCapabilities,
            paused:          false,
        });

        g.consumer = consumer;

        // Connect PlainTransport to FFmpeg's RTP input port
        await plainTransport.connect({
            ip:       '127.0.0.1',
            port:     ffmpegRtpPort,
            rtcpPort: ffmpegRtcpPort,
        });

        // Start FFmpeg: RTP Opus → PCM s16le 44100 stereo
        this._startGuestFFmpeg(guestId, ffmpegRtpPort, consumer.rtpParameters);

        return consumer.id;
    }

    // Called when guest sends guest:produce (WebRTC producer from their mic)
    async acceptProducer(guestId, transportId, kind, rtpParameters, announcedIp) {
        const g = this._guests.get(guestId);
        if (!g?.transport) throw new Error('No transport for guest');

        // Create producer on the WebRTC transport
        const producer = await g.transport.produce({ kind, rtpParameters });
        g.producer = producer;

        // Now set up the RTP pipeline: producer → PlainTransport → FFmpeg
        await this.consume(guestId, producer.id, rtpParameters, announcedIp);

        return producer.id;
    }

    // ── FFmpeg RTP → PCM pipeline ─────────────────────────────────────────────

    _startGuestFFmpeg(guestId, rtpPort, rtpParameters) {
        const { spawn } = require('child_process');

        // Write a minimal SDP for FFmpeg to understand the incoming RTP
        const payloadType = rtpParameters.codecs[0]?.payloadType || 100;
        const sdp = [
            'v=0',
            'o=- 0 0 IN IP4 127.0.0.1',
            's=mediasoup',
            'c=IN IP4 127.0.0.1',
            't=0 0',
            `m=audio ${rtpPort} RTP/AVP ${payloadType}`,
            `a=rtpmap:${payloadType} opus/48000/2`,
            'a=recvonly',
        ].join('\r\n') + '\r\n';

        const sdpPath = `/tmp/ck_guest_${guestId}.sdp`;
        require('fs').writeFileSync(sdpPath, sdp);

        const proc = require('child_process').spawn('ffmpeg', [
            '-hide_banner', '-nostats', '-loglevel', 'warning',
            '-protocol_whitelist', 'file,rtp,udp',
            '-i', sdpPath,
            '-ar', '44100', '-ac', '2',
            '-f', 's16le',
            'pipe:1'
        ], { stdio: ['ignore', 'pipe', 'pipe'] });

        const g = this._guests.get(guestId);
        if (g) g.ffmpeg = proc;

        proc.stdout.on('data', (chunk) => {
            if (this._onPcm) {
                const slot = this._guests.get(guestId)?.slot ?? -1;
                if (slot >= 0) this._onPcm(guestId, slot, chunk);
            }
        });

        proc.stderr.on('data', (d) => {
            const t = d.toString().trim();
            if (t) process.stdout.write(`[guest-${guestId.slice(-4)}] ${t}\n`);
        });

        proc.on('exit', () => {
            require('fs').unlink(sdpPath, () => {});
            console.log(`[webrtc] Guest ${guestId} FFmpeg exited`);
        });

        console.log(`[webrtc] Guest ${guestId} RTP pipeline started on port ${rtpPort}`);
    }

    // ── Guest management ──────────────────────────────────────────────────────

    setGuestName(guestId, name) {
        const g = this._guests.get(guestId);
        if (!g) return;
        g.name = name;
        this.emit('guestList', this.getGuestList());
    }

    // Assign first free slot (0=CH7, 1=CH8) to a guest on connect
    _assignSlot(guestId) {
        for (let i = 0; i < 2; i++) {
            if (!this._slots[i]) {
                this._slots[i] = guestId;
                const g = this._guests.get(guestId);
                if (g) g.slot = i;
                console.log(`[webrtc] Guest ${guestId} → slot ${i} (CH${i + 7})`);
                return i;
            }
        }
        return -1; // no free slot
    }

    getGuestSlot(guestId) {
        const g = this._guests.get(guestId);
        return g?.slot ?? -1;
    }

    setOnPcm(cb) { this._onPcm = cb; }
    setOnDjPcm(cb) { this._onDjPcm = cb; }
    setGain(gain) { this._gain = gain; }

    // ── DJ Mic WebRTC session ─────────────────────────────────────────────────
    // Same mediasoup pipeline as guest callers — just routed to mixer mic0/mic1
    // instead of the guest CH7/CH8 slots.
    //
    // djMicId: unique session ID (e.g. "djmic_username_timestamp")
    // mixerKey: 'mic0' | 'mic1' | 'mic2' | 'mic3' (assigned by server.js)
    //
    // Flow: DJ browser → WebRTC Opus → mediasoup → PlainTransport → FFmpeg → PCM
    //       → _onDjPcm(djMicId, mixerKey, chunk) → mixer._feedBuf(mixerKey)

    async createDjMicTransport(djMicId) {
        if (!this._ready) throw new Error('WebRTC not initialised');

        if (!this._djMics.has(djMicId)) {
            this._djMics.set(djMicId, { transport: null, producer: null, ffmpeg: null, mixerKey: null });
        }

        const transport = await this._router.createWebRtcTransport({
            listenIps:       [{ ip: '0.0.0.0', announcedIp: this._announcedIp || null }],
            enableUdp:       true,
            enableTcp:       true,
            preferUdp:       true,
            initialAvailableOutgoingBitrate: 800000,
        });

        this._djMics.get(djMicId).transport = transport;

        transport.on('dtlsstatechange', (state) => {
            if (state === 'closed') this._cleanupDjMic(djMicId);
        });

        return {
            id:             transport.id,
            iceParameters:  transport.iceParameters,
            iceCandidates:  transport.iceCandidates,
            dtlsParameters: transport.dtlsParameters,
        };
    }

    async connectDjMicTransport(djMicId, dtlsParameters) {
        const s = this._djMics.get(djMicId);
        if (!s?.transport) throw new Error('No transport for DJ mic session');
        await s.transport.connect({ dtlsParameters });
    }

    async acceptDjMicProducer(djMicId, kind, rtpParameters, mixerKey) {
        const s = this._djMics.get(djMicId);
        if (!s?.transport) throw new Error('No transport for DJ mic session');

        const producer = await s.transport.produce({ kind, rtpParameters });
        s.producer  = producer;
        s.mixerKey  = mixerKey;

        // RTP pipeline: producer → PlainTransport → FFmpeg → PCM
        await this._startDjMicPipeline(djMicId, producer.id, rtpParameters, mixerKey);

        return producer.id;
    }

    async _startDjMicPipeline(djMicId, producerId, rtpParameters, mixerKey) {
        // ── PlainTransport → FFmpeg pipeline (correct mediasoup v3 pattern) ──
        //
        // mediasoup PlainTransport CONSUMER pattern:
        //   1. PlainTransport created — mediasoup owns port A (localPort)
        //   2. FFmpeg gets its own free port B via a temporary UDP socket bind
        //   3. plainTransport.connect({ port: B }) — mediasoup sends RTP TO port B
        //   4. FFmpeg SDP references port B — FFmpeg binds to B and receives RTP
        //   5. No port conflict: A ≠ B, each process owns its own socket
        //
        // Previously the connect() pointed back to port A (mediasoup's own port),
        // causing FFmpeg to try to bind the same socket — always "Address already in use".

        const dgram = require('dgram');

        // Get a free port for FFmpeg to bind to
        const ffmpegRtpPort = await new Promise((resolve, reject) => {
            const sock = dgram.createSocket('udp4');
            sock.bind(0, '127.0.0.1', () => {
                const port = sock.address().port;
                sock.close(() => resolve(port));
            });
            sock.on('error', reject);
        });

        const plainTransport = await this._router.createPlainTransport({
            listenIp: { ip: '127.0.0.1' },
            rtcpMux:  true,    // single port, simpler
            comedia:  false,
        });

        const consumer = await plainTransport.consume({
            producerId,
            rtpCapabilities: this._router.rtpCapabilities,
            paused:          false,
        });

        // Tell mediasoup to send RTP to FFmpeg's port (B), not its own port (A)
        await plainTransport.connect({
            ip:   '127.0.0.1',
            port: ffmpegRtpPort,
        });

        this._startDjMicFFmpeg(djMicId, ffmpegRtpPort, consumer.rtpParameters, mixerKey);

        const s = this._djMics.get(djMicId);
        if (s) { s.plainTransport = plainTransport; s.consumer = consumer; }
    }

    _startDjMicFFmpeg(djMicId, rtpPort, rtpParameters, mixerKey) {
        const { spawn } = require('child_process');
        const payloadType = rtpParameters.codecs[0]?.payloadType || 100;

        // Log full RTP parameters so we can verify payload type matches SDP
        console.log(`[djmic] RTP params: PT=${payloadType} codec=${JSON.stringify(rtpParameters.codecs[0])}`);

        const sdp = [
            'v=0',
            'o=- 0 0 IN IP4 127.0.0.1',
            's=djmic',
            'c=IN IP4 127.0.0.1',
            't=0 0',
            `m=audio ${rtpPort} RTP/AVP ${payloadType}`,
            `a=rtpmap:${payloadType} opus/48000/2`,
            'a=recvonly',
        ].join('\r\n') + '\r\n';

        const sdpPath = `/tmp/ck_djmic_${djMicId}.sdp`;
        require('fs').writeFileSync(sdpPath, sdp);
        console.log(`[djmic] SDP written:\n${sdp}`);

        const proc = spawn('ffmpeg', [
            '-hide_banner', '-nostats', '-loglevel', 'info',
            '-protocol_whitelist', 'file,rtp,udp',
            '-i', sdpPath,
            '-acodec', 'pcm_s16le',
            '-ar', '44100', '-ac', '2',
            '-f', 's16le',
            'pipe:1'
        ], { stdio: ['ignore', 'pipe', 'pipe'] });

        const s = this._djMics.get(djMicId);
        if (s) s.ffmpeg = proc;

        let chunkCount = 0;
        proc.stdout.on('data', (chunk) => {
            chunkCount++;
            if (chunkCount <= 5) {
                const samples = [];
                for (let i = 0; i < Math.min(8, chunk.length >> 1); i++) {
                    samples.push(chunk.readInt16LE(i * 2));
                }
                console.log(`[djmic-${mixerKey}] PCM chunk #${chunkCount}: ${chunk.length}B samples=[${samples.join(',')}]`);
            }
            if (this._onDjPcm) this._onDjPcm(djMicId, mixerKey, chunk);
        });
        proc.stderr.on('data', (d) => {
            const t = d.toString().trim();
            if (t) process.stdout.write(`[djmic-${mixerKey}] ${t}\n`);
        });
        proc.on('exit', (code) => {
            require('fs').unlink(sdpPath, () => {});
            console.log(`[webrtc] DJ mic ${djMicId} (${mixerKey}) FFmpeg exited code=${code}`);
        });

        console.log(`[webrtc] DJ mic ${djMicId} → ${mixerKey} FFmpeg on port ${rtpPort} (transport→FFmpeg, no conflict)`);
    }

    disconnectDjMic(djMicId) {
        this._cleanupDjMic(djMicId);
    }

    _cleanupDjMic(djMicId) {
        const s = this._djMics.get(djMicId);
        if (!s) return;
        s.closed = true;
        try { s.consumer?.close(); }        catch (_) {}
        try { s.directTransport?.close(); } catch (_) {}
        try { s.plainTransport?.close(); }  catch (_) {}  // legacy, may not exist
        try { s.ffmpeg?.kill('SIGTERM'); }   catch (_) {}  // legacy, may not exist
        if (s.opusDecoder) { try { s.opusDecoder.delete?.(); } catch (_) {} }
        this._djMics.delete(djMicId);
        console.log(`[webrtc] DJ mic ${djMicId} (${s.mixerKey}) cleaned up`);
    }

    getDjMicIds() {
        return [...this._djMics.keys()];
    }

    disconnectGuest(guestId) {
        this._cleanupGuest(guestId);
        this.emit('guestList', this.getGuestList());
    }

    _cleanupGuest(guestId) {
        const g = this._guests.get(guestId);
        if (!g) return;
        // Free slot
        if (g.slot >= 0 && g.slot < 2) this._slots[g.slot] = null;
        try { g.producer?.close(); }  catch (_) {}
        try { g.consumer?.close(); }  catch (_) {}
        try { g.transport?.close(); } catch (_) {}
        try { g.ffmpeg?.kill('SIGTERM'); } catch (_) {}
        this._guests.delete(guestId);
        console.log(`[webrtc] Guest ${guestId} (slot ${g.slot}) cleaned up`);
        this.emit('guestList', this.getGuestList());
    }

    getGuestList() {
        const list = [];
        this._guests.forEach((g, id) => {
            list.push({ id, name: g.name || 'Guest', slot: g.slot ?? -1, ch: g.slot >= 0 ? g.slot + 7 : null });
        });
        return list;
    }

    syncConsole(channels, mixer) {
        // CH7=guest0, CH8=guest1
        // TB=ON → private talkback, off air (gain already zeroed by mixer.syncConsole)
        // ON=ON, TB=OFF → guest live to PGM
        // Notify each connected guest of their on-air status so their page updates
        [0, 1].forEach(slot => {
            const src = `guest${slot}`;
            const ch  = channels?.find(c => (c.sourceA || '').toLowerCase() === src);
            const onAir = ch ? (ch.on && !ch.tb) : false;
            const inTB  = ch ? !!ch.tb : false;
            const guestId = this._slots[slot];
            if (guestId) {
                // Find the guest's WebSocket and notify
                this.emit('guestStatus', { guestId, slot, onAir, inTB });
            }
        });
    }


    // ── Earphone: server → browser WebRTC audio (Mix 1 monitor) ─────────────
    // Flow: outMix1 PCM → FFmpeg RTP → PlainTransport (producer) →
    //       mediasoup route → WebRtcTransport (consumer) → browser WebRTC track
    // Latency budget: FFmpeg RTP send ~5ms + mediasoup ~1ms + DTLS/SRTP ~20ms = ~26ms
    // Plus encode frame: 20ms Opus → total ~46ms. Far better than HTTP streaming.

    async createEarphoneTransport(sessionId, announcedIp) {
        if (!this._ready) throw new Error('WebRTC not initialised');

        // Each browser session gets its own WebRtcTransport (consumer side)
        const transport = await this._router.createWebRtcTransport({
            listenIps:       [{ ip: '0.0.0.0', announcedIp: announcedIp || '127.0.0.1' }],
            enableUdp:       true,
            enableTcp:       true,
            preferUdp:       true,
        });

        this._earphones.set(sessionId, { transport, producer: null, consumer: null,
                                          plainTransport: null, ffmpeg: null });

        transport.on('dtlsstatechange', (state) => {
            if (state === 'closed') this._cleanupEarphone(sessionId);
        });

        return {
            id:             transport.id,
            iceParameters:  transport.iceParameters,
            iceCandidates:  transport.iceCandidates,
            dtlsParameters: transport.dtlsParameters,
            rtpCapabilities: this._router.rtpCapabilities,
        };
    }

    async connectEarphoneTransport(sessionId, dtlsParameters) {
        const s = this._earphones.get(sessionId);
        if (!s?.transport) throw new Error('No earphone transport for session');
        await s.transport.connect({ dtlsParameters });
    }

    async startEarphoneStream(sessionId) {
        // Earphone path: mixer outMix1 PCM → Opus (in-process) → DirectTransport → WebRTC → browser
        // opusscript encodes PCM to Opus entirely in Node.js — no FFmpeg, no pipes, no ports.
        // DirectTransport.produce() + producer.send(rtpPacket) injects into mediasoup router.
        if (!this._ready) throw new Error('WebRTC not initialised');
        const s = this._earphones.get(sessionId);
        if (!s) throw new Error('No earphone session');

        // Lazy-load opusscript — pure JavaScript Opus encoder, zero native compilation
        if (!this._OpusScript) {
            this._OpusScript = require('opusscript');
        }
        // RESTRICTED_LOWDELAY: designed for real-time streaming — no AUDIO-mode lookahead
        // 64kbps is enough for mono-equivalent; 96kbps gives comfortable stereo headroom
        const encoder = new this._OpusScript(48000, 2, this._OpusScript.Application.RESTRICTED_LOWDELAY);
        encoder.setBitrate(96000);
        s.opusEncoder = encoder;
        s.pcmBuf      = Buffer.alloc(0);   // accumulate PCM until full 20ms frame
        s.seq         = 0;
        s.timestamp   = 0;
        // Stateful resampler: carry phase across ticks to avoid inter-chunk discontinuities
        // srcPhase tracks the exact fractional read position in the 44100Hz stream
        s.srcPhase    = 0.0;              // current read position in source samples
        s.lastSamples = [0, 0];           // last L/R sample from previous chunk (for interpolation at boundary)
        s.resampleRatio = 44100 / 48000;  // source step per output sample (~0.91875)

        // Step 1: DirectTransport — Node.js injects RTP directly into mediasoup router
        const direct = await this._router.createDirectTransport({ maxMessageSize: 262144 });
        s.directTransport = direct;

        // Step 2: Producer — audio/opus 48kHz stereo
        const SSRC = 11111111;
        const PT   = 100;
        const producer = await direct.produce({
            kind: 'audio',
            rtpParameters: {
                codecs: [{
                    mimeType:    'audio/opus',
                    clockRate:   48000,
                    channels:    2,
                    payloadType: PT,
                    parameters:  { 'sprop-stereo': 1 },
                }],
                encodings: [{ ssrc: SSRC }],
            },
        });
        s.producer = producer;
        s.pt       = PT;
        s.ssrc     = SSRC;

        // Step 3: Consumer on browser-facing WebRtcTransport
        const consumer = await s.transport.consume({
            producerId:      producer.id,
            rtpCapabilities: this._router.rtpCapabilities,
            paused:          false,
        });
        s.consumer = consumer;

        console.log(`[webrtc] Earphone started (DirectTransport+Opus): session=${sessionId.slice(-6)}`);

        return {
            id:            consumer.id,
            producerId:    producer.id,
            kind:          consumer.kind,
            rtpParameters: consumer.rtpParameters,
        };
    }

    // Called every mixer tick with s16le 44100Hz stereo PCM from outMix1
    feedEarphone(sessionId, pcmChunk) {
        const s = this._earphones.get(sessionId);
        if (!s?.opusEncoder || !s.producer || s.producer.closed) return;

        // Resample 44100→48000: simple linear interpolation on s16le stereo
        const inSamples  = pcmChunk.length / 4;          // 2ch * 2 bytes
        const outSamples = Math.round(inSamples * s.resampleRatio);
        const resampled  = Buffer.allocUnsafe(outSamples * 4);
        for (let i = 0; i < outSamples; i++) {
            const srcF  = i / s.resampleRatio;
            const srcI  = Math.floor(srcF);
            const frac  = srcF - srcI;
            const next  = Math.min(srcI + 1, inSamples - 1);
            const offA  = srcI * 4;
            const offB  = next  * 4;
            // Left channel
            const lA = pcmChunk.readInt16LE(offA);
            const lB = pcmChunk.readInt16LE(offB);
            resampled.writeInt16LE(Math.round(lA + frac * (lB - lA)), i * 4);
            // Right channel
            const rA = pcmChunk.readInt16LE(offA + 2);
            const rB = pcmChunk.readInt16LE(offB + 2);
            resampled.writeInt16LE(Math.round(rA + frac * (rB - rA)), i * 4 + 2);
        }

        // Accumulate resampled PCM and encode in 960-sample (20ms @ 48kHz) frames
        s.pcmBuf = Buffer.concat([s.pcmBuf, resampled]);
        const FRAME_BYTES = 960 * 4;   // 960 samples * 2ch * 2 bytes
        while (s.pcmBuf.length >= FRAME_BYTES) {
            const frame    = s.pcmBuf.slice(0, FRAME_BYTES);
            s.pcmBuf       = s.pcmBuf.slice(FRAME_BYTES);
            let opusFrame;
            try { opusFrame = s.opusEncoder.encode(frame, 960); } catch (_) { continue; }

            // Build 12-byte RTP header + Opus payload and send into mediasoup router
            const hdr = Buffer.allocUnsafe(12);
            hdr[0] = 0x80;
            hdr[1] = s.pt & 0x7F;
            hdr.writeUInt16BE(s.seq & 0xFFFF, 2);
            hdr.writeUInt32BE(s.timestamp >>> 0, 4);
            hdr.writeUInt32BE(s.ssrc >>> 0, 8);
            s.seq       = (s.seq + 1) & 0xFFFF;
            s.timestamp = (s.timestamp + 960) >>> 0;
            try { s.producer.send(Buffer.concat([hdr, opusFrame])); } catch (_) {}
        }
    }

    disconnectEarphone(sessionId) {
        this._cleanupEarphone(sessionId);
    }

    _cleanupEarphone(sessionId) {
        const s = this._earphones.get(sessionId);
        if (!s) return;
        try { s.consumer?.close(); }         catch (_) {}
        try { s.producer?.close(); }         catch (_) {}
        try { s.directTransport?.close(); }  catch (_) {}
        try { s.transport?.close(); }        catch (_) {}
        this._earphones.delete(sessionId);
        console.log(`[webrtc] Earphone ${sessionId.slice(-6)} cleaned up`);
    }

    getEarphoneIds() { return [...this._earphones.keys()]; }

    async shutdown() {
        this._guests.forEach((_, id) => this._cleanupGuest(id));
        try { this._router?.close(); }  catch (_) {}
        try { this._worker?.close(); }  catch (_) {}
        this._ready = false;
    }
}

module.exports = WebRTCGuests;
