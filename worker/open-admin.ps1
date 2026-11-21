# Open the RitPost AI admin portal, already signed in (no password needed).
# Run from PowerShell:   cd "C:\RitPost Whatsapp\worker" ; .\open-admin.ps1
#
# How it works: this computer is signed in to your Cloudflare account (Wrangler), so it can
# put a one-time sign-in key on your server. The key works once, within 10 minutes.
$ErrorActionPreference = 'Stop'
Set-Location -Path $PSScriptRoot

$cfg = Get-Content (Join-Path $PSScriptRoot '..\lib\config.js') -Raw
$url = [regex]::Match($cfg, "aiServer:\s*'([^']+)'").Groups[1].Value.TrimEnd('/')
if (-not $url) { throw 'No server address in lib\config.js. Run deploy.ps1 first.' }

# A random one-time key; the server only stores its SHA-256.
$rng = New-Object System.Security.Cryptography.RNGCryptoServiceProvider
$bytes = New-Object byte[] 32
$rng.GetBytes($bytes)
$token = -join ($bytes | ForEach-Object { $_.ToString('x2') })
$sha = [System.Security.Cryptography.SHA256]::Create()
$hash = -join ($sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($token)) | ForEach-Object { $_.ToString('x2') })
$exp = [DateTimeOffset]::UtcNow.AddMinutes(10).ToUnixTimeMilliseconds()

$sql = Join-Path $env:TEMP "ritpost-magic-$([guid]::NewGuid().ToString('N')).sql"
"INSERT OR REPLACE INTO settings (key, value) VALUES ('admin_magic', '{""hash"":""$hash"",""exp"":$exp}');" | Set-Content -Path $sql -Encoding ASCII
try {
  Write-Host 'Creating a one-time sign-in link...' -ForegroundColor Cyan
  npx --yes wrangler@4 d1 execute ritpost-ai --remote --file="$sql" --yes | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Wrangler could not reach your Cloudflare account. Run "npx wrangler@4 login" and try again.' }
} finally { Remove-Item $sql -ErrorAction SilentlyContinue }

Start-Process "$url/admin#login=$token"
Write-Host "Opened the admin portal in your browser. The link works once, within 10 minutes." -ForegroundColor Green
Write-Host 'Tip: set a password you can type in Settings -> Admin password.'
