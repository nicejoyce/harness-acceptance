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

test('rejects a route that omits a gate required by one of its rules', async () => {
  const documents = validDocuments();
  (documents.gates.gates as Array<Record<string, unknown>>).push({ id: 'gate.second', severity: 'REQUIRED', kind: 'command', command: 'unit-test', evidence: 'command-output', owner: 'quality', exception_allowed: true });
  (documents.registry.rules as Array<Record<string, unknown>>)[0].gates = ['gate.unit-test', 'gate.second'];
  const result = await validateContracts(await writeDocuments(documents));
  assert.ok(result.diagnostics.some((item) => item.code === 'UNKNOWN_GATE' && item.message.includes('omits required gate')));
});
