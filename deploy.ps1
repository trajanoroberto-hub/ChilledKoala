# deploy.ps1 — Chilled Koala deploy script
# Usage: .\deploy.ps1

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$RepoDir = "D:\basket\Trajano\Apps\chilled_koala"

# ── Read build number from package.json ───────────────────────────────────────
$pkgPath = Join-Path $RepoDir "package.json"
$pkg = Get-Content $pkgPath -Raw | ConvertFrom-Json
$build = $pkg.build

Write-Host ""
Write-Host "=== Chilled Koala Deploy ===" -ForegroundColor Cyan
Write-Host "  Build : $build"
Write-Host ""

# ── 1. git add -A ─────────────────────────────────────────────────────────────
Write-Host "--- git add -A ---" -ForegroundColor Yellow
git -C $RepoDir add -A
if ($LASTEXITCODE -ne 0) { Write-Host "git add failed." -ForegroundColor Red; exit 1 }

# ── 2. git commit ─────────────────────────────────────────────────────────────
Write-Host "--- git commit ---" -ForegroundColor Yellow
git -C $RepoDir commit -m "Build $build"
if ($LASTEXITCODE -ne 0) { Write-Host "git commit failed (nothing to commit?)." -ForegroundColor Red; exit 1 }

# ── 3. git push origin main ───────────────────────────────────────────────────
Write-Host "--- git push origin main ---" -ForegroundColor Yellow
git -C $RepoDir push origin main
if ($LASTEXITCODE -ne 0) { Write-Host "git push failed." -ForegroundColor Red; exit 1 }

# ── 4. VPS: git pull + pm2 restart via WinSCP saved session ───────────────────
Write-Host "--- VPS: git pull + pm2 restart ---" -ForegroundColor Yellow
& 'C:\Program Files (x86)\WinSCP\WinSCP.com' /command `
    "open root@www.gatopretoradio.com.br" `
    "call cd /opt/chilled_koala && git pull && pm2 restart chilled_koala" `
    "exit"
if ($LASTEXITCODE -ne 0) { Write-Host "VPS deploy failed." -ForegroundColor Red; exit 1 }

# ── Done ──────────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "DEPLOY COMPLETE" -ForegroundColor Green
