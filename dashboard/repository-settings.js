import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, copyFileSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { createExecutorLease } from "./executor-lease.js";
import { SETUP_PROFILE_PATH, REPOSITORY_PROMPT_NAMES, setupPath, browserConfigurationErrors, localRepository } from "./repository-setup.js";
import { safeRuntimeText } from "./runtime-requests.js";
import { configuredWorkflow } from "./workflow-policy.js";
import { apiAuthenticationConfiguration } from "./api-authentication.js";
import { resolveLinkedApplications } from "./linked-applications.js";
import { validationGates } from "./validation-gates.js";
import { persistentDevApiConfiguration } from "./dev-post.js";

export { localRepository };

export const REPOSITORY_SETTING_FIELDS = [
  { key: "efficientWorkflow", label: "Use efficient delivery by default: focused checks, then draft PR?", type: "boolean" },
  { key: "readyPublication", label: "Publish ready for review instead of draft? Required checks and publication consent still apply.", type: "boolean" },
  { key: "unitTestsAfterPr", label: "Run broader local unit tests after PR creation?", type: "boolean" },
  { key: "optionalBuilds", label: "Run optional builds after PR creation? Saved once, not asked each stage.", type: "boolean" },
  { key: "askBeforeLiveTests", label: "Ask before optional live tests after a draft PR? Off runs needed tests automatically within existing approved access.", type: "boolean" },
  { key: "name", label: "What should this repository be called?", type: "text" },
  { key: "frontendDirectory", label: "Where is the frontend? Use a repository-relative folder.", type: "text" },
  { key: "frontendCommand", label: "Which command starts the frontend?", type: "text" },
  { key: "frontendPort", label: "Which local port does the frontend use?", type: "number", max: 65535 },
  { key: "frontendHealthUrl", label: "What is its local health URL?", type: "text" },
  { key: "backendEnabled", label: "Configure a local backend too?", type: "boolean" },
  { key: "backendDirectory", label: "Where is the backend?", type: "text", when: "backendEnabled" },
  { key: "backendCommand", label: "Which command starts the backend?", type: "text", when: "backendEnabled" },
  { key: "backendPort", label: "Which local port does the backend use?", type: "number", max: 65535, when: "backendEnabled" },
  { key: "backendHealthUrl", label: "What is the backend's local health URL?", type: "text", when: "backendEnabled" },
  { key: "browserDirectory", label: "Where should Playwright run?", type: "text" },
  { key: "browserCommand", label: "Which command runs the browser tests?", type: "text" },
  { key: "devApiEnabled", label: "Enable real DEV API reads and all writes once for this repository, without per-job permission prompts?", type: "boolean" },
  { key: "devApiOrigins", label: "Which exact DEV HTTPS API origins may React UI tests use? Separate multiple origins with commas.", type: "text", when: "devApiEnabled" },
  { key: "devApiScope", label: "What is the DEV API's full authentication scope? Never enter a token.", type: "text", when: "devApiEnabled" },
  { key: "devApiSessionHelper", label: "Which existing repository-relative .mjs helper provides normal DEV API authentication?", type: "text", when: "devApiEnabled" },
  { key: "devApiProxyPaths", label: "Optional frontend API proxy prefixes mapped to those DEV origins, for example /api. Review the real proxy configuration first.", type: "text", when: "devApiEnabled", optional: true },
  { key: "apiAuthenticationEnabled", label: "Configure portal-backed API authentication and a real read-only API check? Tokens stay in the portal runner's memory.", type: "boolean" },
  { key: "apiProofUrl", label: "Which approved local HTTPS API endpoint should reject anonymous access and pass an authenticated GET?", type: "text", when: "apiAuthenticationEnabled" },
  { key: "apiScope", label: "What is the full API scope (for example api://client-id/access_as_user)? Never enter a token.", type: "text", when: "apiAuthenticationEnabled" },
  { key: "apiProductionDatabaseReadOnly", label: "Allow this local API to read a production database? Requires a database-enforced read-only identity and an assertReadOnlyDatabase helper; never enables writes or deployed production hosts.", type: "boolean", when: "apiAuthenticationEnabled" },
  { key: "linkedPortalId", label: "Which linked portal ID should own API authentication?", type: "text", when: "apiAuthenticationEnabled", role: "consumer" },
  { key: "linkedPortalRepository", label: "Which separately onboarded local Git repository owns the portal and its authenticated session?", type: "text", when: "apiAuthenticationEnabled", role: "consumer" },
  { key: "linkedPortalUrl", label: "What is that portal's local frontend origin, including its port?", type: "text", when: "apiAuthenticationEnabled", role: "consumer" },
  { key: "apiConsumerRepository", label: "Which local Git repository may request API proof? Use this repository for a combined portal/backend.", type: "text", when: "apiAuthenticationEnabled", role: "portal" },
  { key: "apiIncludeWorktrees", label: "Also grant isolated Git worktrees of that same consumer repository?", type: "boolean", when: "apiAuthenticationEnabled", role: "portal" },
  { key: "apiSessionHelper", label: "Which repository-relative JavaScript helper exports withApiToken and assertApiResponse? It must already exist and use normal portal sign-in.", type: "text", when: "apiAuthenticationEnabled", role: "portal" },
  { key: "authenticationRequired", label: "Does browser validation require sign-in?", type: "boolean", unless: "apiAuthenticationEnabled" },
  { key: "authenticationCommand", label: "Which repository command opens sign-in? Never enter credentials.", type: "text", when: "authenticationRequired", unless: "apiAuthenticationEnabled" },
  { key: "authenticationPaths", label: "Which relative authentication status paths should be checked? Separate them with commas; do not paste file contents.", type: "text", when: "authenticationRequired", unless: "apiAuthenticationEnabled" },
  { key: "environments", label: "Which non-production environments are allowed? Separate them with commas.", type: "text" },
  { key: "targetBranch", label: "Which branch should pull requests target?", type: "text" },
  { key: "branchUserId", label: "What developer alias should own new branches?", type: "text" },
  { key: "branchPrefix", label: "Which branch prefix template should be used? Use {userId} for the alias.", type: "text" },
  { key: "idleTimeoutMinutes", label: "How many idle minutes may an executor wait? Choose 1 to 120.", type: "number", max: 120 }
];
const split = (value) => value.split(",").map((part) => part.trim()).filter(Boolean);
const portalInRepository = (profile) => profile.browserAutomation?.mode !== "api" ||
  (profile.browserAutomation?.apiAuthentication?.role ??
    (profile.applications?.frontend ? "portal" : "consumer")) === "portal";
