# Set (or reset) the RitPost AI admin portal password, then check it works.
# Run from PowerShell:   cd "C:\RitPost Whatsapp\worker" ; .\set-admin-password.ps1
#
# The password itself is never sent anywhere or written to disk: only a salted SHA-256
# fingerprint is stored in your server's database. The script then signs in to your live
# server with the password to prove it works.
$ErrorActionPreference = 'Stop'
Set-Location -Path $PSScriptRoot

function Read-Plain($prompt) {
  $s = Read-Host -Prompt $prompt -AsSecureString
  $b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)
  try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }
}

# Your server's address (written by deploy.ps1).
$cfg = Get-Content (Join-Path $PSScriptRoot '..\lib\config.js') -Raw
$url = [regex]::Match($cfg, "aiServer:\s*'([^']+)'").Groups[1].Value.TrimEnd('/')
if (-not $url) { throw 'No server address in lib\config.js. Run deploy.ps1 first.' }

Write-Host "Server: $url" -ForegroundColor DarkGray
Write-Host 'Choose a new admin password (at least 8 characters). Type it (do not paste); it is not shown.' -ForegroundColor Cyan
while ($true) {
  $p1 = (Read-Plain 'New admin password').Trim()
  if ($p1.Length -lt 8) { Write-Host 'Too short: use at least 8 characters.' -ForegroundColor Yellow; continue }
  $p2 = (Read-Plain 'Type it again').Trim()
  if ($p1 -ne $p2) { Write-Host 'The two passwords are different. Try again.' -ForegroundColor Yellow; continue }
  break
}

# Salted fingerprint (UTF-8), same as the server computes.
$rng = New-Object System.Security.Cryptography.RNGCryptoServiceProvider
$saltBytes = New-Object byte[] 16
$rng.GetBytes($saltBytes)
$salt = -join ($saltBytes | ForEach-Object { $_.ToString('x2') })
$sha = [System.Security.Cryptography.SHA256]::Create()
$hash = -join ($sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($salt + $p1)) | ForEach-Object { $_.ToString('x2') })

$sql = Join-Path $env:TEMP "ritpost-admin-$([guid]::NewGuid().ToString('N')).sql"
"INSERT OR REPLACE INTO settings (key, value) VALUES ('admin_hash', '""sha256:$($salt):$($hash)""');" | Set-Content -Path $sql -Encoding ASCII
try {
  Write-Host "`nSaving on your server..." -ForegroundColor Cyan
  npx --yes wrangler@4 d1 execute ritpost-ai --remote --file="$sql" --yes | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Wrangler could not save it. Run "npx wrangler@4 login" and try again.' }
} finally { Remove-Item $sql -ErrorAction SilentlyContinue }

Write-Host 'Checking the new password against your live server...' -ForegroundColor Cyan
$ok = $false
for ($i = 0; $i -lt 6 -and -not $ok; $i++) {
  try {
    $r = Invoke-RestMethod -Uri "$url/admin/api/login" -Headers @{ Authorization = 'Bearer ' + [uri]::EscapeDataString($p1) } -Method Get
    if ($r.ok) { $ok = $true }
  } catch { Start-Sleep -Seconds 3 }
}
Remove-Variable p1, p2
if ($ok) {
  Write-Host "`nWorks! Sign in at $url/admin with this password." -ForegroundColor Green
  Write-Host 'Tip: if Chrome fills in the password box by itself, clear it and type the new password (use Show to check).'
} else {
  Write-Host "`nSaved, but the test sign-in failed. Copy the messages above and send them to support." -ForegroundColor Yellow
}
