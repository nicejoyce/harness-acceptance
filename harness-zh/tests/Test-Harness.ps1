$ErrorActionPreference = 'Stop'

$harnessRoot = Split-Path -Parent $PSScriptRoot
$requiredFiles = @(
    'README.md',
    'config/project-profile.example.yaml',
    'contracts/quality-gates.yaml',
    'governance/document-hierarchy.md',
    'policies/security-and-agent-boundaries.md',
    'workflows/change-delivery.md',
    'governance/record-ownership.md',
    'templates/architecture-decision-record.md',
    'templates/bug-tracker.md',
    'templates/progress.md',
    'scripts/Validate-Harness.ps1'
)

$missing = $requiredFiles | Where-Object { -not (Test-Path (Join-Path $harnessRoot $_)) }
if ($missing) {
    throw "Chinese harness contract is incomplete: $($missing -join ', ')"
}

Write-Host "Chinese harness contract passed: $($requiredFiles.Count) required files found."
