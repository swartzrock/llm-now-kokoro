param(
  [Parameter(Mandatory = $true)][string]$Url,
  [Parameter(Mandatory = $true)][string]$ExpectedSha256
)

$ErrorActionPreference = "Stop"
if ($ExpectedSha256 -notmatch '^[0-9a-f]{64}$') { throw "invalid Bun SHA-256" }
$downloadRoot = Join-Path $env:RUNNER_TEMP ("verified-bun-" + [guid]::NewGuid().ToString("N"))
$archive = Join-Path $downloadRoot "bun.zip"
$unpacked = Join-Path $downloadRoot "unpacked"
New-Item -ItemType Directory -Force -Path $downloadRoot | Out-Null
try {
  Invoke-WebRequest -Uri $Url -OutFile $archive
  $actualSha256 = (Get-FileHash -Algorithm SHA256 $archive).Hash.ToLowerInvariant()
  if ($actualSha256 -ne $ExpectedSha256) { throw "Bun archive checksum mismatch" }
  Expand-Archive -LiteralPath $archive -DestinationPath $unpacked
  $bun = Get-ChildItem -LiteralPath $unpacked -Filter bun.exe -File -Recurse | Select-Object -First 1
  if (-not $bun) { throw "verified Bun archive did not contain bun.exe" }
  $installRoot = Join-Path $env:RUNNER_TEMP "verified-bun"
  New-Item -ItemType Directory -Force -Path $installRoot | Out-Null
  Copy-Item -LiteralPath $bun.FullName -Destination (Join-Path $installRoot "bun.exe") -Force
  Add-Content -LiteralPath $env:GITHUB_PATH -Value $installRoot
} finally {
  Remove-Item -LiteralPath $downloadRoot -Recurse -Force -ErrorAction SilentlyContinue
}