const settingFields = (apiOnly, localPortal) => REPOSITORY_SETTING_FIELDS.filter((field) =>
  !(apiOnly && (field.key.startsWith("frontend") || field.key.startsWith("devApi"))) &&
  (!field.role || field.role === (localPortal ? "portal" : "consumer")));
const sameApiGrant = (left, right) => left && right &&
  ["repository", "origin", "method", "path"].every((key) => left[key] === right[key]) &&
  (left.includeWorktrees === true) === (right.includeWorktrees === true) &&
  (left.productionDatabaseReadOnly === true) === (right.productionDatabaseReadOnly === true);

function readConfiguration(repository) {
  const root = localRepository(repository);
  const path = setupPath(root, SETUP_PROFILE_PATH);
  let raw = null;
  if (existsSync(path)) {
    const info = lstatSync(path);
    if (!info.isFile() || info.size > 65536) {
      throw new Error("The repository profile must be a regular JSON file no larger than 64 KiB.");
    }
    raw = readFileSync(path);
  }
  let profile = {};
  if (raw) {
    try {
      profile = JSON.parse(raw.toString("utf8"));
    } catch {
      throw new Error("Repair the existing repository profile's JSON before editing settings.");
    }
    if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
      throw new Error("The repository profile must be a JSON object.");
    }
  }
  const directory = lstatSync(root);
  const revision = createHash("sha256").update(`${root}\0${directory.dev}\0${directory.ino}\0`)
    .update(raw ?? "profile-not-created").digest("hex");
  return { root, path, profile, revision, exists: raw !== null };
}

