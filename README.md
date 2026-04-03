# Chilled Koala v2.0.0 — Stream Ecosystem

Browser-based, server-side mixing console for AzuraCast / Icecast.  
Emulates a Wheatstone IP-12 digital radio table.

**Author:** Trajano Roberto, Electrical Engineer | Master of Marketing  
Federal University of Itajuba (UNIFEI), Brazil · Monash University, Melbourne, VIC, Australia  
trajanoroberto@gmail.com

**Station:** Gato Preto Radio — gatopretoradio.com.br  
**URL:** https://chilledkoala.gatopretoradio.com.br

---

## Table of Contents

1. [Deploy](#1-deploy)
2. [Architecture](#2-architecture)
3. [Signal Flow](#3-signal-flow)
4. [Module Reference & Pseudo Code](#4-module-reference--pseudo-code)
   - [server.js](#serverjs)
   - [auth.js](#authjs)
   - [mixer.js](#mixerjs)
   - [player.js](#playerjs)
   - [console.js](#consolejs)
   - [playlist.js](#playlistjs)
   - [library.js](#libraryjs)
   - [webrtc.js](#webrtcjs)
   - [app.js](#appjs)
   - [AudioWorklets](#audioworklets)
5. [HTTP API](#5-http-api)
6. [WebSocket Protocol](#6-websocket-protocol)
7. [Configuration (config.ini)](#7-configuration-configini)
8. [Channel Layout](#8-channel-layout)
9. [Access Control](#9-access-control)
10. [DJ PC Microphone Setup](#10-dj-pc-microphone-setup)
11. [Streamer Accounts](#11-streamer-accounts)
12. [Diagnostics](#12-diagnostics)
13. [Firewall](#13-firewall)
14. [Pending](#14-pending)
15. [Build History](#15-build-history)
16. [Academic Paper](#16-academic-paper)
17. [Licence](#17-licence)

---

## 1. Deploy

### Standard deploy (git-based)

```powershell
# Windows — from D:\basket\Trajano\Apps\chilled_koala
.\deploy.ps1
```

`deploy.ps1` does:
1. Reads build number from `package.json`
2. `git add -A`
3. `git commit -m "Build <N>"`
4. `git push origin main` → GitHub
5. SSH via WinSCP saved session `root@www.gatopretoradio.com.br`:  
   `cd /opt/chilled_koala && git pull && pm2 restart chilled_koala`
6. Prints `DEPLOY COMPLETE`

### Verify deploy

```bash
curl -s http://localhost:3100/api/health | grep build
# Browser hard-refresh: Ctrl+Shift+R
```

### First-time VPS install

```bash
apt install -y git nodejs npm
npm install -g pm2
mkdir -p /opt/chilled_koala && cd /opt/chilled_koala
git init
git remote add origin https://github.com/trajanoroberto-hub/ChilledKoala.git
git pull origin main
cp config.ini.example config.ini
nano config.ini          # edit paths, secrets, IPs
npm install --production
pm2 start server.js --name chilled_koala
pm2 save
```

### VPS diagnostics

```bash
pm2 list
pm2 logs chilled_koala --lines 20 --nostream
curl -s http://localhost:3100/api/health | grep build
```

**Healthy log pattern:**
```
[mixer tick] gains: p1=X.XXX mic0=X.XXX | bufs: p1=NNNb | mix1clients=1 ticker=running
[WA] Capture started (AudioWorklet Float32) sampleRate=48000
[PE] jitter buffer full (0.7s) -- playback started
```

---

## 2. Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│  Browser (DJ Console — index.html + app.js)                             │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐               │
│  │ Player 1 │  │ Player 2 │  │ Mic Capt │  │ Earphone │               │
│  │ Controls │  │ Controls │  │ Worklet  │  │ Worklet  │               │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘               │
│       │WS           │WS           │WS binary      │WS binary            │
└───────┼─────────────┼─────────────┼───────────────┼─────────────────────┘
        │             │             │               │
┌───────▼─────────────▼─────────────▼───────────────▼─────────────────────┐
│  server.js  (Express + WebSocket)                                         │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐  │
│  │ auth.js  │  │player.js │  │ mixer.js │  │console.js│  │library.js│  │
│  │(3-method)│  │(FFmpeg)  │  │(Float64) │  │(IP-12)   │  │(FLAC)    │  │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘  └──────────┘  │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐                               │
│  │webrtc.js │  │playlist.j│  │ AzuraCast│                               │
│  │(mediasoup│  │ s        │  │ DB proxy │                               │
│  └──────────┘  └──────────┘  └──────────┘                               │
└─────────────────────────────────────────────────────────────────────────┘
        │                                         │
        ▼                                         ▼
  AzuraCast                               Liquidsoap TCP
  (Docker MariaDB)                        → Icecast → Listeners
```

### Key design decisions

| Decision | Reason |
|---|---|
| Float64 PCM throughout | No precision loss in mix path; FLAC 24-bit source preserved end-to-end |
| Server-side mixing | Consistent output regardless of DJ browser/OS audio stack |
| Backpressure on FFmpeg | Prevents playlist racing through all tracks instantly on fast VPS |
| Wall-clock position tracking | Byte counter drifts 5–10 s over minutes; wall clock matches what DJ hears |
| Three-method auth chain | AzuraCast internal API most reliable; public API + SFTP are fallbacks |
| Direct MariaDB via docker exec | No AzuraCast public API for playlist folder removal; DB access is the only path |

---

## 3. Signal Flow

### FLAC playback

```
FLAC file
  → FFmpeg (f64le, 44100Hz, stereo)
  → player.js stdout pipe
  → mixer.feedPlayer1/2(chunk)
  → mixer._bufs['player1'/'player2']
  → _tick() every 20ms
  → mixed into outMix1 + out (Float64Array)
```

### Local mic (DJ PC)

```
Browser getUserMedia
  → AudioWorklet (mic-capture-worklet.js)
  → Float32 mono 48kHz → F32\0 framing (4-byte magic + 960 samples)
  → WebSocket binary to /ws/main
  → server.js detects F32\0 magic
  → mixer.feedMicF32(sessionId, float32Buffer)
  → resample 48kHz→44100Hz (linear interpolation)
  → stereo duplication → f64le → mixer._bufs['mic0'/'mic1']
```

### Remote DJ mic (WebRTC)

```
Browser mic → mediasoup-client → Opus/RTP/SRTP → UDP
  → mediasoup PlainTransport on VPS
  → FFmpeg (SDP/RTP → s16le 44100Hz)
  → webrtc.js PCM callback
  → mixer.feedMicPcm(mixerKey, chunk)
  → mixer._bufs['mic2'/'mic3']
```

### Guest caller

```
/call page → WebRTC mediasoup → PCM
  → mixer.feedGuest(slot, chunk)
  → mixer._bufs['guest0'/'guest1']
```

### Mix tick (every 20ms)

```
_tick():
  frames = SAMPLE_RATE × elapsed_ms / 1000   (drift-compensated)
  _fMix1 = Σ (player1, player2, mic2, mic3, guest0, guest1) × gain_per_channel
  _fOut  = _fMix1 + mic0 + mic1

  outMix1 → /ws/mix1 WebSocket → earphone-worklet.js → AudioWorklet → DJ headphones
  out     → Opus encoder (FFmpeg) → Liquidsoap TCP → Icecast → listeners
  VU      → RMS per channel → WebSocket broadcast → browser VU meters
```

### Constants

```
SAMPLE_RATE  = 44100 Hz
CHANNELS     = 2 (stereo)
BYTES_FRAME  = 16  (f64le stereo: 8 bytes/sample × 2)
MIX_INTERVAL = 20 ms
BUF_HIGH     = 800 ms  (pause FFmpeg when buffer exceeds this)
BUF_LOW      = 400 ms  (resume FFmpeg when buffer drains to this)
BUF_CAP      = 1500 ms (hard ceiling — safety net above BUF_HIGH)
```

### Fader gain law (IP-12 taper)

```
gain = pos <= 0 ? 0 : Math.pow(pos/100, 2.5) × 3.162

pos=100 → +10 dB   pos=85 → 0 dB (unity)   pos=0 → −∞
```

### VU metering (IP-12 brochure p.12)

```
CUE active      → pre-fader (bar shows signal regardless of ON/fader)
ON, no CUE      → post-fader × faderGain (bar matches broadcast level)
CUE + ON        → CUE wins (pre-fader)
OFF, no CUE     → bar dark
Mic channels    → always metered pre-fader server-side
Peak-hold       → 300 ms, then multiplicative decay 18%/100 ms tick
```

---

## 4. Module Reference & Pseudo Code

### server.js

**Role:** HTTP server, WebSocket hub, request routing, auth guard, stream control, AzuraCast DB proxy.

```
startup:
  loadConfig()           → parse config.ini
  new AuthManager()      → three-method auth chain
  new AudioMixer()       → Float64 PCM mixer
  new ServerPlayer() ×2  → Player 1, Player 2 (FLAC → FFmpeg)
  mixer.setPlayers()     → wire backpressure reporting
  new WebRTCGuests()     → mediasoup for guests + remote DJ mic
  new BroadcastConsole() → IP-12 console state engine
  new LivePlaylist() ×2  → Player 1 playlist, Player 2 playlist
  new MusicLibrary()     → FLAC index cache
  rtcGuests.init()       → start mediasoup worker

HTTP middleware:
  sessionMiddleware()    → file-based sessions (FileStore)
  authGuard()            → redirect to /login if not authenticated
                           public paths: /login, /api/health, /call.html, worklets

WebSocket upgrade handler:
  /ws/main  → DJ console connection (mic audio, control messages)
  /ws/mon   → earphone + signalling (mix1 PCM, WebRTC signalling)

WebSocket message handler (/ws/main):
  binary frame:
    if starts with F32\0 magic → feedMicF32()    (AudioWorklet path)
    else                       → feedMicChunk()  (legacy WebM path)
  JSON:
    ra:play / ra:pause / ra:stop / ra:next / ra:seek → raPlay/raPause/raStop
    rb:* → same for Player 2
    console:on/off/cue/fader/tb/source → console_.setOn/setCue/setFader/setTB/setSource
    stream:start / stream:stop → mixer.startStream / mixer.stopStream
    library:search → library.search()
    playlist:add / playlist:remove / playlist:clear → playlist.addTrack / removeTrack / clear
    guest:join / guest:produce / guest:consume → rtcGuests WebRTC signalling

broadcast(msg):
  → send JSON to all connected /ws/main clients

raPlay(idx, xfade):
  track = playlist.tracks[idx]
  bump _raGeneration to invalidate stale onEnd callbacks
  if xfade → player1.crossfadeTo(track, gain, xfSec, onPcm, onEnd)
  else      → player1.play(track, gain, onPcm, onEnd)
  playlist.setNowPlaying(idx)
  _schedRaXfade()           → schedule crossfade timer based on track duration

_schedRaXfade():
  delay = (track.duration − xfSec − currentPosition) × 1000
  after delay → raPlay(next, true)   // crossfade into next track

syncMixerFromConsole():
  gather mic keys from micSessions + djMicSessions
  compute gain per key from console channel state
  mixer.syncConsole(channels, micAssignments)
  rtcGuests.syncConsole(channels, mixer)

AzuraCast DB routes:
  GET  /api/azuracast/playlist/:id/contents
    → _azDB("SELECT ... FROM station_playlist_folders ...")
    → returns folders with track counts + individual orphan tracks

  POST /api/azuracast/playlist/:id/remove
    body {type:'folder', path}
      → DELETE FROM station_playlist_folders WHERE path=?
      → DELETE FROM station_playlist_media WHERE folder_id IN (...)
    body {type:'tracks', paths:[...]}
      → DELETE FROM station_playlist_media WHERE media_id IN (...)

  POST /api/azuracast/playlist/push
    folders → PUT /api/station/{id}/playlist/{id}/apply-to   (persistent dynamic link)
    tracks  → M3U import POST /api/station/{id}/playlist/{id}/import

_azDB(sql):
  spawn('docker', ['exec', '-i', '-e', 'MYSQL_PWD=...', 'azuracast', 'mariadb', ...])
  write sql to stdin → collect stdout → resolve rows
```

---

### auth.js

**Role:** Three-method authentication chain against AzuraCast streamer accounts.

```
AuthManager(config):
  stationId   = config.azuracast.station_id
  container   = config.azuracast.docker_container  ('azuracast')
  publicHost  = config.azuracast.server
  publicPort  = config.azuracast.port
  timeout     = 8000 ms

authenticate(username, password):
  if rateLimited()   → reject (max 10 auth/sec across all users)
  if checkLock()     → reject (5 fails → 60s lockout per username)

  ok = _authViaDocker(username, password)    // Method 1
  if ok === null:
    ok = _authViaPublicApi(username, password) // Method 2
  if ok === null:
    ok = _authViaSftp(username, password)    // Method 3

  if ok → recordSuccess(); else recordFail()
  return !!ok

_authViaDocker(username, password):
  docker exec azuracast curl -s -X POST
    http://127.0.0.1/api/internal/{stationId}/liquidsoap/auth
    -d '{"user":"...","password":"..."}'
  response 'true'  → return true
  response 'false' → return false
  error/timeout    → return null  (try next method)

_authViaPublicApi(username, password):
  POST http://{publicHost}:{publicPort}/api/internal/{stationId}/liquidsoap/auth
  response 'true'  → return true
  response 'false' → return false
  error/timeout    → return null

_authViaSftp(username, password):
  ssh2 Client.connect(localhost:2022, username, password)
  'ready' event   → return true
  'error' event   → return false
  timeout (8s)    → return false

_checkLock(username):
  if fails[username].lockedUntil > Date.now() → return true (locked)
  if lock expired → delete entry → return false

_recordFail(username):
  fails[username].count++
  if count >= 5 → set lockedUntil = now + 60000

_rateLimited():
  reset counter every 1s window
  if count > 10 → return true
```

---

### mixer.js

**Role:** Server-side Float64 PCM mixer. Produces Mix 1 (station) and Mix 2 (broadcast) every 20 ms.

```
AudioMixer(config):
  _bufs   = {}   // mixerKey → Buffer  (f64le stereo raw PCM)
  _gains  = {}   // mixerKey → float   (0 to 3.162)
  _ticker = null // setInterval handle

MIX1_KEYS = ['player1','player2','mic2','mic3','guest0','guest1']

syncConsole(channels, micAssignments):
  for each channel:
    if source === 'player_1' → _gains['player1'] = ch.on ? taper(fader) : 0
    if source === 'player_2' → _gains['player2'] = ...
    if source === 'guest0/1' → _gains['guest0/1'] = ch.on && !ch.tb ? taper(fader) : 0
  for each micAssignment → _gains[key] = gain

_tick() [every 20ms]:
  elapsed = Date.now() − lastTickAt  (drift-compensated, capped at 3× interval)
  frames  = round(SAMPLE_RATE × elapsed / 1000)
  needed  = frames × BYTES_FRAME

  _fOut  = Float64Array(frames × CHANNELS)   // broadcast accumulator
  _fMix1 = Float64Array(frames × CHANNELS)   // station mix accumulator
  _fCue  = Float64Array(frames × CHANNELS)   // CUE bus (pre-fader)

  for each key in _bufs:
    drain up to `needed` bytes from _bufs[key]
    apply _gains[key] to each Float64 sample
    accumulate into _fMix1 (if MIX1_KEYS) or _fOut (mic0/mic1 only go to _fOut)
    accumulate VU RMS (mics: pre-fader; players/guests: post-fader)

  _fOut += _fMix1 + mic0 + mic1   // broadcast = station + local mics

  report p1/p2 consumed bytes → player1/2.reportConsumed()  (backpressure)

  outMix1 = Buffer from _fMix1
  out     = Buffer from _fOut

  → send outMix1 to all _mix1Clients (DJ earphone WebSocket path)
  → write out to _encoder.stdin  (FFmpeg → Liquidsoap → Icecast)
  → if CUE active: send outCue to monitor clients

  every 250ms → emit 'vu' event with RMS per channel → broadcast to browsers

feedPlayer1/2(chunk): → _feedBuf('player1'/'player2', chunk)
feedGuest(slot, chunk): → _feedBuf('guest0'/'guest1', chunk)
feedMicPcm(key, chunk): → _feedBuf(key, chunk)   // WebRTC DJ mic (already decoded)
feedMicChunk(sessionId, webmChunk):
  → write to per-session FFmpeg WebM decoder stdin
feedMicF32(sessionId, float32Buffer):
  resample Float32 48kHz mono → Float64 44100Hz stereo (linear interpolation)
  if mic0/mic1 and _micDelayMs > 0 → _feedBufDelayed(key, out)
  else → _feedBuf(key, out)

_feedBufDelayed(key, chunk):
  maintain delay buffer of _micDelayMs worth of PCM
  pre-fill with silence on initialisation
  drain everything beyond target depth into real mixer buffer

assignMic(sessionId, mixerKey):
  flush stale buffer
  start FFmpeg WebM decoder for session
  _micMap.set(sessionId, mixerKey)

releaseMic(sessionId):
  kill FFmpeg decoder
  clear buffer and gain for that key

remapMic(sessionId, newKey):
  move buffered PCM from old key to new key

startStream():
  spawn FFmpeg encoder: f64le stdin → libopus 320kbps → stdout
  connect via TCP to Liquidsoap (SOURCE protocol)
  on encoder exit → reconnect with backoff

stopStream():
  kill encoder process
  close TCP socket

addMix1Client(cb) / removeMix1Client(cb):
  manage Set of earphone callback functions
  on first connect: flush all MIX1_KEYS buffers (prevent stale backlog)

startTicker() / stopTicker():
  called by server.js on browser connect/disconnect
  ticker never stops while stream is active
```

---

### player.js

**Role:** FLAC playback engine. Spawns FFmpeg per track, feeds raw PCM to mixer. Manages crossfade and backpressure.

```
ServerPlayer extends EventEmitter:
  _proc     = null  // active FFmpeg process
  _procB    = null  // outgoing FFmpeg process (crossfade)
  _bp       = WeakMap  // proc → { paused: bool }

taper(pos):
  // IP-12 fader law: pos 0–100 → linear gain
  pos <= 0 → 0
  else     → Math.pow(pos/100, 2.5) × 3.162

play(track, gain, onPcm, onEnd):
  kill existing procs
  _seekOffset = 0
  _startedAt_wall = Date.now()
  _playing = true
  bump _playGen   // invalidate any pending _waitDrain
  _spawnFFmpeg(track.path, seekSec=0, gain, onPcm, onEnd, gen)

crossfadeTo(track, gain, xfSec, onPcm, onEnd):
  move _proc → _procB (outgoing, kill after xfSec+0.5s)
  _spawnFFmpeg for new track (incoming)

pause():
  _paused = true
  record _pausedAt for wall-clock accumulation
  kill _proc

resume():
  accumulate _pausedAccum += (Date.now() − _pausedAt)
  _spawnFFmpeg from _seekOffset

stop():
  _playing = false
  kill both _proc and _procB

_spawnFFmpeg(filePath, seekSec, gain, onPcm, onEnd, gen):
  args = ['ffmpeg', '-hide_banner', '-nostats', '-loglevel', 'warning']
  if seekSec > 0 → append ['-ss', seekSec]
  append ['-i', filePath, '-vn', '-f', 'f64le', '-sample_fmt', 'dbl', '-ar', '44100', '-ac', '2', 'pipe:1']
  // Note: gain NOT applied at FFmpeg level — mixer._gains controls gain in real-time
  spawn process

  proc.stdout.on('data', chunk):
    if proc is stale (not _proc or _procB) → discard
    if proc is outgoing (_procB) → discard (only incoming feeds mixer)
    onPcm(chunk)         → mixer.feedPlayer1(chunk)
    _bytesFed += length
    check backpressure:
      actualBuf = mixer._bufs['player1'].length
      if actualBuf >= BUF_HIGH → proc.stdout.pause()  // prevent buffer overflow

  proc.on('exit', code):
    if stale → ignore
    if code !== 0 → delay 400ms → onEnd()  (prevent cascade on bad file)
    else → _waitDrain(onEnd, gen)

_waitDrain(onEnd, gen):
  // Wait for mixer to drain remaining buffered audio
  poll every 20ms:
    remaining = _bytesFed − _bytesConsumed
    if remaining <= 0 → emit 'trackEnded'; onEnd()
    else              → setTimeout(check, 20)

reportConsumed(bytes):
  _bytesConsumed += bytes
  if proc was paused and actualBuf <= BUF_LOW → proc.stdout.resume()

positionSec():
  // Wall-clock position — NOT byte counting
  if paused   → (pausedAt − startedAt_wall − pausedAccum) / 1000 + seekOffset
  if playing  → (Date.now() − startedAt_wall − pausedAccum) / 1000 + seekOffset
```

---

### console.js

**Role:** IP-12 console state engine. Manages 8 channels, faders, CUE, TB, ON/OFF, monitor source, timer. Persists state to config.ini.

```
BroadcastConsole(config):
  channels[0..7]  = _initChannels()  // load from config.ini [channels] section
  monitorSource   = 'pgm1'
  monitorVolume   = 80

_initChannels():
  for i in 0..7:
    read ch{i+1}_name, type, source_a, source_b, label_a, label_b, on, volume from config.ini
    on   = (value === 'true')
    fader = parseInt(volume) || 0

getState():
  return { channels, monitorSource, monitorVolume, pgmChannels, tbChannels, headphoneSource, timer }

setOn(chId, on):     ch.on = on; fire 'on' event
setCue(chId, active): ch.cue = active; fire 'cue' event
setTB(chId, active):
  only allowed for type 'remote' or 'webrtc'
  ch.tb = active; fire 'tb' event
setFader(chId, pos): ch.fader = clamp(0..100); fire 'fader' event
setSource(chId, 'A'|'B'): ch.activeSource = ...; fire 'source' event

setMonitor(source, volume):
  normalise 'pgm' → 'pgm1'
  valid sources: pgm1, cue, offair
  fire 'monitor' event

getMixMinus(chId):
  // PGM channels excluding the guest's own channel (prevents self-hearing)
  return pgmChannels.filter(c ≠ chId)

getMixMinusTB(chId):
  // Mix-minus + host mic added (for talkback monitoring)
  return getMixMinus(chId) + hostChannel

timerStart() / timerStop() / timerReset():
  maintain { running, startedAt, elapsed } with accumulation

persistAllFaders():
  write ch{n}_volume and ch{n}_on back to config object (server then calls saveConfig())

faderToDB(pos):
  pos 0    → −∞
  pos 1..85 → linear −60..0 dB
  pos 86..100 → linear 0..+10 dB

_fire(event, data):
  emit(event, data)
  emit('stateChange', getState())
```

---

### playlist.js

**Role:** Ordered track list with start-time calculation, stop markers, and now-playing tracking. Used by Player 1 and Player 2 independently.

```
LivePlaylist extends EventEmitter:
  tracks[]      = []
  currentIndex  = -1
  nowPlaying    = null

makeEntry(meta):
  assign unique _id (global sequence)
  copy all FLAC metadata fields
  stop = false     // stop marker
  startTime = null // recalculated after every mutation

addTrack(meta):
  entry = makeEntry(meta)
  tracks.push(entry)
  _recalcTimes()
  emit 'updated'

insertNext(meta):
  at = currentIndex + 1  (or 0 if nothing playing)
  tracks.splice(at, 0, makeEntry(meta))
  _recalcTimes(); emit 'updated'

removeTrack(index):
  tracks.splice(index, 1)
  if currentIndex >= index → currentIndex--
  _recalcTimes(); emit 'updated'

toggleStop(index):
  tracks[index].stop = !tracks[index].stop
  emit 'updated'

setNowPlaying(index):
  currentIndex = index
  nowPlaying = tracks[index]
  emit 'nowPlaying'; emit 'updated'

_recalcTimes():
  anchor = currentIndex (or 0)
  cursor = Date.now()
  walk forward from anchor: startTime[i] = cursor; cursor += duration[i] × 1000
  walk backward from anchor-1: cursor −= duration[i]; startTime[i] = cursor

getList():
  return tracks with isCurrent flag set on currentIndex row
```

---

### library.js

**Role:** FLAC metadata cache. Two-phase parallel scan (concurrency 8). Search with multi-word AND logic. Hierarchical tree builder.

```
MusicLibrary(config):
  index    = []      // all FLAC metadata objects
  indexed  = false   // true once cache loaded or rescan complete
  cart     = { sweeper, bumper, trailer, sfx }
  _cacheFile = '.library-cache.json'
  CACHE_SCHEMA = '2.0.0'

loadCache():
  read .library-cache.json
  reject if: file missing | schemaVersion mismatch | musicPath mismatch
  on success: index = data.index; indexed = true

rescan(onProgress):
  if indexing → return false (already running)
  indexing = true
  _walkDir(musicPath, results, onProgress)
  index = results; _saveCache()
  emit completion

_walkDir(dir, results, onProgress):
  // Phase 1: collect all .flac paths (fast — no I/O per file)
  _collectPaths(dir, paths[])
  onProgress(0)   // signal alive immediately

  // Phase 2: read metadata in parallel, concurrency=8
  CONCURRENCY = 8
  shared idx counter; each worker grabs next unclaimed path
  await Promise.all(workers)
  each worker: paths[idx++] → _readMeta() → results.push()

_collectPaths(dir, paths):
  readdir(dir)
  skip hidden files (name starts with '.')
  skip 'cart' and 'sfx' directories
  recurse into subdirectories
  push .flac files to paths

_readMeta(filePath):
  parseFile(filePath, { duration:true, skipCovers:true })
  extract standard tags: title, artist, album, albumartist, track, disc, date, genre, duration
  extract custom tags from FLAC COMMENT blocks:
    GATOPRETO_LUFS, GATOPRETO_STATUS, GATOPRETO_ALBUMID, GATOPRETO_TRACKID, GATOPRETO_ARTISTID
  return metadata object

search(query, field):
  terms = query.toLowerCase().split(' ')
  if no terms → return first 200 from sortedIndex('artist')
  for each track in sortedIndex(field):
    if all terms match at least one field → include in results
  return up to 500 results

_sortedIndex(primaryField):
  sort index by primaryField, tiebreak by title then artist
  cache result per field (invalidated when index changes)

loadCart():
  read sweeper/bumper/trailer/sfx directories from config.ini paths
  list .flac/.mp3/.wav/.ogg files in each

getTree():
  derive Genre → [SubGenre →] Artist → Album → Track hierarchy from file paths
  path structure: musicPath/Genre/[SubGenre/]Artist/Album/track.flac
  return sorted array of genre nodes with nested children arrays
  folders sorted alphabetically; tracks sorted numerically within parent

isPathAllowed(filePath):
  resolve real path; check starts with musicPath or any cart path
  prevents directory traversal attacks
```

---

### webrtc.js

**Role:** mediasoup WebRTC engine for guest callers (CH5/CH6) and remote DJ mic (CH1/CH2).

```
WebRTCGuests extends EventEmitter:
  _worker   = null  // mediasoup Worker (single, handles all sessions)
  _router   = null  // mediasoup Router (Opus 48kHz codec)
  _guests   = Map   // guestId → guest session
  _djMics   = Map   // djMicId → DJ mic session
  _slots    = [null, null]  // guest slot 0=CH5, 1=CH6

init():
  mediasoup.createWorker({ rtcMinPort:40000, rtcMaxPort:40099 })
  worker.on('died') → restart in 2s
  createRouter({ mediaCodecs: [Opus 48kHz stereo] })
  _ready = true; emit 'ready'

getRtpCapabilities():
  return _router.rtpCapabilities  // sent to browser for mediasoup-client init

// Guest session lifecycle:
createGuestSession(guestId):
  createWebRtcTransport() → browser does transport.connect()
  createConsumer(Opus)
  createPlainTransport(on VPS UDP port) → spawn FFmpeg to receive RTP
  FFmpeg: RTP Opus → s16le 44100Hz → pipe → _onPcm callback

createGuestProducer(guestId, rtpParameters):
  _router.consume({ producerId, rtpParameters })
  route PCM to mixer via _onPcm(guestId, chunk)

destroyGuestSession(guestId):
  close transports; kill FFmpeg; release slot

// DJ mic session lifecycle (same router, different callback):
createDjMicSession(djMicId, mixerKey):
  createWebRtcTransport()
  browser produces Opus mic stream
  createPlainTransport → FFmpeg RTP → PCM → _onDjPcm(djMicId, mixerKey, chunk)

syncConsole(channels, mixer):
  update gain for each guest slot based on console channel state

getGuestSlot(guestId):
  return slot index (0 or 1) for this guest session

// Earphone path (server → browser audio):
createEarphoneSession(sessionId):
  createPlainTransport (VPS → browser)
  produces PCM from mixer Mix 1 tick output
  browser consumer decodes Opus for playback
```

---

### app.js

**Role:** Browser SPA. All UI interaction, WebSocket client, Web Audio graph, VU display, library/playlist/console management.

```
init():
  open WebSocket to /ws/main  (DJ control + mic audio)
  open WebSocket to /ws/mon   (earphone PCM + WebRTC signalling)
  setupAudioContext()          → Web Audio API graph
  setupMicCapture()            → AudioWorklet mic-capture-worklet.js
  setupEarphone()              → AudioWorklet earphone-worklet.js + pcm-player.js
  bindConsoleUI()              → fader/ON/CUE/TB buttons → WebSocket messages
  bindPlayerUI()               → ra:play/pause/stop/next → WebSocket
  bindLibraryUI()              → search input → /api/library/search
  bindPlaylistBuilderUI()      → AzuraCast playlist management
  loadLibraryTree()            → /api/library/tree → render folder/track tree
  fetchConsoleState()          → /api/console/state → restore channel state

// Console channel rendering:
buildChannelStrip(ch):
  render ON button, fader (vertical range input), CUE button, TB button
  faderToDB(pos) → display dB value on label

updateConsoleUI(state):
  for each channel: sync ON colour, fader position, CUE glow, TB active

applyRealVULevels(levels):
  for each channel key:
    compute segmentFraction from RMS level
    apply peak-hold (300ms) + multiplicative decay (18%/100ms)
    update CSS segments on VU bar

// Player controls:
sendRaPlay(idx) → ws.send({type:'ra:play', idx})
sendRaPause()   → ws.send({type:'ra:pause'})
sendRaNext()    → ws.send({type:'ra:next'})
raSeek(sec)     → ws.send({type:'ra:seek', position:sec})

// Library browser:
searchLibrary(query, field):
  fetch /api/library/search?q=query&field=field
  render result rows with drag-to-playlist support

renderLibraryTree(tree):
  recursive: genre → sub-genre → artist → album → track
  click folder → expand children
  click track  → add to playlist (via ws playlist:add)
  drag track   → drop onto playlist

// Mic capture:
startMicCapture():
  getUserMedia({ audio: true })
  AudioContext.audioWorklet.addModule('mic-capture-worklet.js')
  mic source → MicCaptureWorklet → port.onmessage
  on message: ws.send(binary frame with F32\0 magic header)

// Earphone:
startEarphone():
  AudioContext.audioWorklet.addModule('earphone-worklet.js')
  ws /ws/mon: binary frames (f64le PCM) → EarphoneWorklet → AudioDestination

// AzuraCast Playlist Builder (pbViewPanel):
openViewPanel():
  fetch /api/azuracast/playlists → populate select
  show panel

loadAzContents(playlistId):
  GET /api/azuracast/playlist/:id/contents
  render folder rows: icon + name + path + track count + Remove button
  render track rows: icon + artist – title + Remove button

removeAzFolder(playlistId, path):
  confirm dialog
  POST /api/azuracast/playlist/:id/remove  {type:'folder', path}
  on success → remove row from DOM

removeAzTracks(playlistId, paths):
  POST /api/azuracast/playlist/:id/remove  {type:'tracks', paths}
  on success → remove rows from DOM

// Clock offset correction for player position display:
// server sends serverNow in ra:state/ra:progress
// browser maintains _clockOffset = Date.now() - serverNow (sliding average)
// correctedPos = state.position + (Date.now() - _clockOffset - state.serverNow) / 1000
```

---

### AudioWorklets

#### mic-capture-worklet.js

```
MicCaptureProcessor extends AudioWorkletProcessor:
  process(inputs):
    input = inputs[0][0]   // Float32 mono 48kHz (960 samples per 20ms)
    frame = new ArrayBuffer(4 + 960×4)
    write magic header: 0x46 0x33 0x32 0x00  ('F32\0')
    copy Float32 samples
    port.postMessage(frame, [frame])  // zero-copy transfer to main thread
    return true  // keep processor alive
```

#### earphone-worklet.js

```
EarphoneWorklet extends AudioWorkletProcessor:
  _ringBuf = Float32Array(RING_SIZE)   // circular ring buffer
  _writePos = 0
  _readPos  = 0

  port.onmessage (from main thread — f64le PCM from server):
    convert f64le → Float32 samples
    write into _ringBuf at _writePos (wrap around)

  process(inputs, outputs):
    if _readPos lags _writePos by < TARGET_FILL → output silence (jitter buffer filling)
    else copy TARGET_FRAMES from _ringBuf[_readPos] to outputs[0]
    // 700ms target fill: absorbs network jitter, provides stable DJ earphone
    return true
```

---

## 5. HTTP API

All endpoints require authentication except those marked `public`.

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/health` | Build, uptime, stream status, library count (**public**) |
| `GET` | `/api/diag/mic` | Mic session / gain / buffer status |
| `GET` | `/api/mixer/diag` | Live gains + buffer sizes per channel |
| `GET` | `/api/audio-quality` | FLAC source RMS/peak + delivery stats |
| `GET` | `/api/latency` | Latency figures per audio path |
| `GET` | `/api/clock` | Server NTP sync status |
| `GET` | `/api/library/search?q=&field=` | Search (field: `title`\|`artist`\|`album`\|`all`) |
| `GET` | `/api/library/tree` | Full genre/artist/album hierarchy |
| `GET` | `/api/library/cart` | Cart contents (sweeper/bumper/trailer/sfx) |
| `GET` | `/api/library/status` | indexed / indexing / count / path |
| `GET` | `/api/library/reindex` | Start rescan, returns `{ job_id }` immediately |
| `GET` | `/api/library/reindex/status/:id` | Poll scan job (`running`/`done`/`error`) |
| `GET` | `/api/stream/status` | Stream state (streaming, uptime, metadata) |
| `GET` | `/api/console/state` | Full console channel state |
| `GET` | `/api/config` | Current config (no secrets) |
| `GET` | `/api/azuracast/playlists` | AzuraCast playlists for station |
| `GET` | `/api/azuracast/playlist/:id/contents` | Folders + tracks in playlist (via DB) |
| `POST` | `/api/auth/login` | `{ username, password }` → sets session (**public**) |
| `POST` | `/api/auth/logout` | Destroy session |
| `POST` | `/api/stream/start` | Start broadcast (primary DJ only) |
| `POST` | `/api/stream/stop` | Stop broadcast (primary DJ only) |
| `POST` | `/api/config/library` | `{ path }` — save music library path |
| `POST` | `/api/config/icecast` | `{ server, port, mount, password }` |
| `POST` | `/api/config/azuracast` | `{ server, port, station_id, api_key }` |
| `POST` | `/api/azuracast/playlist/push` | Push folders/tracks to AzuraCast playlist |
| `POST` | `/api/azuracast/playlist/:id/remove` | Remove folder or tracks from playlist (via DB) |
| `POST` | `/api/mic-delay` | `{ ms }` — set DJ mic delay compensation |

---

## 6. WebSocket Protocol

### `/ws/main` — DJ console

**Binary frames:**
- Starts with `0x46 0x33 0x32 0x00` (`F32\0`) → AudioWorklet mic Float32 frame (4 bytes magic + 960×4 bytes)
- Any other binary → legacy WebM/Opus mic chunk (FFmpeg decoder path)

**JSON messages (client → server):**

| type | payload | action |
|---|---|---|
| `ra:play` | `{ idx }` | Play Player 1 at index |
| `ra:pause` | — | Pause Player 1 |
| `ra:resume` | — | Resume Player 1 |
| `ra:stop` | — | Stop Player 1 |
| `ra:next` | — | Next track Player 1 |
| `ra:seek` | `{ position }` | Seek Player 1 to seconds |
| `rb:*` | same | Player 2 equivalents |
| `console:on` | `{ chId, on }` | Set channel ON/OFF |
| `console:cue` | `{ chId, cue }` | Set channel CUE |
| `console:tb` | `{ chId, tb }` | Set channel TB (momentary) |
| `console:fader` | `{ chId, pos }` | Set fader position 0–100 |
| `console:source` | `{ chId, source }` | Set source A or B |
| `console:monitor` | `{ source, volume }` | Set monitor source/volume |
| `stream:start` | — | Start Icecast broadcast |
| `stream:stop` | — | Stop Icecast broadcast |
| `playlist:add` | `{ path }` | Add track to Player 1 playlist |
| `playlist:insertNext` | `{ path }` | Insert after current track |
| `playlist:remove` | `{ index }` | Remove track at index |
| `playlist:clear` | — | Clear playlist |
| `playlist:toggleStop` | `{ index }` | Toggle stop marker |
| `playlistB:*` | same | Player 2 playlist |

**JSON messages (server → client):**

| type | payload |
|---|---|
| `ra:state` | Full Player 1 state (playing, paused, idx, position, duration, track) |
| `ra:progress` | Position update every 250ms |
| `ra:playlist` | Full playlist list with `trackState` per row |
| `rb:*` | Player 2 equivalents |
| `console:state` | Full console state |
| `vu` | `{ mic0, mic1, mic2, mic3, player1, player2, guest0, guest1 }` RMS values |
| `stream:state` | `{ streaming, uptime }` |

### `/ws/mon` — earphone + signalling

**Binary:** f64le PCM Mix 1 frames (20ms each) → `earphone-worklet.js`

**JSON:** WebRTC signalling (offer/answer/ICE candidates) for mediasoup guest and DJ mic sessions

---

## 7. Configuration (config.ini)

All runtime settings live here. No hard-coded values in any `.js` file.

```ini
[general]
port             = 3100
vps_ip           = 177.136.224.35          # VPS public IP — reference only, not used for connections
public_url       = https://chilledkoala.gatopretoradio.com.br

[security]
session_secret   = <openssl rand -hex 32>  # CHANGE ON FRESH INSTALL
session_timeout  = 28800                   # seconds (8 hours)

[paths]
music_library_path = /mnt/data/azuracast/stations/gato_preto/media/Music
cart_sweeper_path  = .../Music/Cart/Sweeper
cart_bumper_path   = .../Music/Cart/Bumper
cart_trailer_path  = .../Music/Cart/Trailer
sfx_path           = .../Music/SFX

[audio]
crossfade_sec    = 2
bitrate          = 320
mic_delay_ms     = 0     # DJ mic delay compensation (ms); auto-set by browser on connect

[icecast]
server           = 127.0.0.1   # same VPS — always localhost
port             = 80
mount            = /live
listener_mount   = /radio.aac1
password         = <icecast source password>
public_stream_url = https://streams.gatopretoradio.com.br/radio.aac1

[azuracast]
station_id       = 1
docker_container = azuracast
server           = 127.0.0.1   # same VPS — always localhost
port             = 80
api_key          = "your-azuracast-api-key"

[azuracast_dj]
server           = localhost    # same VPS — Liquidsoap DJ port; NEVER use public IP here
port             = 8005
mount            = /

[webrtc]
announced_ip     = 177.136.224.35  # MUST be real public IP for WebRTC NAT traversal
rtp_port_min     = 40000
rtp_port_max     = 40099

[monitor]
source           = pgm1     # pgm1 | cue | offair
volume           = 80

[channels]
ch1_name     = DJ 1 Mic
ch1_type     = remote
ch1_source_a = mic2
ch1_on       = true
ch1_volume   = 80
# ... ch2 through ch8 same pattern
```

> **Important — localhost vs public IP:**  
> All services (Chilled Koala, AzuraCast, Liquidsoap, Icecast) run on the same VPS.  
> Use `localhost`/`127.0.0.1` for every inter-service connection.  
> Only `[webrtc] announced_ip` must use the real public IP (`177.136.224.35`) so WebRTC NAT traversal works for remote guests and DJs.

**Settings editable from the Web UI:**  
Music library path, Icecast mount/password, AzuraCast server/API key — saved back to `config.ini` automatically. No manual editing needed after first setup.

**Build number:**  
Lives in `package.json` (`"build"` field). `server.js` reads it at startup. Confirmed via:
```bash
curl -s http://localhost:3100/api/health | grep build
```

---

## 8. Channel Layout

```
RT 1 — STATION MIX  (DJ earphone + PGM 1)
  CH 1   DJ 1 Mic    type: remote   key: mic2    Remote WebRTC DJ
  CH 2   DJ 2 Mic    type: remote   key: mic3    Remote WebRTC DJ
  CH 3   Player 1    type: player   key: player_1  FLAC files
  CH 4   Player 2    type: player   key: player_2  FLAC files
  CH 5   Guest 1     type: webrtc   key: guest0  /call page
  CH 6   Guest 2     type: webrtc   key: guest1  /call page

RT 2 — BROADCAST MIX  (Mix 1 + local mics → Icecast)
  CH 7   Loc Mic 1   type: mic      key: mic0    DJ PC mic (excluded from Mix 1 — no echo)
  CH 8   Loc Mic 2   type: mic      key: mic1    DJ PC mic (excluded from Mix 1 — no echo)
```

**Mix bus assignment:**  
`MIX1_KEYS` (station mix, earphone): `player1, player2, mic2, mic3, guest0, guest1`  
`MIX2` (broadcast): MIX1 + `mic0` + `mic1`

**VU channel index** (browser `applyRealVULevels`):  
`mic0:0, mic1:1, mic2:2, mic3:3, player1:4, player2:5, guest0:6, guest1:7`

**Guest call link:** https://chilledkoala.gatopretoradio.com.br/call

---

## 9. Access Control

| Role | Capabilities |
|---|---|
| Primary DJ | Full control. Star badge displayed. |
| Secondary DJ | Mic only. All player/stream controls blocked server-side. |
| Guest caller | No login. WebRTC mic. Auto-assigned CH5 or CH6. |

Primary DJ is determined by first login per session. On primary transfer, mixer keys for mic sessions are remapped (`mic0/mic1 ↔ mic2/mic3`).

---

## 10. DJ PC Microphone Setup

**Hardware:** Earphone + mic headset with TRRS splitter  
- Pink plug → PINK rear-panel jack (mic in)  
- Green plug → GREEN rear-panel jack (headphone out)

**Realtek HD Audio Manager → Microphone → Levels:**  
`Microphone: 100` · `Microphone Boost: +20.0 dB`

**Realtek HD Audio Manager → Microphone Effects:**  
`Noise Suppression: OFF` · `Acoustic Echo Cancellation: OFF`

**Windows Sound → Recording → Microphone → Enhancements:**  
`Disable all sound effects: checked`

**Chrome:** Lock icon → Microphone → Allow → hard-refresh (Ctrl+Shift+R)

**Target RMS:** `mic0 = 0.04–0.10` while speaking (comparable to `player1 = 0.02–0.06`)

---

## 11. Streamer Accounts

Add via AzuraCast → My Station → Streamers/DJs → Add Streamer

Verify on VPS:
```bash
docker exec azuracast curl -s -X POST \
  http://127.0.0.1/api/internal/1/liquidsoap/auth \
  -H "Content-Type: application/json" \
  -d '{"user":"USERNAME","password":"PASSWORD"}'
# true = OK   (empty) = not found
```

Auth chain: `docker exec (port 6010) → AzuraCast public API → SFTP port 2022`  
Lockout: 5 failed attempts → 60 s cooldown per username

---

## 12. Diagnostics

### Mic diagnostic

```bash
# Settings tab → Run Mic Diagnostic  OR:
curl http://localhost:3100/api/diag/mic
```

| Result | Meaning |
|---|---|
| `buf=0`, no sessions | Browser mic permission not granted |
| `buf=0`, sessions exist | Check PM2 logs for errors |
| `buf>0`, gain=0 | Channel OFF or fader at bottom |
| `buf>0`, gain>0, rms=0 | Mic too quiet — raise PC mic volume |
| `buf>0`, gain>0, rms>0 | **WORKING OK** |

**Chrome DevTools RMS check** (F12 Console, speak while running):
```javascript
const _o = applyRealVULevels; let _n = 0;
window.applyRealVULevels = function(l) {
  if (_n++ < 8) console.log('mic0=' + l.mic0?.toFixed(5) + '  p1=' + l.player1?.toFixed(5));
  else window.applyRealVULevels = _o; _o(l);
};
```

### Liquidsoap 30-second silence fallback (PENDING)

When live stream is silent for 30 s, revert to AzuraCast automation playlist:

AzuraCast → Broadcasting → Edit Liquidsoap Configuration  
Find:
```
live.on_disconnect(synchronous=false, azuracast.live_disconnected)
```
Add immediately after:
```
live = blank.strip(id="live_blank_strip", max_blank=30., min_noise=0., threshold=-50., live)
```
Then: AzuraCast → Restart Broadcasting

---

## 13. Network & Firewall

### VPS Identity

| Parameter | Value |
|---|---|
| **Public IP** | `177.136.224.35` |
| **VPN internal IP** | `10.11.102.20` |
| **Domain** | `gatopretoradio.com.br` |
| **Chilled Koala URL** | `https://chilledkoala.gatopretoradio.com.br` |
| **Streams URL** | `https://streams.gatopretoradio.com.br/radio.aac1` |

All services — Chilled Koala (Node.js), AzuraCast, Liquidsoap, and Icecast — run on the **same VPS**. All inter-service connections use `localhost` or `127.0.0.1`; the public IP is never used for internal traffic.

### Public ports (open to the internet via 177.136.224.35)

| Protocol | Port | Service |
|---|---|---|
| TCP | 80 | HTTP (redirects to HTTPS) |
| TCP | 443 | HTTPS — Chilled Koala web app + AzuraCast + Icecast streams |

All other ports are **closed** to the public internet.

### Engineering access (VPN required)

Engineers connect to the VPS via **VPN** first, then use the internal IP `10.11.102.20`. This exposes all internal ports without touching the public firewall:

| Protocol | Port | Service |
|---|---|---|
| TCP | 3100 | Chilled Koala Node.js app (direct, no reverse proxy) |
| TCP | 8005 | Liquidsoap DJ source input (AzuraCast) |
| TCP | 22 | SSH |
| TCP | 2022 | AzuraCast SFTP |
| TCP | 6010 | AzuraCast internal API (docker) |
| UDP | 40000–40099 | mediasoup WebRTC RTP (guests + remote DJ) |

### VPN connection

Connect to VPN → then SSH / access services via internal IP:

```bash
# SSH (after VPN connected)
ssh root@10.11.102.20

# WinSCP saved session (via VPN internal IP)
open root@www.gatopretoradio.com.br   # resolves to 10.11.102.20 via VPN

# Verify Chilled Koala build (from inside VPN or VPS)
curl -s http://10.11.102.20:3100/api/health | grep build

# Restart Liquidsoap if DJ source hangs
docker exec azuracast supervisorctl restart station_1:station_1_backend
```

---

## 14. Pending

1. Liquidsoap `blank.strip` 30 s silence fallback — one line (see §12)
2. GO LIVE full broadcast test — voice + music verified on iOS app
3. stephanroberto AzuraCast account — password reset needed
4. Secondary DJ mic CH1/CH2 — full end-to-end test
5. Mobile earphone testing
6. Academic paper — replace `[repository URL]` before submission

---

## 15. Build History

| Build | Fix / Feature |
|---|---|
| 302–303 | djMicSessions excluded → mic0 gain always 0 |
| 306 | Browser cache stale → build number injected into asset URLs |
| 316–327 | WebRTC DJ mic → AudioWorklet path |
| 331 | PGM2 > PGM1 when mics OFF |
| 344 | `/32768` in Float64 output → mix2=0 |
| 345 | Float64 pipeline end-to-end |
| 350 | Earphone broken after Float64 upgrade |
| 350 | Monitor encoder crash f64le → `-sample_fmt flt` added |
| 350 | mic0 buffer 1 MB backlog → flush on assignMic() |
| 351 | PGM2 > PGM1 background noise → use `_mix2rms` from server |
| 352 | ON button missing `updateConsoleUI()` → strip not going green |
| 354 | `_vuChSegs[0]` stomped by `buildMonitorStrip()` → CH7 bar always dark |
| 355 | VU scale ×200 PCM16 era → corrected to ×8 Float64 |
| 356 | IP-12 VU: CUE=pre-fader, ON=post-fader × faderGain |
| 356 | Peak-hold 300 ms + multiplicative decay added |
| 357 | Monitor encoder missing EPIPE handlers → 6 736 restarts fixed |
| 357 | `writableNeedDrain` guard on monitor encoder write |
| 357 | `unhandledRejection` exits → PM2 restarts cleanly |
| 358 | Smart caching: versioned assets 1 hr, static libs 24 hr |
| 359 | Hard-coded paths removed — all settings from config.ini only |
| 359 | Build number → `package.json` `"build"` field, read at startup |
| 360 | `ch_on` + fader loaded from config.ini at startup |
| 360 | `persistAllFaders()` also saves `ch_on` state |
| 361 | Parallel metadata scan concurrency=8 (~8× faster) |
| 361 | Two-phase scan: directory walk first, then parallel `parseFile()` |
| 361 | Scan poll `AbortController` 8 s timeout — UI never freezes |
| 362–374 | WebRTC guest + DJ mic improvements; VU metering fixes |
| 375 | AzuraCast playlist push via M3U import |
| 376 | Folders use `apply-to` (persistent dynamic link); tracks use M3U |
| 377 | AzuraCast playlist contents viewer + folder removal |
| 378 | Playlist folder management via direct DB (view/add/delete) |
| 379 | GitHub Actions deploy workflow; deploy.ps1 → git push |
| 379 | Low-latency MON (adaptive jitter buffer 80–400 ms, Jacktrip-style) |
| 379 | Sidetone: Loc Mic 1/2 → earphone at 0 ms (no server round-trip) |
| 379 | MON Mic toggle button (amber when active) |
| 380 | Sidetone gated by Loc Mic ON/OFF state (was always audible) |
| 380 | SCHED_AHEAD 80 ms → 300 ms (fixes audio gaps on tab-switch/rAF throttle) |
| 380 | Adaptive jitter buffer replaces fixed 700 ms pre-buffer |
| 380 | Packet Loss Concealment (PLC) — 50 %→0 % fade on dropout instead of hard silence |
| 381 | Sidetone gain: fader-proportional → binary ON/OFF (fader=0 was silencing sidetone) |
| 381 | CUE flags: use activeSource (A or B) not always sourceA |
| 381 | MON volume: apply server monitorVolume on WS init (was stuck at 0.80 default) |
| 382 | CUE bus silent when channel OFF: `gain===0 continue` skipped CUE accumulation |
| 382 | Player 2 active track highlight lost after playlist re-render fixed |
| 382 | deploy.ps1 added to git; WinSCP full path set |

---

## 16. Academic Paper

**Title:** "Chilled Koala, Stream Ecosystem"  
**Author:** Trajano Roberto — UNIFEI Brazil + Monash University Melbourne  
**Target:** IEEE Transactions on Broadcasting or JAES  
**File:** `chilled_koala_academic_paper.docx`  
**Status:** Ready — replace `[repository URL]` before submission  
**Repository:** https://github.com/trajanoroberto-hub/ChilledKoala

---

## 17. Licence

MIT License — Copyright © 2026 Trajano Roberto

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions: The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED.
