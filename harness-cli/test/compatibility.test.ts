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
    for (const gate of bundle.gates.gates.filter((candidate) => candidate.kind === 'command' && candidate.id !== 'gate.setup')) {
      assert.equal(followsSetup(gate.id), true, `${gate.id} must be ordered after setup directly or transitively`);
    }
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
  assert.match(workflow, /windows-latest/);
  assert.match(workflow, /ubuntu-latest/);
  assert.match(workflow, /macos-latest/);
  assert.match(workflow, /node-version:\s*24/);
  assert.match(workflow, /npm ci --prefix trusted-harness/);
  assert.doesNotMatch(workflow, /npm ci --ignore-scripts --prefix project/);
  assert.match(workflow, /upload-artifact/);
  assert.doesNotMatch(workflow, /attest-build-provenance/);
  assert.doesNotMatch(workflow, /attestations:\s*write/);
  assert.doesNotMatch(workflow, /id-token:\s*write/);
  assert.doesNotMatch(workflow, /gh api --paginate --slurp --jq/);
  assert.equal(workflow.match(/gh api --paginate [^\n]+ \| jq -s 'add'/g)?.length, 2);
  assert.match(workflow, /prepare-context:/);
  assert.match(workflow, /harness-final:/);
  assert.match(workflow, /download-artifact@v4/);
  const parsed = YAML.parse(workflow) as { permissions: Record<string, string>; jobs: Record<string, { permissions?: Record<string, string>; needs?: string | string[]; steps: Array<{ name?: string; env?: Record<string, string>; run?: string }> }> };
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
  assert.match(finalJob, /plan_sha256/);
  assert.match(finalJob, /manifest_sha256/);
  assert.match(finalJob, /key_id/);
  assert.match(finalJob, /harness-final/);
  assert.match(workflow, /--github-run-id "\$GITHUB_RUN_ID"/);
  assert.match(workflow, /if:\s*always\(\)/);
  assert.match(workflow, /github\.event\.pull_request\.base\.sha/);
  assert.match(workflow, /github\.event\.pull_request\.head\.sha/);
  assert.match(workflow, /--git-base/);
  assert.match(workflow, /github\.event\.pull_request\.labels/);
  assert.match(workflow, /--risk-labels-json/);
  assert.doesNotMatch(workflow, /mapfile/);
  assert.match(workflow, /approvals github/);
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
    assert.doesNotMatch(canonical, /three `harness-\*`|三个 `harness-\*`/i);
    assert.doesNotMatch(canonical, /clean tracked worktree|受跟踪工作区保持干净/i);
    assert.match(trustedExecution, /prepare-context[\s\S]+harness[\s\S]+harness-final/);
    assert.match(canonical, /HARNESS_ED25519_PRIVATE_KEY_B64/);
    assert.match(canonical, /HARNESS_ED25519_PUBLIC_KEYS_JSON/);
    assert.match(canonical, /repository/);
    assert.match(canonical, /pull_request/);
    assert.match(canonical, /base_sha/);
    assert.match(canonical, /head_sha/);
    assert.match(canonical, /tracked[\s\S]+untracked[\s\S]+ignored/i);
    assert.match(canonical, /harness-final/);
  }
});

test('public acceptance assets protect trust controls and require every preflight gate', async () => {
  const owners = await readFile('CODEOWNERS', 'utf8');
  const template = await readFile('CODEOWNERS.template', 'utf8');
  const preflight = await readFile('scripts/Prepare-PublicAcceptance.ps1', 'utf8');
  const acceptance = await readFile('docs/acceptance/github-e2e-template.md', 'utf8');

  for (const protectedPath of ['/.github/workflows/', '/harness/', '/harness-zh/', '/harness-cli/', '/harness-cli/schemas/', '/CODEOWNERS']) {
    assert.match(owners, new RegExp(protectedPath.replaceAll('/', '\\/')));
    assert.match(template, new RegExp(protectedPath.replaceAll('/', '\\/')));
  }
  assert.doesNotMatch(owners, /@(engineering|security|platform)\b/);
  assert.match(template, /@\{\{ACCEPTANCE_REVIEWER_LOGIN\}\}/);
  for (const requiredCommand of ['npm.*test', 'npm.*typecheck', 'validate.*harness', 'validate.*harness-zh', 'python-fixture', 'git.*diff.*--check', 'gitleaks.*--no-git.*--redact']) {
    assert.match(preflight, new RegExp(requiredCommand, 'is'));
  }
  for (const scenario of ['No approval', 'Independent APPROVED', 'New head after approval', 'Reapproval of new head', 'Review dismissed', 'CHANGES_REQUESTED', 'Context mismatch', 'Evidence tampering', 'Matrix failure or cancellation', 'Unknown signing key ID', 'Python non-Node fixture', 'Author self-approval attempt']) {
    assert.match(acceptance, new RegExp(scenario));
  }
});