export function inspectRepositorySettings(repository) {
  const info = readConfiguration(repository);
  const p = info.profile;
  const f = p.applications?.frontend ?? {};
  const b = p.applications?.backend ?? {};
  const browser = p.browserAutomation ?? {};
  const apiOnly = browser.mode === "api";
  const auth = browser.authentication ?? {};
  const api = browser.apiAuthentication ?? {};
  const portal = p.linkedApplications?.find((link) => link.id === auth.linkedApplication) ?? {};
  const workflow = configuredWorkflow(p);
  const values = {
    efficientWorkflow: workflow.mode === "efficient",
    readyPublication: workflow.publication === "ready",
    unitTestsAfterPr: workflow.unitTestsAfterPr,
    optionalBuilds: workflow.optionalBuilds,
    askBeforeLiveTests: workflow.askBeforeLiveTests,
    name: p.name ?? basename(info.root),
    frontendDirectory: f.workingDirectory ?? (existsSync(join(info.root, "frontend")) ? "frontend" : "."),
    frontendCommand: f.command ?? "npm start", frontendPort: f.port ?? 3000,
    frontendHealthUrl: f.healthUrl ?? "http://127.0.0.1:3000",
    backendEnabled: Boolean(p.applications?.backend), backendDirectory: b.workingDirectory ?? ".",
    backendCommand: b.command ?? "dotnet run", backendPort: b.port ?? 5000,
    backendHealthUrl: b.healthUrl ?? "http://127.0.0.1:5000/health",
    browserDirectory: browser.workingDirectory ?? f.workingDirectory ?? ".",
    browserCommand: browser.testCommand ?? "npx playwright test",
    devApiEnabled: browser.dataSafety?.devWrite?.allowAll === true,
    devApiOrigins: (browser.dataSafety?.devWrite?.origins ?? []).join(", "),
    devApiScope: browser.dataSafety?.devWrite?.scope ?? "",
    devApiSessionHelper: browser.dataSafety?.devWrite?.sessionHelper ?? "",
    devApiProxyPaths: (browser.dataSafety?.devWrite?.browserProxyPaths ?? []).join(", "),
    apiAuthenticationEnabled: Boolean(browser.apiAuthentication),
    apiProofUrl: api.url ?? (b.healthUrl?.startsWith("https:") ? b.healthUrl : "https://localhost:50443/protected-read"),
    apiScope: api.scope ?? "", apiProductionDatabaseReadOnly: api.productionDatabaseReadOnly === true,
    linkedPortalId: auth.linkedApplication ?? "api-portal",
    linkedPortalRepository: portal.repository ?? "", linkedPortalUrl: portal.url ?? "http://localhost:3000",
    apiConsumerRepository: api.consumerRepository ?? info.root,
    apiIncludeWorktrees: api.grant?.includeWorktrees ?? false,
    apiSessionHelper: api.sessionHelper ?? ".fixlab/api-session.mjs",
    authenticationRequired: auth.required ?? false, authenticationCommand: auth.command ?? "",
    authenticationPaths: (auth.statusPaths ?? []).join(", "),
    environments: (Array.isArray(p.environments) ? p.environments :
      p.environments && typeof p.environments === "object" ? Object.keys(p.environments) : ["local", "dev", "sit"]).join(", "),
    targetBranch: p.pullRequests?.defaultTargetBranch ?? "main",
    branchUserId: p.pullRequests?.branchNaming?.userId ?? "",
    branchPrefix: p.pullRequests?.branchNaming?.prefixTemplate ?? "users/{userId}",
    idleTimeoutMinutes: p.validation?.agentIdleTimeoutMinutes ?? 20
  };
  for (const value of Object.values(values)) {
    if (typeof value === "string" && (!safeRuntimeText(value, 2048) ||
        /--(?:password|passwd|secret|token|cookie|api-key|authorization)(?:=|\s)/i.test(value))) {
      throw new Error("Editable settings contain sensitive or oversized values. Remove credentials from profile commands before using this editor.");
    }
  }
  return { repository: info.root, revision: info.revision, exists: info.exists,
    fields: settingFields(apiOnly, portalInRepository(p)), values };
}

