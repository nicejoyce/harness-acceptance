import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { validateContracts } from '../src/contracts.ts';

type Documents = {
  profile: Record<string, unknown>;
  gates: Record<string, unknown>;
  routes: Record<string, unknown>;
  registry: Record<string, unknown>;
};

function validDocuments(): Documents {
  return {
    profile: {
      version: 1,
      project: { name: 'fixture', owner: 'engineering', data_classification: 'internal' },
      commands: {
        'unit-test': { executable: 'node', args: ['--version'], cwd: '.', timeout_seconds: 30 },
      },
      approvals: { roles: { engineering: ['engineering'] } },
    },
    gates: {
      version: 1,
      gates: [
        {
          id: 'gate.unit-test',
          severity: 'REQUIRED',
          kind: 'command',
          command: 'unit-test',
          evidence: 'command-output',
          owner: 'quality',
          exception_allowed: true,
        },
      ],
    },
    routes: {
      version: 1,
      routes: [
        {
          id: 'route.default',
          include: ['**/*'],
          rules: ['TEST-001'],
          gates: ['gate.unit-test'],
          approvals: [],
        },
      ],
    },
    registry: {
      version: 3,
      modules: { quality_engineering: { prefix: 'TEST', owner: 'quality' } },
      rules: [
        {
          id: 'TEST-001',
          module: 'quality_engineering',
          severity: 'REQUIRED',
          gates: ['gate.unit-test'],
          exception_allowed: true,
        },
      ],
    },
  };
}

function validV4Documents(): Documents {
  const documents = validDocuments();
  documents.gates.version = 2;
  const gate = (documents.gates.gates as Array<Record<string, unknown>>)[0];
  gate.verification = {
    verifier_id: 'verifier.test-001',
    scope: 'rule-specific',
    rule_ids: ['TEST-001'],
  };
  documents.registry.version = 4;
  const rule = (documents.registry.rules as Array<Record<string, unknown>>)[0];
  rule.enforcement = {
    mode: 'machine-enforced',
    verifier_gate_ids: ['gate.unit-test'],
  };
  return documents;
}

async function writeDocuments(documents: Documents): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'harness-contracts-'));
  await Promise.all([
    mkdir(path.join(root, 'config'), { recursive: true }),
    mkdir(path.join(root, 'contracts'), { recursive: true }),
    mkdir(path.join(root, 'rules'), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(path.join(root, 'config/project-profile.yaml'), JSON.stringify(documents.profile)),
    writeFile(path.join(root, 'contracts/gate-catalog.yaml'), JSON.stringify(documents.gates)),
    writeFile(path.join(root, 'contracts/routes.yaml'), JSON.stringify(documents.routes)),
    writeFile(path.join(root, 'rules/registry.yaml'), JSON.stringify(documents.registry)),
  ]);
  return root;
}

test('accepts a valid canonical contract bundle', async () => {
  const root = await writeDocuments(validDocuments());
  const result = await validateContracts(root);
  assert.equal(result.valid, true, JSON.stringify(result.diagnostics));
});

test('accepts a valid v4 enforcement contract bundle', async () => {
  const result = await validateContracts(await writeDocuments(validV4Documents()));
  assert.equal(result.valid, true, JSON.stringify(result.diagnostics));
});

test('requires enforcement declarations on every v4 rule', async () => {
  const documents = validV4Documents();
  delete (documents.registry.rules as Array<Record<string, unknown>>)[0].enforcement;
  const result = await validateContracts(await writeDocuments(documents));
  assert.ok(result.diagnostics.some((item) => item.code === 'SCHEMA_INVALID' && item.document === 'rules/registry.yaml'));
});

test('rejects advisory BLOCKER rules', async () => {
  const documents = validV4Documents();
  const rule = (documents.registry.rules as Array<Record<string, unknown>>)[0];
  rule.severity = 'BLOCKER';
  rule.exception_allowed = false;
  rule.gates = [];
  rule.enforcement = { mode: 'advisory' };
  const result = await validateContracts(await writeDocuments(documents));
  assert.ok(result.diagnostics.some((item) => item.code === 'ENFORCEMENT_INVALID' && item.message.includes('BLOCKER')));
});

