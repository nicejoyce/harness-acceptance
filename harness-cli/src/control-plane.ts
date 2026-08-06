import { lstat, readFile, readdir, readlink } from 'node:fs/promises';
import path from 'node:path';

import { parse } from 'yaml';

import { auditEnforcement } from './enforcement-audit.ts';
import { loadContracts, validateContracts } from './contracts.ts';
import { sha256, stableJson } from './hash.ts';
import { analyzeWorkflowPolicyRoots } from './workflow-policy.ts';

const protectedPatterns = [
  '.github/workflows/**',
  'CODEOWNERS*',
  'harness/**',
  'harness-zh/**',
  'harness-cli/**',
  'harness-service/**',
  'package.json',
  'package-lock.json',
  'stryker.config.json',
  'stryker.full.config.json',
  'scripts/**',
];

const immutableControlPlanePaths = [
  '.github/workflows',
  'CODEOWNERS',
  'CODEOWNERS.template',
  'harness-cli',
  'harness-service',
  'package.json',
  'package-lock.json',
  'stryker.config.json',
  'stryker.full.config.json',
  'scripts',
];

export interface ControlPlaneDiagnostic {
  code: 'CONTROL_PLANE_INVALID' | 'CONTROL_PLANE_DOWNGRADE' | 'WORKFLOW_POLICY_INVALID';
  document: string;
  message: string;
}

export interface ControlPlaneVerificationResult {
  valid: boolean;
  diagnostics: ControlPlaneDiagnostic[];
}

async function immutableSnapshot(root: string): Promise<Map<string, string>> {
  const snapshot = new Map<string, string>();
  const visit = async (relativePath: string): Promise<void> => {
    const absolutePath = path.join(root, relativePath);
    let metadata;
    try {
      metadata = await lstat(absolutePath);
    } catch {
      snapshot.set(relativePath.replaceAll('\\', '/'), '<missing>');
      return;
    }
    const normalized = relativePath.replaceAll('\\', '/');
    if (metadata.isSymbolicLink()) {
      snapshot.set(normalized, `<symlink:${await readlink(absolutePath)}> `);
      return;
    }
    if (metadata.isDirectory()) {
      const entries = await readdir(absolutePath, { withFileTypes: true });
      for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) await visit(path.join(relativePath, entry.name));
      return;
    }
    snapshot.set(normalized, sha256(await readFile(absolutePath)));
  };
  for (const relativePath of immutableControlPlanePaths) await visit(relativePath);
  return snapshot;
}