function configuredProfile(root, original, values) {
  const apiOnly = original.browserAutomation?.mode === "api";
  if (!values || typeof values !== "object" || Array.isArray(values) ||
      Object.keys(values).some((key) => !REPOSITORY_SETTING_FIELDS.some((field) => field.key === key))) {
    throw new Error("Only the displayed repository settings may be updated.");
  }
  for (const field of settingFields(apiOnly, portalInRepository(original))) {
    if (field.when && values[field.when] === false) { continue; }
    if (field.unless && values[field.unless] === true) { continue; }
    const value = values[field.key];
    if (field.optional && value === "") { continue; }
    if (field.type === "boolean" ? typeof value !== "boolean"
      : field.type === "number" ? !Number.isInteger(value) || value < 1 || value > field.max
        : !safeRuntimeText(value, 2048) || !value.trim() ||
          /--(?:password|passwd|secret|token|cookie|api-key|authorization)(?:=|\s)/i.test(value)) {
      throw new Error(`Invalid setting: ${field.key}. Use a non-sensitive value of the displayed type.`);
    }
  }
  const directory = (value) => {
    const path = setupPath(root, value);
    if (!existsSync(path) || !lstatSync(path).isDirectory()) {
      throw new Error("Application and browser working directories must already exist inside the repository.");
    }
    return value;
  };
  const application = (prefix, previous) => {
    const url = new URL(values[`${prefix}HealthUrl`]);
    if (!["http:", "https:"].includes(url.protocol) || !["localhost", "127.0.0.1"].includes(url.hostname) ||
        url.username || url.password || url.search || url.hash) {
      throw new Error("Application health URLs must be credential-free loopback HTTP(S) URLs without query strings.");
    }
    return { ...previous, workingDirectory: directory(values[`${prefix}Directory`]),
      command: values[`${prefix}Command`], port: values[`${prefix}Port`], healthUrl: url.href };
  };
  const environments = split(values.environments);
  if (!environments.length || environments.length > 12 || environments.some((name) =>
    !/^[a-z0-9][a-z0-9_-]{0,31}$/i.test(name) || /^(?:prod|production)(?:$|[-_])/i.test(name))) {
    throw new Error("Choose at most 12 named non-production environments.");
  }
  const environmentDefinitions = original.environments && !Array.isArray(original.environments) &&
    typeof original.environments === "object" ? original.environments : null;
  if (environmentDefinitions && environments.some((name) => !Object.hasOwn(environmentDefinitions, name))) {
    throw new Error("Configure new structured environment definitions in the repository profile before enabling them here.");
  }
  if (!/^[a-z0-9][a-z0-9._-]{0,79}$/i.test(values.branchUserId) ||
      !/^[a-z0-9][a-z0-9._/-]{0,199}$/i.test(values.targetBranch) ||
      values.targetBranch.includes("..")) {
    throw new Error("Use a safe developer alias and pull-request target branch.");
  }
  const prefix = values.branchPrefix.replaceAll("{userId}", values.branchUserId);
  if (!/^[a-z0-9][a-z0-9._/-]{0,199}$/i.test(prefix) || prefix.includes("..")) {
    throw new Error("Use a safe branch prefix, with only the optional {userId} placeholder.");
  }
  if (original.browserAutomation?.dataSafety?.productionAllowed === true) {
    throw new Error("This editor cannot change a profile permitting production operations. Review its safety policy separately.");
  }
  const browserDirectory = directory(values.browserDirectory);
  const statusPaths = values.authenticationRequired && !values.apiAuthenticationEnabled ? split(values.authenticationPaths) : [];
  if (values.authenticationRequired && !values.apiAuthenticationEnabled && (!statusPaths.length || statusPaths.length > 8)) {
    throw new Error("Authenticated browser setup requires 1 to 8 relative status paths.");
  }
  for (const path of statusPaths) { setupPath(setupPath(root, browserDirectory), path); }
  const applications = { ...original.applications };
  if (!apiOnly) { applications.frontend = application("frontend", original.applications?.frontend); }
  if (apiOnly && !values.backendEnabled) {
    throw new Error("API-only Playwright validation requires a configured backend.");
  }
  if (values.backendEnabled) { applications.backend = application("backend", original.applications?.backend); }
  else { delete applications.backend; }
  const profile = {
    ...original, version: original.version ?? 1, name: values.name, applications,
    workflow: configuredWorkflow({ workflow: {
      mode: values.efficientWorkflow ? "efficient" : "strict",
      publication: values.readyPublication ? "ready" : "draft",
      unitTestsAfterPr: values.unitTestsAfterPr, optionalBuilds: values.optionalBuilds,
      askBeforeLiveTests: values.askBeforeLiveTests
    } }),
    validation: { ...original.validation, agentIdleTimeoutMinutes: values.idleTimeoutMinutes },
    browserAutomation: {
      package: "@playwright/test", ...(!apiOnly ? { browser: "chromium" } : {}), ...original.browserAutomation,
      workingDirectory: browserDirectory, testCommand: values.browserCommand,
      testSynthesis: original.browserAutomation?.testSynthesis ?? {
        enabled: true, defaultDataSource: "synthetic-intercepted", devReadOnly: Object.keys(original).length === 0,
        ppeReadOnly: Object.keys(original).length === 0,
        mutationMode: "intercepted", requireScenarioEvidence: true
      },
      authentication: { ...original.browserAutomation?.authentication,
        required: values.authenticationRequired, command: values.authenticationRequired ? values.authenticationCommand : "",
        statusPaths },
      dataSafety: { policy: "Use the reviewed test data source and intercept mutations; real writes require separate explicit authorization.",
        ...original.browserAutomation?.dataSafety, productionAllowed: false }
    },
    environments: environmentDefinitions
      ? Object.fromEntries(environments.map((name) => [name, environmentDefinitions[name]])) : environments,
    pullRequests: { ...original.pullRequests, defaultTargetBranch: values.targetBranch,
      requireConfirmation: original.pullRequests?.requireConfirmation ?? true,
      branchNaming: { ...original.pullRequests?.branchNaming,
        userId: values.branchUserId, prefixTemplate: values.branchPrefix } }
  };
  if (values.devApiEnabled) {
    profile.browserAutomation.dataSafety.devWrite = {
      ...original.browserAutomation?.dataSafety?.devWrite,
      allowAll: true, origins: split(values.devApiOrigins),
      scope: values.devApiScope, sessionHelper: values.devApiSessionHelper,
      ...(values.devApiProxyPaths ? { browserProxyPaths: split(values.devApiProxyPaths) } : {})
    };
    if (!values.devApiProxyPaths) { delete profile.browserAutomation.dataSafety.devWrite.browserProxyPaths; }
    profile.browserAutomation.testSynthesis = {
      ...profile.browserAutomation.testSynthesis, devReadOnly: false
    };
    profile.worktreeSetup = { ...profile.worktreeSetup,
      files: [...new Set([...(profile.worktreeSetup?.files ?? []), values.devApiSessionHelper])] };
  } else if (profile.browserAutomation.dataSafety.devWrite?.allowAll === true) {
    profile.browserAutomation.dataSafety.devWrite = {
      ...profile.browserAutomation.dataSafety.devWrite, allowAll: false
    };
  }
  const configured = configuredApiAuthentication(root, original, profile, values, apiOnly);
  if (values.devApiEnabled) { persistentDevApiConfiguration(root, configured); }
  return configured;
}

