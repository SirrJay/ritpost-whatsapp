# RitPost AI server: one-time setup and deploy to your Cloudflare account.
# Run from PowerShell:   cd "C:\RitPost Whatsapp\worker" ; .\deploy.ps1
# You will: approve Wrangler in your browser, and paste your OpenAI key + choose an admin
# password when asked. Nothing secret is written to any file.
$ErrorActionPreference = 'Stop'
Set-Location -Path $PSScriptRoot
$w = @('--yes', 'wrangler@4')

function Step($n, $text) { Write-Host "`n[$n] $text" -ForegroundColor Cyan }

Step 1 'Sign in to Cloudflare (a browser window opens: click Allow)'
npx @w whoami 2>$null | Out-String | Tee-Object -Variable who | Out-Null
if ($who -notmatch 'associated with the email|You are logged in') { npx @w login }

$toml = Get-Content wrangler.toml -Raw
if ($toml -match 'PASTE-YOUR-DATABASE-ID-HERE') {
  Step 2 'Creating the database (ritpost-ai)'
  $out = npx @w d1 create ritpost-ai 2>&1 | Out-String
  Write-Host $out
  $id = [regex]::Match($out, '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}').Value
  if (-not $id) {
    $list = npx @w d1 list --json 2>$null | Out-String
    $id = [regex]::Match($list, '"uuid":\s*"([0-9a-f-]{36})"[^}]*"name":\s*"ritpost-ai"').Groups[1].Value
  }
  if (-not $id) { throw 'Could not read the database id. Paste it into wrangler.toml (database_id) and run this again.' }
  ($toml -replace 'PASTE-YOUR-DATABASE-ID-HERE', $id) | Set-Content wrangler.toml -NoNewline
  Write-Host "Database id saved in wrangler.toml: $id"
} else { Step 2 'Database already set up' }

Step 3 'Creating the tables'
npx @w d1 execute ritpost-ai --remote --file=schema.sql --yes

Step 4 'Deploying the server'
$dep = npx @w deploy 2>&1 | Out-String
Write-Host $dep
$url = [regex]::Match($dep, 'https://[a-z0-9.-]+\.workers\.dev').Value
if (-not $url) { throw 'Deploy did not report a workers.dev address. Check the messages above.' }

Step 5 'Your OpenAI API key (paste it and press Enter; it is stored encrypted on Cloudflare only)'
npx @w secret put OPENAI_API_KEY
Step 6 'Choose an admin password for the portal (paste/type it and press Enter)'
npx @w secret put ADMIN_TOKEN

Step 7 'Pointing RitPost at your server'
$cfg = Join-Path $PSScriptRoot '..\lib\config.js'
(Get-Content $cfg -Raw) -replace "aiServer:\s*'[^']*'", "aiServer: '$url'" | Set-Content $cfg -NoNewline

Write-Host "`nDone!" -ForegroundColor Green
Write-Host "  Server:        $url"
Write-Host "  Admin portal:  $url/admin   (sign in with your admin password)"
Write-Host "  RitPost now uses it (lib/config.js updated). Reload RitPost at chrome://extensions."
