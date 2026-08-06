import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { cp, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { exportEd25519PrivateKey } from '../../harness-cli/src/signing.ts';
import { createHarnessService, createHarnessServiceCore, type HiddenTestInvocation } from '../src/server.ts';
import { createHarnessMcpTools } from '../src/mcp.ts';

async function serviceFixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'harness-service-'));
  await cp(path.resolve('harness'), path.join(root, 'harness'), { recursive: true });
  const keys = generateKeyPairSync('ed25519');
  let invocation: Record<string, unknown> | undefined;
  const options = {
    contract_root: path.join(root, 'harness'),
    tenants: { tenant_a: { 'org/repo': { repository_root: root } } },
    hidden_tests: {
      package_id: 'hidden-suite-v1',
      run: async (input: HiddenTestInvocation) => {
        invocation = input as unknown as Record<string, unknown>;
        return { passed: true, test_count: 3 };
      },
    },
    signing_private_key_base64: exportEd25519PrivateKey(keys.privateKey),
  };
  const core = createHarnessServiceCore(options);
  const service = createHarnessService(options);
  const server = service.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return { service: core, server, base: `http://127.0.0.1:${address.port}`, getInvocation: () => invocation };
}

test('validates and plans only against the protected base contract for an authorized repository', async () => {
  const fixture = await serviceFixture();
  try {
    const validate = await fetch(`${fixture.base}/validate`, { method: 'POST', body: JSON.stringify({ tenant: 'tenant_a', repository: 'org/repo' }) });
    assert.equal(validate.status, 200);
    assert.equal((await validate.json() as { valid: boolean }).valid, true);
    const plan = await fetch(`${fixture.base}/plan`, { method: 'POST', body: JSON.stringify({ tenant: 'tenant_a', repository: 'org/repo', changed_files: ['src/example.ts'], operation: 'change', target_environment: 'test' }) });
    assert.equal(plan.status, 200);
    assert.equal((await plan.json() as { plan: { source_revision: string | null } }).plan.source_revision, null);
    const denied = await fetch(`${fixture.base}/plan`, { method: 'POST', body: JSON.stringify({ tenant: 'tenant_a', repository: 'org/other', changed_files: ['src/example.ts'], operation: 'change', target_environment: 'test' }) });
    assert.equal(denied.status, 403);
  } finally {
    await new Promise<void>((resolve) => fixture.server.close(() => resolve()));
  }
});

test('runs hidden tests through the server-side isolation contract and returns only a signature', async () => {
  const fixture = await serviceFixture();
  try {
    const response = await fetch(`${fixture.base}/hidden-tests/run`, { method: 'POST', body: JSON.stringify({ tenant: 'tenant_a', repository: 'org/repo', commit_sha: 'a'.repeat(40) }) });
    assert.equal(response.status, 200);
    const body = await response.json() as { version: number; algorithm: string; payload: Record<string, unknown>; signature_base64: string };
    assert.equal(body.algorithm, 'Ed25519');
    assert.equal(body.payload.package_id, 'hidden-suite-v1');
    assert.equal(body.payload.network, 'disabled');
    assert.equal(body.payload.credentials, 'none');
    assert.equal('source' in body.payload, false);
    assert.equal('package_path' in body.payload, false);
    assert.equal(fixture.getInvocation()?.network, 'disabled');
    assert.equal(fixture.getInvocation()?.credentials, 'none');
  } finally {
    await new Promise<void>((resolve) => fixture.server.close(() => resolve()));
  }
});

test('MCP exposes only validate, plan, and evidence verify operations', async () => {
  const fixture = await serviceFixture();
  try {
    const tools = createHarnessMcpTools(fixture.service);
    assert.deepEqual(Object.keys(tools).sort(), ['evidence_verify', 'plan', 'validate']);
    assert.equal('shell' in tools, false);
  } finally {
    await new Promise<void>((resolve) => fixture.server.close(() => resolve()));
  }
});