function configureApiGateSelection(profile, gateId, enabled, apiOnly) {
  validationGates(profile);
  const validation = profile.validation;
  const update = ids => [...ids.filter(id => id !== gateId), ...(enabled ? [gateId] : [])];
  if (validation.apiOnly) {
    validation.apiOnly = { ...validation.apiOnly, gateIds: update(validation.apiOnly.gateIds) };
  }
  if (validation.changeAware) {
    const policy = validation.changeAware;
    const backend = profile.applications?.backend?.workingDirectory?.replace(/\\/gu, "/").replace(/\/$/u, "");
    const applies = scope => scope.paths.some(path => {
      const root = path.replace(/\\/gu, "/").replace(/\/$/u, "");
      return (backend === "." && apiOnly) || root === backend ||
        root.startsWith(`${backend}/`) || backend?.startsWith(`${root}/`);
    });
    if (enabled && !policy.scopes.some(applies)) {
      throw new Error("Review change-aware backend scopes before adding the required API proof gate.");
    }
    validation.changeAware = { ...policy, scopes: policy.scopes.map(scope => ({
      ...scope, gateIds: enabled && applies(scope) ? update(scope.gateIds) :
        scope.gateIds.filter(id => id !== gateId)
    })) };
  }
}

function configuredApiAuthentication(root, original, profile, values, apiOnly) {
  const localPortal = portalInRepository(original);
  const previous = original.browserAutomation?.apiAuthentication;
  const previousTestSynthesis = previous?.previousTestSynthesis ?? original.browserAutomation?.testSynthesis;
  const previousAuthentication = previous?.previousAuthentication ?? {
    required: original.browserAutomation?.authentication?.required ?? false,
    command: original.browserAutomation?.authentication?.command ?? "",
    proofCommand: original.browserAutomation?.authentication?.proofCommand,
    statusPaths: original.browserAutomation?.authentication?.statusPaths ?? [],
    linkedApplication: original.browserAutomation?.authentication?.linkedApplication
  };
  const authentication = profile.browserAutomation.authentication;
  const gateId = "portal-backed-api-read";
  const gates = original.validation?.gates ?? [];
  if (!Array.isArray(gates)) { throw new Error("validation.gates must be an array before configuring API authentication."); }
  const remainingGates = previous ? gates.filter((gate) => gate.id !== gateId) : gates;
  if (previous?.grantAdded) {
    authentication.apiProofFor = (authentication.apiProofFor ?? [])
      .filter((grant) => !sameApiGrant(grant, previous.grant));
  }
  if (previous?.link) {
    profile.linkedApplications = (profile.linkedApplications ?? []).filter((link) => link.id !== previous.link.id);
    if (previous.previousLink) { profile.linkedApplications.push(previous.previousLink); }
  }
  if (!values.apiAuthenticationEnabled) {
    if (previous) {
      Object.assign(authentication, previousAuthentication);
      delete profile.browserAutomation.apiAuthentication;
      configureApiGateSelection(profile, gateId, false, apiOnly);
      if (previous.previousTestSynthesis) {
        profile.browserAutomation.testSynthesis = previous.previousTestSynthesis;
      }
      if (previous.hadExplicitGates || remainingGates.length) { profile.validation.gates = remainingGates; }
      else { delete profile.validation.gates; }
    }
    return profile;
  }
  if (remainingGates.some((gate) => gate.id === gateId)) {
    throw new Error("The generated API gate ID is already in use; review that gate before onboarding authentication.");
  }
  const configuration = apiAuthenticationConfiguration(root, {
    role: localPortal ? "portal" : "consumer", url: values.apiProofUrl, scope: values.apiScope,
    ...(values.apiProductionDatabaseReadOnly ? { productionDatabaseReadOnly: true } : {}),
    ...(localPortal ? { sessionHelper: values.apiSessionHelper,
      consumerRepository: localRepository(values.apiConsumerRepository) } : {})
  });
  if (!(Array.isArray(profile.environments) ? profile.environments : Object.keys(profile.environments)).includes("local")) {
    throw new Error("Portal-backed API setup requires the explicitly permitted local environment.");
  }
  const url = new URL(configuration.url);
  if (apiOnly) {
    profile.browserAutomation.testSynthesis = configuration.productionDatabaseReadOnly
      ? { ...previousTestSynthesis, defaultDataSource: "production-read-only", mutationMode: "none" }
      : previousTestSynthesis;
  }
  if ((apiOnly || configuration.consumerRepository === root) &&
      (!profile.applications?.backend?.healthUrl ||
       new URL(profile.applications.backend.healthUrl).origin !== url.origin)) {
    throw new Error("API proof must target the configured local backend origin, not a different server.");
  }
  profile.browserAutomation.dataSafety.allowedOrigins = [...new Set([
    ...(profile.browserAutomation.dataSafety.allowedOrigins ?? []), url.origin
  ])];
  profile.browserAutomation.dataSafety.allowedMethods = [...new Set([
    ...(profile.browserAutomation.dataSafety.allowedMethods ?? []), "GET"
  ])];
  if (apiOnly && configuration.productionDatabaseReadOnly) {
    profile.browserAutomation.dataSafety.allowedOrigins = [url.origin];
    profile.browserAutomation.dataSafety.allowedMethods = ["GET", "HEAD", "OPTIONS"];
  }
  const relativeRoot = relative(setupPath(root, profile.browserAutomation.workingDirectory), root) || ".";
  const commandName = localPortal ? "portal-api-proof" : "linked-api-proof";
  const runner = `fixlab ${commandName} "${relativeRoot}"`;
  if (!localPortal) {
    authentication.required = true;
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/u.test(values.linkedPortalId)) {
      throw new Error("Choose a safe linked portal ID.");
    }
    const repository = localRepository(values.linkedPortalRepository);
    if (repository === root) { throw new Error("An API-only consumer must select a separate portal repository."); }
    const link = { id: values.linkedPortalId, repository, application: "frontend",
      url: values.linkedPortalUrl, environment: "local" };
    const existing = (profile.linkedApplications ?? []).find((entry) => entry.id === link.id);
    configuration.previousLink = existing;
    configuration.link = link;
    profile.linkedApplications = [...(profile.linkedApplications ?? []).filter((entry) => entry.id !== link.id), link];
    resolveLinkedApplications(root, profile);
    authentication.linkedApplication = link.id;
    authentication.command = `${runner} --authenticate --yes`;
    authentication.proofCommand = `${runner} --proof --yes`;
    authentication.statusPaths = [".auth/api-ready.json"];
  } else {
    const grant = { repository: configuration.consumerRepository, origin: url.origin, method: "GET",
      path: url.pathname, ...(values.apiIncludeWorktrees ? { includeWorktrees: true } : {}),
      ...(configuration.productionDatabaseReadOnly ? { productionDatabaseReadOnly: true } : {}) };
    const grants = authentication.apiProofFor ?? [];
    if (!Array.isArray(grants) || grants.length > 8) { throw new Error("Review existing API proof grants before onboarding."); }
    configuration.grantAdded = !grants.some((entry) => sameApiGrant(entry, grant));
    configuration.grant = grant;
    authentication.apiProofFor = configuration.grantAdded ? [...grants, grant] : grants;
    if (authentication.apiProofFor.length > 8) { throw new Error("At most eight API proof grants are allowed."); }
    Object.assign(authentication, previousAuthentication);
    configuration.command = `${previousAuthentication.command && !configuration.productionDatabaseReadOnly
      ? `${previousAuthentication.command} && ` : ""}${runner} --authenticate --yes`;
    configuration.proofCommand = `${runner} --proof --yes`;
    configuration.statusPaths = configuration.productionDatabaseReadOnly ? [".auth/api-ready.json"]
      : [...new Set([...previousAuthentication.statusPaths, ".auth/api-ready.json"])];
    if (apiOnly) {
      Object.assign(authentication, { required: true, command: configuration.command,
        proofCommand: configuration.proofCommand, statusPaths: configuration.statusPaths });
    }
    profile.worktreeSetup = { ...profile.worktreeSetup,
      files: [...new Set([...(profile.worktreeSetup?.files ?? []), configuration.sessionHelper])] };
  }
  configuration.previousAuthentication = previousAuthentication;
  configuration.previousTestSynthesis = previousTestSynthesis;
  configuration.hadExplicitGates = previous?.hadExplicitGates ?? (original.validation?.gates !== undefined);
  profile.browserAutomation.apiAuthentication = configuration;
  const gate = { id: gateId, kind: "tests", stage: "live-test", required: true,
    workingDirectory: ".", timeoutSeconds: 180,
    ...(process.platform === "win32" ? { command: "pwsh",
      args: ["-NoProfile", "-NonInteractive", "-Command", `& fixlab ${commandName} . --proof --yes; exit $LASTEXITCODE`] }
      : { command: "fixlab", args: [commandName, ".", "--proof", "--yes"] }) };
  profile.validation.gates = [...remainingGates, gate];
  configureApiGateSelection(profile, gateId, true, apiOnly);
  return profile;
}

