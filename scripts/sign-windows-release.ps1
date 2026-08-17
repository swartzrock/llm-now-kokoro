$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

foreach ($name in @(
  "WINDOWS_CODESIGN_PFX_BASE64",
  "WINDOWS_CODESIGN_PFX_PASSWORD",
  "WINDOWS_RFC3161_TIMESTAMP_URL"
)) {
  if (-not [Environment]::GetEnvironmentVariable($name)) {
    throw "missing $name"
  }
}
if ($args.Count -ne 4) {
  throw "usage: sign-windows-release.ps1 <asset-root> <rc-tag> <source-commit> <bun-lock-sha256>"
}
if (-not $env:WINDOWS_RFC3161_TIMESTAMP_URL.StartsWith("https://")) {
  throw "WINDOWS_RFC3161_TIMESTAMP_URL must use HTTPS"
}

$assetRoot = (Resolve-Path $args[0]).Path
$pfxPath = Join-Path ([System.IO.Path]::GetTempPath()) ("llm-now-kokoro-" + [Guid]::NewGuid() + ".pfx")
try {
  [IO.File]::WriteAllBytes($pfxPath, [Convert]::FromBase64String($env:WINDOWS_CODESIGN_PFX_BASE64))
  $files = Get-ChildItem -LiteralPath $assetRoot -File | Where-Object {
    $_.Extension -in @(".exe", ".dll", ".node")
  } | Sort-Object FullName
  if ($files.Count -eq 0) { throw "no Windows native files to sign" }
  foreach ($file in $files) {
    & signtool sign /fd SHA256 /f $pfxPath /p $env:WINDOWS_CODESIGN_PFX_PASSWORD `
      /tr $env:WINDOWS_RFC3161_TIMESTAMP_URL /td SHA256 $file.FullName
    if ($LASTEXITCODE -ne 0) { throw "signtool sign failed" }
    & signtool verify /pa /all /v $file.FullName
    if ($LASTEXITCODE -ne 0) { throw "WinVerifyTrust policy verification failed" }
  }
  & bun (Join-Path $PSScriptRoot "write-signing-receipt.ts") windows $assetRoot `
    (Join-Path (Split-Path $assetRoot) "signing-receipt.json") $args[1] $args[2] $args[3]
  if ($LASTEXITCODE -ne 0) { throw "signing receipt failed" }
} finally {
  Remove-Item -LiteralPath $pfxPath -Force -ErrorAction SilentlyContinue
}
