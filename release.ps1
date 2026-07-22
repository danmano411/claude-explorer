# Loads .env (KEY=value lines) into the environment, then runs the release.
Get-Content "$PSScriptRoot\.env" | ForEach-Object {
  if ($_ -match '^\s*([^#][^=]*)=(.*)$') {
    Set-Item -Path "env:$($Matches[1].Trim())" -Value $Matches[2].Trim()
  }
}
npm run release
