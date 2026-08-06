import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import YAML from 'yaml';
import { loadContracts } from '../src/contracts.ts';

test('PowerShell wrappers delegate to the TypeScript CLI', async () => {
  for (const file of ['harness/scripts/Validate-Harness.ps1', 'harness-zh/scripts/Validate-Harness.ps1']) {
    const source = await readFile(file, 'utf8');
    assert.match(source, /harness-cli[\\/]src[\\/]cli\.ts/);
    assert.match(source, /node/);
    assert.doesNotMatch(source, /Get-ChildItem.+-Filter '\*\.md'/s);
  }
});

test('canonical distributions prepare project dependencies through a declared setup gate', async () => {
  for (const root of ['harness', 'harness-zh']) {
    const bundle = await loadContracts(root);
    assert.ok(bundle.profile.commands['dependency-setup']);
    const setup = bundle.gates.gates.find((gate) => gate.id === 'gate.setup');
    assert.equal(setup?.command, 'dependency-setup');
    const catalog = new Map(bundle.gates.gates.map((gate) => [gate.id, gate]));
    const followsSetup = (gateId: string, seen = new Set<string>()): boolean => {
      if (gateId === 'gate.setup') return true;
      if (seen.has(gateId)) return false;
      seen.add(gateId);
      return (catalog.get(gateId)?.depends_on ?? []).some((dependency) => followsSetup(dependency, seen));
    };
    for (const gate of bundle.gates.gates.filter((candidate) => candidate.kind === 'command' && candidate.id !== 'gate.setup' && bundle.profile.commands[candidate.command!]?.execution_root !== 'trusted-harness')) {
      assert.equal(followsSetup(gate.id), true, `${gate.id} must be ordered after setup directly or transitively`);
    }
  }
});

test('canonical distributions execute an unwaivable control-plane verifier from trusted Harness', async () => {
  for (const root of ['harness', 'harness-zh']) {
    const bundle = await loadContracts(root);
    const rule = bundle.registry.rules.find((candidate) => candidate.id === 'SEC-009');
    const gate = bundle.gates.gates.find((candidate) => candidate.id === 'gate.control-plane-integrity');
    const command = bundle.profile.commands['control-plane-integrity'];
    assert.equal(rule?.severity, 'BLOCKER');
    assert.equal(rule?.exception_allowed, false);
    assert.equal(rule?.enforcement?.mode, 'machine-enforced');
    assert.equal(gate?.severity, 'BLOCKER');
    assert.equal(gate?.exception_allowed, false);
    assert.equal(gate?.kind, 'command');
    assert.equal(command?.execution_root, 'trusted-harness');
  }
});

test('canonical GitHub approval roles use the configured reviewer login instead of role placeholders', async () => {
  const configuredReviewers = new Set<string>();
  for (const root of ['harness', 'harness-zh']) {
    const bundle = await loadContracts(root);
    for (const [role, identities] of Object.entries(bundle.profile.approvals.roles)) {
      assert.equal(identities.includes(role), false, `${role} still contains a role-name placeholder`);
      assert.equal(identities.length, 1, `${role} must have exactly one acceptance reviewer`);
      assert.match(identities[0], /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/);
      configuredReviewers.add(identities[0].toLowerCase());
    }
  }
  assert.equal(configuredReviewers.size, 1, 'English and Chinese profiles must use the same acceptance reviewer');
});

