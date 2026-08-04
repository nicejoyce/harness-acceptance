param(
    [Parameter(Mandatory = $true)][string]$OutputDirectory,
    [Parameter(Mandatory = $true)][string]$ReviewerLogin,
    [Parameter(Mandatory = $true)][string]$PythonExecutable
)

$ErrorActionPreference = 'Stop'
$repository = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$output = [System.IO.Path]::GetFullPath($OutputDirectory)

function Invoke-Checked {
    param([string]$Executable, [string[]]$Arguments)
    & $Executable @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$Executable failed with exit code $LASTEXITCODE"
    }
}

if (-not (Test-Path -LiteralPath $PythonExecutable -PathType Leaf)) {
    throw "Python executable does not exist: $PythonExecutable"
}
if (-not (Get-Command gitleaks -ErrorAction SilentlyContinue)) {
    throw 'gitleaks is required before preparing a public snapshot'
}

Push-Location $repository
try {
    $env:PYTHON = $PythonExecutable
    Invoke-Checked npm @('test')
    Invoke-Checked npm @('run', 'typecheck')
    Invoke-Checked npm @('run', 'harness', '--', 'validate', '--root', 'harness')
    Invoke-Checked npm @('run', 'harness', '--', 'validate', '--root', 'harness-zh')
    Invoke-Checked node @('--test', 'harness-cli/test/python-fixture.test.ts')
    Invoke-Checked git @('diff', '--check')
    Invoke-Checked node @('scripts/export-public-snapshot.ts', '--output', $output, '--reviewer', $ReviewerLogin)
    Invoke-Checked gitleaks @('detect', '--source', $output, '--no-git', '--redact')
}
finally {
    Pop-Location
}

Write-Output "Public snapshot preflight passed: $output"
