import { identityForApproval } from './github-identities.ts';
import type { ApprovalRecord, ContractBundle, ExecutionPlan, GitHubUserType, IdentitySnapshot } from './types.ts';

export interface GitHubReview {
  id: number;
  user: { login: string; type?: GitHubUserType } | null;
  state: string;
  submitted_at: string | null;
  commit_id: string;
  html_url: string;
}

export interface GitHubApprovalContext {
  repository: string;
  pull_request: number;
}

export function createGitHubApprovals(bundle: ContractBundle, plan: ExecutionPlan, reviews: GitHubReview[], context: GitHubApprovalContext, identitySnapshot: IdentitySnapshot): ApprovalRecord[] {
  if (!plan.source_revision) throw new Error('GitHub approvals require a commit-bound execution plan');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(context.repository) || !Number.isSafeInteger(context.pull_request) || context.pull_request < 1) throw new Error('Invalid GitHub approval context');
  const manualGateIds = plan.gates.filter((gate) => gate.kind === 'manual-review').map((gate) => gate.id).sort();
  if (manualGateIds.length === 0) return [];
  const latest = new Map<string, GitHubReview>();
  const ordered = reviews
    .filter((review) => review.user && review.submitted_at && review.commit_id.toLowerCase() === plan.source_revision)
    .sort((left, right) => left.submitted_at!.localeCompare(right.submitted_at!) || left.id - right.id);
  for (const review of ordered) {
    if (review.state === 'APPROVED' || review.state === 'CHANGES_REQUESTED' || review.state === 'DISMISSED') latest.set(review.user!.login.toLowerCase(), review);
  }

  const records: ApprovalRecord[] = [];
  for (const role of plan.approvals) {
    const authorizedLogins = bundle.profile.approvals.roles[role] ?? [];
    const review = authorizedLogins.map((identity) => latest.get(identity.toLowerCase())).find((candidate) => candidate?.state === 'APPROVED' && candidate.user && identityForApproval(identitySnapshot, candidate.user.login, { ...context, commit_sha: plan.source_revision! }));
    if (!review?.user || !review.submitted_at) continue;
    const expires = new Date(review.submitted_at);
    expires.setUTCDate(expires.getUTCDate() + 7);
    records.push({
      id: `APP-GH-${review.id}-${role}`,
      gate_ids: manualGateIds,
      role,
      approver: review.user.login,
      source: 'github-review',
      repository: context.repository,
      pull_request: context.pull_request,
      review_id: review.id,
      commit_sha: plan.source_revision,
      approval_reference: `https://github.com/${context.repository}/pull/${context.pull_request}#pullrequestreview-${review.id}`,
      approved_at: review.submitted_at,
      expires_at: expires.toISOString(),
    });
  }
  return records;
}
