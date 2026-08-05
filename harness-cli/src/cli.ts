#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { classifyChanges } from './classifier.ts';
import { loadContracts, validateContracts } from './contracts.ts';
import { verifyEvidence } from './evidence.ts';
import { ExitCode, exitCodeForManifest } from './exit-codes.ts';
import { createPlan, PlanningError, verifyPlan } from './planner.ts';
import { runPlan } from './runner.ts';
import { schemaErrorMessages, schemaValidator } from './schema.ts';
import { assertGitPlanContext, changedFilesFromGit, GitPlanContextError, gitRepositoryRoot, pathsReferToSameLocation, resolveGitRevision } from './git.ts';
import { executionContextFromParts, executionContextsEqual } from './context.ts';
import { createGitHubApprovals, type GitHubReview } from './github-approvals.ts';
import { aggregateTrustedEvidence, type GitHubJobConclusion } from './aggregate.ts';
import { loadTrustedEd25519PublicKeys, signFinalResult, verifySignedFinalResult, type SignedFinalResult } from './signing.ts';
import type { ApprovalRecord, ExceptionRecord, ExecutionContext, ExecutionPlan } from './types.ts';
import type { CiProvenance } from './types.ts';

function values(args: string[], flag: string): string[] {
  const result: string[] = [];
  for (let index = 0; index < args.length; index += 1) if (args[index] === flag && args[index + 1]) result.push(args[index + 1]);
  return result;
}

function value(args: string[], flag: string, fallback?: string): string {
  const result = values(args, flag).at(-1) ?? fallback;
  if (result === undefined) throw new Error(`Missing required option ${flag}`);
  return result;
}

function jsonStringArray(args: string[], flag: string): string[] {
  const raw = values(args, flag).at(-1);
  if (!raw) return [];
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === 'string')) throw new PlanningError(`${flag} must be a JSON string array`);
  return parsed;
}

function positiveInteger(args: string[], flag: string): number {
  const raw = value(args, flag);
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new PlanningError(`${flag} must be a positive integer`);
  return parsed;
}

function githubExecutionContext(args: string[], required = false): ExecutionContext | null {
  const flags = ['--repository', '--pull-request', '--base-sha', '--head-sha'];
  const present = flags.filter((flag) => values(args, flag).length > 0);
  if (present.length === 0) {
    if (required) throw new PlanningError('GitHub execution context requires --repository, --pull-request, --base-sha, and --head-sha');
    return null;
  }
  if (present.length !== flags.length) throw new PlanningError('GitHub execution context requires --repository, --pull-request, --base-sha, and --head-sha');
  try {
    return executionContextFromParts(
      value(args, '--repository'),
      positiveInteger(args, '--pull-request'),
      value(args, '--base-sha'),
      value(args, '--head-sha'),
    );
  } catch (error) {
    throw new PlanningError(error instanceof Error ? error.message : 'Invalid GitHub execution context');
  }
}

function ciProvenance(args: string[]): CiProvenance | undefined {
  const flags = ['--github-repository', '--github-run-id', '--github-run-attempt', '--github-workflow-ref', '--github-event-name'];
  const present = flags.filter((flag) => values(args, flag).length > 0);
  if (present.length === 0) return undefined;
  if (present.length !== flags.length) throw new PlanningError('GitHub CI provenance requires every --github-* option');
  const repository = value(args, '--github-repository');
  const runId = value(args, '--github-run-id');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || !/^[1-9][0-9]*$/.test(runId)) throw new PlanningError('Invalid GitHub CI provenance');
  return {
    provider: 'github-actions',
    repository,
    run_id: runId,
    run_attempt: positiveInteger(args, '--github-run-attempt'),
    workflow_ref: value(args, '--github-workflow-ref'),
    event_name: value(args, '--github-event-name'),
  };
}

