$ErrorActionPreference = 'Stop'
try {
  $wlSpecLine = [Console]::ReadLine()
  if (!$wlSpecLine) { exit 0 }
  $wlSpec = $wlSpecLine | ConvertFrom-Json
  Add-Type -Path (Join-Path $PSScriptRoot 'windows-job.cs')
  foreach ($wlProperty in $wlSpec.env.PSObject.Properties) {
    [Environment]::SetEnvironmentVariable($wlProperty.Name, [string]$wlProperty.Value, 'Process')
  }
  [WhaleLifeOwnedJob]::Run([string]$wlSpec.exe, [string]$wlSpec.commandLine, [string]$wlSpec.cwd)
} catch {
  [Console]::WriteLine('{"event":"supervisor-error"}')
  exit 1
}