test('GitHub Actions isolates project commands and publishes a trusted signed final check', async () => {
  const workflow = await readFile('.github/workflows/harness.yml', 'utf8');
  const platformPolicy = await readFile('harness/contracts/platform-policy.yaml', 'utf8');
  const workflowTools = JSON.parse(await readFile('harness-cli/config/workflow-security-tools.json', 'utf8')) as { actions: Record<string, { uses: string }> };
  assert.match(platformPolicy, /windows-latest/);
  assert.match(platformPolicy, /ubuntu-latest/);
  assert.match(platformPolicy, /macos-latest/);
  assert.match(workflow, /platforms matrix/);
  assert.match(workflow, /fromJSON\(needs\.prepare-context\.outputs\.platform_matrix\)/);
  assert.match(workflow, /runs-on: \$\{\{ matrix\.runner \}\}/);
  assert.match(workflow, /node-version:\s*24/);
  assert.match(workflow, /npm ci --prefix trusted-harness/);
  assert.doesNotMatch(workflow, /npm ci --ignore-scripts --prefix project/);
  assert.match(workflow, /upload-artifact/);
  assert.doesNotMatch(workflow, /attest-build-provenance/);
  assert.doesNotMatch(workflow, /attestations:\s*write/);
  assert.doesNotMatch(workflow, /id-token:\s*write/);
  assert.doesNotMatch(workflow, /gh api --paginate --slurp --jq/);
  const parsed = YAML.parse(workflow) as { permissions: Record<string, string>; jobs: Record<string, { permissions?: Record<string, string>; needs?: string | string[]; steps: Array<{ name?: string; env?: Record<string, string>; run?: string; uses?: string; with?: Record<string, unknown> }> }> };
  const externalUses = Object.values(parsed.jobs).flatMap((job) => job.steps).map((step) => step.uses).filter((uses): uses is string => Boolean(uses));
  assert.ok(externalUses.length > 0);
  assert.ok(externalUses.every((uses) => /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[a-f0-9]{40}$/.test(uses)));
  const allowedActions = new Set(Object.values(workflowTools.actions).map((action) => action.uses));
  assert.ok(externalUses.every((uses) => allowedActions.has(uses)));
  for (const job of Object.values(parsed.jobs)) {
    assert.equal(job.steps[0]?.uses, workflowTools.actions['harden-runner'].uses);
    assert.deepEqual(job.steps[0]?.with, { 'egress-policy': 'audit' });
  }
  assert.equal(workflow.match(/gh api --paginate [^\n]+ \| jq -s 'add'/g)?.length, 2);
  const pipelineBlocks = Object.values(parsed.jobs)
    .flatMap((job) => job.steps)
    .map((step) => step.run)
    .filter((run): run is string => Boolean(run?.match(/gh api --paginate [^\n]+ \| jq -s 'add'/)));
  assert.equal(pipelineBlocks.length, 2);
  for (const run of pipelineBlocks) {
    assert.match(run, /^\s*set -euo pipefail\s*$/m);
    assert.match(run, /set -euo pipefail[\s\S]*gh api --paginate [^\n]+ \| jq -s 'add'/);
  }
  assert.match(workflow, /refs\/heads\/harness-bundle-base/);
  assert.match(workflow, /refs\/heads\/harness-bundle-head/);
  const prepareSteps = parsed.jobs['prepare-context'].steps;
  const workflowPolicyRun = prepareSteps.find((step) => step.name === 'Validate pull request workflow as untrusted data')?.run;
  assert.equal(workflowPolicyRun, 'node trusted-harness/harness-cli/src/cli.ts workflow-policy check --workflow-root project/.github/workflows --baseline-workflow-root trusted-harness/.github/workflows --json');
  const externalAuditRun = prepareSteps.find((step) => step.name === 'Run pinned external workflow auditors')?.run;
  assert.equal(externalAuditRun, 'node trusted-harness/harness-cli/src/cli.ts workflow-policy audit-external --config trusted-harness/harness-cli/config/workflow-security-tools.json --workflow-root project/.github/workflows --tools-dir workflow-security-tools --json');
  const controlPlaneRun = prepareSteps.find((step) => step.name === 'Verify candidate control plane with trusted policy')?.run;
  assert.equal(controlPlaneRun, 'node trusted-harness/harness-cli/src/cli.ts control-plane verify --baseline-root trusted-harness --candidate-root project --json');
  const bundleRun = prepareSteps.find((step) => step.name === 'Build immutable plan and approvals')?.run;
  assert.ok(bundleRun);
  assert.match(bundleRun, /git -C "project" update-ref "refs\/heads\/harness-bundle-base" "\$BASE_SHA"/);
  assert.match(bundleRun, /git -C "project" update-ref "refs\/heads\/harness-bundle-head" "\$HEAD_SHA"/);
  assert.match(bundleRun, /git -C "project" bundle create "\.\.\/prepared\/project\.bundle" "refs\/heads\/harness-bundle-base" "refs\/heads\/harness-bundle-head"/);
  assert.doesNotMatch(bundleRun, /git -C "project" bundle create [^\n]*--all/);
  assert.match(bundleRun, /git -C "project" bundle verify "\.\.\/prepared\/project\.bundle"/);
  assert.match(bundleRun, /git -C "project" update-ref -d "refs\/heads\/harness-bundle-base"/);
  assert.match(bundleRun, /git -C "project" update-ref -d "refs\/heads\/harness-bundle-head"/);
  assert.match(bundleRun, /trap cleanup_bundle_refs EXIT/);
  assert.match(bundleRun, /trap - EXIT/);
  assert.ok(bundleRun.indexOf('trap cleanup_bundle_refs EXIT') < bundleRun.indexOf('git -C "project" update-ref "refs/heads/harness-bundle-base"'));
  assert.ok(bundleRun.indexOf('git -C "project" update-ref') < bundleRun.indexOf('git -C "project" bundle create'));
  assert.ok(bundleRun.indexOf('git -C "project" bundle create') < bundleRun.indexOf('git -C "project" bundle verify'));
  assert.ok(bundleRun.indexOf('git -C "project" update-ref -d "refs/heads/harness-bundle-head"') < bundleRun.indexOf('trap - EXIT'));
  const recreateCheckout = parsed.jobs.harness.steps.find((step) => step.name === 'Recreate a clean pull request checkout')?.run;
  assert.ok(recreateCheckout);
  assert.match(recreateCheckout, /git clone --no-checkout "prepared\/project\.bundle" "project"/);
  assert.match(recreateCheckout, /git -C "project" checkout --detach "\$HEAD_SHA"/);
  assert.match(recreateCheckout, /git -C "project" rev-parse --verify "\$BASE_SHA\^\{commit\}"/);
  assert.match(recreateCheckout, /git -C "project" rev-parse --verify "\$HEAD_SHA\^\{commit\}"/);
  const recreateCheckoutStep = parsed.jobs.harness.steps.find((step) => step.name === 'Recreate a clean pull request checkout');
  assert.equal(recreateCheckoutStep?.env?.BASE_SHA, '${{ github.event.pull_request.base.sha }}');
  assert.match(workflow, /prepare-context:/);
  assert.match(workflow, /harness-final:/);
  assert.ok(workflow.includes(workflowTools.actions['download-artifact'].uses));
  assert.deepEqual(parsed.jobs.harness.permissions, {});
  assert.equal(parsed.jobs.harness.needs, 'prepare-context');
  assert.deepEqual(parsed.jobs['harness-final'].permissions, { contents: 'read', 'pull-requests': 'read', checks: 'write' });
  assert.deepEqual(parsed.jobs['harness-final'].needs, ['prepare-context', 'harness']);
  const projectJob = JSON.stringify(parsed.jobs.harness);
  assert.doesNotMatch(projectJob, /GH_TOKEN|github\.token|ACTIONS_ID_TOKEN|gh api/);
  const prepareJob = JSON.stringify(parsed.jobs['prepare-context']);
  assert.match(prepareJob, /GH_TOKEN/);
  assert.match(prepareJob, /gh api/);
  const finalJob = JSON.stringify(parsed.jobs['harness-final']);
  assert.match(finalJob, /GH_TOKEN/);
  assert.match(finalJob, /final aggregate/);
  assert.match(finalJob, /final verify/);
  assert.match(finalJob, /HARNESS_ED25519_PRIVATE_KEY_B64/);
  assert.match(finalJob, /HARNESS_ED25519_PUBLIC_KEY_B64/);
  assert.match(finalJob, /HARNESS_ED25519_PUBLIC_KEYS_JSON/);
  assert.match(finalJob, /records render/);
  assert.match(finalJob, /--final final\.signed\.json/);
  assert.match(finalJob, /SUMMARY=\$\(cat final-record\.md\)/);
  assert.match(finalJob, /harness-final/);
  const finalAggregateStep = parsed.jobs['harness-final'].steps.find((step) => step.name === 'Recompute and sign the final result');
  assert.equal(finalAggregateStep?.env?.PR_AUTHOR, '${{ github.event.pull_request.user.login }}');
  assert.match(finalAggregateStep?.run ?? '', /--author "\$PR_AUTHOR"/);
  assert.match(workflow, /--github-run-id "\$GITHUB_RUN_ID"/);
  assert.match(workflow, /if:\s*always\(\)/);
  assert.match(workflow, /github\.event\.pull_request\.base\.sha/);
  assert.match(workflow, /github\.event\.pull_request\.head\.sha/);
  assert.match(workflow, /--git-base/);
  assert.match(workflow, /github\.event\.pull_request\.labels/);
  assert.match(workflow, /--risk-labels-json/);
  assert.doesNotMatch(workflow, /mapfile/);
  assert.match(workflow, /approvals github/);
  assert.equal(workflow.match(/identities github/g)?.length, 2);
  assert.equal(workflow.match(/attestations agents/g)?.length, 2);
  assert.equal(workflow.match(/--identities /g)?.length, 4);
  assert.match(workflow, /github-repository-collaborator-permission/);
  assert.match(workflow, /github\.event\.pull_request\.user\.login/);
  assert.match(workflow, /--approvals/);
  assert.match(workflow, /--repository "\$GH_REPOSITORY"/);
  assert.match(workflow, /--pull-request "\$PR_NUMBER"/);
  assert.match(workflow, /pull_request_review:/);
  assert.match(workflow, /pull_request_target/);
  assert.match(workflow, /trusted-harness\/harness-cli/);
  assert.match(workflow, /persist-credentials:\s*false/);
  assert.match(workflow, /--project-root project/);
  assert.doesNotMatch(workflow, /^\s*push:/m);
  assert.doesNotMatch(workflow, /--changed-file src\/example\.txt/);
});

