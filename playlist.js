/**
 * Chilled Koala v2.0.0 — Live Playlist
 * Spec §22.2.20–22.2.22
 * Fields: #, Start Time, ARTIST – TITLE, Duration, Delete, Insert Stop
 * Now Playing: full FLAC metadata display
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
const path             = require('path');

let _seq = 1;

function makeEntry(meta) {
    return {
        _id:          _seq++,
        path:         meta.path         || '',
        title:        meta.title        || path.basename(meta.path || '', '.flac'),
        artist:       meta.artist       || '',
        album:        meta.album        || '',
        albumartist:  meta.albumartist  || '',
        tracknumber:  meta.tracknumber  || null,
        tracktotal:   meta.tracktotal   || null,
        discnumber:   meta.discnumber   || null,
        disctotal:    meta.disctotal    || null,
        date:         meta.date         || '',
        originaldate: meta.originaldate || '',
        genre:        meta.genre        || '',
        duration:     meta.duration     || 0,
        lufs:         meta.lufs         || '',
        status:       meta.status       || '',
        albumid:      meta.albumid      || '',
        trackid:      meta.trackid      || '',
        artistid:     meta.artistid     || '',
        stop:         false,            // stop marker after this track
        startTime:    null,             // ISO string, recalculated
    };
}

class LivePlaylist extends EventEmitter {
    constructor(config) {
        super();
        this.tracks       = [];
        this.currentIndex = -1;
        this.nowPlaying   = null;
    }

    // ── Mutations ─────────────────────────────────────────────────────────────

    addTrack(meta) {
        const entry = makeEntry(meta);
        this.tracks.push(entry);
        this._recalcTimes();
        this._broadcast();
        return entry;
    }

    insertNext(meta) {
        const at    = this.currentIndex >= 0 ? this.currentIndex + 1 : 0;
        const entry = makeEntry(meta);
        this.tracks.splice(at, 0, entry);
        this._recalcTimes();
        this._broadcast();
        return entry;
    }

    removeTrack(index) {
        if (index < 0 || index >= this.tracks.length) return;
        this.tracks.splice(index, 1);
        if (this.currentIndex >= index) {
            this.currentIndex = Math.max(-1, this.currentIndex - 1);
        }
        this._recalcTimes();
        this._broadcast();
    }

    toggleStop(index) {
        const t = this.tracks[index];
        if (!t) return;
        t.stop = !t.stop;
        this._broadcast();
    }

    setNowPlaying(index) {
        if (index < 0 || index >= this.tracks.length) return;
        this.currentIndex = index;
        this.nowPlaying   = this.tracks[index];
        this.emit('nowPlaying', this.nowPlaying);
        this._broadcast();
    }

    clearNowPlaying() {
        this.currentIndex = -1;
        this.nowPlaying   = null;
        this.emit('nowPlaying', null);
        this._broadcast();
    }

    clear() {
        this.tracks       = [];
        this.currentIndex = -1;
        this.nowPlaying   = null;
        this._broadcast();
    }

    // ── Time calculation ──────────────────────────────────────────────────────
    // Anchor: if there is a current track, its start time = now;
    //         otherwise first track starts now.

    _recalcTimes() {
        if (!this.tracks.length) return;

        const now    = Date.now();
        const anchor = this.currentIndex >= 0 ? this.currentIndex : 0;
        let   cursor = now;

        // Walk forward from anchor — never stop at stop marks, always chain all tracks
        for (let i = anchor; i < this.tracks.length; i++) {
            this.tracks[i].startTime = new Date(cursor).toISOString();
            cursor += Math.round((this.tracks[i].duration || 0) * 1000);
            // stop marks pause the show but we still calculate when the next track WOULD start
        }

        // Walk backward from anchor-1
        cursor = now;
        for (let i = anchor - 1; i >= 0; i--) {
            cursor -= Math.round((this.tracks[i].duration || 0) * 1000);
            this.tracks[i].startTime = new Date(cursor).toISOString();
        }
    }

    // ── Serialization ─────────────────────────────────────────────────────────

    getList() {
        return this.tracks.map((t, i) => ({
            index:        i,
            _id:          t._id,
            path:         t.path,
            title:        t.title,
            artist:       t.artist,
            album:        t.album,
            albumartist:  t.albumartist,
            tracknumber:  t.tracknumber,
            tracktotal:   t.tracktotal,
            discnumber:   t.discnumber,
            disctotal:    t.disctotal,
            date:         t.date,
            originaldate: t.originaldate,
            genre:        t.genre,
            duration:     t.duration,
            lufs:         t.lufs,
            status:       t.status,
            albumid:      t.albumid,
            trackid:      t.trackid,
            artistid:     t.artistid,
            stop:         t.stop,
            startTime:    t.startTime,
            isCurrent:    i === this.currentIndex,
        }));
    }

    getNowPlaying() { return this.nowPlaying; }

    _broadcast() {
        this.emit('updated', this.getList());
    }
}

module.exports = LivePlaylist;