export function planRepositorySettings({ repository, revision, values, install, packageRoot, validate }) {
  const info = readConfiguration(repository);
  if (revision !== info.revision) { throw new Error("Repository settings changed. Reload and review a new plan."); }
  const profile = configuredProfile(info.root, info.profile, values);
  if (Buffer.byteLength(`${JSON.stringify(profile, null, 2)}\n`) > 65536) {
    throw new Error("The updated repository profile would exceed the 64 KiB settings limit.");
  }
  const validation = validate(profile);
  const errors = [...(validation.ok ? [] : [validation.detail]), ...browserConfigurationErrors(profile, info.root)];
  if (errors.length) { throw new Error(`Profile configuration is incomplete: ${errors.join("; ")}`); }
  const assets = install ? [
    ...REPOSITORY_PROMPT_NAMES.map((name) => ({ name: join(".github", "prompts", name),
      source: join(packageRoot, "prompts", name) })),
    { name: join(".github", "agents", "fixlab-autofix.agent.md"),
      source: join(packageRoot, "templates", "fixlab-autofix.agent.md") }
  ].filter((asset) => {
    const path = setupPath(info.root, asset.name);
    if (!existsSync(path)) { return true; }
    if (!lstatSync(path).isFile()) { throw new Error("Existing FixLab scaffolding must use regular non-symlink files."); }
    return false;
  }) : [];
  return { id: randomUUID(), createdAt: Date.now(), repository: info.root, revision,
    values, profile, assets, files: [...assets.map((asset) => asset.name), SETUP_PROFILE_PATH] };
}

