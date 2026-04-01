================================================================================
  CHILLED KOALA v2.0.0 — Stream Ecosystem
  Browser-based, server-side mixing for AzuraCast / Icecast
  Copyright © 2026 Trajano Roberto — Released under the MIT License
================================================================================

  Author  : Trajano Roberto, Electrical Engineer | Master of Marketing
            Federal University of Itajuba (UNIFEI), Brazil
            Monash University, Melbourne, VIC, Australia
            trajanoroberto@gmail.com

  Station : Gato Preto Radio — gatopretoradio.com.br
  URL     : https://chilledkoala.gatopretoradio.com.br


════════════════════════════════════════════════════════════════════════════════
  DEPLOY — READ THIS FIRST
════════════════════════════════════════════════════════════════════════════════

EVERY UPDATE (standard deploy)
  scp chilled_koala_v2.0.0.zip root@177.136.224.35:/opt/chilled_koala/
  cd /opt/chilled_koala && unzip -o chilled_koala_v2.0.0.zip && bash upgrade.sh
  curl -s http://localhost:3100/api/health | grep build
  Browser hard-refresh: Ctrl+Shift+R (Windows/Linux) or Cmd+Shift+R (macOS)

FIRST-TIME INSTALL
  apt install unzip && npm install -g pm2
  mkdir -p /opt/chilled_koala && cd /opt/chilled_koala
  unzip -o chilled_koala_v2.0.0.zip
  cp config.ini config.ini.bak
  nano config.ini                         <- edit paths, secrets, IPs
  bash upgrade.sh

STATION DETAILS
  URL         : https://chilledkoala.gatopretoradio.com.br
  VPS IP      : 177.136.224.35
  Port        : 3100
  PM2 name    : chilled_koala
  Install dir : /opt/chilled_koala

VPS DIAGNOSTICS
  pm2 list
  pm2 logs chilled_koala --lines 20 --nostream
  curl -s http://localhost:3100/api/health | grep build

HEALTHY LOG PATTERN
  [mixer tick] gains: p1=X.XXX mic0=X.XXX | bufs: p1=NNNb | mix1clients=1 ticker=running
  [WA] Capture started (AudioWorklet Float32) sampleRate=48000
  [PE] jitter buffer full (0.7s) -- playback started

FIREWALL
  TCP 3100        Chilled Koala web app
  UDP 40000-40099 mediasoup WebRTC
  TCP 8005        Liquidsoap source (outbound to AzuraCast)


════════════════════════════════════════════════════════════════════════════════
  CONFIG  (config.ini)
════════════════════════════════════════════════════════════════════════════════

ALL RUNTIME SETTINGS LIVE IN config.ini — NO HARD-CODED VALUES IN CODE.

  [general]
  port             = 3100
  public_url       = https://your-domain.com

  [security]
  session_secret   = <openssl rand -hex 32>     <- CHANGE ON FRESH INSTALL
  session_timeout  = 28800

  [paths]
  music_library_path = /mnt/data/azuracast/stations/gato_preto/media/Music
  cart_sweeper_path  = /mnt/data/azuracast/stations/gato_preto/media/Music/Cart/Sweeper
  cart_bumper_path   = /mnt/data/azuracast/stations/gato_preto/media/Music/Cart/Bumper
  cart_trailer_path  = /mnt/data/azuracast/stations/gato_preto/media/Music/Cart/Trailer
  sfx_path           = /mnt/data/azuracast/stations/gato_preto/media/Music/SFX

  [audio]
  crossfade_sec    = 2
  bitrate          = 320

  [icecast]
  server           = 127.0.0.1
  port             = 80
  mount            = /live
  listener_mount   = /radio.aac1
  password         = <icecast source password>   <- CHANGE
  public_stream_url = https://streams.gatopretoradio.com.br/radio.aac1

  [azuracast]
  station_id       = 1
  docker_container = azuracast
  server           = 127.0.0.1
  port             = 80

  [azuracast_dj]
  server           = <VPS public IP>
  port             = 8005
  mount            = /

  [webrtc]
  announced_ip     = <VPS public IP>
  rtp_port_min     = 40000
  rtp_port_max     = 40099

