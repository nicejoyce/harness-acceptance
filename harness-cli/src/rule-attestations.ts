import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { parse } from 'yaml';

import type { Diagnostic } from './diagnostics.ts';
import { schemaErrorMessages, schemaValidator } from './schema.ts';
import { stableJson } from './hash.ts';
import { identityForApproval } from './github-identities.ts';
import type { ContractBundle, ExecutionPlan, GitHubUserType, IdentitySnapshot, PlannedRuleAttestation, RuleAttestationPolicyCatalog, RuleAttestationRecord } from './types.ts';

export interface GitHubAttestationReview {
  id: number;
  user: { login: string; type?: GitHubUserType } | null;
  state: string;
  submitted_at: string | null;
  commit_id: string;
  body: string | null;
}

export interface GitHubAttestationContext {
  repository: string;
  pull_request: number;
}

export async function loadRuleAttestationPolicies(contractRoot: string): Promise<RuleAttestationPolicyCatalog> {
  const document = path.join(contractRoot, 'contracts/rule-attestation-policies.yaml');
  const catalog = parse(await readFile(document, 'utf8')) as RuleAttestationPolicyCatalog;
  const validate = await schemaValidator('rule-attestation-policies.schema.json');
  if (!validate(catalog)) throw new Error(`Invalid rule attestation policy catalog: ${schemaErrorMessages(validate.errors).join('; ')}`);
  if (new Set(catalog.policies.map((policy) => policy.id)).size !== catalog.policies.length) throw new Error('Duplicate rule attestation policy ID');
  return catalog;
}

export async function plannedRuleAttestations(bundle: ContractBundle, ruleIds: string[]): Promise<PlannedRuleAttestation[]> {
  if (bundle.registry.version !== 4) return [];
  const humanRules = bundle.registry.rules.filter((rule) => ruleIds.includes(rule.id) && rule.enforcement.mode === 'human-attested');
  if (humanRules.length === 0) return [];
  const catalog = await loadRuleAttestationPolicies(bundle.root);
  return humanRules.map((rule) => {
    const policyId = rule.enforcement.mode === 'human-attested' ? rule.enforcement.attestation_policy_id : '';
    const policy = catalog.policies.find((candidate) => candidate.id === policyId);
    if (!policy || !policy.rule_ids.includes(rule.id)) throw new Error(`Missing attestation policy for ${rule.id}`);
    for (const role of policy.roles) if (!bundle.profile.approvals.roles[role]) throw new Error(`Unknown attestation role ${role} for ${rule.id}`);
    return {
      policy_id: policy.id,
      rule_ids: [...policy.rule_ids].sort(),
      roles: [...policy.roles].sort(),
      checklist_version: policy.checklist_version,
      required_claims: [...policy.required_claims].sort(),
    };
  }).sort((left, right) => left.policy_id.localeCompare(right.policy_id));
}

export async function validateRuleAttestations(bundle: ContractBundle, plan: ExecutionPlan, records: RuleAttestationRecord[]): Promise<Diagnostic[]> {
  const diagnostics: Diagnostic[] = [];
  const validate = await schemaValidator('rule-attestation.schema.json');
  const recordsByPolicy = new Map<string, RuleAttestationRecord[]>();
  for (const record of records) {
    const document = `rule-attestations/${record.id}`;
    if (!validate(record)) {
      diagnostics.push(...schemaErrorMessages(validate.errors).map((message) => ({ code: 'RULE_ATTESTATION_INVALID' as const, document, path: '/', message })));
      continue;
    }
    recordsByPolicy.set(record.policy_id, [...(recordsByPolicy.get(record.policy_id) ?? []), record]);
  }

  const plannedIds = new Set(plan.rule_attestations.map((planned) => planned.policy_id));
  for (const record of records) if (!plannedIds.has(record.policy_id)) diagnostics.push({ code: 'RULE_ATTESTATION_INVALID', document: `rule-attestations/${record.id}`, path: '/policy_id', message: `Unexpected rule attestation policy: ${record.policy_id}` });
  for (const planned of plan.rule_attestations) {
    const matches = recordsByPolicy.get(planned.policy_id) ?? [];
    if (matches.length === 0) {
      diagnostics.push({ code: 'RULE_ATTESTATION_MISSING', document: 'rule-attestations', path: `/${planned.policy_id}`, message: `Missing rule attestation: ${planned.policy_id}` });
      continue;
    }
    if (matches.length !== 1) diagnostics.push({ code: 'RULE_ATTESTATION_INVALID', document: 'rule-attestations', path: `/${planned.policy_id}`, message: `Rule attestation must be unique: ${planned.policy_id}` });
    for (const record of matches) {
      const authorized = bundle.profile.approvals.roles[record.role]?.some((identity) => identity.toLowerCase() === record.approver.toLowerCase()) ?? false;
      const valid = planned.roles.includes(record.role)
        && authorized
        && stableJson(record.rule_ids) === stableJson(planned.rule_ids)
        && record.checklist_version === planned.checklist_version
        && stableJson([...record.claims].sort()) === stableJson(planned.required_claims)
        && record.repository.toLowerCase() === plan.context?.repository.toLowerCase()
        && record.pull_request === plan.context?.pull_request
        && record.commit_sha === plan.source_revision;
      if (!valid) diagnostics.push({ code: 'RULE_ATTESTATION_INVALID', document: `rule-attestations/${record.id}`, path: '/', message: `Rule attestation does not match its plan, identity authorization, or execution context: ${planned.policy_id}` });
    }
  }
  return diagnostics;
}