export function applyRepositorySettings(plan, ownerId) {
  const lease = createExecutorLease(plan.repository, ownerId).acquire(plan.id);
  let temporary = null;
  try {
    const current = readConfiguration(plan.repository);
    if (current.revision !== plan.revision) { throw new Error("The repository changed after review; no settings were saved."); }
    for (const asset of plan.assets) {
      const path = setupPath(plan.repository, asset.name);
      if (existsSync(path)) { throw new Error("Setup files changed after review. Review a new plan before applying."); }
    }
    for (const asset of plan.assets) {
      const path = setupPath(plan.repository, asset.name);
      mkdirSync(dirname(path), { recursive: true });
      setupPath(plan.repository, asset.name);
      copyFileSync(asset.source, path, constants.COPYFILE_EXCL);
    }
    const path = setupPath(plan.repository, SETUP_PROFILE_PATH);
    mkdirSync(dirname(path), { recursive: true });
    setupPath(plan.repository, SETUP_PROFILE_PATH);
    const candidate = `${path}.${randomUUID()}.tmp`;
    const descriptor = openSync(candidate, "wx", 0o600);
    temporary = candidate;
    try {
      writeFileSync(descriptor, `${JSON.stringify(plan.profile, null, 2)}\n`);
    } finally {
      closeSync(descriptor);
    }
    renameSync(temporary, path);
    temporary = null;
    return { saved: true, repository: plan.repository, files: plan.files };
  } finally {
    try {
      if (temporary) { unlinkSync(temporary); }
    } finally {
      lease.release();
    }
  }
}
