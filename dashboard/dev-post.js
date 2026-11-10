import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { apiScope, apiSessionHelper } from "./api-authentication.js";
import { safeRuntimeText } from "./runtime-requests.js";
import { SETUP_PROFILE_PATH, setupPath } from "./repository-setup.js";

function configurationAt(repository, environment = "dev", jobConsent = false, originWrites = false, postBases = false) {
  const label = environment.toUpperCase();
  const operation = originWrites ? `${label} write` : "POST";
  const path = setupPath(repository, SETUP_PROFILE_PATH);
  const info = lstatSync(path);
  if (!info.isFile() || info.nlink !== 1 || info.size > 65536) {
    throw new Error(`${operation} requires an unlinked, bounded repository profile.`);
  }
  const raw = readFileSync(path);
  let profile;
  try { profile = JSON.parse(raw.toString("utf8")); } catch {
    throw new Error(`${operation} requires a valid JSON repository profile.`);
  }
  const safety = profile.browserAutomation?.dataSafety;
  const configuration = originWrites ? safety?.[`${environment}Write`] : safety?.post?.[environment] ??
    (environment === "dev" ? safety?.devPost : undefined);
  if (!configuration || (postBases && configuration.baseUrls === undefined)) { return null; }
  const environments = Array.isArray(profile.environments)
    ? profile.environments : Object.keys(profile.environments ?? {});
  if (!environments.some((value) => typeof value === "string" && value.toLowerCase() === environment) ||
      safety.productionAllowed !== false || profile.validation?.liveTestsRequired === false ||
      profile.browserAutomation.mode === "api" ||
      profile.browserAutomation.apiAuthentication?.productionDatabaseReadOnly === true ||
      (jobConsent
        ? !["non-production-approved", "non-production-read-only", "synthetic-intercepted", "local-fixture"]
          .includes(profile.browserAutomation.testSynthesis?.defaultDataSource)
        : profile.browserAutomation.testSynthesis?.defaultDataSource !== "non-production-approved" ||
          profile.browserAutomation.testSynthesis?.mutationMode !== "approved-write")) {
    throw new Error(`${operation} requires explicit non-production ${originWrites ? "origin" : "endpoint"} approval; API-only and production-backed read-only contracts remain unchanged.`);
  }
  const helper = apiSessionHelper(repository, configuration.sessionHelper);
  if (!helper.endsWith(".mjs")) {
    throw new Error(`${operation} requires an existing .mjs session helper for revision-bound loading.`);
  }
  const scope = apiScope(configuration.scope);
  if (postBases) {
    if (!jobConsent || !["dev", "sit", "uat", "ppe"].includes(environment) ||
        !Array.isArray(configuration.baseUrls) || !configuration.baseUrls.length ||
        configuration.baseUrls.length > 16) {
      throw new Error("All-POST approval requires 1-16 reviewed non-production API base URLs.");
    }
    for (const base of configuration.baseUrls) {
      const url = new URL(base);
      const labels = [...url.hostname.split(/[.-]/u), ...url.pathname.split("/")].map((value) => {
        const label = value.toLowerCase();
        return label === "development" ? "dev" : label;
      });
      if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash ||
          url.href.replace(/\/$/u, "") !== base || !safeRuntimeText(base, 1000) ||
          !/^\/[A-Za-z0-9._~/-]*$/u.test(url.pathname) ||
          /(?:^|[./_-])(?:prod|prd|production)(?:[./_-]|$)/iu.test(`${url.hostname}${url.pathname}`) ||
          !labels.includes(environment) ||
          ["dev", "ppe", "sit", "uat", "stage", "staging"]
            .some((value) => labels.includes(value) && value !== environment)) {
        throw new Error("POST API bases must be exact HTTPS URLs identifying only the selected non-production environment.");
      }
    }
  } else if (originWrites) {
    if (!["dev", "ppe"].includes(environment) || !jobConsent ||
        !Array.isArray(configuration.origins) || !configuration.origins.length ||
        configuration.origins.length > 16) {
      throw new Error(`${label} writes require 1-16 explicitly reviewed ${label} HTTPS origins.`);
    }
    for (const origin of configuration.origins) {
      const url = new URL(origin);
      const labels = url.hostname.toLowerCase().split(/[.-]/u);
      const expected = environment === "dev" ? ["dev", "development"] : ["ppe"];
      if (url.protocol !== "https:" || url.origin !== origin || url.username || url.password ||
          !safeRuntimeText(origin, 1000) || url.hostname.includes("*") ||
          !expected.some((value) => labels.includes(value)) ||
          ["dev", "development", "ppe", "sit", "uat", "stage", "staging", "prod", "prd", "production"]
            .some((value) => labels.includes(value) && !expected.includes(value))) {
        throw new Error(`${label} write origins must be exact credential-free HTTPS origins with a ${label} hostname, not another environment.`);
      }
    }
  } else {
    if (!Array.isArray(configuration.actions) || !configuration.actions.length ||
        configuration.actions.length > 16) {
      throw new Error("POST requires 1-16 exact, repository-approved endpoint/test-record actions.");
    }
    for (const action of configuration.actions) {
      const url = new URL(action?.url);
      if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash ||
          url.href !== action.url || !safeRuntimeText(action.url, 1000) ||
          /(?:^|[.-])(?:prod|prd|production)(?:[.-]|$)/iu.test(url.hostname) ||
          !/^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(action.testRecord?.field) ||
          typeof action.testRecord?.value !== "string" || !action.testRecord.value.trim() ||
          !safeRuntimeText(action.testRecord.value, 200)) {
        throw new Error("POST actions require exact credential-free HTTPS URLs and an explicit safe test-record field/value.");
      }
    }
  }
  return { configuration, helper, scope,
    revision: createHash("sha256").update(raw).update(readFileSync(helper)).digest("hex") };
}

