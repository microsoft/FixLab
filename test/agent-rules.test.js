import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { mkdtempSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { checkAgentRules } from "../scripts/ci/check-agent-rules.mjs";
import {
  checkBranchPolicy,
  checkPolicy
} from "../scripts/ci/check-policy.mjs";

const testDirectory = dirname(fileURLToPath(import.meta.url));

test("scenario-first validation and independent recovery stay aligned across browser entry points", () => {
  const root = join(testDirectory, "..");
  for (const entryPoint of ["dashboard/server.js", "bin/fixlab.js"]) {
    assert.match(readFileSync(join(root, entryPoint), "utf8"), /SCENARIO_VALIDATION_GUIDANCE/u, entryPoint);
  }
  for (const entryPoint of [
    "dashboard/workflow-policy.js", "agents/fixlab.md", "com.github.copilot/agents/fixlab.agent.md",
    "templates/fixlab-autofix.agent.md", ".github/agents/fixlab-autofix.agent.md",
    ".github/agents/fixlab.agent.md", "prompts/fixlab.live-test.prompt.md"
  ]) {
    const text = readFileSync(join(root, entryPoint), "utf8").replace(/\s+/gu, " ");
    for (const contract of [
      /Scenario-first validation/u, /expected-versus-observed assertions/u,
      /not a setup check, sign-in or screenshot alone/u,
      /repair its syntax\/selectors/u, /approved synthetic\/intercepted data/u,
      /discoverable \.spec file in a job-owned folder/u,
      /configured testDir; honor testMatch\/project/u, /Verify --list before execution/u,
      /report file path, runner command and assertion results/u,
      /label synthetic UI coverage separately/u,
      /Finish independent scenarios before asking/u,
      /never use another checkout to prove an unpublished fix/u,
      /explicitly deferred checks keep their contracts/u
    ]) { assert.match(text, contract, entryPoint); }
  }
});

test("full-page portal evidence guidance stays aligned without requiring browser artifacts for API-only jobs", () => {
  const root = join(testDirectory, "..");
  for (const entryPoint of ["dashboard/server.js", "bin/fixlab.js"]) {
    assert.match(readFileSync(join(root, entryPoint), "utf8"), /PORTAL_SCREENSHOT_GUIDANCE/u);
  }
  for (const entryPoint of [
    "dashboard/workflow-policy.js", "agents/fixlab.md", "com.github.copilot/agents/fixlab.agent.md",
    "templates/fixlab-autofix.agent.md", ".github/agents/fixlab-autofix.agent.md",
    ".github/agents/fixlab.agent.md", "prompts/fixlab.live-test.prompt.md"
  ]) {
    const text = readFileSync(join(root, entryPoint), "utf8").replace(/\s+/gu, " ");
    assert.match(text, /page\.screenshot\(\{ path, fullPage: true \}\)/u, entryPoint);
    assert.match(text, /Default to unmasked full-page screenshots of approved portal pages/u, entryPoint);
    assert.match(text, /Do not blanket-mask the page or ask again for default screenshot capture/u, entryPoint);
    assert.match(text, /job-owned transient wrapper/u, entryPoint);
    assert.match(text, /original test, shared configuration/u, entryPoint);
    assert.match(text, /Explicit repository privacy rules and genuinely sensitive content/u, entryPoint);
    assert.match(text, /sign-in\/MFA screens or private\/customer data/u, entryPoint);
    assert.match(text, /Keep evidence local; external sharing needs separate approval/u, entryPoint);
    assert.match(text, /API-only and unit-test-only runs require no browser screenshot/u, entryPoint);
    assert.match(text, /numbered journey per scenario/u, entryPoint);
    assert.match(text, /SHA-256/u, entryPoint);
    assert.match(text, /exact bytes passed to the upload/u, entryPoint);
    assert.match(text, /expected versus observed/u, entryPoint);
    assert.match(text, /Save\/Submit and persistence remain unverified/u, entryPoint);
  }
});

test("safe recovery and scoped DEV/PPE/SIT/UAT POST guidance stay aligned across execution surfaces", () => {
  const root = join(testDirectory, "..");
  for (const entryPoint of ["dashboard/server.js", "bin/fixlab.js"]) {
    assert.match(readFileSync(join(root, entryPoint), "utf8"), /RUNTIME_RECOVERY_GUIDANCE/u);
  }
  for (const entryPoint of [
    "dashboard/workflow-policy.js", "agents/fixlab.md", "com.github.copilot/agents/fixlab.agent.md",
    "templates/fixlab-autofix.agent.md", ".github/agents/fixlab-autofix.agent.md", ".github/agents/fixlab.agent.md"
  ]) {
    const text = readFileSync(join(root, entryPoint), "utf8").replace(/\s+/gu, " ");
    for (const contract of [
      /oversized inline scripts/u, /repackage the rejected operation to evade review/u,
      /Deny and request safe recovery/u, /fixlab_dev_post/u, /dataSafety\.devPost/u,
      /DEV\/PPE\/SIT\/UAT/u, /fixlab_nonproduction_post/u, /dataSafety\.post/u,
      /checkbox/u, /[Uu]nchecked/u,
      /single-use human confirmation/u, /Allow all and batch approval never apply/u,
      /without repeat confirmation/u, /profile\/helper revision/u,
      /newly reviewed job/u, /stop job-scoped approval/u,
      /API-only read-only contracts/u, /never substitute a shell\/browser POST/u
    ]) { assert.match(text, contract, entryPoint); }
  }
});

test("focused retrieval and automatic affected-surface guidance stay aligned across runtimes", () => {
  const root = join(testDirectory, "..");
  for (const entryPoint of ["dashboard/server.js", "bin/fixlab.js"]) {
    const content = readFileSync(join(root, entryPoint), "utf8");
    assert.match(content, /componentRetrievalGuidance\(/u, entryPoint);
  }
  for (const entryPoint of [
    "agents/fixlab.md", "com.github.copilot/agents/fixlab.agent.md",
    "templates/fixlab-autofix.agent.md", ".github/agents/fixlab-autofix.agent.md",
    ".github/agents/fixlab.agent.md", "dashboard/affected-surface.js"
  ]) {
    const content = readFileSync(join(root, entryPoint), "utf8").replace(/\s+/gu, " ");
    for (const contract of [
      /complete verified Git diff, not report keywords/u, /nearest existing regression/u,
      /bounded symbol\/file reads/u, /explicitly required gates/u,
      /strict mode and explicit full\/UI requests/u, /cache source contents/u,
      /required local API\/runtime verification/u
    ]) {
      assert.match(content, contract, entryPoint);
    }
  }
});

test("agent rule governance accepts a bounded lifecycle corpus", () => {
  const root = mkdtempSync(join(tmpdir(), "fixlab-agent-rules-"));
  const instructions = join(root, ".github", "instructions");
  mkdirSync(instructions, { recursive: true });
  writeFileSync(
    join(root, ".github", "copilot-code-review.yml"),
    JSON.stringify({
      corpus: ".github/instructions/learned-rules.instructions.md",
      promotion: { minimumDistinctRuns: 2, maximumActiveRules: 3 }
    })
  );
  writeFileSync(
    join(instructions, "learned-rules.instructions.md"),
    [
      "# Active learned rules",
      "## Keep validation deterministic",
      "# Candidate rules",
      "# Retired rules"
    ].join("\n")
  );

  try {
    assert.deepEqual(checkAgentRules(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cross-runtime validation guidance stays aligned", () => {
  const root = join(testDirectory, "..");
  const runtimeEntryPoints = [
    "dashboard/server.js",
    "bin/fixlab.js"
  ];
  const agentEntryPoints = [
    "agents/fixlab.md",
    "com.github.copilot/agents/fixlab.agent.md",
    "templates/fixlab-autofix.agent.md",
    ".github/agents/fixlab-autofix.agent.md"
  ];
  const entryPoints = [...runtimeEntryPoints, ...agentEntryPoints];

  for (const entryPoint of entryPoints) {
    const content = readFileSync(join(root, entryPoint), "utf8");
    assert.match(content, /permissionPreflight/, `${entryPoint} must describe opt-in permission preflight`);
    assert.match(content, /component path-to-gate policies/, `${entryPoint} must preserve reviewed component validation`);
    assert.match(
      content,
      /primary\s+business-data\s+source/,
      `${entryPoint} must preserve backend-first validation guidance`
    );
    assert.match(
      content,
      /read-only/,
      `${entryPoint} must preserve read-only backend access`
    );
    assert.match(
      content,
      /intercept(?:\s+every)?\s+mutat/,
      `${entryPoint} must preserve mutation interception`
    );
    assert.match(
      content,
      /(?:unreachable|access fails|access prevents the read)/,
      `${entryPoint} must preserve access-failure fallback conditions`
    );
    assert.match(
      content,
      /no safe records/,
      `${entryPoint} must preserve safe-record fallback conditions`
    );
    assert.match(
      content,
      /expected\s+empty[- ]state|expected\s+empty\s+state/,
      `${entryPoint} must preserve empty-state behavior`
    );
    assert.match(
      content,
      /synthetic pass proves\s+(?:the\s+)?UI\s+behavior\s+only/,
      `${entryPoint} must preserve the synthetic fallback limitation`
    );
    assert.match(
      content,
      /transient validation artifact/,
      `${entryPoint} must preserve transient Playwright cleanup guidance`
    );
    assert.match(
      content,
      /\*\.auth\.spec\.ts/,
      `${entryPoint} must preserve authenticated-test persistence guidance`
    );
  }

  for (const entryPoint of [...agentEntryPoints, "bin/fixlab.js"]) {
    const content = readFileSync(join(root, entryPoint), "utf8");
    assert.match(content, /`FLAB:`/, `${entryPoint} must identify FixLab-created PRs`);
    assert.match(content, /repository's PR template/, `${entryPoint} must format PR bodies`);
  }

  for (const entryPoint of agentEntryPoints) {
    const content = readFileSync(join(root, entryPoint), "utf8");
    assert.match(
      content,
      /profile selects `non-production-read-only`[\s\S]{0,160}selects any profile-approved non-production environment[\s\S]{0,220}primary business-data source/,
      `${entryPoint} must condition backend-first guidance on both profile source and environment selection`
    );
    assert.match(
      content,
      /draft pull request/,
      `${entryPoint} must support early draft pull-request visibility`
    );
    assert.match(
      content,
      /smallest focused regression checks\s+pass/,
      `${entryPoint} must gate an early draft on focused regression evidence`
    );
    assert.match(
      content,
      /never mark (?:it|the PR) ready|never mark the PR ready/i,
      `${entryPoint} must preserve final readiness gating`
    );
    assert.match(
      content,
      /Fall back to `synthetic-intercepted` only when[\s\S]{0,180}(?:unreachable|access fails)[\s\S]{0,180}no safe records/,
      `${entryPoint} must condition synthetic fallback on access or safe-record failure`
    );
  }

  const browserRule = readFileSync(
    join(
      root,
      ".github",
      "instructions",
      "browser-event-registration.instructions.md"
    ),
    "utf8"
  );
  assert.match(browserRule, /applyTo: "dashboard\/public\/\*\*\/\*\.js"/);
  assert.match(browserRule, /event registration/);
});

test("transient journey exceptions stay bounded across all execution surfaces", () => {
  const root = join(testDirectory, "..");
  for (const entryPoint of ["dashboard/server.js", "bin/fixlab.js"]) {
    assert.match(readFileSync(join(root, entryPoint), "utf8"), /TRANSIENT_PLAYWRIGHT_GUIDANCE/u, entryPoint);
  }
  for (const entryPoint of [
    "dashboard/workflow-policy.js", "agents/fixlab.md", "com.github.copilot/agents/fixlab.agent.md",
    "templates/fixlab-autofix.agent.md", ".github/agents/fixlab-autofix.agent.md",
    ".github/agents/fixlab.agent.md"
  ]) {
    const text = readFileSync(join(root, entryPoint), "utf8").replace(/\s+/gu, " ");
    for (const contract of [
      /validate-only and playwright-only modes/u, /job-owned transient Playwright journeys/u,
      /configured test directory/u, /fixtures and authentication helpers unchanged/u,
      /same-job retries while validation is blocked/u, /Never overwrite pre-existing tests/u,
      /Normal runtime permissions, prior denials, managed policy, human sign-in/u,
      /no runtime access or business writes/u
    ]) { assert.match(text, contract, entryPoint); }
  }
});

test("connected recovery and scoped iteration guidance remain aligned across runtimes", () => {
  const root = join(testDirectory, "..");
  for (const entryPoint of [
    "dashboard/server.js", "bin/fixlab.js", "agents/fixlab.md",
    "com.github.copilot/agents/fixlab.agent.md",
    "templates/fixlab-autofix.agent.md", ".github/agents/fixlab-autofix.agent.md"
  ]) {
    const content = readFileSync(join(root, entryPoint), "utf8").replace(/\s+/gu, " ");
    for (const contract of [
      /fixlab_dashboard_status/, /fixlab_dashboard_reply/,
      /fixlab_dashboard_control/, /Do not ask again for routine steps/,
      /checkout matches the PR source commit/,
      /playwright-only/, /repository's Playwright configuration/,
      /host's question UI/, /user's explicit answer/,
      /full regression is explicitly deferred, not passed/,
      /PR readiness stays blocked/, /Continue independent safe checks/,
      /changed fingerprint requires a new review/,
      /Do not delete or edit transient test artifacts while validation is discovering or executing them/
    ]) {
      assert.match(content, contract, entryPoint);
    }
  }
});

test("every runtime prepares worktrees with scoped approval and human authentication", () => {
  const root = join(testDirectory, "..");
  for (const entryPoint of [
    "dashboard/server.js",
    "bin/fixlab.js",
    "agents/fixlab.md",
    "com.github.copilot/agents/fixlab.agent.md",
    "templates/fixlab-autofix.agent.md",
    ".github/agents/fixlab-autofix.agent.md"
  ]) {
    const content = readFileSync(join(root, entryPoint), "utf8").replace(/\s+/gu, " ");
    assert.match(content, /--from SOURCE --runtime RUNTIME/, entryPoint);
    assert.match(content, /scoped setup approval/, entryPoint);
    assert.match(content, /worktreeSetup.files/, entryPoint);
    assert.match(content, /Never copy credentials or browser state/, entryPoint);
    assert.match(content, /do not retry unchanged approvals or grant blanket path access/, entryPoint);
    assert.match(content, /Sign-in and MFA remain human-controlled/, entryPoint);
    assert.match(content, /In read-only modes, do not provision or alter configuration/, entryPoint);
  }
});

test("every PR entry point publishes before waiting for remote CI", () => {
  const root = join(testDirectory, "..");
  const entryPoints = [
    "dashboard/server.js",
    "bin/fixlab.js",
    "agents/fixlab.md",
    "com.github.copilot/agents/fixlab.agent.md",
    "templates/fixlab-autofix.agent.md",
    ".github/agents/fixlab-autofix.agent.md",
    "prompts/fixlab.pr.prompt.md"
  ];
  for (const entryPoint of entryPoints) {
    const content = readFileSync(join(root, entryPoint), "utf8").replace(/\s+/gu, " ");
    assert.match(content, /required local validation and approval gates/,
      `${entryPoint} must preserve local validation and publication approval`);
    assert.match(content, /publish the authorized PR by marking it ready for review/,
      `${entryPoint} must explicitly publish instead of leaving the PR draft`);
    assert.match(content, /Do not wait for remote PR CI or build completion before publication/,
      `${entryPoint} must not wait for a build triggered by publication`);
    assert.match(content, /Verify the PR is no longer draft before reporting the PR stage passed/,
      `${entryPoint} must verify publication before reporting success`);
    assert.match(content, /Report remote checks as pending, not passed, and leave merge policies intact/,
      `${entryPoint} must not equate publication with successful CI or merge approval`);
    assert.match(content, /gh pr ready/,
      `${entryPoint} must identify the GitHub draft transition`);
    assert.match(content, /az repos pr update --id (?:<id>|PR_ID) --draft false/,
      `${entryPoint} must identify the Azure DevOps draft transition`);
  }
});

test("repository policy matches enforced CI and rollback controls", () => {
  const root = join(testDirectory, "..");

  assert.deepEqual(checkPolicy(root), []);
});

test("branch policy requires contributor review while allowing owner bypass", () => {
  const policy = {
    targetBranch: "main",
    maintainerModel: "owner-bypass",
    requiredStatusChecks: ["test", "analyze"],
    pullRequest: {
      requiredApprovingReviews: 1,
      dismissStaleApprovals: true,
      requireCodeOwnerReview: true,
      requireReviewThreadResolution: true
    },
    history: {
      requireLinearHistory: true,
      blockDeletion: true,
      blockForcePush: true
    },
    bypass: {
      repositoryRole: "admin"
    }
  };

  assert.deepEqual(checkBranchPolicy(policy), []);
  for (const invalidCount of [0, 2, "1", true, 1.5, Infinity]) {
    policy.pullRequest.requiredApprovingReviews = invalidCount;
    assert.ok(
      checkBranchPolicy(policy).includes(
        "branch policy must require exactly one contributor approval"
      )
    );
  }
  policy.pullRequest.requiredApprovingReviews = 1;
  policy.pullRequest.requireCodeOwnerReview = false;
  assert.ok(
    checkBranchPolicy(policy).includes(
      "branch policy must require code-owner review"
    )
  );
  policy.pullRequest.requireCodeOwnerReview = true;
  policy.bypass.repositoryRole = "maintain";
  assert.ok(
    checkBranchPolicy(policy).includes(
      "branch policy must reserve owner bypass for repository administrators"
    )
  );
  policy.bypass.repositoryRole = "admin";
  policy.maintainerModel = "solo";
  assert.ok(
    checkBranchPolicy(policy).includes(
      "branch policy must declare the owner-bypass maintainer model"
    )
  );
});