SETTINGS EDITABLE FROM THE WEB UI
  Music library path, Icecast mount/password, DJ server/port — saved back to
  config.ini automatically on Save. No manual editing needed after first setup.

BUILD NUMBER
  Lives in package.json ("build" field) — the single source of truth.
  server.js reads it at startup. Never hard-coded in any .js file.
  Bump package.json "build" before each deploy. Health check confirms it:
    curl -s http://localhost:3100/api/health | grep build


════════════════════════════════════════════════════════════════════════════════
  CHANNEL LAYOUT
════════════════════════════════════════════════════════════════════════════════

  RT 1 -- STATION MIX  (DJ earphone + PGM 1)
    CH 1   DJ 1 Mic    remote   mic2      remote WebRTC DJ
    CH 2   DJ 2 Mic    remote   mic3      remote WebRTC DJ
    CH 3   Player 1    player   player_1  FLAC files
    CH 4   Player 2    player   player_2  FLAC files
    CH 5   Guest 1     webrtc   guest0    /call page
    CH 6   Guest 2     webrtc   guest1    /call page

  RT 2 -- BROADCAST MIX  (Mix 1 + local mics -> Icecast)
    CH 7   Loc Mic 1   mic      mic0      DJ PC mic (excluded from Mix 1 -- no echo)
    CH 8   Loc Mic 2   mic      mic1      DJ PC mic (excluded from Mix 1 -- no echo)

  MIX1_KEYS (server): player1, player2, mic2, mic3, guest0, guest1
  VU_KEY_CH (browser): mic0:0, mic1:1, mic2:2, mic3:3, player1:4, player2:5, guest0:6, guest1:7

  Guest call link: https://chilledkoala.gatopretoradio.com.br/call


════════════════════════════════════════════════════════════════════════════════
  DJ PC MICROPHONE SETUP  (Windows -- Gato Preto Radio DJ PC)
════════════════════════════════════════════════════════════════════════════════

  Hardware: earphone+mic headset with TRRS splitter adapter
  Pink plug -> PINK rear-panel jack (mic in)
  Green plug -> GREEN rear-panel jack (headphone out)

  Realtek HD Audio Manager -> Microphone -> Levels:
    Microphone: 100    Microphone Boost: +20.0 dB

  Realtek HD Audio Manager -> Microphone -> Microphone Effects:
    Noise Suppression: OFF    Acoustic Echo Cancellation: OFF

  Windows Sound -> Recording -> Microphone -> Enhancements:
    Disable all sound effects: checked

  Chrome: lock icon -> Microphone -> Allow -> hard-refresh (Ctrl+Shift+R)

  TARGET RMS: mic0 = 0.04-0.10 while speaking (comparable to player1 = 0.02-0.06)


════════════════════════════════════════════════════════════════════════════════
  STREAMER ACCOUNTS
════════════════════════════════════════════════════════════════════════════════

  Add: AzuraCast -> My Station -> Streamers/DJs -> Add Streamer

  Verify on VPS:
    docker exec azuracast curl -s -X POST \
      http://127.0.0.1/api/internal/1/liquidsoap/auth \
      -H "Content-Type: application/json" \
      -d '{"user":"USERNAME","password":"PASSWORD"}'
    true = OK   empty = not found

  Auth chain: docker exec (port 6010) -> AzuraCast public API -> SFTP port 2022
  Lockout: 5 failed attempts -> 60s cooldown per username


════════════════════════════════════════════════════════════════════════════════
  LIQUIDSOAP -- 30 SECOND SILENCE FALLBACK  (PENDING -- not yet applied)
════════════════════════════════════════════════════════════════════════════════

  When live stream is silent for 30s, reverts to AzuraCast automation playlist.

  AzuraCast -> Broadcasting -> Edit Liquidsoap Configuration
  Find:
    live.on_disconnect(synchronous=false, azuracast.live_disconnected)
  Add immediately after:
    live = blank.strip(id="live_blank_strip", max_blank=30., min_noise=0., threshold=-50., live)

  Then: AzuraCast -> Restart Broadcasting