export function createPostWriteApproval(repository, targetEnvironment, jobId) {
  const environment = typeof targetEnvironment === "string" ? targetEnvironment.toLowerCase() : "";
  if (!["dev", "sit", "uat", "ppe"].includes(environment) ||
      typeof jobId !== "string" || !/^[a-f0-9-]{36}$/u.test(jobId)) {
    throw new Error("Job-scoped POST approval requires an exact job and DEV/SIT/UAT/PPE environment.");
  }
  return { jobId, environment, revision: configurationAt(repository, environment, true)?.revision ?? null };
}

function createOriginWriteApproval(repository, targetEnvironment, jobId, expectedEnvironment) {
  const environment = typeof targetEnvironment === "string" ? targetEnvironment.toLowerCase() : "";
  const label = expectedEnvironment.toUpperCase();
  if (environment !== expectedEnvironment || typeof jobId !== "string" || !/^[a-f0-9-]{36}$/u.test(jobId)) {
    throw new Error(`Broad ${label} write approval requires an exact job and explicitly selected ${label} environment.`);
  }
  const plan = configurationAt(repository, environment, true, true);
  if (!plan) {
    throw new Error(`Configure dataSafety.${environment}Write with reviewed ${label} origins and an existing authentication helper before approval.`);
  }
  return { jobId, environment, revision: plan.revision, mode: `${environment}-origin` };
}

export function createDevWriteApproval(repository, targetEnvironment, jobId) {
  return createOriginWriteApproval(repository, targetEnvironment, jobId, "dev");
}

export function createPpeWriteApproval(repository, targetEnvironment, jobId) {
  return createOriginWriteApproval(repository, targetEnvironment, jobId, "ppe");
}

export function createPostBaseApproval(repository, targetEnvironment, jobId) {
  const environment = typeof targetEnvironment === "string" ? targetEnvironment.toLowerCase() : "";
  if (!["dev", "sit", "uat", "ppe"].includes(environment) ||
      typeof jobId !== "string" || !/^[a-f0-9-]{36}$/u.test(jobId)) {
    throw new Error("All-POST approval requires an exact job and explicitly selected non-production environment.");
  }
  const plan = configurationAt(repository, environment, true, false, true);
  if (!plan) {
    throw new Error(`Configure dataSafety.post.${environment}.baseUrls and an existing authentication helper before approval.`);
  }
  return { jobId, environment, revision: plan.revision, mode: "post-base" };
}

