import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Ajv, type ErrorObject, type ValidateFunction } from 'ajv';
import { parse } from 'yaml';

import type { Diagnostic, ValidationResult } from './diagnostics.ts';
import type { ContractBundle, GateCatalog, ProjectProfile, RouteCatalog, RuleRegistry } from './types.ts';

const documents = {
  profile: { relativePath: 'config/project-profile.yaml', schema: 'project-profile.schema.json' },
  gates: { relativePath: 'contracts/gate-catalog.yaml', schema: 'gate-catalog.schema.json' },
  routes: { relativePath: 'contracts/routes.yaml', schema: 'routes.schema.json' },
  registry: { relativePath: 'rules/registry.yaml', schema: 'registry.schema.json' },
} as const;

type DocumentName = keyof typeof documents;

const schemaRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../schemas');

async function validators(): Promise<Record<DocumentName, ValidateFunction>> {
  const ajv = new Ajv({ allErrors: true, strict: true });
  const entries = await Promise.all(
    Object.entries(documents).map(async ([name, definition]) => {
      const source = await readFile(path.join(schemaRoot, definition.schema), 'utf8');
      return [name, ajv.compile(JSON.parse(source))] as const;
    }),
  );
  return Object.fromEntries(entries) as Record<DocumentName, ValidateFunction>;
}

function schemaDiagnostics(document: string, errors: ErrorObject[] | null | undefined): Diagnostic[] {
  return (errors ?? []).map((error) => ({
    code: 'SCHEMA_INVALID',
    document,
    path: error.instancePath || '/',
    message: error.message ?? 'Schema validation failed',
  }));
}

function findPlaceholders(value: unknown, document: string, currentPath = ''): Diagnostic[] {
  if (typeof value === 'string' && /<[^<>]+>/.test(value)) {
    return [{ code: 'PLACEHOLDER_FOUND', document, path: currentPath || '/', message: 'Unresolved placeholder found' }];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => findPlaceholders(item, document, `${currentPath}/${index}`));
  }
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, item]) => findPlaceholders(item, document, `${currentPath}/${key}`));
  }
  return [];
}

function duplicateDiagnostics(ids: string[], document: string, subject: string): Diagnostic[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) duplicates.add(id);
    seen.add(id);
  }
  return [...duplicates].sort().map((id) => ({
    code: 'DUPLICATE_ID',
    document,
    path: '/',
    message: `Duplicate ${subject} ID: ${id}`,
  }));
}

function semanticDiagnostics(bundle: ContractBundle): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const gateIds = new Set(bundle.gates.gates.map((gate) => gate.id));
  const ruleIds = new Set(bundle.registry.rules.map((rule) => rule.id));
  const commandIds = new Set(Object.keys(bundle.profile.commands));
  const approvalRoles = new Set(Object.keys(bundle.profile.approvals.roles));

  diagnostics.push(...duplicateDiagnostics(bundle.gates.gates.map((gate) => gate.id), documents.gates.relativePath, 'gate'));
  diagnostics.push(...duplicateDiagnostics(bundle.routes.routes.map((route) => route.id), documents.routes.relativePath, 'route'));
  diagnostics.push(...duplicateDiagnostics(bundle.registry.rules.map((rule) => rule.id), documents.registry.relativePath, 'rule'));

  for (const gate of bundle.gates.gates) {
    if (gate.command && !commandIds.has(gate.command)) {
      diagnostics.push({ code: 'UNKNOWN_COMMAND', document: documents.gates.relativePath, path: `/gates/${gate.id}/command`, message: `Unknown command: ${gate.command}` });
    }
    for (const dependency of gate.depends_on ?? []) {
      if (!gateIds.has(dependency)) diagnostics.push({ code: 'UNKNOWN_GATE', document: documents.gates.relativePath, path: `/gates/${gate.id}/depends_on`, message: `Unknown gate: ${dependency}` });
    }
  }
  for (const [commandId, command] of Object.entries(bundle.profile.commands)) {
    for (const key of command.sensitive_environment ?? []) {
      if (command.environment?.[key] !== undefined) diagnostics.push({ code: 'SENSITIVE_VALUE_INLINE', document: documents.profile.relativePath, path: `/commands/${commandId}/environment/${key}`, message: `Sensitive environment value must be inherited at runtime: ${key}` });
    }
  }
  for (const rule of bundle.registry.rules) {
    for (const gateId of rule.gates) {
      if (!gateIds.has(gateId)) diagnostics.push({ code: 'UNKNOWN_GATE', document: documents.registry.relativePath, path: `/rules/${rule.id}/gates`, message: `Unknown gate: ${gateId}` });
    }
  }
  for (const route of bundle.routes.routes) {
    for (const ruleId of route.rules) {
      if (!ruleIds.has(ruleId)) diagnostics.push({ code: 'UNKNOWN_RULE', document: documents.routes.relativePath, path: `/routes/${route.id}/rules`, message: `Unknown rule: ${ruleId}` });
    }
    for (const gateId of route.gates) {
      if (!gateIds.has(gateId)) diagnostics.push({ code: 'UNKNOWN_GATE', document: documents.routes.relativePath, path: `/routes/${route.id}/gates`, message: `Unknown gate: ${gateId}` });
    }
    const requiredGates = new Set(route.rules.flatMap((ruleId) => bundle.registry.rules.find((rule) => rule.id === ruleId)?.gates ?? []));
    for (const gateId of requiredGates) {
      if (!route.gates.includes(gateId)) diagnostics.push({ code: 'UNKNOWN_GATE', document: documents.routes.relativePath, path: `/routes/${route.id}/gates`, message: `Route ${route.id} omits required gate ${gateId}` });
    }
    for (const role of route.approvals) {
      if (!approvalRoles.has(role)) diagnostics.push({ code: 'APPROVAL_INVALID', document: documents.routes.relativePath, path: `/routes/${route.id}/approvals`, message: `Unknown approval role: ${role}` });
    }
    if (route.approvals.length > 0 && !route.gates.some((gateId) => bundle.gates.gates.find((gate) => gate.id === gateId)?.kind === 'manual-review')) {
      diagnostics.push({ code: 'APPROVAL_INVALID', document: documents.routes.relativePath, path: `/routes/${route.id}/approvals`, message: `Route ${route.id} requires approvals but selects no manual-review gate` });
    }
  }
  return diagnostics;
}

