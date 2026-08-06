import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { classifyChanges } from '../../harness-cli/src/classifier.ts';
import { loadContracts, validateContracts } from '../../harness-cli/src/contracts.ts';
import { verifyEvidence } from '../../harness-cli/src/evidence.ts';
import { createPlan } from '../../harness-cli/src/planner.ts';
import { sha256, stableJson } from '../../harness-cli/src/hash.ts';
import type { ClassificationInput, ContractBundle, ExecutionContext } from '../../harness-cli/src/types.ts';

interface TenantRepository { repository_root: string; evidence_root?: string }

export interface HiddenTestInvocation {
  tenant: string;
  repository: string;
  commit_sha: string;
  package_id: string;
  network: 'disabled';
  credentials: 'none';
}

export interface HarnessServiceOptions {
  contract_root: string;
  tenants: Record<string, Record<string, TenantRepository>>;
  signing_private_key_base64: string;
  hidden_tests: { package_id: string; run: (input: HiddenTestInvocation) => Promise<{ passed: boolean; test_count: number }> };
}

export interface HarnessServiceCore {
  validate(input: unknown): Promise<unknown>;
  plan(input: unknown): Promise<unknown>;
  evidenceVerify(input: unknown): Promise<unknown>;
  hiddenTestsRun(input: unknown): Promise<unknown>;
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.statusCode = status;
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify(value));
}

async function body(request: IncomingMessage): Promise<unknown> {
  let source = '';
  for await (const chunk of request) {
    source += String(chunk);
    if (source.length > 1_000_000) throw new Error('Request body too large');
  }
  return source.length === 0 ? {} : JSON.parse(source);
}

function objectInput(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Request body must be an object');
  return input as Record<string, unknown>;
}

function textInput(input: Record<string, unknown>, name: string): string {
  if (typeof input[name] !== 'string' || input[name] === '') throw new Error(`Missing ${name}`);
  return input[name] as string;
}

function repositoryContext(options: HarnessServiceOptions, input: Record<string, unknown>): { tenant: string; repository: string; target: TenantRepository } {
  const tenant = textInput(input, 'tenant');
  const repository = textInput(input, 'repository');
  const target = options.tenants[tenant]?.[repository];
  if (!target) throw Object.assign(new Error('Repository is not authorized for this tenant'), { statusCode: 403 });
  return { tenant, repository, target };
}

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function signHiddenResult(payload: Record<string, unknown>, encoded: string): Record<string, unknown> {
  const key = createPrivateKey({ key: Buffer.from(encoded, 'base64'), format: 'der', type: 'pkcs8' });
  const publicDer = createPublicKey(key).export({ format: 'der', type: 'spki' });
  return { version: 1, algorithm: 'Ed25519', key_id: sha256(publicDer), payload, signature_base64: sign(null, Buffer.from(stableJson(payload)), key).toString('base64') };
}

export function createHarnessServiceCore(options: HarnessServiceOptions): HarnessServiceCore {
  const loadBase = async (): Promise<ContractBundle> => loadContracts(options.contract_root);
  return {
    async validate(input) {
      repositoryContext(options, objectInput(input));
      return validateContracts(options.contract_root);
    },
    async plan(input) {
      const request = objectInput(input);
      repositoryContext(options, request);
      const bundle = await loadBase();
      const classificationInput: ClassificationInput = {
        changed_files: request.changed_files as string[],
        risk_labels: request.risk_labels as string[] | undefined,
        operation: request.operation as ClassificationInput['operation'],
        target_environment: textInput(request, 'target_environment'),
      };
      const classification = classifyChanges(bundle, classificationInput);
      return { plan: await createPlan(bundle, classification, []) };
    },
    async evidenceVerify(input) {
      const request = objectInput(input);
      const target = repositoryContext(options, request).target;
      const manifestPath = path.resolve(textInput(request, 'manifest_path'));
      const evidenceRoot = path.resolve(target.evidence_root ?? target.repository_root);
      if (!inside(evidenceRoot, manifestPath)) throw Object.assign(new Error('Manifest path is outside the authorized evidence root'), { statusCode: 403 });
      const context = request.context as ExecutionContext | null | undefined;
      return verifyEvidence(options.contract_root, manifestPath, target.repository_root, context ?? null);
    },
    async hiddenTestsRun(input) {
      const request = objectInput(input);
      const { tenant, repository } = repositoryContext(options, request);
      const commitSha = textInput(request, 'commit_sha');
      const result = await options.hidden_tests.run({ tenant, repository, commit_sha: commitSha, package_id: options.hidden_tests.package_id, network: 'disabled', credentials: 'none' });
      return signHiddenResult({ version: 1, tenant, repository, commit_sha: commitSha, package_id: options.hidden_tests.package_id, passed: result.passed, test_count: result.test_count, network: 'disabled', credentials: 'none' }, options.signing_private_key_base64);
    },
  };
}

export function createHarnessService(options: HarnessServiceOptions): Server {
  const core = createHarnessServiceCore(options);
  return createServer(async (request, response) => {
    try {
      if (request.method !== 'POST') return json(response, 405, { error: 'POST required' });
      const input = await body(request);
      const handlers: Record<string, (value: unknown) => Promise<unknown>> = {
        '/validate': core.validate,
        '/plan': core.plan,
        '/evidence/verify': core.evidenceVerify,
        '/hidden-tests/run': core.hiddenTestsRun,
      };
      const handler = handlers[request.url ?? ''];
      if (!handler) return json(response, 404, { error: 'Unknown endpoint' });
      return json(response, 200, await handler(input));
    } catch (error) {
      const status = typeof error === 'object' && error !== null && 'statusCode' in error && typeof (error as { statusCode?: unknown }).statusCode === 'number' ? (error as { statusCode: number }).statusCode : 400;
      return json(response, status, { error: error instanceof Error ? error.message : String(error) });
    }
  });
}
