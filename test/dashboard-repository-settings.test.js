import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { applyRepositorySettings, inspectRepositorySettings, localRepository, planRepositorySettings } from "../dashboard/repository-settings.js";
import { canonicalExecutionRepository, createExecutorLease } from "../dashboard/executor-lease.js";
import { SETUP_PROFILE_PATH } from "../dashboard/repository-setup.js";
import { configuredTestSynthesis, validateLiveTestProfile } from "../dashboard/server.js";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
function fixture() {
  const repository = mkdtempSync(join(tmpdir(), "fixlab-settings-"));
  const initialized = spawnSync("git", ["init", "--quiet"], {
    cwd: repository, windowsHide: true, encoding: "utf8"
  });
  assert.equal(initialized.status, 0, initialized.stderr);
  return repository;
}
function plan(repository, overrides = {}, install = true) {
  const inspected = inspectRepositorySettings(repository);
  return planRepositorySettings({ repository, revision: inspected.revision,
    values: { ...inspected.values, branchUserId: "synthetic-user", ...overrides },
    install, packageRoot, validate: validateLiveTestProfile });
}

test("repository onboarding previews without writes and creates only missing reviewed scaffolding", () => {
  const repository = fixture();
  try {
    assert.equal(localRepository(repository), repository);
    const preview = plan(repository);
    assert.equal(existsSync(join(repository, ".github")), false);
    assert.equal(preview.files.length, 11);
    const applied = applyRepositorySettings(preview, "synthetic-settings-owner");
    assert.equal(applied.saved, true);
    const profile = JSON.parse(readFileSync(join(repository, SETUP_PROFILE_PATH), "utf8"));
    assert.equal(profile.pullRequests.branchNaming.userId, "synthetic-user");
    assert.deepEqual(profile.workflow, {
      mode: "efficient", publication: "draft", unitTestsAfterPr: false, optionalBuilds: false
    });
    assert.equal(profile.browserAutomation.dataSafety.productionAllowed, false);
    assert.equal(configuredTestSynthesis(profile, "", undefined, "dev").source, "non-production-read-only");
    assert.equal(configuredTestSynthesis(profile, "", undefined, "ppe").source, "non-production-read-only");
    assert.equal(configuredTestSynthesis(profile, "", undefined, "sit").source, "synthetic-intercepted");
    assert.equal(validateLiveTestProfile(profile).ok, true);
    assert.equal(existsSync(join(repository, ".github", "agents", "fixlab-autofix.agent.md")), true);
    assert.equal(
      readFileSync(join(repository, ".github", "prompts", "fixlab.summary.prompt.md"), "utf8"),
      readFileSync(join(packageRoot, "prompts", "fixlab.summary.prompt.md"), "utf8")
    );
    assert.equal(existsSync(canonicalExecutionRepository(repository).directory), false);
    assert.equal(plan(repository).assets.length, 0);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("repository settings preserve undisplayed configuration and never expose environment values", () => {
  const repository = fixture();
  try {
    applyRepositorySettings(plan(repository), "synthetic-settings-owner");
    const path = join(repository, SETUP_PROFILE_PATH);
    const profile = JSON.parse(readFileSync(path, "utf8"));
    profile.browserAutomation.authentication.environment = { SYNTHETIC_PRIVATE: "noncredential-private-sentinel" };
    profile.pullRequests.requireConfirmation = false;
    profile.workflow.publication = "ready";
    profile.customContract = { retained: true };
    delete profile.browserAutomation.testSynthesis.devReadOnly;
    delete profile.browserAutomation.testSynthesis.ppeReadOnly;
    profile.environments = { dev: { syntheticContract: "preserved" } };
    writeFileSync(path, JSON.stringify(profile));
    const inspected = inspectRepositorySettings(repository);
    assert.doesNotMatch(JSON.stringify(inspected), /noncredential-private-sentinel|SYNTHETIC_PRIVATE/);
    const preview = plan(repository, { name: "Updated synthetic repository",
      efficientWorkflow: false, optionalBuilds: true, unitTestsAfterPr: false }, false);
    assert.deepEqual(preview.files, [SETUP_PROFILE_PATH]);
    applyRepositorySettings(preview, "synthetic-settings-owner");
    const updated = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(updated.name, "Updated synthetic repository");
    assert.deepEqual(updated.workflow, {
      mode: "strict", publication: "ready", unitTestsAfterPr: false, optionalBuilds: true
    });
    assert.deepEqual(updated.customContract, { retained: true });
    assert.equal(updated.pullRequests.requireConfirmation, false);
    assert.equal(configuredTestSynthesis(updated, "", undefined, "dev").source, "synthetic-intercepted");
    assert.equal(configuredTestSynthesis(updated, "", undefined, "ppe").source, "synthetic-intercepted");
    assert.deepEqual(updated.environments, profile.environments);
    assert.deepEqual(updated.browserAutomation.authentication.environment, profile.browserAutomation.authentication.environment);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("DEV API setup enables persistent real UI access without job permissions or read-only defaults", () => {
  const repository = fixture();
  try {
    applyRepositorySettings(plan(repository), "synthetic-settings-owner");
    writeFileSync(join(repository, "dev-session.mjs"), "throw new Error('Setup must not execute authentication');");
    const preview = plan(repository, {
      devApiEnabled: true, devApiOrigins: "https://api.dev.example.test",
      devApiScope: "api://example-service/access", devApiSessionHelper: "dev-session.mjs"
    }, false);
    const safety = preview.profile.browserAutomation.dataSafety;
    assert.deepEqual(safety.devWrite, {
      allowAll: true, origins: ["https://api.dev.example.test"],
      scope: "api://example-service/access", sessionHelper: "dev-session.mjs"
    });
    const evidence = configuredTestSynthesis(preview.profile, "", undefined, "dev");
    assert.equal(evidence.source, "non-production-approved");
    assert.equal(evidence.mutationMode, "approved-write");
    assert.notEqual(evidence.devReadOnly, true);
    assert.equal(preview.profile.browserAutomation.testSynthesis.devReadOnly, false);
    assert.equal(configuredTestSynthesis(preview.profile, "none", undefined, "dev").mutationMode, "none");
    assert.equal(configuredTestSynthesis(preview.profile, "intercepted", undefined, "dev").mutationMode, "intercepted");
    assert.equal(configuredTestSynthesis(preview.profile, "", undefined, "sit").source, "synthetic-intercepted");
    assert.ok(preview.profile.worktreeSetup.files.includes("dev-session.mjs"));
    applyRepositorySettings(preview, "synthetic-settings-owner");
    assert.equal(inspectRepositorySettings(repository).values.devApiEnabled, true);
    for (const invalid of [
      { devApiOrigins: "https://api.ppe.example.test" },
      { devApiOrigins: "https://api.dev.example.test/path" },
      { devApiScope: "not-an-api-scope" }, { devApiSessionHelper: "missing.mjs" },
      { devApiProxyPaths: "/api/../production" }, { devApiProxyPaths: "//other-host" }
    ]) {
      assert.throws(() => plan(repository, invalid, false));
    }
    const proxied = plan(repository, { devApiProxyPaths: "/api, /odata" }, false);
    assert.deepEqual(proxied.profile.browserAutomation.dataSafety.devWrite.browserProxyPaths, ["/api", "/odata"]);
    applyRepositorySettings(proxied, "synthetic-settings-owner");
    assert.equal(plan(repository, { devApiProxyPaths: "" }, false)
      .profile.browserAutomation.dataSafety.devWrite.browserProxyPaths, undefined);
    const disabled = plan(repository, { devApiEnabled: false }, false);
    assert.equal(disabled.profile.browserAutomation.dataSafety.devWrite.allowAll, false);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("repository settings reject stale plans and never replace an active executor lease", () => {
  const repository = fixture();
  try {
    const reviewed = plan(repository);
    const lease = createExecutorLease(repository, "synthetic-active-owner").acquire("synthetic-live-job");
    try {
      assert.throws(() => applyRepositorySettings(reviewed, "synthetic-settings-owner"), /lease is reserved/);
      assert.equal(existsSync(join(repository, SETUP_PROFILE_PATH)), false);
    } finally {
      lease.release();
    }
    mkdirSync(join(repository, ".github", "fixlab"), { recursive: true });
    writeFileSync(join(repository, SETUP_PROFILE_PATH), '{"name":"Concurrent edit"}');
    assert.throws(() => applyRepositorySettings(reviewed, "synthetic-settings-owner"), /changed after review/);
    assert.equal(readFileSync(join(repository, SETUP_PROFILE_PATH), "utf8"), '{"name":"Concurrent edit"}');
    assert.equal(existsSync(canonicalExecutionRepository(repository).directory), false);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("API-only repository settings never add a frontend or browser and retain backend safety", () => {
  const repository = fixture();
  try {
    applyRepositorySettings(plan(repository), "synthetic-settings-owner");
    const path = join(repository, SETUP_PROFILE_PATH);
    const profile = JSON.parse(readFileSync(path, "utf8"));
    delete profile.applications.frontend;
    profile.applications.backend = {
      command: "dotnet run", workingDirectory: ".", port: 5087,
      healthUrl: "http://127.0.0.1:5087/health"
    };
    delete profile.browserAutomation.browser;
    profile.browserAutomation.mode = "api";
    profile.browserAutomation.dataSafety.allowedOrigins = ["http://127.0.0.1:5087"];
    profile.browserAutomation.dataSafety.allowedMethods = ["GET"];
    profile.browserAutomation.testSynthesis.defaultDataSource = "non-production-read-only";
    profile.browserAutomation.testSynthesis.mutationMode = "none";
    writeFileSync(path, JSON.stringify(profile));
    assert.equal(inspectRepositorySettings(repository).fields.some((field) => field.key.startsWith("frontend")), false);
    assert.equal(inspectRepositorySettings(repository).fields.some((field) => field.key.startsWith("devApi")), false);
    const preview = plan(repository, { name: "Updated API workspace" }, false);
    assert.equal(preview.profile.applications.frontend, undefined);
    assert.equal(preview.profile.browserAutomation.browser, undefined);
    assert.equal(preview.profile.browserAutomation.mode, "api");
    assert.deepEqual(preview.profile.browserAutomation.dataSafety, profile.browserAutomation.dataSafety);
    assert.throws(() => plan(repository, { backendEnabled: false }, false), /requires a configured backend/);
    applyRepositorySettings(preview, "synthetic-settings-owner");
    assert.equal(validateLiveTestProfile(JSON.parse(readFileSync(path, "utf8"))).ok, true);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("repository configuration rejects traversal, credential commands and unsafe health or environment settings", () => {
  const repository = fixture();
  try {
    for (const override of [
      { frontendDirectory: ".." },
      { frontendHealthUrl: "https://example.com/health" },
      { frontendHealthUrl: "http://user:password@127.0.0.1:3000" },
      { frontendCommand: "npm --token synthetic-value" },
      { environments: "local,production" },
      { branchPrefix: "../outside" },
      { unexpected: "Not an editable field" },
      { authenticationRequired: true, authenticationCommand: "npm run auth", authenticationPaths: "../outside" }
    ]) {
      assert.throws(() => plan(repository, override), undefined, JSON.stringify(override));
    }
    const inspected = inspectRepositorySettings(repository);
    assert.throws(() => planRepositorySettings({ repository, revision: "stale",
      values: inspected.values, install: false, packageRoot, validate: validateLiveTestProfile }), /changed/);
    const subdirectory = join(repository, "subdirectory");
    mkdirSync(subdirectory);
    assert.throws(() => localRepository(subdirectory), /root of an existing Git/);
    assert.equal(existsSync(join(repository, SETUP_PROFILE_PATH)), false);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("portal API onboarding wires the owned helper and gate without running code or losing existing authentication", () => {
  const repository = fixture();
  try {
    applyRepositorySettings(plan(repository), "synthetic-settings-owner");
    const path = join(repository, SETUP_PROFILE_PATH);
    const profile = JSON.parse(readFileSync(path, "utf8"));
    profile.browserAutomation.authentication = { required: true, command: "node sign-in.mjs",
      proofCommand: "node prove-portal.mjs", statusPaths: [".auth/session.json"] };
    profile.validation.gates = [{ id: "existing-build", command: "node", args: ["build.mjs"],
      workingDirectory: ".", timeoutSeconds: 30, required: true }];
    profile.validation.apiOnly = { baseRef: "origin/main", paths: ["backend"],
      fullValidationPaths: ["shared"], gateIds: ["existing-build"] };
    writeFileSync(path, JSON.stringify(profile));
    writeFileSync(join(repository, "session.mjs"), "throw new Error('Planning must not execute helpers');");
    const settings = { apiAuthenticationEnabled: true, apiProofUrl: "https://localhost:50443/protected",
      apiScope: "api://fixture/read", apiSessionHelper: "session.mjs", apiConsumerRepository: repository,
      backendEnabled: true, backendPort: 50443, backendHealthUrl: "https://localhost:50443/protected" };
    const preview = plan(repository, settings, false);
    assert.equal(preview.profile.browserAutomation.apiAuthentication.role, "portal");
    assert.equal(preview.profile.validation.gates[0].id, "existing-build");
    assert.equal(preview.profile.validation.gates[1].required, true);
    assert.deepEqual(preview.profile.validation.apiOnly.gateIds, ["existing-build", "portal-backed-api-read"]);
    assert.deepEqual(preview.profile.browserAutomation.authentication.command, "node sign-in.mjs");
    assert.deepEqual(preview.profile.browserAutomation.authentication.proofCommand, "node prove-portal.mjs");
    assert.deepEqual(preview.profile.browserAutomation.authentication.statusPaths, [".auth/session.json"]);
    assert.match(preview.profile.browserAutomation.apiAuthentication.command, /^node sign-in\.mjs && fixlab portal-api-proof/u);
    assert.match(preview.profile.browserAutomation.apiAuthentication.proofCommand, /^fixlab portal-api-proof/u);
    assert.deepEqual(preview.profile.browserAutomation.apiAuthentication.statusPaths, [".auth/session.json", ".auth/api-ready.json"]);
    assert.equal(existsSync(join(repository, ".auth")), false);
    applyRepositorySettings(preview, "synthetic-settings-owner");
    const repeated = plan(repository, {}, false);
    assert.equal(repeated.profile.validation.gates.length, 2);
    assert.equal(repeated.profile.browserAutomation.authentication.apiProofFor.length, 1);
    assert.equal(repeated.profile.browserAutomation.apiAuthentication.command.match(/portal-api-proof/gu).length, 1);
    const disabled = plan(repository, { apiAuthenticationEnabled: false }, false);
    assert.equal(disabled.profile.browserAutomation.apiAuthentication, undefined);
    assert.equal(disabled.profile.browserAutomation.authentication.command, "node sign-in.mjs");
    assert.equal(disabled.profile.validation.gates.length, 1);
    assert.deepEqual(disabled.profile.validation.apiOnly.gateIds, ["existing-build"]);
    assert.throws(() => plan(repository, { ...settings, apiSessionHelper: "../outside.mjs" }, false));
    assert.throws(() => plan(repository, { ...settings,
      apiProofUrl: "https://localhost:50444/protected" }, false), /configured local backend origin/u);
  } finally { rmSync(repository, { recursive: true, force: true }); }
});

test("change-aware onboarding requires API proof for backend scopes but not frontend scopes", () => {
  const repository = fixture();
  try {
    applyRepositorySettings(plan(repository), "synthetic-settings-owner");
    const path = join(repository, SETUP_PROFILE_PATH);
    const profile = JSON.parse(readFileSync(path, "utf8"));
    profile.validation.gates = [{ id: "existing-build", command: "node", args: ["build.mjs"],
      workingDirectory: ".", timeoutSeconds: 30, required: true }];
    profile.validation.changeAware = { baseRef: "origin/main", fullValidationPaths: ["shared"],
      scopes: [
        { paths: ["backend/Src"], gateIds: ["existing-build"] },
        { paths: ["frontend"], gateIds: ["existing-build"] }
      ] };
    writeFileSync(path, JSON.stringify(profile));
    mkdirSync(join(repository, "backend"));
    writeFileSync(join(repository, "session.mjs"), "export async function withApiToken() {}");
    const settings = { apiAuthenticationEnabled: true, apiProofUrl: "https://localhost:50443/protected",
      apiScope: "api://fixture/read", apiSessionHelper: "session.mjs", apiConsumerRepository: repository,
      backendEnabled: true, backendDirectory: "backend", backendPort: 50443,
      backendHealthUrl: "https://localhost:50443/protected" };
    const preview = plan(repository, settings, false);
    assert.deepEqual(preview.profile.validation.changeAware.scopes.map(scope => scope.gateIds), [
      ["existing-build", "portal-backed-api-read"], ["existing-build"]
    ]);
    assert.throws(() => plan(repository, { ...settings, backendDirectory: "." }, false), /Review change-aware backend scopes/u);
    applyRepositorySettings(preview, "synthetic-settings-owner");
    const disabled = plan(repository, { apiAuthenticationEnabled: false }, false);
    assert.deepEqual(disabled.profile.validation.changeAware.scopes.map(scope => scope.gateIds),
      [["existing-build"], ["existing-build"]]);
  } finally { rmSync(repository, { recursive: true, force: true }); }
});

test("API-only onboarding uses its same-repository portal without switching to UI tests or linking to itself", () => {
  const repository = fixture();
  try {
    applyRepositorySettings(plan(repository), "synthetic-settings-owner");
    const path = join(repository, SETUP_PROFILE_PATH);
    const profile = JSON.parse(readFileSync(path, "utf8"));
    profile.browserAutomation.mode = "api";
    profile.browserAutomation.testCommand = "node api-tests.mjs";
    profile.browserAutomation.testSynthesis.defaultDataSource = "non-production-read-only";
    profile.browserAutomation.testSynthesis.mutationMode = "none";
    profile.browserAutomation.dataSafety.allowedOrigins = ["https://localhost:50443"];
    profile.browserAutomation.dataSafety.allowedMethods = ["GET"];
    profile.browserAutomation.authentication = { required: true, command: "node sign-in.mjs",
      proofCommand: "node prove-portal.mjs", statusPaths: [".auth/session.json"] };
    profile.applications.backend = { command: "dotnet run", workingDirectory: ".",
      port: 50443, healthUrl: "https://localhost:50443/protected" };
    writeFileSync(path, JSON.stringify(profile));
    writeFileSync(join(repository, "session.mjs"), "export async function withApiToken() {}");
    const inspected = inspectRepositorySettings(repository);
    assert.ok(inspected.fields.some(field => field.key === "apiSessionHelper"));
    assert.equal(inspected.fields.some(field => field.key === "linkedPortalRepository"), false);
    const preview = plan(repository, { apiAuthenticationEnabled: true,
      apiProofUrl: "https://localhost:50443/protected", apiScope: "api://fixture/read",
      apiSessionHelper: "session.mjs", apiConsumerRepository: repository }, false);
    const browser = preview.profile.browserAutomation;
    assert.equal(browser.mode, "api");
    assert.equal(browser.testCommand, "node api-tests.mjs");
    assert.equal(browser.apiAuthentication.role, "portal");
    assert.equal(browser.authentication.linkedApplication, undefined);
    assert.match(browser.authentication.command, /^node sign-in\.mjs && fixlab portal-api-proof/u);
    assert.match(browser.authentication.proofCommand, /^fixlab portal-api-proof/u);
    assert.ok(browser.authentication.statusPaths.includes(".auth/api-ready.json"));
    assert.deepEqual(preview.profile.applications.frontend, profile.applications.frontend);
    assert.equal(preview.profile.linkedApplications?.length ?? 0, 0);
    assert.equal(validateLiveTestProfile(preview.profile).ok, true);
    applyRepositorySettings(preview, "synthetic-settings-owner");
    const repeated = plan(repository, {}, false);
    assert.equal(repeated.profile.browserAutomation.authentication.command.match(/portal-api-proof/gu).length, 1);
    assert.equal(inspectRepositorySettings(repository).values.apiProductionDatabaseReadOnly, false);
    const production = plan(repository, { apiProductionDatabaseReadOnly: true }, false);
    assert.equal(production.profile.browserAutomation.testSynthesis.defaultDataSource, "production-read-only");
    assert.equal(production.profile.browserAutomation.testSynthesis.mutationMode, "none");
    assert.equal(production.profile.browserAutomation.dataSafety.productionAllowed, false);
    assert.deepEqual(production.profile.browserAutomation.dataSafety.allowedOrigins, ["https://localhost:50443"]);
    assert.equal(production.profile.browserAutomation.apiAuthentication.grant.productionDatabaseReadOnly, true);
    assert.match(production.profile.browserAutomation.authentication.command, /^fixlab portal-api-proof/u);
    assert.deepEqual(production.profile.browserAutomation.authentication.statusPaths, [".auth/api-ready.json"]);
    assert.deepEqual(production.profile.applications.backend, profile.applications.backend);
    applyRepositorySettings(production, "synthetic-settings-owner");
    const nonProduction = plan(repository, { apiProductionDatabaseReadOnly: false }, false);
    assert.equal(nonProduction.profile.browserAutomation.testSynthesis.defaultDataSource, "non-production-read-only");
    assert.match(nonProduction.profile.browserAutomation.authentication.command, /^node sign-in\.mjs && /u);
    const disabled = plan(repository, { apiAuthenticationEnabled: false }, false);
    assert.equal(disabled.profile.browserAutomation.mode, "api");
    assert.equal(disabled.profile.browserAutomation.authentication.command, "node sign-in.mjs");
  } finally { rmSync(repository, { recursive: true, force: true }); }
});

test("API-only onboarding selects a linked portal without writing to it or adding a frontend", () => {
  const repository = fixture();
  const portal = fixture();
  try {
    applyRepositorySettings(plan(portal), "synthetic-portal-owner");
    applyRepositorySettings(plan(repository), "synthetic-api-owner");
    const path = join(repository, SETUP_PROFILE_PATH);
    const profile = JSON.parse(readFileSync(path, "utf8"));
    delete profile.applications.frontend;
    delete profile.browserAutomation.browser;
    profile.browserAutomation.mode = "api";
    profile.browserAutomation.testSynthesis.defaultDataSource = "non-production-read-only";
    profile.browserAutomation.testSynthesis.mutationMode = "none";
    profile.applications.backend = { workingDirectory: ".", command: "dotnet run",
      port: 50443, healthUrl: "https://localhost:50443/protected" };
    writeFileSync(path, JSON.stringify(profile));
    const portalBefore = readFileSync(join(portal, SETUP_PROFILE_PATH), "utf8");
    const settings = { apiAuthenticationEnabled: true, apiProofUrl: "https://localhost:50443/protected",
      apiScope: "api://fixture/read", linkedPortalRepository: portal,
      linkedPortalId: "portal", linkedPortalUrl: "http://localhost:3000" };
    const preview = plan(repository, settings, false);
    assert.equal(preview.profile.applications.frontend, undefined);
    assert.equal(preview.profile.browserAutomation.browser, undefined);
    assert.equal(preview.profile.browserAutomation.mode, "api");
    assert.equal(preview.profile.browserAutomation.apiAuthentication.role, "consumer");
    assert.equal(preview.profile.browserAutomation.authentication.linkedApplication, "portal");
    assert.match(preview.profile.browserAutomation.authentication.command, /linked-api-proof/u);
    applyRepositorySettings(preview, "synthetic-api-owner");
    assert.equal(readFileSync(join(portal, SETUP_PROFILE_PATH), "utf8"), portalBefore);
    assert.equal(existsSync(join(repository, ".auth")), false);
    const disabled = plan(repository, { apiAuthenticationEnabled: false }, false);
    assert.equal(disabled.profile.validation.gates, undefined);
    assert.throws(() => plan(repository, { ...settings, linkedPortalRepository: repository }, false), /separate portal/u);
    assert.throws(() => plan(repository, { ...settings, linkedPortalUrl: "http://localhost:3001" }, false), /match the frontend/u);
    assert.throws(() => plan(repository, { ...settings,
      apiProofUrl: "https://localhost:50444/protected" }, false), /configured local backend origin/u);
  } finally {
    rmSync(repository, { recursive: true, force: true });
    rmSync(portal, { recursive: true, force: true });
  }
});

test("repository settings refuse symlinked scaffolding instead of writing outside the selected repository", () => {
  const repository = fixture();
  const outside = mkdtempSync(join(tmpdir(), "fixlab-settings-outside-"));
  try {
    symlinkSync(outside, join(repository, ".github"), process.platform === "win32" ? "junction" : "dir");
    assert.throws(() => inspectRepositorySettings(repository), /symbolic links/);
    assert.equal(existsSync(join(outside, "fixlab")), false);
  } finally {
    rmSync(repository, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
