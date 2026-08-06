export type Severity = 'BLOCKER' | 'REQUIRED' | 'CONDITIONAL';

export interface CommandDescriptor {
  executable: string;
  args: string[];
  cwd: string;
  execution_root?: 'project' | 'trusted-harness';
  timeout_seconds: number;
  environment?: Record<string, string>;
  inherited_environment?: string[];
  sensitive_environment?: string[];
}

export interface ProjectProfile {
  version: number;
  project: {
    name: string;
    owner: string;
    data_classification: 'public' | 'internal' | 'confidential' | 'restricted';
  };
  commands: Record<string, CommandDescriptor>;
  approvals: { roles: Record<string, string[]> };
}

export interface GateDefinition {
  id: string;
  severity: Severity;
  kind: 'command' | 'manual-review';
  command?: string;
  evidence: string;
  owner: string;
  exception_allowed: boolean;
  depends_on?: string[];
  verification?: {
    verifier_id: string;
    scope: 'rule-specific';
    rule_ids: string[];
  };
}

export interface LegacyGateCatalog {
  version: 1;
  gates: GateDefinition[];
}

export interface VerifiedGateCatalog {
  version: 2;
  gates: GateDefinition[];
}

export type GateCatalog = LegacyGateCatalog | VerifiedGateCatalog;

export interface RouteDefinition {
  id: string;
  include: string[];
  exclude?: string[];
  extends?: string;
  risk_tier?: RiskTier;
  fallback?: boolean;
  rules: string[];
  gates: string[];
  approvals: string[];
}

export interface RouteCatalog {
  version: number;
  routes: RouteDefinition[];
}

export type RiskTier = 'low' | 'medium' | 'high' | 'critical';

interface RuleDefinitionBase {
  id: string;
  module: string;
  severity: Severity;
  gates: string[];
  exception_allowed: boolean;
}

export interface LegacyRuleDefinition extends RuleDefinitionBase {
  enforcement?: never;
}

export type RuleEnforcement =
  | { mode: 'machine-enforced'; verifier_gate_ids: string[] }
  | { mode: 'human-attested'; attestation_policy_id: string }
  | { mode: 'advisory' };

export interface EnforcedRuleDefinition extends RuleDefinitionBase {
  enforcement: RuleEnforcement;
}

export type RuleDefinition = LegacyRuleDefinition | EnforcedRuleDefinition;

export interface LegacyRuleRegistry {
  version: 3;
  modules: Record<string, { prefix: string; owner: string }>;
  rules: LegacyRuleDefinition[];
}

export interface EnforcedRuleRegistry {
  version: 4;
  modules: Record<string, { prefix: string; owner: string }>;
  rules: EnforcedRuleDefinition[];
}

export type RuleRegistry = LegacyRuleRegistry | EnforcedRuleRegistry;

export interface ContractBundle {
  root: string;
  profile: ProjectProfile;
  gates: GateCatalog;
  routes: RouteCatalog;
  registry: RuleRegistry;
}

export interface ClassificationInput {
  changed_files: string[];
  risk_labels?: string[];
  operation: 'change' | 'merge' | 'release';
  target_environment: string;
}

export interface Classification {
  changed_files: string[];
  route_ids: string[];
  rule_ids: string[];
  gate_ids: string[];
  approvals: string[];
  risk_labels: string[];
  operation: ClassificationInput['operation'];
  target_environment: string;
  risk_tier: RiskTier;
}

export interface ExecutionContext {
  repository: string;
  pull_request: number;
  base_sha: string;
  head_sha: string;
}

export interface ExceptionRecord {
  id: string;
  rule_ids: string[];
  gate_ids: string[];
  scope: { paths: string[] };
  reason: string;
  risk: string;
  compensating_controls: string[];
  approver: string;
  approval_reference: string;
  created_at: string;
  review_at: string;
  expires_at: string;
  removal_plan: string;
}

export interface ApprovalRecord {
  id: string;
  gate_ids: string[];
  role: string;
  approver: string;
  source: 'github-review';
  repository: string;
  pull_request: number;
  review_id: number;
  commit_sha: string;
  approval_reference: string;
  approved_at: string;
  expires_at: string;
}

export type GitHubUserType = 'User' | 'Bot' | 'Organization' | 'App';
export type IdentityApiSource = 'github-organization-membership' | 'github-repository-collaborator-permission';

