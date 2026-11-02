<#
Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
#>
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
