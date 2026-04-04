/**
 * Chilled Koala v2.0.0 — Music Library
 * Scans music_library_path, extracts FLAC metadata, persists to cache file.
 * On startup: loads from cache (instant). After upgrade or music changes:
 * operator runs "Rescan & Rebuild Cache" from Settings.
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

const fs   = require('fs');
const path = require('path');
const { Worker } = require('worker_threads');
const { parseFile } = require('music-metadata');

// Cache schema version — bump this with every release that changes the
// metadata fields stored per track. On startup, if the cache was written
// by a different schema version it is rejected and a rescan is required.
// This enforces the policy: cache is always rebuilt after an upgrade.
const CACHE_SCHEMA = '2.0.0';

class MusicLibrary {
    constructor(config) {
        this.config   = config;
        this.index    = [];
        this.indexed  = false;
        this.indexing = false;
        this._sortedCache = {};
        this.cart     = { sweeper: [], bumper: [], trailer: [], sfx: [] };
        // Cache file: serialised metadata for all FLAC files.
        // Survives pm2 restarts. Invalidated by schema version mismatch or path change.
        this._cacheFile = path.join(__dirname, '.library-cache.json');
    }

    get musicPath() {
        return this.config.paths.music_library_path || '';
    }

    // ── Cache load (startup — instant, no filesystem scan) ────────────────────
    // Reads .library-cache.json into memory.
    // Rejects cache if:
    //   - File absent (first run, or cache manually deleted)
    //   - schemaVersion !== CACHE_SCHEMA (upgrade deployed new metadata fields)
    //   - musicPath mismatch (library path changed in config.ini)
    // In all rejection cases: library shows empty, operator runs Rescan from Settings.

    loadCache() {
        try {
            if (!fs.existsSync(this._cacheFile)) {
                console.log('📚 No library cache found — run Rescan & Rebuild Cache from Settings');
                return false;
            }
            const raw  = fs.readFileSync(this._cacheFile, 'utf8');
            const data = JSON.parse(raw);

            if (data.schemaVersion !== CACHE_SCHEMA) {
                console.log(`📚 Cache schema ${data.schemaVersion} → current ${CACHE_SCHEMA} — rescan required after upgrade`);
                return false;
            }
            if (data.musicPath !== this.musicPath) {
                console.log(`📚 Cache path mismatch — rescan required (config path changed)`);
                return false;
            }

            // Deduplicate: first by real path (symlinks/hardlinks), then by metadata
            // fingerprint (actual file copies with identical content/tags).
            const entries  = data.index || [];
            const seenReal = new Set();
            const seenFp   = new Set();
            this.index = entries.filter(t => {
                if (!t.path) return false;
                let real = t.path;
                try { real = fs.realpathSync(t.path); } catch (_) {}
                if (seenReal.has(real)) return false;
                seenReal.add(real);
                const fp = this._fingerprint(t);
                if (seenFp.has(fp)) return false;
                seenFp.add(fp);
                return true;
            });
            this.indexed = true;
            this._sortedCache = {};
            const dupes = entries.length - this.index.length;
            if (dupes > 0) console.warn(`⚠ Library cache: removed ${dupes} duplicate track(s) on load`);
            console.log(`✓ Library cache loaded: ${this.index.length} tracks (schema ${CACHE_SCHEMA})`);
            return true;
        } catch (err) {
            console.warn('⚠ Could not load library cache:', err.message);
            return false;
        }
    }

    // ── Cache save (after rescan completes) ───────────────────────────────────
    _saveCache() {
        try {
            const data = JSON.stringify({
                schemaVersion: CACHE_SCHEMA,
                musicPath:     this.musicPath,
                builtAt:       new Date().toISOString(),
                trackCount:    this.index.length,
                index:         this.index,
            });
            fs.writeFileSync(this._cacheFile, data, 'utf8');
            console.log(`✓ Library cache saved: ${this.index.length} tracks (schema ${CACHE_SCHEMA})`);
        } catch (err) {
            console.warn('⚠ Could not save library cache:', err.message);
        }
    }

    // ── Rescan & Rebuild Cache ────────────────────────────────────────────────
    // Triggered by POST /api/library/reindex — never called automatically.
    // onProgress(scanned) called on first track, then every 100 tracks.
    // Returns false immediately if a scan is already running.

    async rescan(onProgress) {
        if (this.indexing) {
            console.warn('📚 Rescan skipped — scan already in progress');
            return false;
        }
        this.indexing = true;
        this.indexed  = false;
        const p = this.musicPath;
        console.log(`📚 Rescan started: ${p}`);
        try {
            if (!fs.existsSync(p)) {
                console.warn(`⚠ Music library path not found: ${p}`);
                this.index   = [];
                this.indexed = true;
                return true;
            }
            const results = [];
            await this._walkDir(p, results, onProgress);
            // Deduplicate by metadata fingerprint — catches actual file copies
            const seenFp = new Set();
            this.index = results.filter(t => {
                const fp = this._fingerprint(t);
                if (seenFp.has(fp)) return false;
                seenFp.add(fp);
                return true;
            });
            const dupes = results.length - this.index.length;
            if (dupes > 0) console.warn(`⚠ Rescan: removed ${dupes} duplicate track(s)`);
            this.indexed = true;
            this._sortedCache = {};
            this._saveCache();
            console.log(`✓ Rescan complete: ${this.index.length} tracks from ${p}`);
            return true;
        } catch (err) {
            console.error('✗ Rescan error:', err.message);
            this.indexed = true;
            throw err;   // propagate so SCAN_JOBS gets status:'error'
        } finally {
            this.indexing = false;
        }
    }

    async buildIndex() { return this.rescan(); }

    // ── Rescan in worker_threads ───────────────────────────────────────────────
    // Same contract as rescan() but runs the directory walk + metadata extraction
    // entirely in a worker thread so the main-thread mixer tick is never blocked.
    // Drop-in replacement: callers swap library.rescan() → library.rescanInWorker().

    rescanInWorker(onProgress) {
        if (this.indexing) {
            console.warn('📚 Rescan skipped — scan already in progress');
            return Promise.resolve(false);
        }
        this.indexing = true;
        this.indexed  = false;
        const p = this.musicPath;
        console.log(`📚 Rescan (worker) started: ${p}`);

        return new Promise((resolve, reject) => {
            const workerPath = path.join(__dirname, 'library-worker.js');
            const worker = new Worker(workerPath, { workerData: { musicPath: p } });

            worker.on('message', (msg) => {
                if (msg.type === 'progress') {
                    if (onProgress) onProgress(msg.scanned);
                } else if (msg.type === 'result') {
                    // Deduplicate (worker already deduped by fingerprint; re-check real paths here)
                    const entries  = msg.index || [];
                    const seenReal = new Set();
                    const seenFp   = new Set();
                    this.index = entries.filter(t => {
                        if (!t.path) return false;
                        let real = t.path;
                        try { real = fs.realpathSync(t.path); } catch (_) {}
                        if (seenReal.has(real)) return false;
                        seenReal.add(real);
                        const fp = this._fingerprint(t);
                        if (seenFp.has(fp)) return false;
                        seenFp.add(fp);
                        return true;
                    });
                    const dupes = entries.length - this.index.length;
                    if (dupes > 0) console.warn(`⚠ Rescan: removed ${dupes} additional duplicate(s) on main thread`);
                    this.indexed = true;
                    this._sortedCache = {};
                    this._saveCache();
                    console.log(`✓ Rescan (worker) complete: ${this.index.length} tracks from ${p}`);
                    this.indexing = false;
                    resolve(true);
                } else if (msg.type === 'error') {
                    console.error('✗ Rescan (worker) error:', msg.error);
                    this.indexed  = true;
                    this.indexing = false;
                    reject(new Error(msg.error));
                }
            });

            worker.on('error', (err) => {
                console.error('✗ Rescan worker crashed:', err.message);
                this.indexed  = true;
                this.indexing = false;
                reject(err);
            });

            worker.on('exit', (code) => {
                if (code !== 0 && this.indexing) {
                    // Worker exited without sending result/error
                    this.indexing = false;
                    reject(new Error(`library-worker exited with code ${code}`));
                }
            });
        });
    }

    // ── Two-phase scan: collect all FLAC paths, then read metadata in parallel ─
    // Phase 1: fast directory walk collects every .flac path (no I/O per file).
    // Phase 2: parallel parseFile() with concurrency=8 — ~8x faster than serial.
    // onProgress fired immediately on start, then every 50 tracks.

    // Unique fingerprint for a track based on content, not file path.
    // Used to deduplicate file copies (same song stored in two locations).
    // trackid is authoritative when set; otherwise fall back to artist+title+album+duration.
    _fingerprint(t) {
        if (t.trackid) return `id:${t.trackid}`;
        const dur = Math.round(t.duration || 0);
        return `${(t.artist || '').toLowerCase()}|${(t.title || '').toLowerCase()}|${(t.album || '').toLowerCase()}|${dur}`;
    }

    async _collectPaths(dir, paths, seenFiles, visitedDirs) {
        // Resolve dir to real path so symlinked directories aren't walked twice.
        // e.g. /music/ByArtist/Georgia Scarlet → /music/Albums/X both resolve to the same real dir.
        let realDir;
        try { realDir = await fs.promises.realpath(dir); } catch (_) { realDir = dir; }
        if (visitedDirs.has(realDir)) return;
        visitedDirs.add(realDir);

        let entries;
        try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); }
        catch (_) { return; }
        for (const e of entries) {
            if (e.name.startsWith('.')) continue;
            const full = path.join(dir, e.name);
            if (e.isDirectory() || e.isSymbolicLink()) {
                // Follow symlinks to directories too (stat follows the link)
                let stat;
                try { stat = await fs.promises.stat(full); } catch (_) { continue; }
                if (!stat.isDirectory()) continue;
                const low = e.name.toLowerCase();
                if (low === 'cart' || low === 'sfx') continue;
                await this._collectPaths(full, paths, seenFiles, visitedDirs);
            } else if (e.isFile() && path.extname(e.name).toLowerCase() === '.flac') {
                // Resolve real path so hardlinks and file-symlinks map to one entry
                let realFile;
                try { realFile = await fs.promises.realpath(full); } catch (_) { realFile = full; }
                if (!seenFiles.has(realFile)) {
                    seenFiles.add(realFile);
                    paths.push(full);
                }
            }
        }
    }

    async _walkDir(dir, results, onProgress) {
        // Phase 1: collect all FLAC paths (fast — no metadata I/O)
        const paths = [];
        await this._collectPaths(dir, paths, new Set(), new Set());
        if (onProgress) onProgress(0);   // signal alive immediately after directory walk

        // Phase 2: read metadata in parallel, concurrency=8
        // Workers share a single idx counter — each grabs the next unclaimed path.
        const CONCURRENCY = 8;
        let idx = 0;
        const worker = async () => {
            while (idx < paths.length) {
                const filePath = paths[idx++];
                const meta = await this._readMeta(filePath);
                if (meta) {
                    results.push(meta);
                    if (onProgress && (results.length === 1 || results.length % 50 === 0)) {
                        onProgress(results.length);
                    }
                }
            }
        };
        await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    }

    async _readMeta(filePath) {
        try {
            const { common: t, format: f } = await parseFile(filePath, {
                duration:    true,
                skipCovers:  true,
                includeChapters: false
            });

            // Extract GATOPRETO custom tags from comments
            const comments = t.comment || [];
            const getTag   = (prefix) =>
                (comments.find(c => String(c).startsWith(prefix + '=')) || '')
                    .split('=').slice(1).join('=') || '';

            return {
                path:         filePath,
                filename:     path.basename(filePath, path.extname(filePath)),
                title:        t.title        || path.basename(filePath, '.flac'),
                artist:       t.artist       || '',
                album:        t.album        || '',
                albumartist:  t.albumartist  || '',
                tracknumber:  t.track?.no    || null,
                tracktotal:   t.track?.of    || null,
                discnumber:   t.disk?.no     || null,
                disctotal:    t.disk?.of     || null,
                date:         t.date         || String(t.year || ''),
                originaldate: t.originaldate || '',
                genre:        (t.genre || []).join(', '),
                duration:     f.duration    || 0,
                lufs:         getTag('GATOPRETO_LUFS'),
                status:       getTag('GATOPRETO_STATUS'),
                albumid:      getTag('GATOPRETO_ALBUMID'),
                trackid:      getTag('GATOPRETO_TRACKID'),
                artistid:     getTag('GATOPRETO_ARTISTID'),
            };
        } catch (_) {
            return null;
        }
    }

    // ── Cart ──────────────────────────────────────────────────────────────────

    async loadCart() {
        const map = {
            sweeper: this.config.paths.cart_sweeper_path,
            bumper:  this.config.paths.cart_bumper_path,
            trailer: this.config.paths.cart_trailer_path,
            sfx:     this.config.paths.sfx_path,
        };
        for (const [key, dir] of Object.entries(map)) {
            this.cart[key] = dir ? this._listAudioFiles(dir, key) : [];
        }
        const total = Object.values(this.cart).reduce((s, a) => s + a.length, 0);
        console.log(`✓ Cart loaded: ${total} items`);
    }

    _listAudioFiles(dir, type) {
        try {
            return fs.readdirSync(dir)
                .filter(f => ['.flac', '.mp3', '.wav', '.ogg'].includes(
                    path.extname(f).toLowerCase()
                ))
                .map((f, i) => ({
                    id:   `${type}_${i}`,
                    name: path.basename(f, path.extname(f)),
                    path: path.join(dir, f),
                    type,
                }));
        } catch (_) { return []; }
    }

    // ── Search ────────────────────────────────────────────────────────────────
    // Multi-word AND search: all terms must match at least one searched field.
    // field: 'title'|'artist'|'album'|'albumartist'|'genre'|'date'|'originaldate'|'all'
    // Returns up to 500 results; empty query returns 200 sorted by artist+title.

    search(query, field = 'title') {
        const terms = String(query || '').toLowerCase().trim().split(/\s+/).filter(Boolean);

        if (!terms.length) {
            // Empty query → return first 200 from sorted cache (artist+title order)
            return this._sortedIndex('artist').slice(0, 200);
        }

        const FIELDS_ALL = ['title', 'artist', 'album', 'albumartist', 'genre', 'date', 'originaldate'];
        const fields = field === 'all' ? FIELDS_ALL : [field];

        // Search against field-appropriate sorted index so results are alphabetically
        // ordered by the field the user is searching — artist search → A…Z by artist,
        // title search → A…Z by title, etc.
        const source  = this._sortedIndex(field === 'all' ? 'artist' : field);
        const results = [];
        for (const t of source) {
            if (terms.every(term => fields.some(f => String(t[f] || '').toLowerCase().includes(term)))) {
                results.push(t);
                if (results.length >= 500) break;
            }
        }
        return results;
    }

    // Cached sorted index keyed by primary sort field.
    // Sorts by the requested field first, then title as tiebreaker.
    _sortedIndex(primaryField = 'artist') {
        if (!this._sortedCache) this._sortedCache = {};
        const cached = this._sortedCache[primaryField];
        if (cached && cached.length === this.index.length) return cached;

        const sorted = this.index.slice().sort((a, b) => {
            const av = String(a[primaryField] || '').toLowerCase();
            const bv = String(b[primaryField] || '').toLowerCase();
            const cmp = av.localeCompare(bv);
            if (cmp !== 0) return cmp;
            // Tiebreaker: always sort by title then artist
            const tc = String(a.title || '').toLowerCase().localeCompare(String(b.title || '').toLowerCase());
            if (tc !== 0) return tc;
            return String(a.artist || '').toLowerCase().localeCompare(String(b.artist || '').toLowerCase());
        });
        this._sortedCache[primaryField] = sorted;
        return sorted;
    }

    getTrack(filePath) {
        if (!filePath) return null;
        return this.index.find(t => t.path === filePath) || null;
    }

    // Validate a file path is within allowed library or cart directories (prevent traversal)
    isPathAllowed(filePath) {
        if (!filePath) return false;
        const real = path.resolve(filePath);
        if (real.startsWith(path.resolve(this.musicPath))) return true;
        const cartPaths = [
            this.config.paths.cart_sweeper_path,
            this.config.paths.cart_bumper_path,
            this.config.paths.cart_trailer_path,
            this.config.paths.sfx_path,
        ].filter(Boolean);
        return cartPaths.some(p => real.startsWith(path.resolve(p)));
    }

    setMusicPath(p) {
        this.config.paths.music_library_path = p;
        this.indexed = false;
        this._sortedCache = {};
        // Remove stale cache — old path's index is invalid for new path
        try { fs.unlinkSync(this._cacheFile); } catch (_) {}
    }

    getIndex()  { return this.index; }
    getCart()   { return this.cart; }
    isReady()   { return this.indexed; }
    isIndexing(){ return this.indexing; }

    // ── Tree builder ──────────────────────────────────────────────────────────
    // Derives a Genre → SubGenre → Artist → Album → Tracks hierarchy from file
    // paths relative to music_library_path.
    // Path structure (as observed in Gato Preto library):
    //   <musicPath>/<MainGenre>/<SubGenre?>/<Artist>/<Album>/<track.flac>
    //   OR  <musicPath>/<MainGenre>/<Artist>/<Album>/<track.flac>  (no sub-genre)
    //
    // Returns: Array of genre nodes, each:
    //   { name, path, children: [ subGenre|artist node, ... ] }
    // Terminal track nodes:
    //   { name, path, isTrack:true, duration, artist, title, album }
    getTree() {
        if (!this.indexed || this.index.length === 0) return [];

        const base = path.resolve(this.musicPath);
        // tree: Map<genreName, Map<subOrArtist, Map<artistOrAlbum, Map<albumOrTrack, ...>>>>
        // We build a plain nested object for easy JSON serialisation.
        const root = {};   // genre → { _path, children: {} }

        for (const track of this.index) {
            const rel = path.relative(base, track.path);   // e.g. Rock/Hard Rock/Artist/Album/01.flac
            const parts = rel.split(path.sep);
            // parts[0]=genre, parts[1..n-1]=hierarchy, parts[n-1]=filename
            if (parts.length < 2) continue;

            const genre = parts[0];
            const filename = parts[parts.length - 1];
            const middle = parts.slice(1, parts.length - 1);  // everything between genre and filename

            // Build genre node
            if (!root[genre]) root[genre] = { _path: path.join(base, genre), children: {} };
            let node = root[genre].children;
            let curPath = path.join(base, genre);

            // Walk middle segments (subGenre / Artist / Album)
            for (const seg of middle) {
                curPath = path.join(curPath, seg);
                if (!node[seg]) node[seg] = { _path: curPath, children: {} };
                node = node[seg].children;
            }

            // Leaf: track file
            node[filename] = {
                _path:    track.path,
                _isTrack: true,
                _track:   {
                    title:    track.title,
                    artist:   track.artist,
                    album:    track.album,
                    duration: track.duration,
                },
            };
        }

        // Serialise to array structure
        function nodeToArr(obj, depth) {
            return Object.keys(obj).sort((a, b) => {
                // Tracks always last within their parent
                const aT = !!obj[a]._isTrack, bT = !!obj[b]._isTrack;
                if (aT !== bT) return aT ? 1 : -1;
                return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
            }).map(name => {
                const n = obj[name];
                if (n._isTrack) {
                    return { name, path: n._path, isTrack: true, ...n._track };
                }
                return { name, path: n._path, children: nodeToArr(n.children, depth + 1) };
            });
        }

        return Object.keys(root).sort((a, b) => a.localeCompare(b)).map(genre => ({
            name: genre,
            path: root[genre]._path,
            children: nodeToArr(root[genre].children, 1),
        }));
    }
}

module.exports = MusicLibrary;
