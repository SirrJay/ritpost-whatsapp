# Set (or reset) the RitPost AI admin portal password.
# Run from PowerShell:   cd "C:\RitPost Whatsapp\worker" ; .\set-admin-password.ps1
$ErrorActionPreference = 'Stop'
Set-Location -Path $PSScriptRoot

function Read-Plain($prompt) {
  $s = Read-Host -Prompt $prompt -AsSecureString
  $b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)
  try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }
}

Write-Host 'Choose a new admin password (at least 8 characters). You type it twice; it is not shown.' -ForegroundColor Cyan
while ($true) {
  $p1 = (Read-Plain 'New admin password').Trim()
  if ($p1.Length -lt 8) { Write-Host 'Too short: use at least 8 characters.' -ForegroundColor Yellow; continue }
  $p2 = (Read-Plain 'Type it again').Trim()
  if ($p1 -ne $p2) { Write-Host 'The two passwords are different. Try again.' -ForegroundColor Yellow; continue }
  break
}

# Pipe it straight into Wrangler (nothing is written to disk).
$p1 | npx --yes wrangler@4 secret put ADMIN_TOKEN
if ($LASTEXITCODE -ne 0) { throw 'Wrangler could not save the password. Run "npx wrangler@4 login" and try again.' }
Remove-Variable p1, p2
Write-Host "`nSaved. Wait about 20 seconds, then sign in at your server's /admin page with this password." -ForegroundColor Green
