[CmdletBinding()]
param(
    [switch]$RequireProjectProfile,
    [switch]$Json
)

$ErrorActionPreference = 'Stop'
$harnessRoot = Split-Path -Parent $PSScriptRoot
$workspaceRoot = Split-Path -Parent $harnessRoot
$cli = Join-Path $workspaceRoot 'harness-cli/src/cli.ts'

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw 'Node.js 24 is required to run the Harness CLI.'
}

$arguments = @($cli, 'validate', '--root', $harnessRoot)
if ($Json) { $arguments += '--json' }
& node @arguments
exit $LASTEXITCODE