async function readDocument(root: string, name: DocumentName, validate: ValidateFunction): Promise<{ value?: unknown; diagnostics: Diagnostic[] }> {
  const document = documents[name].relativePath;
  const absolutePath = path.join(root, document);
  try {
    await access(absolutePath);
  } catch {
    return { diagnostics: [{ code: 'DOCUMENT_MISSING', document, path: '/', message: 'Required document is missing' }] };
  }

  let value: unknown;
  try {
    value = parse(await readFile(absolutePath, 'utf8'));
  } catch (error) {
    return { diagnostics: [{ code: 'YAML_INVALID', document, path: '/', message: error instanceof Error ? error.message : 'Invalid YAML' }] };
  }

  const diagnostics = findPlaceholders(value, document);
  if (!validate(value)) diagnostics.push(...schemaDiagnostics(document, validate.errors));
  return { value, diagnostics };
}

export async function validateContracts(root: string): Promise<ValidationResult> {
  const compiled = await validators();
  const loaded = await Promise.all(
    (Object.keys(documents) as DocumentName[]).map(async (name) => [name, await readDocument(root, name, compiled[name])] as const),
  );
  const values = Object.fromEntries(loaded) as Record<DocumentName, { value?: unknown; diagnostics: Diagnostic[] }>;
  const diagnostics = loaded.flatMap(([, result]) => result.diagnostics);
  if (diagnostics.some((item) => item.code === 'DOCUMENT_MISSING' || item.code === 'YAML_INVALID' || item.code === 'SCHEMA_INVALID')) {
    return { valid: false, diagnostics };
  }

  const bundle: ContractBundle = {
    root: path.resolve(root),
    profile: values.profile.value as ProjectProfile,
    gates: values.gates.value as GateCatalog,
    routes: values.routes.value as RouteCatalog,
    registry: values.registry.value as RuleRegistry,
  };
  diagnostics.push(...semanticDiagnostics(bundle));
  return { valid: diagnostics.length === 0, diagnostics };
}

export async function loadContracts(root: string): Promise<ContractBundle> {
  const result = await validateContracts(root);
  if (!result.valid) throw new Error(JSON.stringify(result.diagnostics));
  const values = await Promise.all(
    (Object.keys(documents) as DocumentName[]).map(async (name) => parse(await readFile(path.join(root, documents[name].relativePath), 'utf8'))),
  );
  return { root: path.resolve(root), profile: values[0], gates: values[1], routes: values[2], registry: values[3] } as ContractBundle;
}
