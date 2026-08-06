import type { ExecutionContext, IdentitySnapshot, IdentitySubject } from './types.ts';

export interface CreateIdentitySnapshotInput {
  repository: string;
  pull_request: number;
  commit_sha: string;
  author: string;
  captured_at: string;
  subjects: IdentitySubject[];
}

const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const commitPattern = /^[a-f0-9]{40,64}$/;

function validTimestamp(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

export function createIdentitySnapshot(input: CreateIdentitySnapshotInput): IdentitySnapshot {
  if (!repositoryPattern.test(input.repository) || !Number.isSafeInteger(input.pull_request) || input.pull_request < 1) throw new Error('Invalid identity snapshot context');
  if (!commitPattern.test(input.commit_sha) || input.author.trim().length === 0 || !validTimestamp(input.captured_at)) throw new Error('Invalid identity snapshot metadata');
  const seen = new Set<string>();
  const subjects = input.subjects.map((subject) => {
    const login = subject.login.trim();
    const key = login.toLowerCase();
    if (login.length === 0 || seen.has(key) || !validTimestamp(subject.queried_at)) throw new Error('Invalid or duplicate identity subject');
    seen.add(key);
    return { ...subject, login };
  }).sort((left, right) => left.login.toLowerCase().localeCompare(right.login.toLowerCase()));
  return { version: 1, repository: input.repository, pull_request: input.pull_request, commit_sha: input.commit_sha, author: input.author, captured_at: input.captured_at, subjects };
}

export function identityForApproval(snapshot: IdentitySnapshot, login: string, context: Pick<ExecutionContext, 'repository' | 'pull_request'> & { commit_sha: string }): IdentitySubject | undefined {
  if (snapshot.repository.toLowerCase() !== context.repository.toLowerCase() || snapshot.pull_request !== context.pull_request || snapshot.commit_sha !== context.commit_sha) return undefined;
  if (snapshot.author.toLowerCase() === login.toLowerCase()) return undefined;
  const subject = snapshot.subjects.find((candidate) => candidate.login.toLowerCase() === login.toLowerCase());
  return subject?.user_type === 'User' && subject.affiliation_state === 'active' ? subject : undefined;
}