test('canonical documentation describes the current trusted execution model', async () => {
  for (const root of ['harness', 'harness-zh']) {
    const readme = await readFile(`${root}/README.md`, 'utf8');
    const enforcement = await readFile(`${root}/enforcement/README.md`, 'utf8');
    const trustedExecution = await readFile(`${root}/governance/trusted-execution.md`, 'utf8');
    const canonical = `${readme}\n${enforcement}\n${trustedExecution}`;

    assert.doesNotMatch(canonical, /gh attestation verify|provenance attestation|GitHub provenance attestation/i);
    assert.doesNotMatch(canonical, /three `harness-\*`|?? `harness-\*`/i);
    assert.doesNotMatch(canonical, /clean tracked worktree|??????????/i);
    assert.match(trustedExecution, /prepare-context[\s\S]+harness[\s\S]+harness-final/);
    assert.match(canonical, /HARNESS_ED25519_PRIVATE_KEY_B64/);
    assert.match(canonical, /HARNESS_ED25519_PUBLIC_KEYS_JSON/);
    assert.match(canonical, /repository/);
    assert.match(canonical, /pull_request/);
    assert.match(canonical, /base_sha/);
    assert.match(canonical, /head_sha/);
    assert.match(canonical, /tracked[\s\S]+untracked[\s\S]+ignored/i);
    assert.match(canonical, /harness-final/);
    assert.match(canonical, /two independent non-author CODEOWNER approvals|???????? CODEOWNER ??/);
    assert.match(canonical, /user\.type/);
    assert.match(canonical, /Bot/);
    assert.match(canonical, /identity snapshot|????/i);
  }
});

