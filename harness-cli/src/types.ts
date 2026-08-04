export type Severity = 'BLOCKER' | 'REQUIRED' | 'CONDITIONAL';

export interface CommandDescriptor {
  executable: string;
  args: string[];
  cwd: string;
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
}

export interface GateCatalog {
  version: number;
  gates: GateDefinition[];
}

export interface RouteDefinition {
  id: string;
  include: string[];
  exclude?: string[];
  rules: string[];
  gates: string[];
  approvals: string[];
}

export interface RouteCatalog {
  version: number;
  routes: RouteDefinition[];
}

export interface RuleDefinition {
  id: string;
  module: string;
  severity: Severity;
  gates: string[];
  exception_allowed: boolean;
}

export interface RuleRegistry {
  version: number;
  modules: Record<string, { prefix: string; owner: string }>;
  rules: RuleDefinition[];
}

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

export interface ExecutionPlan {
  version: 1;
  context: ExecutionContext | null;
  source_base_revision: string | null;
  source_revision: string | null;
  operation: ClassificationInput['operation'];
  target_environment: string;
  changed_files: string[];
  risk_labels: string[];
  route_ids: string[];
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
  started_at: string;
  ended_at: string;
  gates: GateEvidence[];
  approvals: ApprovalEvidence[];
  result: 'passed' | 'failed';
  manifest_sha256: string;
}
