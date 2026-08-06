import { sha256 } from './hash.ts';
import type { AgentAttestationRecord, GitHubUserType } from './types.ts';

export interface AgentReview {
  id: number;
  user: { login: string; type: GitHubUserType } | null;
  state: string;
  submitted_at: string | null;
  commit_id: string;
  body: string | null;
}

export interface AgentAttestationContext {
  repository: string;
  pull_request: number;
  commit_sha: string;
}

export function createAgentAttestations(reviews: AgentReview[], context: AgentAttestationContext): AgentAttestationRecord[] {
  return reviews.flatMap((review): AgentAttestationRecord[] => {
    if (!review.user || review.user.type === 'User' || !review.submitted_at || !Number.isFinite(Date.parse(review.submitted_at)) || review.commit_id.toLowerCase() !== context.commit_sha) return [];
    return [{
      id: `AGT-GH-${review.id}`,
      actor: review.user.login,
      actor_type: review.user.type,
      source: 'github-review',
      repository: context.repository,
      pull_request: context.pull_request,
      commit_sha: context.commit_sha,
      review_id: review.id,
      review_state: review.state,
      body_sha256: sha256(review.body ?? ''),
      attested_at: review.submitted_at,
    }];
  }).sort((left, right) => left.review_id - right.review_id);
}