test('public acceptance assets protect trust controls and require every preflight gate', async () => {
  const owners = await readFile('CODEOWNERS', 'utf8');
  let template: string | undefined;
  try {
    template = await readFile('CODEOWNERS.template', 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const preflight = await readFile('scripts/Prepare-PublicAcceptance.ps1', 'utf8');
  const acceptance = await readFile('docs/acceptance/github-e2e-template.md', 'utf8');
  const rewardHacking = await readFile('docs/acceptance/reward-hacking-template.md', 'utf8');

  for (const protectedPath of ['/.github/workflows/', '/harness/', '/harness-zh/', '/harness-cli/', '/harness-cli/schemas/', '/CODEOWNERS']) {
    assert.match(owners, new RegExp(protectedPath.replaceAll('/', '\\/')));
    if (template !== undefined) assert.match(template, new RegExp(protectedPath.replaceAll('/', '\\/')));
  }
  assert.doesNotMatch(owners, /@(engineering|security|platform)\b/);
  if (template !== undefined) {
    assert.match(template, /@\{\{ACCEPTANCE_REVIEWER_LOGIN\}\}/);
  } else {
    assert.doesNotMatch(owners, /\{\{ACCEPTANCE_REVIEWER_LOGIN\}\}/);
  }
  assert.match(acceptance, /Required approvals:\s*`2`/);
  for (const requiredCommand of ['npm.*test', 'npm.*typecheck', 'validate.*harness', 'validate.*harness-zh', 'python-fixture', 'git.*diff.*--check', 'gitleaks.*--no-git.*--redact']) {
    assert.match(preflight, new RegExp(requiredCommand, 'is'));
  }
  for (const scenario of ['No approval', 'Independent APPROVED', 'New head after approval', 'Reapproval of new head', 'Review dismissed', 'CHANGES_REQUESTED', 'Context mismatch', 'Evidence tampering', 'Matrix failure or cancellation', 'Unknown signing key ID', 'Python non-Node fixture', 'Author self-approval attempt', 'Bot/App review presented as human rule attestation', 'Generic review presented as rule attestation', 'No-meaning coverage test', 'Base implementation does not fail new regression test', 'Missing, duplicate, or extra platform Evidence', 'Dependency install scripts enabled', 'Unknown path classified as low risk']) {
    assert.match(acceptance, new RegExp(scenario));
  }
  for (const scenario of ['PR title or body interpolated into `run:`', 'Generic review impersonates rule attestation', 'Meaningless tests or surviving mutants', 'Platform is omitted, duplicated, or invented']) {
    assert.match(rewardHacking, new RegExp(scenario.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});
