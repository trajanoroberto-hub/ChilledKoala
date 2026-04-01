/**
 * Chilled Koala v2.0.0 — Authentication Manager
 *
 * Auth chain (first success wins):
 *   1. docker exec → AzuraCast internal Liquidsoap auth API (most reliable)
 *   2. AzuraCast public REST API on port 80 (no docker exec needed)
 *   3. SFTP on port 2022 (legacy fallback)
 *
 * AzuraCast runs inside Docker — the internal API (port 6010) is NOT exposed
 * to the host. We reach it by running curl inside the container via docker exec.
 *
 * Security:
 *   - Brute-force protection: 5 failed attempts → 60s lockout per username
 *   - Rate limit: max 10 auth requests/sec across all users
 *
 * SPDX-License-Identifier: MIT
 * MIT License — Copyright © 2026 Trajano Roberto
 */

'use strict';

const http         = require('http');
const { execFile } = require('child_process');
const { Client }   = require('ssh2');

// ── Brute-force protection ────────────────────────────────────────────────────
const MAX_FAILS   = 5;
const LOCKOUT_MS  = 60_000;
const _fails      = new Map();

function _checkLock(username) {
    const entry = _fails.get(username);
    if (!entry) return false;
    if (entry.lockedUntil && Date.now() < entry.lockedUntil) return true;
    if (entry.lockedUntil && Date.now() >= entry.lockedUntil) _fails.delete(username);
    return false;
}

function _recordFail(username) {
    const entry = _fails.get(username) || { count: 0, lockedUntil: 0 };
    entry.count++;
    if (entry.count >= MAX_FAILS) {
        entry.lockedUntil = Date.now() + LOCKOUT_MS;
        console.warn(`⚠ Auth locked: ${username} (${MAX_FAILS} failed attempts — locked ${LOCKOUT_MS / 1000}s)`);
    }
    _fails.set(username, entry);
}

function _recordSuccess(username) {
    _fails.delete(username);
}

// ── Global rate limiter ───────────────────────────────────────────────────────
let _authCount = 0;
let _authWindow = Date.now();
const MAX_AUTH_PER_SEC = 10;

function _rateLimited() {
    const now = Date.now();
    if (now - _authWindow > 1000) { _authCount = 0; _authWindow = now; }
    _authCount++;
    return _authCount > MAX_AUTH_PER_SEC;
}

// ── AuthManager ───────────────────────────────────────────────────────────────

class AuthManager {
    constructor(config) {
        const az        = config.azuracast || {};
        this.stationId  = parseInt(az.station_id || '1');
        this.container  = az.docker_container || 'azuracast';
        this.sftpHost   = 'localhost';
        this.sftpPort   = 2022;
        this.timeout    = 8000;

        // Public API on port 80 (always accessible from host)
        this.publicHost = az.server || '127.0.0.1';
        this.publicPort = parseInt(az.port || '80');

        console.log(`✓ Auth: docker exec ${this.container} → internal API (primary)`);
        console.log(`✓ Auth: http://${this.publicHost}:${this.publicPort} public API (secondary)`);
        console.log(`✓ Auth: SFTP ${this.sftpHost}:${this.sftpPort} (tertiary fallback)`);
    }

    // ── Method 1: docker exec into AzuraCast container, call internal API ────
    // Bypasses the host-port-6010 problem entirely.
    // The internal API is always reachable from inside the container.
    _authViaDocker(username, password) {
        return new Promise((resolve) => {
            const body   = JSON.stringify({ user: username, password });
            const path   = `/api/internal/${this.stationId}/liquidsoap/auth`;
            const curlCmd = [
                'exec', this.container,
                'curl', '-s', '-m', '5',
                '-X', 'POST',
                '-H', 'Content-Type: application/json',
                '-d', body,
                `http://127.0.0.1/${path.replace(/^\//, '')}`
            ];

            const timer = setTimeout(() => {
                console.log(`✗ Auth docker exec timeout — trying public API: ${username}`);
                resolve(null);
            }, this.timeout);

            execFile('docker', curlCmd, { timeout: this.timeout }, (err, stdout) => {
                clearTimeout(timer);
                if (err) {
                    console.log(`✗ Auth docker exec error (${err.message}) — trying public API: ${username}`);
                    return resolve(null);
                }
                const raw = stdout.trim();
                if (raw === 'true') {
                    console.log(`✓ Auth docker-exec OK: ${username}`);
                    return resolve(true);
                }
                if (raw === 'false') {
                    console.log(`✗ Auth docker-exec denied: ${username}`);
                    return resolve(false);
                }
                // Empty or unexpected response — try next method
                console.log(`✗ Auth docker-exec unexpected response (${raw || 'empty'}) — trying public API: ${username}`);
                resolve(null);
            });
        });
    }

