#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { minimatch } from 'minimatch';

import { classifyChanges } from './classifier.ts';
import { loadContracts, validateContracts } from './contracts.ts';
import { verifyEvidence } from './evidence.ts';
import { ExitCode, exitCodeForManifest } from './exit-codes.ts';
import { createPlan, PlanningError, verifyPlan } from './planner.ts';
import { runPlan } from './runner.ts';
import { schemaErrorMessages, schemaValidator } from './schema.ts';
import { assertGitPlanContext, changedFilesFromGit, GitPlanContextError, gitRepositoryRoot, resolveGitRevision } from './git.ts';
import { executionContextFromParts, executionContextsEqual } from './context.ts';
import { createGitHubApprovals, type GitHubReview } from './github-approvals.ts';
import { aggregateTrustedEvidence, type GitHubJobConclusion } from './aggregate.ts';
import { loadTrustedEd25519PublicKeys, signFinalResult, verifySignedFinalResult, type SignedFinalResult } from './signing.ts';
import { analyzeWorkflowPolicy, analyzeWorkflowPolicyRoots } from './workflow-policy.ts';
import { listWorkflowFiles } from './workflow-policy.ts';
import { loadWorkflowSecurityTools, runWorkflowAuditors } from './workflow-auditors.ts';
import { auditEnforcement } from './enforcement-audit.ts';
import { verifyControlPlane } from './control-plane.ts';
import { createGitHubRuleAttestations, type GitHubAttestationReview } from './rule-attestations.ts';
import { createIdentitySnapshot } from './github-identities.ts';
import { createAgentAttestations, type AgentReview } from './agent-attestations.ts';
import { verifyChangedLineCoverage } from './coverage.ts';
import { classifyDependencyChange, loadDependencyPolicy, type DependencyChangeInput } from './dependencies.ts';
import { loadTestQualityPolicy, runRegressionProof } from './regression-proof.ts';
import { evaluateStrykerReport } from './mutation.ts';
import { deriveDeliveryRecord, renderDeliveryRecord } from './records.ts';
import { loadPlatformPolicy, platformMatrix, type PlatformId } from './platforms.ts';
import { evaluatePlatformMetrics, platformAuditSampleFromFinal } from './platform-metrics.ts';
import type { ApprovalRecord, ExceptionRecord, ExecutionContext, ExecutionPlan, IdentitySnapshot, IdentitySubject, RuleAttestationRecord } from './types.ts';
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

