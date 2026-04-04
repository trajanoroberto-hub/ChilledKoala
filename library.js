/**
 * Chilled Koala v2.0.0 — Music Library (SQLite backend)
 * Scans music_library_path, extracts FLAC metadata, persists to SQLite DB.
 * On startup: validates schema + path in DB meta table (instant).
 * After upgrade or music changes: operator runs "Rescan & Rebuild Cache".
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

// Cache schema version — bump this with every release that changes stored metadata fields.
// On startup, schema mismatch rejects the DB and forces a rescan.
const CACHE_SCHEMA = '2.0.0';

class MusicLibrary {
    constructor(config) {
        this.config   = config;
        this.indexed  = false;
        this.indexing = false;
        this.cart     = { sweeper: [], bumper: [], trailer: [], sfx: [] };
        this._db      = null;
        this._dbFile  = path.join(__dirname, '.library.db');
        // Legacy JSON cache — removed on first run if present
        this._legacyCacheFile = path.join(__dirname, '.library-cache.json');
    }

    get musicPath() {
        return this.config.paths.music_library_path || '';
    }

    // ── Database bootstrap ─────────────────────────────────────────────────────
    // Opens .library.db (WAL mode for concurrent reads during a rescan),
    // creates schema on first run.  Called lazily — never fails silently.

    _openDB() {
        if (this._db) return this._db;
        const Database = require('better-sqlite3');
        this._db = new Database(this._dbFile);
        this._db.pragma('journal_mode = WAL');
        this._db.pragma('synchronous = NORMAL');
        this._db.exec(`
            CREATE TABLE IF NOT EXISTS meta (
                key   TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS tracks (
                path         TEXT UNIQUE NOT NULL,
                filename     TEXT,
                title        TEXT,
                artist       TEXT,
                album        TEXT,
                albumartist  TEXT,
                tracknumber  INTEGER,
                tracktotal   INTEGER,
                discnumber   INTEGER,
                disctotal    INTEGER,
                date         TEXT,
                originaldate TEXT,
                genre        TEXT,
                duration     REAL,
                lufs         TEXT,
                status       TEXT,
                albumid      TEXT,
                trackid      TEXT,
                artistid     TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_title       ON tracks (title       COLLATE NOCASE);
            CREATE INDEX IF NOT EXISTS idx_artist      ON tracks (artist      COLLATE NOCASE);
            CREATE INDEX IF NOT EXISTS idx_album       ON tracks (album       COLLATE NOCASE);
            CREATE INDEX IF NOT EXISTS idx_albumartist ON tracks (albumartist COLLATE NOCASE);
            CREATE INDEX IF NOT EXISTS idx_genre       ON tracks (genre       COLLATE NOCASE);
            CREATE INDEX IF NOT EXISTS idx_date        ON tracks (date);
            CREATE INDEX IF NOT EXISTS idx_trackid     ON tracks (trackid);
        `);
        return this._db;
    }

    _getMeta(key)       { return this._openDB().prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value ?? null; }
    _setMeta(key, val)  { this._openDB().prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(key, String(val)); }

    // ── Cache load (startup — instant) ────────────────────────────────────────
    // Validates schema version and musicPath in the meta table.
    // On mismatch: library shows empty, operator runs Rescan from Settings.

    loadCache() {
        try {
            // One-time migration: remove legacy JSON cache if still present
            if (fs.existsSync(this._legacyCacheFile)) {
                try { fs.unlinkSync(this._legacyCacheFile); } catch (_) {}
                console.log('📚 Removed legacy JSON cache (migrated to SQLite)');
            }

            const schema = this._getMeta('schema');
            const mPath  = this._getMeta('musicPath');

            if (schema !== CACHE_SCHEMA) {
                console.log(`📚 DB schema ${schema || 'none'} → current ${CACHE_SCHEMA} — rescan required`);
                return false;
            }
            if (mPath !== this.musicPath) {
                console.log(`📚 DB path mismatch — rescan required (config path changed)`);
                return false;
            }

            const count = this._openDB().prepare('SELECT COUNT(*) AS n FROM tracks').get().n;
            this.indexed = true;
            console.log(`✓ Library DB loaded: ${count} tracks (schema ${CACHE_SCHEMA})`);
            return true;
        } catch (err) {
            console.warn('⚠ Could not load library DB:', err.message);
            return false;
        }
    }

    // ── Write meta after a scan ───────────────────────────────────────────────
    _saveCache() {
        const count = this._openDB().prepare('SELECT COUNT(*) AS n FROM tracks').get().n;
        this._openDB().transaction(() => {
            this._setMeta('schema',    CACHE_SCHEMA);
            this._setMeta('musicPath', this.musicPath);
            this._setMeta('builtAt',   new Date().toISOString());
            this._setMeta('count',     String(count));
        })();
        console.log(`✓ Library DB saved: ${count} tracks (schema ${CACHE_SCHEMA})`);
    }

    // ── Bulk insert — replaces entire tracks table in one transaction ─────────
    _bulkInsert(tracks) {
        const db     = this._openDB();
        const insert = db.prepare(`
            INSERT OR IGNORE INTO tracks
                (path, filename, title, artist, album, albumartist,
                 tracknumber, tracktotal, discnumber, disctotal,
                 date, originaldate, genre, duration,
                 lufs, status, albumid, trackid, artistid)
            VALUES
                (@path, @filename, @title, @artist, @album, @albumartist,
                 @tracknumber, @tracktotal, @discnumber, @disctotal,
                 @date, @originaldate, @genre, @duration,
                 @lufs, @status, @albumid, @trackid, @artistid)
        `);
        db.transaction(() => {
            db.prepare('DELETE FROM tracks').run();
            for (const t of tracks) insert.run(t);
        })();
    }

    // ── Rescan & Rebuild (main-thread fallback) ────────────────────────────────
    // Triggered directly when worker_threads is unavailable.
    // Normally callers use rescanInWorker() to avoid main-thread blocking.

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
                this._bulkInsert([]);
                this._saveCache();
                this.indexed = true;
                return true;
            }
            const results = [];
            await this._walkDir(p, results, onProgress);
            const seenFp = new Set();
            const deduped = results.filter(t => {
                const fp = this._fingerprint(t);
                if (seenFp.has(fp)) return false;
                seenFp.add(fp);
                return true;
            });
            const dupes = results.length - deduped.length;
            if (dupes > 0) console.warn(`⚠ Rescan: removed ${dupes} duplicate track(s)`);
            this._bulkInsert(deduped);
            this._saveCache();
            this.indexed = true;
            console.log(`✓ Rescan complete: ${deduped.length} tracks from ${p}`);
            return true;
        } catch (err) {
            console.error('✗ Rescan error:', err.message);
            this.indexed = true;
            throw err;
        } finally {
            this.indexing = false;
        }
    }

    async buildIndex() { return this.rescan(); }

    // ── Rescan in worker_threads ───────────────────────────────────────────────
    // Runs directory walk + metadata extraction entirely off the main thread.
    // Results arrive as a flat array; main thread deduplicates and bulk-inserts.

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
                    const entries  = msg.index || [];
                    // Second-pass dedup: real-path resolution (symlinks/hardlinks)
                    const seenReal = new Set();
                    const seenFp   = new Set();
                    const deduped  = entries.filter(t => {
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
                    const dupes = entries.length - deduped.length;
                    if (dupes > 0) console.warn(`⚠ Rescan: removed ${dupes} additional duplicate(s)`);
                    this._bulkInsert(deduped);
                    this._saveCache();
                    this.indexed  = true;
                    this.indexing = false;
                    const count = this._openDB().prepare('SELECT COUNT(*) AS n FROM tracks').get().n;
                    console.log(`✓ Rescan (worker) complete: ${count} tracks from ${p}`);
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
                    this.indexing = false;
                    reject(new Error(`library-worker exited with code ${code}`));
                }
            });
        });
    }

    // ── Directory walk + metadata (used by rescan() fallback) ─────────────────

    _fingerprint(t) {
        if (t.trackid) return `id:${t.trackid}`;
        const dur = Math.round(t.duration || 0);
        return `${(t.artist||'').toLowerCase()}|${(t.title||'').toLowerCase()}|${(t.album||'').toLowerCase()}|${dur}`;
    }

    async _collectPaths(dir, paths, seenFiles, visitedDirs) {
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
                let stat;
                try { stat = await fs.promises.stat(full); } catch (_) { continue; }
                if (!stat.isDirectory()) continue;
                const low = e.name.toLowerCase();
                if (low === 'cart' || low === 'sfx') continue;
                await this._collectPaths(full, paths, seenFiles, visitedDirs);
            } else if (e.isFile() && path.extname(e.name).toLowerCase() === '.flac') {
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
        const paths = [];
        await this._collectPaths(dir, paths, new Set(), new Set());
        if (onProgress) onProgress(0);

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
                duration: true, skipCovers: true, includeChapters: false
            });
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
        } catch (_) { return null; }
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
    // Multi-word AND search via SQL LIKE — all terms must match at least one
    // searched field.  Results ordered by primary sort field then title.
    // Empty query returns 200 tracks ordered by artist+title.

    search(query, field = 'title') {
        const db    = this._openDB();
        const terms = String(query || '').toLowerCase().trim().split(/\s+/).filter(Boolean);

        if (!terms.length) {
            return db.prepare(`
                SELECT * FROM tracks
                ORDER BY artist COLLATE NOCASE, title COLLATE NOCASE
                LIMIT 200
            `).all();
        }

        const FIELDS_ALL = ['title', 'artist', 'album', 'albumartist', 'genre', 'date', 'originaldate'];
        const fields     = field === 'all' ? FIELDS_ALL : [field];
        const sortField  = field === 'all' ? 'artist' : field;

        // Each term must match at least one field (OR within term, AND across terms).
        // Escape LIKE wildcards in the term itself to prevent injection.
        const escape = (s) => s.replace(/[%_\\]/g, '\\$&');
        const clauses = terms.map(() =>
            '(' + fields.map(f => `${f} LIKE ? ESCAPE '\\'`).join(' OR ') + ')'
        );
        const sql    = `SELECT * FROM tracks WHERE ${clauses.join(' AND ')}
                        ORDER BY ${sortField} COLLATE NOCASE, title COLLATE NOCASE LIMIT 500`;
        const params = terms.flatMap(term => fields.map(() => `%${escape(term)}%`));
        return db.prepare(sql).all(params);
    }

    // ── Accessors ─────────────────────────────────────────────────────────────

    getTrack(filePath) {
        if (!filePath) return null;
        return this._openDB().prepare('SELECT * FROM tracks WHERE path = ?').get(filePath) || null;
    }

    // Returns all tracks sorted by artist, title — used for tree building and
    // cache-warm reads.  ~10ms even for 10,000 tracks on a modern drive.
    getIndex() {
        if (!this.indexed) return [];
        return this._openDB().prepare(
            'SELECT * FROM tracks ORDER BY artist COLLATE NOCASE, title COLLATE NOCASE'
        ).all();
    }

    getCart()    { return this.cart; }
    isReady()    { return this.indexed; }
    isIndexing() { return this.indexing; }

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
        // Wipe tracks + path meta — old index is invalid for the new path
        try {
            const db = this._openDB();
            db.transaction(() => {
                db.prepare('DELETE FROM tracks').run();
                db.prepare("DELETE FROM meta WHERE key = 'musicPath'").run();
            })();
        } catch (_) {}
    }

    // ── Tree builder ──────────────────────────────────────────────────────────
    // Derives Genre → SubGenre → Artist → Album → Tracks from file paths.
    // Path structure: <musicPath>/<Genre>/<SubGenre?>/<Artist>/<Album>/<track.flac>

    getTree() {
        if (!this.indexed) return [];
        const tracks = this.getIndex();
        if (tracks.length === 0) return [];

        const base = path.resolve(this.musicPath);
        const root = {};

        for (const track of tracks) {
            const rel   = path.relative(base, track.path);
            const parts = rel.split(path.sep);
            if (parts.length < 2) continue;

            const genre    = parts[0];
            const filename = parts[parts.length - 1];
            const middle   = parts.slice(1, parts.length - 1);

            if (!root[genre]) root[genre] = { _path: path.join(base, genre), children: {} };
            let node    = root[genre].children;
            let curPath = path.join(base, genre);

            for (const seg of middle) {
                curPath = path.join(curPath, seg);
                if (!node[seg]) node[seg] = { _path: curPath, children: {} };
                node = node[seg].children;
            }

            node[filename] = {
                _path:    track.path,
                _isTrack: true,
                _track:   { title: track.title, artist: track.artist, album: track.album, duration: track.duration },
            };
        }

        function nodeToArr(obj) {
            return Object.keys(obj).sort((a, b) => {
                const aT = !!obj[a]._isTrack, bT = !!obj[b]._isTrack;
                if (aT !== bT) return aT ? 1 : -1;
                return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
            }).map(name => {
                const n = obj[name];
                if (n._isTrack) return { name, path: n._path, isTrack: true, ...n._track };
                return { name, path: n._path, children: nodeToArr(n.children) };
            });
        }

        return Object.keys(root).sort((a, b) => a.localeCompare(b)).map(genre => ({
            name:     genre,
            path:     root[genre]._path,
            children: nodeToArr(root[genre].children),
        }));
    }
}

module.exports = MusicLibrary;