export function createGitHubRuleAttestations(bundle: ContractBundle, plan: ExecutionPlan, reviews: GitHubAttestationReview[], context: GitHubAttestationContext, identities: IdentitySnapshot): RuleAttestationRecord[] {
  if (!plan.source_revision || !plan.context) throw new Error('GitHub rule attestations require a commit-bound execution plan');
  if (context.repository.toLowerCase() !== plan.context.repository.toLowerCase() || context.pull_request !== plan.context.pull_request) throw new Error('GitHub rule attestation context does not match the plan');
  const latestByLogin = new Map<string, GitHubAttestationReview>();
  for (const review of [...reviews].sort((left, right) => (left.submitted_at ?? '').localeCompare(right.submitted_at ?? '') || left.id - right.id)) {
    if (!review.user || !review.submitted_at || review.commit_id.toLowerCase() !== plan.source_revision) continue;
    if (review.state === 'APPROVED' || review.state === 'CHANGES_REQUESTED' || review.state === 'DISMISSED') latestByLogin.set(review.user.login.toLowerCase(), review);
  }

  const records = new Map<string, RuleAttestationRecord>();
  for (const review of latestByLogin.values()) {
    if (review.state !== 'APPROVED' || !review.user || !review.submitted_at || !review.body || !identityForApproval(identities, review.user.login, { ...context, commit_sha: plan.source_revision })) continue;
    let payload: unknown;
    try {
      payload = JSON.parse(review.body);
    } catch {
      continue;
    }
    const declarations = (payload as { harness_rule_attestations?: unknown })?.harness_rule_attestations;
    if (!Array.isArray(declarations)) continue;
    for (const declaration of declarations) {
      if (!declaration || typeof declaration !== 'object') continue;
      const value = declaration as { policy_id?: unknown; checklist_version?: unknown; claims?: unknown };
      if (typeof value.policy_id !== 'string' || typeof value.checklist_version !== 'string' || !Array.isArray(value.claims) || !value.claims.every((claim) => typeof claim === 'string')) continue;
      const planned = plan.rule_attestations.find((candidate) => candidate.policy_id === value.policy_id);
      if (!planned) continue;
      const role = planned.roles.find((candidate) => bundle.profile.approvals.roles[candidate]?.some((identity) => identity.toLowerCase() === review.user!.login.toLowerCase()));
      if (!role) continue;
      records.set(planned.policy_id, {
        id: `RAT-GH-${review.id}-${planned.policy_id}`,
        policy_id: planned.policy_id,
        rule_ids: [...planned.rule_ids],
        role,
        approver: review.user.login,
        source: 'github-review',
        repository: context.repository,
        pull_request: context.pull_request,
        commit_sha: plan.source_revision,
        checklist_version: value.checklist_version,
        claims: [...value.claims],
        review_id: review.id,
        attested_at: review.submitted_at,
      });
    }
  }
  return [...records.values()].sort((left, right) => left.policy_id.localeCompare(right.policy_id));
}