    // ── Method 2: AzuraCast public REST API on port 80 ───────────────────────
    // POST /api/internal/{station_id}/liquidsoap/auth via the public nginx proxy.
    // No docker exec needed, no special ports — just HTTP on port 80.
    _authViaPublicApi(username, password) {
        return new Promise((resolve) => {
            const body = JSON.stringify({ user: username, password });
            const path = `/api/internal/${this.stationId}/liquidsoap/auth`;

            const req = http.request({
                hostname: this.publicHost,
                port:     this.publicPort,
                path,
                method:   'POST',
                headers:  {
                    'Content-Type':   'application/json',
                    'Content-Length': Buffer.byteLength(body),
                    'User-Agent':     'ChilledKoala/2.0.0',
                },
            }, (res) => {
                let data = '';
                res.setEncoding('utf8');
                res.on('data', (chunk) => { data += chunk; });
                res.on('end', () => {
                    const raw = data.trim();
                    if (raw === 'true') {
                        console.log(`✓ Auth public-API OK: ${username}`);
                        return resolve(true);
                    }
                    if (raw === 'false') {
                        console.log(`✗ Auth public-API denied: ${username}`);
                        return resolve(false);
                    }
                    console.log(`✗ Auth public-API unexpected (${raw || 'empty'}) — SFTP fallback: ${username}`);
                    resolve(null);
                });
            });

            req.setTimeout(this.timeout, () => {
                console.log(`✗ Auth public-API timeout — SFTP fallback: ${username}`);
                req.destroy();
                resolve(null);
            });

            req.on('error', (err) => {
                console.log(`✗ Auth public-API error (${err.message}) — SFTP fallback: ${username}`);
                resolve(null);
            });

            req.write(body);
            req.end();
        });
    }

    // ── Method 3: SFTP on port 2022 (legacy fallback) ────────────────────────
    _authViaSftp(username, password) {
        return new Promise((resolve) => {
            const conn = new Client();
            let done   = false;

            const finish = (result) => {
                if (done) return;
                done = true;
                clearTimeout(timer);
                try { conn.end(); } catch (_) {}
                resolve(result);
            };

            const timer = setTimeout(() => {
                console.log(`✗ Auth SFTP timeout: ${username}`);
                finish(false);
            }, this.timeout);

            conn.on('ready', () => {
                console.log(`✓ Auth SFTP OK: ${username}`);
                finish(true);
            });

            conn.on('error', (err) => {
                console.log(`✗ Auth SFTP fail ${username}: ${err.message}`);
                finish(false);
            });

            conn.connect({
                host:     this.sftpHost,
                port:     this.sftpPort,
                username,
                password,
                algorithms: {
                    serverHostKey: ['ssh-rsa','ecdsa-sha2-nistp256','ecdsa-sha2-nistp384','ecdsa-sha2-nistp521','ssh-ed25519'],
                },
                hostVerifier: () => true,
                readyTimeout: this.timeout,
            });
        });
    }

    // ── Public: authenticate(username, password) → boolean ───────────────────
    async authenticate(username, password) {
        if (!username || !password) return false;

        if (_rateLimited()) {
            console.warn(`⚠ Auth rate limited — rejected: ${username}`);
            return false;
        }

        if (_checkLock(username)) {
            console.warn(`⚠ Auth locked out: ${username}`);
            return false;
        }

        // Method 1: docker exec → internal API
        let ok = await this._authViaDocker(username, password);

        // Method 2: public REST API on port 80
        if (ok === null) {
            ok = await this._authViaPublicApi(username, password);
        }

        // Method 3: SFTP fallback
        if (ok === null) {
            console.log(`⚠ All APIs unreachable — SFTP fallback: ${username}`);
            ok = await this._authViaSftp(username, password);
        }

        if (ok) {
            _recordSuccess(username);
        } else {
            _recordFail(username);
        }

        return !!ok;
    }
}

module.exports = AuthManager;