export interface IdentitySubject {
  login: string;
  user_type: GitHubUserType;
  affiliation_state: 'active' | 'inactive';
  api_source: IdentityApiSource;
  queried_at: string;
}

export interface IdentitySnapshot {
  version: 1;
  repository: string;
  pull_request: number;
  commit_sha: string;
  author: string;
  captured_at: string;
  subjects: IdentitySubject[];
}

export interface AgentAttestationRecord {
  id: string;
  actor: string;
  actor_type: Exclude<GitHubUserType, 'User'>;
  source: 'github-review';
  repository: string;
  pull_request: number;
  commit_sha: string;
  review_id: number;
  review_state: string;
  body_sha256: string;
  attested_at: string;
}

export interface PlannedGate {
  id: string;
  severity: Severity;
  kind: GateDefinition['kind'];
  command?: string;
  rule_ids: string[];
  depends_on: string[];
  exception_id?: string;
  approval_id?: string;
  approval_digest?: string;
}

export interface RuleAttestationPolicy {
  id: string;
  rule_ids: string[];
  roles: string[];
  checklist_version: string;
  required_claims: string[];
}

export interface RuleAttestationPolicyCatalog {
  version: 1;
  policies: RuleAttestationPolicy[];
}

export interface PlannedRuleAttestation {
  policy_id: string;
  rule_ids: string[];
  roles: string[];
  checklist_version: string;
  required_claims: string[];
}

export interface RuleAttestationRecord {
  id: string;
  policy_id: string;
  rule_ids: string[];
  role: string;
  approver: string;
  source: 'github-review';
  repository: string;
  pull_request: number;
  commit_sha: string;
  checklist_version: string;
  claims: string[];
  review_id: number;
  attested_at: string;
}

export interface ExecutionPlan {
  version: 1;
  lane: 'fast' | 'full';
  risk_tier: RiskTier;
  expected_platforms: Array<'linux' | 'win32' | 'darwin'>;
  execution_platforms: Array<'linux' | 'win32' | 'darwin'>;
  platform_reason_codes: string[];
  fallback_full_matrix: boolean;
  platform_mode: 'shadow' | 'enforce' | 'fallback';
  context: ExecutionContext | null;
  source_base_revision: string | null;
  source_revision: string | null;
  operation: ClassificationInput['operation'];
  target_environment: string;
  changed_files: string[];
  risk_labels: string[];
  route_ids: string[];
  rule_ids: string[];
  rule_attestations: PlannedRuleAttestation[];
  approvals: string[];
  gates: PlannedGate[];
}

export type GateState = 'passed' | 'failed' | 'timed_out' | 'cancelled' | 'exception';

export interface GateEvidence {
  gate_id: string;
  rule_ids: string[];
  command_digest?: string;
  started_at: string;
  ended_at: string;
  duration_ms: number;
  exit_code: number | null;
  state: GateState;
  log_path?: string;
  log_sha256?: string;
  exception_id?: string;
  approval_id?: string;
  approval_digest?: string;
}

export interface ApprovalEvidence {
  role: string;
  approval_ids: string[];
  state: 'passed' | 'failed';
}

export interface CiProvenance {
  provider: 'github-actions';
  repository: string;
  run_id: string;
  run_attempt: number;
  workflow_ref: string;
  event_name: string;
}

export interface EvidenceManifest {
  version: 1;
  lane: 'fast' | 'full';
  risk_tier: RiskTier;
  harness_version: string;
  run_id: string;
  repository_root: string;
  context: ExecutionContext | null;
  commit_sha: string | null;
  ci_provenance: CiProvenance | null;
  platform: string;
  node_version: string;
  operation: ClassificationInput['operation'];
  target_environment: string;
  changed_files: string[];
  route_ids: string[];
  contracts_sha256: string;
  plan_path: string;
  plan_sha256: string;
  exceptions_path: string;
  exceptions_sha256: string;
  approvals_path: string;
  approvals_sha256: string;
  rule_attestations_path: string;
  rule_attestations_sha256: string;
  started_at: string;
  ended_at: string;
  gates: GateEvidence[];
  approvals: ApprovalEvidence[];
  result: 'passed' | 'failed';
  manifest_sha256: string;
}