function writeResult(result: unknown, json: boolean): void {
  if (json) process.stdout.write(`${JSON.stringify(result)}\n`);
  else process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

async function readExceptions(args: string[]): Promise<ExceptionRecord[]> {
  const exceptionPath = values(args, '--exceptions').at(-1);
  if (!exceptionPath) return [];
  return JSON.parse(await readFile(exceptionPath, 'utf8')) as ExceptionRecord[];
}

async function readApprovals(args: string[]): Promise<ApprovalRecord[]> {
  const approvalPath = values(args, '--approvals').at(-1);
  if (!approvalPath) return [];
  return JSON.parse(await readFile(approvalPath, 'utf8')) as ApprovalRecord[];
}

async function main(args: string[]): Promise<number> {
  const json = args.includes('--json');
  const root = path.resolve(value(args, '--root', '.'));
  const projectRoot = path.resolve(value(args, '--project-root', root));
  const command = args[0];

  if (command === 'validate') {
    const result = await validateContracts(root);
    writeResult(result, json);
    return result.valid ? ExitCode.SUCCESS : ExitCode.CONTRACT_INVALID;
  }

  if (command === 'plan') {
    try {
      const bundle = await loadContracts(root);
      const operation = value(args, '--operation', 'merge');
      if (!['change', 'merge', 'release'].includes(operation)) throw new PlanningError(`Invalid operation: ${operation}`);
      const context = githubExecutionContext(args);
      const gitBase = values(args, '--git-base').at(-1);
      const gitHead = value(args, '--git-head', 'HEAD');
      if (context && (!gitBase || values(args, '--git-head').length === 0)) throw new PlanningError('GitHub execution context requires --git-base and --git-head');
      const gitRoot = gitBase ? await gitRepositoryRoot(projectRoot) : undefined;
      if (gitRoot && !await pathsReferToSameLocation(gitRoot, projectRoot)) throw new PlanningError('--project-root must be the Git repository root');
      const changedFiles = gitBase ? await changedFilesFromGit(gitRoot!, gitBase, gitHead) : values(args, '--changed-file');
      if (changedFiles.length === 0) throw new PlanningError('No changed files were provided or detected');
      const classification = classifyChanges(bundle, {
        changed_files: changedFiles,
        risk_labels: [...values(args, '--risk-label'), ...jsonStringArray(args, '--risk-labels-json')],
        operation: operation as 'change' | 'merge' | 'release',
        target_environment: value(args, '--environment', 'test'),
      });
      const plan = await createPlan(bundle, classification, await readExceptions(args), new Date(), gitRoot ? await resolveGitRevision(gitRoot, gitHead) : null, gitRoot ? await resolveGitRevision(gitRoot, gitBase!) : null, context);
      const output = value(args, '--output', path.join(root, '.harness/plan.json'));
      await mkdir(path.dirname(output), { recursive: true });
      await writeFile(output, `${JSON.stringify(plan, null, 2)}\n`, 'utf8');
      writeResult({ valid: true, output, plan }, json);
      return ExitCode.SUCCESS;
    } catch (error) {
      writeResult({ valid: false, error: error instanceof Error ? error.message : String(error) }, json);
      return error instanceof PlanningError ? ExitCode.PLANNING_FAILED : ExitCode.CONTRACT_INVALID;
    }
  }

  if (command === 'run') {
    try {
      const context = githubExecutionContext(args);
      const bundle = await loadContracts(root);
      const plan: unknown = JSON.parse(await readFile(value(args, '--plan'), 'utf8'));
      const validatePlan = await schemaValidator('plan.schema.json');
      if (!validatePlan(plan)) {
        writeResult({ valid: false, diagnostics: schemaErrorMessages(validatePlan.errors) }, json);
        return ExitCode.PLANNING_FAILED;
      }
      const outputDir = path.resolve(value(args, '--output', path.join(root, '.harness/evidence')));
      if ((plan as ExecutionPlan).source_revision || (plan as ExecutionPlan).source_base_revision) {
        if (!(plan as ExecutionPlan).source_revision || !(plan as ExecutionPlan).source_base_revision) throw new PlanningError('Git-bound plans require both source revisions');
        const gitRoot = await gitRepositoryRoot(projectRoot);
        if (!await pathsReferToSameLocation(gitRoot, projectRoot)) throw new PlanningError('--project-root must be the Git repository root');
        await assertGitPlanContext(gitRoot, (plan as ExecutionPlan).source_base_revision!, (plan as ExecutionPlan).source_revision!, (plan as ExecutionPlan).changed_files);
      } else {
        try {
          await gitRepositoryRoot(projectRoot);
          throw new PlanningError('Plans executed inside a Git repository must be Git-bound');
        } catch (error) {
          if (error instanceof PlanningError) throw error;
        }
      }
      const manifest = await runPlan(bundle, plan as ExecutionPlan, { output_dir: outputDir, project_root: projectRoot, exceptions: await readExceptions(args), approvals: await readApprovals(args), ...(context ?? {}), ci_provenance: ciProvenance(args) });
      writeResult(manifest, json);
      return exitCodeForManifest(manifest);
    } catch (error) {
      writeResult({ valid: false, error: error instanceof Error ? error.message : String(error) }, json);
      return error instanceof PlanningError || error instanceof GitPlanContextError ? ExitCode.PLANNING_FAILED : ExitCode.INTERNAL_ERROR;
    }
  }

  if (command === 'approvals' && args[1] === 'github') {
    try {
      const context = githubExecutionContext(args, true)!;
      const bundle = await loadContracts(root);
      const plan: unknown = JSON.parse(await readFile(value(args, '--plan'), 'utf8'));
      const validatePlan = await schemaValidator('plan.schema.json');
      if (!validatePlan(plan)) throw new PlanningError(schemaErrorMessages(validatePlan.errors).join('; '));
      await verifyPlan(bundle, plan as ExecutionPlan, []);
      const gitRoot = await gitRepositoryRoot(projectRoot);
      if (!await pathsReferToSameLocation(gitRoot, projectRoot)) throw new PlanningError('--project-root must be the Git repository root');
      if (!(plan as ExecutionPlan).source_base_revision || !(plan as ExecutionPlan).source_revision) throw new PlanningError('GitHub approvals require a Git-bound plan');
      if (!executionContextsEqual((plan as ExecutionPlan).context, context)) throw new PlanningError('GitHub approvals context does not match the plan');
      await assertGitPlanContext(gitRoot, (plan as ExecutionPlan).source_base_revision!, (plan as ExecutionPlan).source_revision!, (plan as ExecutionPlan).changed_files);
      const reviews = JSON.parse(await readFile(value(args, '--reviews'), 'utf8')) as GitHubReview[];
      const approvals = createGitHubApprovals(bundle, plan as ExecutionPlan, reviews, { repository: context.repository, pull_request: context.pull_request });
      const output = path.resolve(value(args, '--output'));
      await mkdir(path.dirname(output), { recursive: true });
      await writeFile(output, `${JSON.stringify(approvals, null, 2)}\n`, 'utf8');
      writeResult({ valid: true, output, approvals }, json);
      return ExitCode.SUCCESS;
    } catch (error) {
      writeResult({ valid: false, error: error instanceof Error ? error.message : String(error) }, json);
      return error instanceof PlanningError ? ExitCode.PLANNING_FAILED : ExitCode.CONTRACT_INVALID;
    }
  }

  if (command === 'final' && args[1] === 'aggregate') {
    try {
      const context = githubExecutionContext(args);
      const conclusion = value(args, '--job-conclusion') as GitHubJobConclusion;
      if (!['success', 'failure', 'cancelled', 'skipped'].includes(conclusion)) throw new PlanningError('Invalid GitHub job conclusion');
      const expectedApprovals = JSON.parse(await readFile(value(args, '--expected-approvals'), 'utf8')) as ApprovalRecord[];
      const finalResult = await aggregateTrustedEvidence({
        contract_root: root,
        project_root: projectRoot,
        context,
        manifest_paths: values(args, '--manifest').map((item) => path.resolve(item)),
        job_conclusion: conclusion,
        expected_approvals: expectedApprovals,
      });
      const privateKey = process.env.HARNESS_ED25519_PRIVATE_KEY_B64;
      if (!privateKey) throw new Error('HARNESS_ED25519_PRIVATE_KEY_B64 is required');
      const envelope = signFinalResult(finalResult, privateKey);
      const output = path.resolve(value(args, '--output'));
      await mkdir(path.dirname(output), { recursive: true });
      await writeFile(output, `${JSON.stringify(envelope, null, 2)}\n`, 'utf8');
      writeResult({ valid: true, output, final: envelope }, json);
      return ExitCode.SUCCESS;
    } catch (error) {
      writeResult({ valid: false, error: error instanceof Error ? error.message : String(error) }, json);
      return ExitCode.EVIDENCE_INVALID;
    }
  }

  if (command === 'final' && args[1] === 'verify') {
    try {
      const envelope: unknown = JSON.parse(await readFile(path.resolve(value(args, '--input')), 'utf8'));
      const validate = await schemaValidator('final.schema.json');
      const schemaValid = validate(envelope);
      const diagnostics = schemaValid ? [] : schemaErrorMessages(validate.errors);
      let valid = false;
      if (schemaValid) {
        const signed = envelope as SignedFinalResult;
        const anchors = loadTrustedEd25519PublicKeys(process.env.HARNESS_ED25519_PUBLIC_KEYS_JSON, process.env.HARNESS_ED25519_PUBLIC_KEY_B64);
        const publicKey = anchors.get(signed.key_id);
        valid = publicKey !== undefined && verifySignedFinalResult(signed, publicKey);
        if (!valid) diagnostics.push(`No valid trusted Ed25519 signature for key ID ${signed.key_id}`);
      }
      writeResult({ valid, diagnostics }, json);
      return valid ? ExitCode.SUCCESS : ExitCode.EVIDENCE_INVALID;
    } catch (error) {
      writeResult({ valid: false, error: error instanceof Error ? error.message : String(error) }, json);
      return ExitCode.EVIDENCE_INVALID;
    }
  }

  if (command === 'evidence' && args[1] === 'verify') {
    const context = githubExecutionContext(args);
    const result = await verifyEvidence(root, path.resolve(value(args, '--manifest')), projectRoot, context);
    writeResult(result, json);
    return result.valid ? ExitCode.SUCCESS : ExitCode.EVIDENCE_INVALID;
  }

  throw new Error('Usage: harness <validate|plan|run|approvals github|evidence verify|final aggregate|final verify> [options]');
}

main(process.argv.slice(2))
  .then((code) => { process.exitCode = code; })
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = ExitCode.INTERNAL_ERROR;
  });