test('rejects machine-enforced rules without verifier gates', async () => {
  const documents = validV4Documents();
  (documents.registry.rules as Array<Record<string, unknown>>)[0].enforcement = { mode: 'machine-enforced' };
  const result = await validateContracts(await writeDocuments(documents));
  assert.ok(result.diagnostics.some((item) => item.code === 'SCHEMA_INVALID' && item.message.includes('verifier_gate_ids')));
});

test('rejects manual-review gates used as machine verifiers', async () => {
  const documents = validV4Documents();
  const gate = (documents.gates.gates as Array<Record<string, unknown>>)[0];
  gate.kind = 'manual-review';
  delete gate.command;
  delete gate.verification;
  const result = await validateContracts(await writeDocuments(documents));
  assert.ok(result.diagnostics.some((item) => item.code === 'ENFORCEMENT_INVALID' && item.message.includes('command gate')));
});

test('rejects verification metadata on manual-review gates', async () => {
  const documents = validV4Documents();
  const gate = (documents.gates.gates as Array<Record<string, unknown>>)[0];
  gate.kind = 'manual-review';
  delete gate.command;
  const result = await validateContracts(await writeDocuments(documents));
  assert.ok(result.diagnostics.some((item) => item.code === 'SCHEMA_INVALID' && item.document === 'contracts/gate-catalog.yaml'));
});

test('requires gate catalog v2 for a v4 rule registry', async () => {
  const documents = validV4Documents();
  documents.gates.version = 1;
  delete (documents.gates.gates as Array<Record<string, unknown>>)[0].verification;
  const result = await validateContracts(await writeDocuments(documents));
  assert.ok(result.diagnostics.some((item) => item.code === 'ENFORCEMENT_INVALID' && item.message.includes('gate catalog v2')));
});

test('rejects verifier gates that are not selected by the rule', async () => {
  const documents = validV4Documents();
  (documents.registry.rules as Array<Record<string, unknown>>)[0].gates = [];
  const result = await validateContracts(await writeDocuments(documents));
  assert.ok(result.diagnostics.some((item) => item.code === 'ENFORCEMENT_INVALID' && item.message.includes('must select verifier gate')));
});

test('rejects verifier metadata that does not bind the verified rule', async () => {
  const documents = validV4Documents();
  const gate = (documents.gates.gates as Array<Record<string, unknown>>)[0];
  gate.verification = {
    verifier_id: 'verifier.other-001',
    scope: 'rule-specific',
    rule_ids: ['OTHER-001'],
  };
  const result = await validateContracts(await writeDocuments(documents));
  assert.ok(result.diagnostics.some((item) => item.code === 'ENFORCEMENT_INVALID' && item.message.includes('does not declare rule')));
});

test('rejects gate verification declarations not referenced by the declared rule', async () => {
  const documents = validV4Documents();
  const rule = (documents.registry.rules as Array<Record<string, unknown>>)[0];
  rule.enforcement = { mode: 'human-attested', attestation_policy_id: 'attestation.test-001' };
  const result = await validateContracts(await writeDocuments(documents));
  assert.ok(result.diagnostics.some((item) => item.code === 'ENFORCEMENT_INVALID' && item.message.includes('is not referenced by rule')));
});

test('requires an attestation policy for human-attested rules', async () => {
  const documents = validV4Documents();
  (documents.registry.rules as Array<Record<string, unknown>>)[0].enforcement = { mode: 'human-attested' };
  const result = await validateContracts(await writeDocuments(documents));
  assert.ok(result.diagnostics.some((item) => item.code === 'SCHEMA_INVALID' && item.message.includes('attestation_policy_id')));
});

test('rejects advisory rules that still select blocking gates', async () => {
  const documents = validV4Documents();
  const rule = (documents.registry.rules as Array<Record<string, unknown>>)[0];
  rule.enforcement = { mode: 'advisory' };
  const result = await validateContracts(await writeDocuments(documents));
  assert.ok(result.diagnostics.some((item) => item.code === 'ENFORCEMENT_INVALID' && item.message.includes('cannot select blocking gates')));
});