export function inspectPostBaseConfiguration(repository) {
  const environments = [];
  const errors = [];
  for (const environment of ["dev", "sit", "uat", "ppe"]) {
    try {
      if (configurationAt(repository, environment, true, false, true)) { environments.push(environment); }
    } catch (error) {
      errors.push({ environment, error: safeRuntimeText(error.message, 1000)
        ? error.message : "Invalid POST API base setup; review the configured environment and helper." });
    }
  }
  return { environments, errors };
}

export function inspectPpeWriteConfiguration(repository) {
  try {
    return { configured: Boolean(configurationAt(repository, "ppe", true, true)), error: null };
  } catch (error) {
    return { configured: false, error: safeRuntimeText(error.message, 1000)
      ? error.message : "PPE write setup validation failed; review the configured origins and authentication helper." };
  }
}

export function isOriginWriteApproval(approval) {
  return approval?.mode === "dev-origin" || approval?.mode === "ppe-origin" ||
    approval?.mode === "post-base";
}

export function createNonProductionPostTool({ repository, targetEnvironment, mutationMode,
  selectedMutationMode = "", allowPostRequests, postWriteApproval, jobId, isReady, ask,
  request = fetch, now = Date.now }) {
  if (allowPostRequests !== undefined && typeof allowPostRequests !== "boolean") {
    throw new Error("allowPostRequests must be a boolean.");
  }
  const environment = typeof targetEnvironment === "string" ? targetEnvironment.toLowerCase() : "";
  const jobConsent = typeof allowPostRequests === "boolean";
  const jobScoped = postWriteApproval !== undefined && postWriteApproval !== null;
  const originWrites = isOriginWriteApproval(postWriteApproval);
  const postBases = postWriteApproval?.mode === "post-base";
  const allMethods = originWrites && !postBases;
  const label = environment.toUpperCase();
  const operation = allMethods ? `${label} write` : "POST";
  if (jobScoped &&
      (typeof postWriteApproval !== "object" || Array.isArray(postWriteApproval) ||
        allowPostRequests !== true || postWriteApproval.jobId !== jobId ||
        postWriteApproval.environment !== environment ||
        (postWriteApproval.mode !== undefined && !originWrites) ||
        (originWrites && (!(postBases ? ["dev", "sit", "uat", "ppe"] : ["dev", "ppe"]).includes(environment) ||
          !(postWriteApproval.mode === `${environment}-origin` ||
            postBases) ||
          postWriteApproval.revision === null)) ||
        typeof jobId !== "string" || !/^[a-f0-9-]{36}$/u.test(jobId) ||
        (postWriteApproval.revision !== null &&
          !/^[a-f0-9]{64}$/u.test(postWriteApproval.revision)))) {
    throw new Error(`Invalid job-scoped ${operation} approval; start a newly reviewed job.`);
  }
  const approvedRevision = postWriteApproval?.revision;
  let approvalStopped = false;
  if (!["dev", "sit", "uat", "ppe"].includes(environment) || selectedMutationMode ||
      (!jobConsent && (environment !== "dev" || mutationMode !== "approved-write"))) {
    return null;
  }
  const planAt = () => {
    try { return configurationAt(repository, environment, jobConsent, originWrites && !postBases, postBases); } catch (error) {
      approvalStopped = jobScoped;
      throw error;
    }
  };
  if (!jobConsent && !planAt()) { return null; }
  return {
    name: allMethods ? `fixlab_${environment}_write` :
      !jobConsent && environment === "dev" ? "fixlab_dev_post" : "fixlab_nonproduction_post",
    description: originWrites
      ? `Send ${allMethods ? "a POST, PUT, PATCH or DELETE" : "any POST, including writes,"} to any path/record within the configured ${label} HTTPS ${postBases ? "API bases" : "origins"}, using existing authentication. The user explicitly approved ${allMethods ? "broad writes" : "all POST requests only"} for this job; no endpoint/test-record list or repeat confirmation is needed. Approval is job/profile/helper-bound and expires with execution. No other ${allMethods ? "" : "methods, "}environments, redirects, retries, credentials or response bodies. A real write is not a passed scenario assertion.`
      : `Send one ${label} POST using its configured endpoint/test-record allowlist and existing authentication helper. ${jobScoped ? "The user approved this job's configured writes through the POST checkbox; no repeat confirmation is needed. Approval is bound to this job and the reviewed profile/helper revision." : "The complete URL and JSON payload require individual human confirmation, even with Allow all."} Missing setup blocks the action, not unrelated work. No redirects, retries, credentials or response bodies. This is a real write, not intercepted evidence.`,
    skipPermission: true,
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", maxLength: 1000 },
        ...(allMethods ? { method: { type: "string", enum: ["POST", "PUT", "PATCH", "DELETE"] } } : {}),
        payload: originWrites
          ? { anyOf: [{ type: "object", additionalProperties: true }, { type: "array", items: {} }] }
          : { type: "object", additionalProperties: true },
        purpose: { type: "string", minLength: 1, maxLength: 200 }
      },
      required: ["url", "purpose", ...(allMethods ? ["method"] : originWrites ? [] : ["payload"])],
      additionalProperties: false
    },
    async handler(args) {
      if (process.env.DEBUG || process.env.PWDEBUG || process.env.NODE_DEBUG) {
        throw new Error(`${operation} requires credential-sensitive debug logging to be disabled.`);
      }
      if (!isReady()) { throw new Error(`${operation} is blocked by policy, the execution budget or executor shutdown.`); }
      if (approvalStopped) {
        throw new Error(`The job-scoped ${operation} approval has stopped after an unsuccessful attempt or changed configuration. Inspect the selected environment and start a newly reviewed job; no request was sent.`);
      }
      const plan = planAt();
      if (!plan) {
        approvalStopped = jobScoped;
        if (originWrites) {
          if (postBases) {
            throw new Error(`${label} POST API bases are not configured. Review dataSafety.post.${environment}.baseUrls and start a newly reviewed job. No request was sent.`);
          }
          throw new Error(`${label} writes are not configured. Configure dataSafety.${environment}Write and start a newly reviewed job. No request was sent.`);
        }
        throw new Error(`${label} POST is not configured. Configure dataSafety.post.${environment} with approved endpoints, test records and an existing API session helper. No request was sent.`);
      }
      if (jobScoped && approvedRevision !== plan.revision) {
        approvalStopped = true;
        throw new Error(`${operation} policy/helper changed or was not configured at approval; start a newly reviewed job. No request was sent.`);
      }
      const method = allMethods ? args?.method : "POST";
      if (!args || Object.keys(args).some((key) => !["url", "payload", "purpose", ...(allMethods ? ["method"] : [])].includes(key)) ||
          (allMethods && !["POST", "PUT", "PATCH", "DELETE"].includes(method)) ||
          (!(originWrites && args.payload === undefined) &&
            (!args.payload || typeof args.payload !== "object" || (!originWrites && Array.isArray(args.payload)))) ||
          !safeRuntimeText(args.purpose, 200) || !args.purpose.trim()) {
        throw new Error(`${operation} requires an exact URL, ${originWrites ? "approved method, optional JSON object/array" : "JSON object"} and non-sensitive purpose.`);
      }
      const payload = args.payload === undefined ? undefined : JSON.stringify(args.payload);
      if (payload !== undefined && !safeRuntimeText(payload, 4000)) {
        throw new Error(`${operation} payload is sensitive or oversized; it cannot be reviewed or sent.`);
      }
      const body = payload === undefined ? undefined : JSON.parse(payload);
      let url;
      if (originWrites) {
        if (!safeRuntimeText(args.url, 1000)) { throw new Error(`${label} write URL is sensitive or invalid.`); }
        const target = new URL(args.url);
        const approvedDestination = postBases
          ? !/%(?:2f|5c|25)/iu.test(target.pathname) && plan.configuration.baseUrls.some((base) => {
            const approved = new URL(base);
            return target.origin === approved.origin &&
              (target.pathname === approved.pathname || target.pathname.startsWith(`${approved.pathname.replace(/\/$/u, "")}/`));
          })
          : plan.configuration.origins.includes(target.origin);
        if (target.protocol !== "https:" || target.username || target.password || target.hash ||
            target.href !== args.url || !approvedDestination) {
          throw new Error(`${label} write destination is outside the explicitly approved ${label} ${postBases ? "API bases" : "origins"}.`);
        }
        url = target.href;
      } else {
        const action = plan.configuration.actions.find((value) => value.url === args.url &&
          Object.hasOwn(body, value.testRecord.field) &&
          body[value.testRecord.field] === value.testRecord.value);
        if (!action) { throw new Error("POST endpoint or test record is not explicitly allowlisted."); }
        url = action.url;
      }
      const expiresAt = now() + 300000;
      if (!jobScoped) {
        const details = JSON.stringify({ environment: label, method: "POST", url,
          purpose: args.purpose, payload: body, expiresAt: new Date(expiresAt).toISOString(),
          ...(jobConsent ? { enabledAtJobStart: allowPostRequests } : {}),
          notice: "Real data-changing action. Review every field. One attempt only; no redirects, retries or blanket approval." }, null, 2);
        if (!safeRuntimeText(details)) { throw new Error("POST review is sensitive or oversized."); }
        const decision = await ask({
          kind: "permission", title: `${allowPostRequests === false ? "Allow" : "Confirm"} one ${label} POST action`, details,
          canApprove: true, perAction: true, choices: [], allowFreeform: false
        });
        if (decision.action !== "allow" || decision.scope !== undefined || decision.recover !== undefined) {
          throw new Error("POST was not individually approved; no request was sent.");
        }
      }
      if (!isReady() || now() >= expiresAt || planAt()?.revision !== plan.revision) {
        approvalStopped = jobScoped;
        throw new Error(`${operation} approval expired or its policy/helper changed; no request was sent.`);
      }
      let adapter;
      try { adapter = await import(`${pathToFileURL(plan.helper).href}?fixlab=${plan.revision}`); } catch {
        throw new Error(`The configured authentication helper could not be loaded; no ${operation} was sent.`);
      }
      if (typeof adapter.withApiToken !== "function") {
        throw new Error("The repository session helper must export withApiToken; no request was sent.");
      }
      let attempts = 0;
      let result;
      let accepting = true;
      try {
        await adapter.withApiToken({ scope: plan.scope, environment, interactive: false }, async (value) => {
          if (!accepting || ++attempts !== 1 || typeof value !== "string" || value.length > 65536 ||
              !/^[A-Za-z0-9._~+/-]+=*$/u.test(value) || !isReady() || now() >= expiresAt ||
              process.env.DEBUG || process.env.PWDEBUG || process.env.NODE_DEBUG ||
              planAt()?.revision !== plan.revision) {
            throw new Error(`${operation} approval/authentication is no longer valid.`);
          }
          try {
            const response = await request(url, {
              method, redirect: "manual", signal: AbortSignal.timeout(15000),
              headers: { Accept: "application/json", "Content-Type": "application/json",
                Authorization: `Bearer ${value}` },
              body: payload
            });
            result = { environment: label, method, status: response.status,
              outcome: "response-received", source: "non-production-approved", mutationMode: "approved-write",
              validationPassed: false, responseBodyReturned: false, automaticRetry: false };
            await response.body?.cancel();
          } catch {
            throw new Error(`${operation} outcome is unknown. Approval is spent. Inspect the selected environment before requesting any new action; no automatic retry was made.`);
          }
        });
      } catch {
        approvalStopped = jobScoped;
        if (attempts) {
          throw new Error(`${operation} may have been attempted. Approval is spent. Inspect the selected environment before any new action; no automatic retry was made.`);
        }
        throw new Error(`${operation} authentication did not complete; no request was sent. Complete human sign-in using the configured helper.`);
      } finally {
        accepting = false;
      }
      if (attempts !== 1 || !result) {
        approvalStopped = jobScoped;
        throw new Error(`${operation} authentication helper did not complete one request. Inspect the selected environment; no automatic retry was made.`);
      }
      if (result.status < 200 || result.status >= 300) {
        approvalStopped = jobScoped;
        throw new Error(`${operation} returned HTTP ${result.status}. Approval is spent; no redirect or automatic retry was made.`);
      }
      return result;
    }
  };
}

export const createDevPostTool = createNonProductionPostTool;
