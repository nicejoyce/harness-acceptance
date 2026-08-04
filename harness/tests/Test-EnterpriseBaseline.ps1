$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$required = @(
    'policies/code-quality-baseline.md',
    'contracts/quality-baseline.yaml',
    'governance/document-triggers.md',
    'governance/exception-policy.md',
    'governance/maturity-model.md',
    'rules/registry.yaml',
    'rules/global.md',
    'rules/testing.md',
    'rules/infra.md',
    'rules/stacks/README.md',
    'enforcement/README.md',
    'enforcement/pre-commit.example.yaml',
    'enforcement/ci-gates.example.yaml',
    'skills/setup.md',
    'skills/debug.md',
    'skills/review.md',
    'skills/release.md',
    'skills/incident.md'
)
$missing = $required | Where-Object { -not (Test-Path (Join-Path $root $_)) }
if ($missing) { throw "Enterprise baseline is incomplete: $($missing -join ', ')" }
$registry = Get-Content (Join-Path $root 'rules/registry.yaml') -Raw
foreach ($id in @('SEC-001', 'DATA-003', 'ARCH-001', 'TEST-005', 'DEP-003', 'OPS-006', 'AI-002')) {
    if ($registry -notmatch $id) { throw "Required rule missing from registry: $id" }
}
Write-Host "Enterprise baseline contract passed: $($required.Count) files and core rules found."
