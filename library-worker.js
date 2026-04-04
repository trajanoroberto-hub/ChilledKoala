'use strict';
/**
 * Chilled Koala v2.0.0 — Library Rescan Worker
 * Runs the FLAC directory walk + metadata extraction entirely off the main thread
 * so the 20ms mixer tick is never delayed during a library rescan.
 *
 * Communication with parent (library.js rescanInWorker):
 *   parent → worker : workerData = { musicPath: string }
 *   worker → parent : { type: 'progress', scanned: number }   (every 50 tracks)
 *   worker → parent : { type: 'result',   index:   Array }    (on completion)
 *   worker → parent : { type: 'error',    error:   string }   (on failure)
 */

const { workerData, parentPort } = require('worker_threads');
const path       = require('path');
const fs         = require('fs');
const { parseFile } = require('music-metadata');

const { musicPath } = workerData;

// ── Helpers (mirrors library.js — kept in sync manually) ─────────────────────

async function _collectPaths(dir, paths, seenFiles, visitedDirs) {
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
            await _collectPaths(full, paths, seenFiles, visitedDirs);
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

async function _readMeta(filePath) {
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

function _fingerprint(t) {
    if (t.trackid) return `id:${t.trackid}`;
    const dur = Math.round(t.duration || 0);
    return `${(t.artist||'').toLowerCase()}|${(t.title||'').toLowerCase()}|${(t.album||'').toLowerCase()}|${dur}`;
}

// ── Main scan ─────────────────────────────────────────────────────────────────

(async () => {
    try {
        if (!fs.existsSync(musicPath)) {
            parentPort.postMessage({ type: 'result', index: [] });
            return;
        }

        // Phase 1: directory walk (I/O — async, no CPU blocking)
        const paths = [];
        await _collectPaths(musicPath, paths, new Set(), new Set());
        parentPort.postMessage({ type: 'progress', scanned: 0 });

        // Phase 2: metadata extraction — 8 concurrent readers
        // This is the CPU-heavy part (FLAC tag parsing). Running in worker_threads
        // keeps it entirely off the main thread and away from the mixer tick.
        const results = [];
        const CONCURRENCY = 8;
        let idx = 0;
        const reader = async () => {
            while (idx < paths.length) {
                const filePath = paths[idx++];
                const meta = await _readMeta(filePath);
                if (meta) {
                    results.push(meta);
                    if (results.length === 1 || results.length % 50 === 0) {
                        parentPort.postMessage({ type: 'progress', scanned: results.length });
                    }
                }
            }
        };
        await Promise.all(Array.from({ length: CONCURRENCY }, reader));

        // Phase 3: deduplicate by metadata fingerprint
        const seenFp = new Set();
        const index  = results.filter(t => {
            const fp = _fingerprint(t);
            if (seenFp.has(fp)) return false;
            seenFp.add(fp);
            return true;
        });

        const dupes = results.length - index.length;
        if (dupes > 0) process.stdout.write(`[library-worker] removed ${dupes} duplicate(s)\n`);

        parentPort.postMessage({ type: 'result', index });
    } catch (err) {
        parentPort.postMessage({ type: 'error', error: err.message });
    }
})();
