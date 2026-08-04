import type { ExecutionContext } from './types.ts';

const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const shaPattern = /^[a-f0-9]{40,64}$/;

export function validateExecutionContext(context: ExecutionContext | null | undefined): ExecutionContext | null {
  if (context == null) return null;
  if (!repositoryPattern.test(context.repository)) throw new Error('Invalid GitHub execution context repository');
  if (!Number.isSafeInteger(context.pull_request) || context.pull_request < 1) throw new Error('Invalid GitHub execution context pull request');
  if (!shaPattern.test(context.base_sha) || !shaPattern.test(context.head_sha)) throw new Error('Invalid GitHub execution context SHA');
  return Object.freeze({ ...context });
}

export function executionContextsEqual(left: ExecutionContext | null | undefined, right: ExecutionContext | null | undefined): boolean {
  if (left == null || right == null) return left == null && right == null;
  return left.repository.toLowerCase() === right.repository.toLowerCase()
    && left.pull_request === right.pull_request
    && left.base_sha === right.base_sha
    && left.head_sha === right.head_sha;
}

export function executionContextFromParts(repository?: string, pull_request?: number, base_sha?: string, head_sha?: string): ExecutionContext | null {
  const present = [repository, pull_request, base_sha, head_sha].filter((value) => value !== undefined);
  if (present.length === 0) return null;
  if (present.length !== 4) throw new Error('GitHub execution context requires repository, pull request, base SHA, and head SHA');
  return validateExecutionContext({ repository: repository!, pull_request: pull_request!, base_sha: base_sha!, head_sha: head_sha! });
}