════════════════════════════════════════════════════════════════════════════════
  MIC DIAGNOSTIC
════════════════════════════════════════════════════════════════════════════════

  Settings tab -> Run Mic Diagnostic
  OR: curl http://localhost:3100/api/diag/mic

    buf=0,  no sessions    -> browser mic permission not granted
    buf=0,  sessions exist -> check PM2 logs for errors
    buf>0,  gain=0         -> channel OFF or fader at bottom
    buf>0,  gain>0, rms=0  -> mic too quiet -- raise PC mic volume
    buf>0,  gain>0, rms>0  -> WORKING OK

  Chrome DevTools RMS check (F12 Console, speak while running):
    const _o=applyRealVULevels;let _n=0;
    window.applyRealVULevels=function(l){
      if(_n++<8)console.log('mic0='+l.mic0?.toFixed(5)+'  p1='+l.player1?.toFixed(5));
      else window.applyRealVULevels=_o; _o(l);};


════════════════════════════════════════════════════════════════════════════════
  ARCHITECTURE
════════════════════════════════════════════════════════════════════════════════

  SIGNAL FLOW
    FLAC files  -> FFmpeg -> f64le PCM -> mixer buffer
    Local mic   -> AudioWorklet -> Float32 -> F32\0 magic -> WS -> feedMicF32
    Remote DJ   -> WebRTC mediasoup -> PlainTransport -> FFmpeg RTP -> mixer
    Guest call  -> WebRTC mediasoup -> PlainTransport -> FFmpeg RTP -> mixer

    _tick() every 20ms:
      Mix 1 = player1+player2+mic2+mic3+guest0+guest1 -> /ws/mon -> DJ earphone
      Mix 2 = Mix 1 + mic0 + mic1 -> Opus -> Liquidsoap TCP -> Icecast

  PIPELINE -- Float64 throughout (build 345+)
    FFmpeg -sample_fmt dbl -> f64le (44100 Hz stereo, 16 bytes/frame)
    feedMicF32: Float32 48kHz mono -> resample -> Float64 44100 Hz stereo
    _fOut/_fMix1: Float64Array accumulators -- no precision loss
    Encoders: f64le + -sample_fmt flt -> libopus 320kbps

  CONSTANTS
    SAMPLE_RATE=44100  CHANNELS=2  BYTES_FRAME=16  MIX_INTERVAL=20ms
    BUF_HIGH=800ms  BUF_LOW=400ms  BUF_CAP=1500ms

  FADER GAIN LAW  (IP-12 taper)
    gain = pos<=0 ? 0 : Math.pow(pos/100, 2.5) * 3.162
    pos=100 -> +10dB   pos=63 -> 0dB (unity)   pos=0 -> -inf

  VU METERING  (IP-12 brochure p.12)
    CUE -> pre-fader (bar shows signal regardless of ON/fader)
    ON  -> post-fader x faderGain (bar matches broadcast level)
    CUE+ON -> CUE wins
    OFF, no CUE -> bar dark
    Server: mic channels metered pre-fader (doVU regardless of gain)
    Browser: peak-hold 300ms, multiplicative decay 18%/100ms tick

  MIC FRAME FORMAT
    Magic: F32\0 = 0x46 0x33 0x32 0x00
    Size: 960 x 4 bytes + 4 magic = 3844 bytes per 20ms

  AUDIO QUALITY -- FLAC -> ICECAST
    FLAC (16/24-bit) -> FFmpeg f64le -> Float64 mixer -> libopus 320kbps VBR
    No resampling (FLAC already 44.1kHz). No precision loss in mix path.
    Opus 320kbps is perceptually transparent for stereo broadcast.

  BROADCAST CONTINUITY
    Mix 2 (broadcast) includes mic0/mic1 even when Mix 1 is silent.
    Speaking on Loc Mic 1 keeps the live stream non-silent independently
    of Player 1 state. TCP keepalive detects dead Liquidsoap connections
    within ~15s and reconnects automatically (encoder kept alive, no gap).
    Without blank.strip (PENDING above), silence never triggers AutoDJ --
    only TCP disconnect does.

  SILENCE TIMEOUT
    Current: none (blank.strip not yet applied in Liquidsoap).
    After applying: 30 seconds below -50 dBFS -> AutoDJ resumes.
    On TCP disconnect: AutoDJ resumes immediately (live.on_disconnect).


