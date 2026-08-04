export type DiagnosticCode =
  | 'DOCUMENT_MISSING'
  | 'YAML_INVALID'
  | 'SCHEMA_INVALID'
  | 'PLACEHOLDER_FOUND'
  | 'DUPLICATE_ID'
  | 'UNKNOWN_GATE'
  | 'UNKNOWN_RULE'
  | 'UNKNOWN_COMMAND'
  | 'EXCEPTION_EXPIRED'
  | 'EXCEPTION_SCOPE_MISMATCH'
  | 'BLOCKER_EXCEPTION_FORBIDDEN'
  | 'EXCEPTION_INVALID'
  | 'EVIDENCE_INVALID'
  | 'EVIDENCE_DIGEST_MISMATCH'
  | 'EVIDENCE_ARTIFACT_MISSING'
  | 'PLAN_INVALID'
  | 'APPROVAL_INVALID'
  | 'SENSITIVE_VALUE_INLINE';

export interface Diagnostic {
  code: DiagnosticCode;
  document: string;
  path: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  diagnostics: Diagnostic[];
}