function valueFromEnvironment(name: string): string {
  if (!/^[A-Z][A-Z0-9_]*$/.test(name)) throw new PlanningError(`Invalid environment variable name: ${name}`);
  const result = process.env[name];
  if (!result) throw new PlanningError(`Missing required environment variable ${name}`);
  return result;
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

async function readRuleAttestations(args: string[]): Promise<RuleAttestationRecord[]> {
  const attestationPath = values(args, '--rule-attestations').at(-1);
  if (!attestationPath) return [];
  return JSON.parse(await readFile(attestationPath, 'utf8')) as RuleAttestationRecord[];
}

async function main(args: string[]): Promise<number> {
  const json = args.includes('--json');
  const root = path.resolve(value(args, '--root', '.'));
  const projectRoot = path.resolve(value(args, '--project-root', root));
  const command = args[0];

  if (command === 'workflow-policy' && args[1] === 'check') {
    const workflowPath = values(args, '--workflow').at(-1);
    const workflowRoot = values(args, '--workflow-root').at(-1);
    if (Boolean(workflowPath) === Boolean(workflowRoot)) throw new Error('Specify exactly one of --workflow or --workflow-root');
    const baselineWorkflowRoot = values(args, '--baseline-workflow-root').at(-1);
    if (baselineWorkflowRoot && !workflowRoot) throw new Error('--baseline-workflow-root requires --workflow-root');
    const diagnostics = workflowRoot
      ? await analyzeWorkflowPolicyRoots(path.resolve(workflowRoot), baselineWorkflowRoot ? path.resolve(baselineWorkflowRoot) : undefined)
      : analyzeWorkflowPolicy(await readFile(path.resolve(workflowPath!), 'utf8'));
    const result = { valid: diagnostics.length === 0, diagnostics };
    writeResult(result, json);
    return result.valid ? ExitCode.SUCCESS : ExitCode.CONTRACT_INVALID;
  }

  if (command === 'workflow-policy' && args[1] === 'audit-external') {
    const workflowRoot = path.resolve(value(args, '--workflow-root'));
    const config = await loadWorkflowSecurityTools(path.resolve(value(args, '--config')));
    const workflowFiles = await listWorkflowFiles(workflowRoot);
    await runWorkflowAuditors(config, workflowFiles, path.resolve(value(args, '--tools-dir')));
    writeResult({ valid: true, diagnostics: [], tools: Object.fromEntries(Object.entries(config.tools).map(([name, tool]) => [name, tool.version])) }, json);
    return ExitCode.SUCCESS;
  }

  if (command === 'enforcement' && args[1] === 'audit') {
    const result = await auditEnforcement(root);
    writeResult(result, json);
    return result.valid ? ExitCode.SUCCESS : ExitCode.CONTRACT_INVALID;
  }

  if (command === 'coverage' && args[1] === 'verify') {
    try {
      const result = await verifyChangedLineCoverage({
        repository_root: projectRoot,
        base: values(args, '--base-env').length > 0 ? valueFromEnvironment(value(args, '--base-env')) : value(args, '--base'),
        head: values(args, '--head-env').length > 0 ? valueFromEnvironment(value(args, '--head-env')) : value(args, '--head'),
        report_path: path.resolve(value(args, '--report')),
        minimum: Number(value(args, '--minimum', '80')),
        critical_minimum: Number(value(args, '--critical-minimum', '90')),
      });
      writeResult(result, json);
      return result.valid ? ExitCode.SUCCESS : ExitCode.EVIDENCE_INVALID;
    } catch (error) {
      writeResult({ valid: false, error: error instanceof Error ? error.message : String(error) }, json);
      return ExitCode.EVIDENCE_INVALID;
    }
  }

  if (command === 'dependencies' && args[1] === 'classify') {
    try {
      await loadDependencyPolicy(root);
      const input = JSON.parse(await readFile(value(args, '--input'), 'utf8')) as DependencyChangeInput;
      const classification = classifyDependencyChange(input);
      writeResult({ valid: true, classification }, json);
      return ExitCode.SUCCESS;
    } catch (error) {
      writeResult({ valid: false, error: error instanceof Error ? error.message : String(error) }, json);
      return ExitCode.CONTRACT_INVALID;
    }
  }

  if (command === 'regression-proof' && args[1] === 'verify') {
    try {
      const policy = await loadTestQualityPolicy(root);
      const base = values(args, '--base-env').length > 0 ? valueFromEnvironment(value(args, '--base-env')) : value(args, '--base');
      const head = values(args, '--head-env').length > 0 ? valueFromEnvironment(value(args, '--head-env')) : value(args, '--head');
      const changedTests = (values(args, '--changed-test').length > 0 ? values(args, '--changed-test') : await changedFilesFromGit(projectRoot, base, head))
        .filter((file) => policy.changed_test_patterns.some((pattern) => minimatch(file, pattern, { dot: true })));
      const result = await runRegressionProof({ repository_root: projectRoot, base, head, changed_tests: changedTests, command: policy.test_command });
      writeResult(result, json);
      return result.valid ? ExitCode.SUCCESS : ExitCode.EVIDENCE_INVALID;
    } catch (error) {
      writeResult({ valid: false, error: error instanceof Error ? error.message : String(error) }, json);
      return ExitCode.EVIDENCE_INVALID;
    }
  }

  if (command === 'mutation' && args[1] === 'verify') {
    try {
      const policy = await loadTestQualityPolicy(root);
      const report = JSON.parse(await readFile(value(args, '--report'), 'utf8')) as unknown;
      const result = evaluateStrykerReport(report, values(args, '--changed-module'), policy.mutation.smoke_threshold);
      writeResult(result, json);
      return result.valid ? ExitCode.SUCCESS : ExitCode.EVIDENCE_INVALID;
    } catch (error) {
      writeResult({ valid: false, error: error instanceof Error ? error.message : String(error) }, json);
      return ExitCode.EVIDENCE_INVALID;
    }
  }

  if (command === 'control-plane' && args[1] === 'verify') {
    const result = await verifyControlPlane(path.resolve(value(args, '--baseline-root')), path.resolve(value(args, '--candidate-root')));
    writeResult(result, json);
    return result.valid ? ExitCode.SUCCESS : ExitCode.CONTRACT_INVALID;
  }

  if (command === 'validate') {
    const result = await validateContracts(root);
    writeResult(result, json);
    return result.valid ? ExitCode.SUCCESS : ExitCode.CONTRACT_INVALID;
  }

  if (command === 'identities' && args[1] === 'github') {
    try {
      const context = githubExecutionContext(args, true)!;
      const subjects = JSON.parse(await readFile(value(args, '--subjects'), 'utf8')) as IdentitySubject[];
      const snapshot = createIdentitySnapshot({
        repository: context.repository,
        pull_request: context.pull_request,
        commit_sha: context.head_sha,
        author: value(args, '--author'),
        captured_at: value(args, '--captured-at', new Date().toISOString()),
        subjects,
      });
      const validate = await schemaValidator('identity-snapshot.schema.json');
      if (!validate(snapshot)) throw new PlanningError(schemaErrorMessages(validate.errors).join('; '));
      const output = path.resolve(value(args, '--output'));
      await mkdir(path.dirname(output), { recursive: true });
      await writeFile(output, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
      writeResult({ valid: true, output, identity_snapshot: snapshot }, json);
      return ExitCode.SUCCESS;
    } catch (error) {
      writeResult({ valid: false, error: error instanceof Error ? error.message : String(error) }, json);
      return ExitCode.CONTRACT_INVALID;
    }
  }

  if (command === 'attestations' && args[1] === 'agents') {
    try {
      const context = githubExecutionContext(args, true)!;
      const reviews = JSON.parse(await readFile(value(args, '--reviews'), 'utf8')) as AgentReview[];
      const records = createAgentAttestations(reviews, { repository: context.repository, pull_request: context.pull_request, commit_sha: context.head_sha });
      const validate = await schemaValidator('agent-attestation.schema.json');
      for (const record of records) if (!validate(record)) throw new PlanningError(schemaErrorMessages(validate.errors).join('; '));
      const output = path.resolve(value(args, '--output'));
      await mkdir(path.dirname(output), { recursive: true });
      await writeFile(output, `${JSON.stringify(records, null, 2)}\n`, 'utf8');
      writeResult({ valid: true, output, agent_attestations: records }, json);
      return ExitCode.SUCCESS;
    } catch (error) {
      writeResult({ valid: false, error: error instanceof Error ? error.message : String(error) }, json);
      return ExitCode.CONTRACT_INVALID;
    }
  }

  if (command === 'plan') {
    try {
      const bundle = await loadContracts(root);
      const operation = value(args, '--operation', 'merge');
      if (!['change', 'merge', 'release'].includes(operation)) throw new PlanningError(`Invalid operation: ${operation}`);
      const context = githubExecutionContext(args);
      const lane = value(args, '--lane', context ? 'full' : 'fast');
      if (lane !== 'fast' && lane !== 'full') throw new PlanningError(`Invalid lane: ${lane}`);
      const gitBase = values(args, '--git-base').at(-1);
      const gitHead = value(args, '--git-head', 'HEAD');
      if (context && (!gitBase || values(args, '--git-head').length === 0)) throw new PlanningError('GitHub execution context requires --git-base and --git-head');
      const gitRoot = gitBase ? await gitRepositoryRoot(projectRoot) : undefined;
      if (gitRoot && gitRoot !== projectRoot) throw new PlanningError('--project-root must be the Git repository root');
      const changedFiles = gitBase ? await changedFilesFromGit(gitRoot!, gitBase, gitHead) : values(args, '--changed-file');
      if (changedFiles.length === 0) throw new PlanningError('No changed files were provided or detected');
      const classification = classifyChanges(bundle, {
        changed_files: changedFiles,
        risk_labels: [...values(args, '--risk-label'), ...jsonStringArray(args, '--risk-labels-json')],
        operation: operation as 'change' | 'merge' | 'release',
        target_environment: value(args, '--environment', 'test'),
      });
      const plan = await createPlan(bundle, classification, await readExceptions(args), new Date(), gitRoot ? await resolveGitRevision(gitRoot, gitHead) : null, gitRoot ? await resolveGitRevision(gitRoot, gitBase!) : null, context, lane);
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
        if (gitRoot !== projectRoot) throw new PlanningError('--project-root must be the Git repository root');
        await assertGitPlanContext(gitRoot, (plan as ExecutionPlan).source_base_revision!, (plan as ExecutionPlan).source_revision!, (plan as ExecutionPlan).changed_files);
      } else {
        try {
          await gitRepositoryRoot(projectRoot);
          throw new PlanningError('Plans executed inside a Git repository must be Git-bound');
        } catch (error) {
          if (error instanceof PlanningError) throw error;
        }
      }
      const manifest = await runPlan(bundle, plan as ExecutionPlan, { output_dir: outputDir, project_root: projectRoot, exceptions: await readExceptions(args), approvals: await readApprovals(args), rule_attestations: await readRuleAttestations(args), ...(context ?? {}), ci_provenance: ciProvenance(args) });
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
      if (gitRoot !== projectRoot) throw new PlanningError('--project-root must be the Git repository root');
      if (!(plan as ExecutionPlan).source_base_revision || !(plan as ExecutionPlan).source_revision) throw new PlanningError('GitHub approvals require a Git-bound plan');
      if (!executionContextsEqual((plan as ExecutionPlan).context, context)) throw new PlanningError('GitHub approvals context does not match the plan');
      await assertGitPlanContext(gitRoot, (plan as ExecutionPlan).source_base_revision!, (plan as ExecutionPlan).source_revision!, (plan as ExecutionPlan).changed_files);
      const reviews = JSON.parse(await readFile(value(args, '--reviews'), 'utf8')) as GitHubReview[];
      const identities = JSON.parse(await readFile(value(args, '--identities'), 'utf8')) as IdentitySnapshot;
      const approvals = createGitHubApprovals(bundle, plan as ExecutionPlan, reviews, { repository: context.repository, pull_request: context.pull_request }, identities);
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

  if (command === 'attestations' && args[1] === 'github') {
    try {
      const context = githubExecutionContext(args, true)!;
      const bundle = await loadContracts(root);
      const plan: unknown = JSON.parse(await readFile(value(args, '--plan'), 'utf8'));
      const validatePlan = await schemaValidator('plan.schema.json');
      if (!validatePlan(plan)) throw new PlanningError(schemaErrorMessages(validatePlan.errors).join('; '));
      await verifyPlan(bundle, plan as ExecutionPlan, []);
      if (!(plan as ExecutionPlan).source_base_revision || !(plan as ExecutionPlan).source_revision) throw new PlanningError('GitHub attestations require a Git-bound plan');
      if (!executionContextsEqual((plan as ExecutionPlan).context, context)) throw new PlanningError('GitHub attestation context does not match the plan');
      const reviews = JSON.parse(await readFile(value(args, '--reviews'), 'utf8')) as GitHubAttestationReview[];
      const identities = JSON.parse(await readFile(value(args, '--identities'), 'utf8')) as IdentitySnapshot;
      const ruleAttestations = createGitHubRuleAttestations(bundle, plan as ExecutionPlan, reviews, { repository: context.repository, pull_request: context.pull_request }, identities);
      const output = path.resolve(value(args, '--output'));
      await mkdir(path.dirname(output), { recursive: true });
      await writeFile(output, `${JSON.stringify(ruleAttestations, null, 2)}\n`, 'utf8');
      writeResult({ valid: true, output, rule_attestations: ruleAttestations }, json);
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
      const expectedRuleAttestations = JSON.parse(await readFile(value(args, '--expected-rule-attestations'), 'utf8')) as RuleAttestationRecord[];
      const finalResult = await aggregateTrustedEvidence({
        contract_root: root,
        project_root: projectRoot,
        context,
        manifest_paths: values(args, '--manifest').map((item) => path.resolve(item)),
        job_conclusion: conclusion,
        expected_approvals: expectedApprovals,
        expected_rule_attestations: expectedRuleAttestations,
      });
      const privateKey = process.env.HARNESS_ED25519_PRIVATE_KEY_B64;
      if (!privateKey) throw new Error('HARNESS_ED25519_PRIVATE_KEY_B64 is required');
      const envelope = signFinalResult(finalResult, privateKey);
      const output = path.resolve(value(args, '--output'));
      await mkdir(path.dirname(output), { recursive: true });
      await writeFile(output, `${JSON.stringify(envelope, null, 2)}\n`, 'utf8');
      const sampleOutput = values(args, '--platform-sample-output').at(-1);
      if (sampleOutput) {
        const samplePath = path.resolve(sampleOutput);
        await mkdir(path.dirname(samplePath), { recursive: true });
        await writeFile(samplePath, `${JSON.stringify(platformAuditSampleFromFinal(finalResult), null, 2)}\n`, 'utf8');
      }
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

  if (command === 'records' && args[1] === 'render') {
    try {
      const format = value(args, '--format') as 'markdown' | 'json';
      if (format !== 'markdown' && format !== 'json') throw new Error('Record format must be markdown or json');
      const anchors = loadTrustedEd25519PublicKeys(process.env.HARNESS_ED25519_PUBLIC_KEYS_JSON, process.env.HARNESS_ED25519_PUBLIC_KEY_B64);
      const record = await deriveDeliveryRecord({
        contract_root: root,
        project_root: projectRoot,
        manifest_path: path.resolve(value(args, '--manifest')),
        final_path: path.resolve(value(args, '--final')),
        trusted_public_keys: anchors,
      });
      const rendered = renderDeliveryRecord(record, format);
      const outputValue = values(args, '--output').at(-1);
      if (outputValue) {
        const output = path.resolve(outputValue);
        await mkdir(path.dirname(output), { recursive: true });
        await writeFile(output, rendered, 'utf8');
        writeResult({ valid: true, output }, json);
      } else {
        process.stdout.write(rendered);
      }
      return ExitCode.SUCCESS;
    } catch (error) {
      writeResult({ valid: false, error: error instanceof Error ? error.message : String(error) }, json);
      return ExitCode.EVIDENCE_INVALID;
    }
  }

  if (command === 'platforms' && args[1] === 'matrix') {
    try {
      const plan: unknown = JSON.parse(await readFile(path.resolve(value(args, '--plan')), 'utf8'));
      const validatePlan = await schemaValidator('plan.schema.json');
      if (!validatePlan(plan)) throw new PlanningError(schemaErrorMessages(validatePlan.errors).join('; '));
      const policy = await loadPlatformPolicy(root);
      const matrix = platformMatrix(policy, (plan as ExecutionPlan).execution_platforms as PlatformId[]);
      writeResult(matrix, json);
      return ExitCode.SUCCESS;
    } catch (error) {
      writeResult({ valid: false, error: error instanceof Error ? error.message : String(error) }, json);
      return ExitCode.PLANNING_FAILED;
    }
  }

  if (command === 'platform-metrics' && args[1] === 'evaluate') {
    try {
      const samples = JSON.parse(await readFile(path.resolve(value(args, '--input')), 'utf8')) as unknown;
      if (!Array.isArray(samples)) throw new Error('Platform metrics input must be an array');
      const report = evaluatePlatformMetrics(samples as never[]);
      const outputValue = values(args, '--output').at(-1);
      if (outputValue) {
        const output = path.resolve(outputValue);
        await mkdir(path.dirname(output), { recursive: true });
        await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
      }
      writeResult(report, json || !outputValue);
      return ExitCode.SUCCESS;
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

  throw new Error('Usage: harness <validate|plan|run|coverage verify|regression-proof verify|mutation verify|dependencies classify|workflow-policy check|enforcement audit|control-plane verify|identities github|approvals github|attestations github|attestations agents|evidence verify|final aggregate|final verify|records render|platforms matrix|platform-metrics evaluate> [options]');
}

main(process.argv.slice(2))
  .then((code) => { process.exitCode = code; })
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = ExitCode.INTERNAL_ERROR;
  });