════════════════════════════════════════════════════════════════════════════════
  ACCESS CONTROL
════════════════════════════════════════════════════════════════════════════════

  Primary DJ    Full control. Star badge.
  Secondary DJ  Mic only. All controls blocked server-side.
  Guest caller  No login. WebRTC mic. Auto-assigned CH5 or CH6.


════════════════════════════════════════════════════════════════════════════════
  HTTP API  (all require authentication except /api/health)
════════════════════════════════════════════════════════════════════════════════

  GET  /api/health                       Build, uptime, stream status, library
  GET  /api/diag/mic                     Mic session/gain/buffer status
  GET  /api/mixer/diag                   Live gains + buffer sizes
  GET  /api/audio-quality                FLAC source RMS/peak + delivery stats
  GET  /api/latency                      Latency figures for each audio path
  GET  /api/clock                        Server NTP sync status
  GET  /api/library/search?q=&field=     Search library (field: title|artist|album|all)
  GET  /api/library/cart                 Cart contents
  GET  /api/library/status               Indexed/indexing/count/path
  GET  /api/library/reindex              Start rescan, returns job_id immediately
  GET  /api/library/reindex/status/:id   Poll scan job status
  GET  /api/stream/status                Stream state
  GET  /api/console/state                Console channel state
  GET  /api/config                       Current config (no secrets)
  POST /api/stream/start                 Start broadcast (primary only)
  POST /api/stream/stop                  Stop broadcast (primary only)
  POST /api/config/library               {"path": "..."}  -- saves to config.ini
  POST /api/config/icecast               {"server","port","mount","password"}


════════════════════════════════════════════════════════════════════════════════
  FILE INVENTORY  (22 files, flat -- no subdirectories)
════════════════════════════════════════════════════════════════════════════════

  server.js              HTTP + WebSocket, routing, auth, stream control
  auth.js                Three-method auth chain
  mixer.js               Float64 PCM mixer, backpressure, VU, encoders
  player.js              FLAC player, FFmpeg, backpressure
  console.js             Channel state -- faders, CUE, TB, ON/OFF
  library.js             FLAC library cache, search (path from config.ini)
  playlist.js            Playlist engine -- Player 1 and 2
  webrtc.js              mediasoup WebRTC -- guests + remote DJ
  app.js                 Browser SPA -- UI, Web Audio, VU display
  index.html             Main console
  login.html             Login page
  call.html              Guest caller page
  style.css              All styles
  config.ini             Runtime configuration -- ALL settings here
  package.json           npm dependencies + build number ("build" field)
  upgrade.sh             Deploy: npm install + pm2 restart
  README.txt             This file
  LICENSE.txt            MIT licence
  mediasoup-client.js    Bundled mediasoup browser client
  pcm-player.js          Bundled PCM player (MIT, Samir Das)
  earphone-worklet.js    AudioWorklet ring buffer
  mic-capture-worklet.js AudioWorklet Float32 mic capture + F32\0 framing


════════════════════════════════════════════════════════════════════════════════
  BUILD HISTORY  (do not regress)