export async function verifyControlPlane(baselineRepositoryRoot: string, candidateRepositoryRoot: string): Promise<ControlPlaneVerificationResult> {
  const baselineRoot = path.resolve(baselineRepositoryRoot);
  const candidateRoot = path.resolve(candidateRepositoryRoot);
  const diagnostics: ControlPlaneDiagnostic[] = [];
  const distributions = ['harness', 'harness-zh'] as const;

  const [baselineSnapshot, candidateSnapshot] = await Promise.all([immutableSnapshot(baselineRoot), immutableSnapshot(candidateRoot)]);
  for (const file of new Set([...baselineSnapshot.keys(), ...candidateSnapshot.keys()])) {
    if (baselineSnapshot.get(file) !== candidateSnapshot.get(file)) diagnostics.push({ code: 'CONTROL_PLANE_DOWNGRADE', document: file, message: `Immutable control-plane file must match the protected base: ${file}` });
  }

  for (const distribution of distributions) {
    const root = path.join(candidateRoot, distribution);
    const validation = await validateContracts(root);
    for (const diagnostic of validation.diagnostics) {
      diagnostics.push({ code: 'CONTROL_PLANE_INVALID', document: `${distribution}/${diagnostic.document}`, message: `${diagnostic.code}: ${diagnostic.message}` });
    }
    if (validation.valid) {
      const audit = await auditEnforcement(root);
      for (const diagnostic of audit.diagnostics) diagnostics.push({ code: 'CONTROL_PLANE_INVALID', document: `${distribution}/contracts/enforcement-inventory.yaml`, message: `${diagnostic.code}: ${diagnostic.message}` });
    }
  }
  if (diagnostics.length > 0) return { valid: false, diagnostics };

  const [baseline, candidate, candidateChinese] = await Promise.all([
    loadContracts(path.join(baselineRoot, 'harness')),
    loadContracts(path.join(candidateRoot, 'harness')),
    loadContracts(path.join(candidateRoot, 'harness-zh')),
  ]);
  if (stableJson(candidate) !== stableJson({ ...candidateChinese, root: candidate.root })) {
    diagnostics.push({ code: 'CONTROL_PLANE_INVALID', document: 'harness-zh', message: 'English and Chinese machine contracts must remain identical' });
  }
  const [englishInventory, chineseInventory] = await Promise.all([
    readFile(path.join(candidateRoot, 'harness/contracts/enforcement-inventory.yaml'), 'utf8').then((source) => parse(source)),
    readFile(path.join(candidateRoot, 'harness-zh/contracts/enforcement-inventory.yaml'), 'utf8').then((source) => parse(source)),
  ]);
  if (stableJson(englishInventory) !== stableJson(chineseInventory)) {
    diagnostics.push({ code: 'CONTROL_PLANE_INVALID', document: 'harness-zh/contracts/enforcement-inventory.yaml', message: 'English and Chinese enforcement inventories must remain identical' });
  }

  if (baseline.registry.version === 4 && candidate.registry.version === 4) {
    for (const baselineRule of baseline.registry.rules.filter((rule) => rule.severity === 'BLOCKER')) {
      const candidateRule = candidate.registry.rules.find((rule) => rule.id === baselineRule.id);
      if (!candidateRule || candidateRule.severity !== 'BLOCKER' || candidateRule.exception_allowed || candidateRule.enforcement.mode === 'advisory') {
        diagnostics.push({ code: 'CONTROL_PLANE_DOWNGRADE', document: 'harness/rules/registry.yaml', message: `Protected BLOCKER rule cannot be removed or weakened: ${baselineRule.id}` });
        continue;
      }
      if (baselineRule.enforcement.mode === 'machine-enforced' && candidateRule.enforcement.mode !== 'machine-enforced') {
        diagnostics.push({ code: 'CONTROL_PLANE_DOWNGRADE', document: 'harness/rules/registry.yaml', message: `Machine-enforced BLOCKER cannot be downgraded: ${baselineRule.id}` });
      }
    }
  }

  const selfRule = candidate.registry.rules.find((rule) => rule.id === 'SEC-009');
  if (candidate.registry.version !== 4 || !selfRule || selfRule.severity !== 'BLOCKER' || selfRule.exception_allowed || selfRule.enforcement?.mode !== 'machine-enforced' || !selfRule.enforcement.verifier_gate_ids.includes('gate.control-plane-integrity')) {
    diagnostics.push({ code: 'CONTROL_PLANE_DOWNGRADE', document: 'harness/rules/registry.yaml', message: 'SEC-009 must remain an unwaivable machine-enforced BLOCKER' });
  }
  const selfGate = candidate.gates.gates.find((gate) => gate.id === 'gate.control-plane-integrity');
  if (!selfGate || selfGate.kind !== 'command' || selfGate.severity !== 'BLOCKER' || selfGate.exception_allowed || selfGate.command !== 'control-plane-integrity' || selfGate.verification?.verifier_id !== 'verifier.control-plane-integrity' || !selfGate.verification.rule_ids.includes('SEC-009')) {
    diagnostics.push({ code: 'CONTROL_PLANE_DOWNGRADE', document: 'harness/contracts/gate-catalog.yaml', message: 'gate.control-plane-integrity must remain the dedicated SEC-009 command verifier' });
  }
  const selfRoute = candidate.routes.routes.find((route) => route.id === 'route.harness-self');
  if (!selfRoute || protectedPatterns.some((pattern) => !selfRoute.include.includes(pattern)) || (selfRoute.exclude?.length ?? 0) > 0 || !selfRoute.rules.includes('SEC-009') || !selfRoute.gates.includes('gate.control-plane-integrity') || !selfRoute.gates.includes('gate.peer-review') || !selfRoute.approvals.includes('security') || !selfRoute.approvals.includes('platform')) {
    diagnostics.push({ code: 'CONTROL_PLANE_DOWNGRADE', document: 'harness/contracts/routes.yaml', message: 'route.harness-self must retain every protected path without exclude, SEC-009, its verifier, and both approval roles' });
  }
  const command = candidate.profile.commands['control-plane-integrity'];
  const baselineCommand = baseline.profile.commands['control-plane-integrity'];
  if (!command || !baselineCommand || stableJson(command) !== stableJson(baselineCommand)) {
    diagnostics.push({ code: 'CONTROL_PLANE_DOWNGRADE', document: 'harness/config/project-profile.yaml', message: 'Control-plane verifier descriptor must exactly match the protected base trusted-harness command' });
  }

  const workflowDiagnostics = await analyzeWorkflowPolicyRoots(
    path.join(candidateRoot, '.github/workflows'),
    path.join(baselineRoot, '.github/workflows'),
  );
  for (const diagnostic of workflowDiagnostics) diagnostics.push({ code: 'WORKFLOW_POLICY_INVALID', document: diagnostic.document, message: `${diagnostic.code}: ${diagnostic.message}` });
  return { valid: diagnostics.length === 0, diagnostics };
}
