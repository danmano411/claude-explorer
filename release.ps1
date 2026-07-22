# Builds the installer and creates ONE draft GitHub Release with all three
# update-feed assets. Uses `gh` auth — no GH_TOKEN/.env needed.
# (electron-builder's own --publish races itself into duplicate drafts on 26.x.)
$ErrorActionPreference = 'Stop'

npm run package
if ($LASTEXITCODE -ne 0) { exit 1 }

$version = (Get-Content "$PSScriptRoot\package.json" -Raw | ConvertFrom-Json).version
$dist = Join-Path $PSScriptRoot 'dist'

# latest.yml references hyphenated asset names (GitHub mangles spaces);
# copy the built files to the names electron-updater will look for.
$exe = Join-Path $dist "Claude-Explorer-Setup-$version.exe"
Copy-Item (Join-Path $dist "Claude Explorer Setup $version.exe") $exe -Force
Copy-Item (Join-Path $dist "Claude Explorer Setup $version.exe.blockmap") "$exe.blockmap" -Force

gh release create "v$version" --draft --title "v$version" --generate-notes `
  $exe "$exe.blockmap" (Join-Path $dist 'latest.yml')