════════════════════════════════════════════════════════════════════════════════

  302-303  djMicSessions excluded -> mic0 gain always 0
  306      Browser cache stale -> build number injected into asset URLs
  316      WebRTC DJ mic -> AudioWorklet path (build 327)
  331      PGM2 > PGM1 when mics OFF
  344      /32768 in Float64 output -> mix2=0
  345      Float64 pipeline end-to-end
  350      Earphone broken after Float64 upgrade
  350      Monitor encoder crash f64le -> -sample_fmt flt added
  350      mic0 buffer 1MB backlog -> flush on assignMic()
  351      PGM2 > PGM1 background noise -> use _mix2rms from server
  352      ON button missing updateConsoleUI() -> strip not going green
  354      _vuChSegs[0] stomped by buildMonitorStrip() -> CH7 bar always dark
  355      VU scale x200 PCM16 era -> corrected to x8 Float64
  356      IP-12 VU: CUE=pre-fader, ON=post-fader x faderGain
  356      Peak-hold 300ms + multiplicative decay added
  357      Monitor encoder missing EPIPE handlers -> 6736 restarts fixed
  357      writableNeedDrain guard on monitor encoder write
  357      unhandledRejection exits -> PM2 restarts cleanly
  358      Smart caching: versioned assets 1hr, static libs 24hr
  358      README consolidated -- deploy at top, all docs in one file
  359      Hard-coded paths removed -- all settings from config.ini only
  359      Build number -> package.json "build" field, read at startup
  359      library.js musicPath fallback removed -- config.ini authoritative
  360      console.js: ch_on and fader loaded from config.ini at startup (were hardcoded false/0)
  360      persistAllFaders() now also saves ch_on state
  360      config.ini: all channels on=true, volume=80 as default startup state


════════════════════════════════════════════════════════════════════════════════
  361      library.js: parallel metadata scan concurrency=8 (~8x faster for large libraries)
  361      library.js: two-phase scan -- directory walk first, then parallel parseFile()
  361      app.js: scan poll AbortController 8s timeout -- UI never freezes on stalled request
  361      app.js: poll interval 2s, max polls 1800 (1 hour) -- no timeout for large libraries
  361      server.js: headersTimeout/requestTimeout=0 -- no server-side timeout on scan polls

  CURRENT STATUS -- Build 361
════════════════════════════════════════════════════════════════════════════════

  WORKING
    Float64 pipeline end-to-end
    AudioWorklet mic capture -> F32\0 -> feedMicF32 -> Float64 buffer
    mic0 gain correct (0.300 typical with fader at -9dB)
    mic0 RMS 0.04-0.15 while speaking (post Realtek fix)
    Three-method auth chain
    Cache busting via build number (from package.json)
    PGM2 = PGM1 when CH7/CH8 OFF
    MON PGM1 auto-starts on login
    DJ earphone working: Float64 -> Float32 in _enqueue()
    IP-12 VU: CUE pre-fader, ON post-fader, peak-hold decay
    CH7/CH8 VU bars working (buildMonitorStrip _vuChSegs[0] fix)
    Server crash loop fixed (EPIPE handlers on monitor encoder)
    PM2 restart count stable
    All paths from config.ini -- zero hard-coding in server code

  PENDING
    1. Liquidsoap blank.strip 30s silence fallback -- one line, see section above
    2. GO LIVE full broadcast test -- voice + music verified on iOS app
    3. stephanroberto AzuraCast account -- password reset needed
    4. Secondary DJ mic CH1/CH2 -- full end-to-end test
    5. Mobile earphone testing
    6. GitHub repository creation
    7. Academic paper -- replace [repository URL] before submission


════════════════════════════════════════════════════════════════════════════════
  ACADEMIC PAPER
════════════════════════════════════════════════════════════════════════════════

  Title  : "Chilled Koala, Stream Ecosystem"
  Author : Trajano Roberto -- UNIFEI Brazil + Monash University Melbourne
  Target : IEEE Transactions on Broadcasting or JAES
  File   : chilled_koala_academic_paper.docx
  Status : Ready -- replace [repository URL] before submission


════════════════════════════════════════════════════════════════════════════════
  LICENCE
════════════════════════════════════════════════════════════════════════════════

  MIT License -- Copyright 2026 Trajano Roberto. See LICENSE.txt.

================================================================================