test('rejects an empty project profile', async () => {
  const documents = validDocuments();
  documents.profile = {};
  const result = await validateContracts(await writeDocuments(documents));
  assert.equal(result.valid, false);
  assert.ok(result.diagnostics.some((item) => item.code === 'SCHEMA_INVALID'));
});

test('rejects unresolved placeholders', async () => {
  const documents = validDocuments();
  (documents.profile.project as Record<string, unknown>).name = '<project-name>';
  const result = await validateContracts(await writeDocuments(documents));
  assert.ok(result.diagnostics.some((item) => item.code === 'PLACEHOLDER_FOUND'));
});

test('rejects unknown fields', async () => {
  const documents = validDocuments();
  documents.profile.unknown = true;
  const result = await validateContracts(await writeDocuments(documents));
  assert.ok(result.diagnostics.some((item) => item.code === 'SCHEMA_INVALID'));
});

test('rejects duplicate rule IDs', async () => {
  const documents = validDocuments();
  const rules = documents.registry.rules as unknown[];
  rules.push(structuredClone(rules[0]));
  const result = await validateContracts(await writeDocuments(documents));
  assert.ok(result.diagnostics.some((item) => item.code === 'DUPLICATE_ID'));
});

test('rejects dangling gate references', async () => {
  const documents = validDocuments();
  (documents.registry.rules as Array<Record<string, unknown>>)[0].gates = ['gate.missing'];
  const result = await validateContracts(await writeDocuments(documents));
  assert.ok(result.diagnostics.some((item) => item.code === 'UNKNOWN_GATE'));
});

test('rejects unknown approval roles and routes that cannot collect approvals', async () => {
  const documents = validDocuments();
  const route = (documents.routes.routes as Array<Record<string, unknown>>)[0];
  route.approvals = ['security'];
  const result = await validateContracts(await writeDocuments(documents));
  assert.ok(result.diagnostics.some((item) => item.code === 'APPROVAL_INVALID'));

  (documents.profile.approvals as Record<string, unknown>).roles = { engineering: ['engineering'], security: ['security'] };
  const impossible = await validateContracts(await writeDocuments(documents));
  assert.ok(impossible.diagnostics.some((item) => item.code === 'APPROVAL_INVALID'));
});

test('rejects sensitive environment values embedded in the project profile', async () => {
  const documents = validDocuments();
  const command = (documents.profile.commands as Record<string, Record<string, unknown>>)['unit-test'];
  command.environment = { API_TOKEN: 'plaintext-secret' };
  command.sensitive_environment = ['API_TOKEN'];
  const result = await validateContracts(await writeDocuments(documents));
  assert.ok(result.diagnostics.some((item) => item.code === 'SENSITIVE_VALUE_INLINE'));
});

test('accepts only explicit project or trusted Harness command roots', async () => {
  const trusted = validDocuments();
  (trusted.profile.commands as Record<string, Record<string, unknown>>)['unit-test'].execution_root = 'trusted-harness';
  assert.equal((await validateContracts(await writeDocuments(trusted))).valid, true);

  const invalid = validDocuments();
  (invalid.profile.commands as Record<string, Record<string, unknown>>)['unit-test'].execution_root = 'pull-request-controlled';
  const result = await validateContracts(await writeDocuments(invalid));
  assert.ok(result.diagnostics.some((item) => item.code === 'SCHEMA_INVALID'));
});

test('rejects a route that omits a gate required by one of its rules', async () => {
  const documents = validDocuments();
  (documents.gates.gates as Array<Record<string, unknown>>).push({ id: 'gate.second', severity: 'REQUIRED', kind: 'command', command: 'unit-test', evidence: 'command-output', owner: 'quality', exception_allowed: true });
  (documents.registry.rules as Array<Record<string, unknown>>)[0].gates = ['gate.unit-test', 'gate.second'];
  const result = await validateContracts(await writeDocuments(documents));
  assert.ok(result.diagnostics.some((item) => item.code === 'UNKNOWN_GATE' && item.message.includes('omits required gate')));
});
