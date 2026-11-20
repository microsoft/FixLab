import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { apiSessionHelper } from "./api-authentication.js";
import { configuredValidationEnvironments, validateTargetEnvironment } from "./validation-environments.js";
import { setupPath } from "./repository-setup.js";

export const ANALYSIS_EVIDENCE_GUIDANCE =
  "Incident evidence: discover repository-owned Cosmos/trace helpers in profile.analysis.evidenceSources for the exact selected non-production environment. Read helper usage and verify its current source revision. Discovery grants no tool or data access and proves no read-only enforcement; normal permissions, authentication and stricter unit-only/API-only policies remain authoritative. Use only separately approved read-only access with bounded IDs, time ranges and fields. Never infer production permission from DEV or az login; host Copilot MCP connections are not automatically inherited. Preserve sanitized source/time/correlation evidence, not credentials, customer records or raw responses. Missing access, read-only proof or row-level evidence is a blocker, not a confirmed cause or justification for a speculative fix.";

export function configuredAnalysisEvidence(repository, profile, environment) {
  const sources = profile.analysis?.evidenceSources;
  if (sources === undefined) { return []; }
  if (!Array.isArray(sources) || sources.length > 10) {
    throw new Error("analysis.evidenceSources must contain at most 10 repository-owned helpers.");
  }
  const environments = configuredValidationEnvironments(profile);
  const ids = new Set();
  return sources.map(source => {
    if (!source || typeof source.id !== "string" ||
        !/^[a-z][a-z0-9-]{0,63}$/u.test(source.id) || ids.has(source.id) ||
        !["cosmos", "traces"].includes(source.kind) || typeof source.environment !== "string" ||
        !source.environment || /^(prod|production|live)$/iu.test(source.environment) ||
        typeof source.helper !== "string" || source.helper.length > 240 ||
        isAbsolute(source.helper) || !/^[A-Za-z0-9._/\\ -]+$/u.test(source.helper)) {
      throw new Error("Each analysis evidence source requires a unique id, cosmos/traces kind and explicit non-production environment.");
    }
    ids.add(source.id);
    const selected = validateTargetEnvironment(source.environment, environments);
    if (/^live$/iu.test(selected)) {
      throw new Error("Incident evidence helpers require an explicitly configured non-production environment.");
    }
    const helper = apiSessionHelper(repository, source.helper);
    return {
      id: source.id, kind: source.kind, environment: selected, helper: source.helper,
      revision: createHash("sha256").update(readFileSync(helper)).digest("hex")
    };
  }).filter(source => source.environment.toLowerCase() === environment?.toLowerCase());
}

export function analysisEvidenceContext(sources) {
  if (!sources.length) { return ""; }
  return [
    "Configured incident evidence helpers (discovery only, not tool or data authorization):",
    JSON.stringify(sources),
    ANALYSIS_EVIDENCE_GUIDANCE,
    "No helper is executed automatically. Distinguish application exclusions from downstream rejections using actual evidence."
  ].join("\n");
}

export function configuredProductionEvidence(repository, profile) {
  const sources = profile.analysis?.productionReadOnlyEvidence;
  if (sources === undefined) { return []; }
  if (!Array.isArray(sources) || sources.length > 10) {
    throw new Error("analysis.productionReadOnlyEvidence requires at most 10 reviewed readers.");
  }
  const ids = new Set((profile.analysis?.evidenceSources ?? []).map(source => source.id));
  return sources.map(source => {
    const repositoryScope = source?.scope === "repository";
    if (!source || typeof source.id !== "string" ||
        !/^[a-z][a-z0-9-]{0,63}$/u.test(source.id) || ids.has(source.id) ||
        !["cosmos", "traces"].includes(source.kind) || source.environment !== "production" ||
        source.readOnly !== true ||
        (source.scope !== undefined && !repositoryScope) ||
        typeof source.helper !== "string" || source.helper.length > 240 ||
        isAbsolute(source.helper) || !/^[A-Za-z0-9._/\\ -]+$/u.test(source.helper) ||
        typeof source.helperSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(source.helperSha256)) {
      throw new Error("Production evidence requires unique ids, cosmos/traces kind, production environment, readOnly=true, an exact workItemId/correlationId and a reviewed helper SHA256.");
    }
    if (repositoryScope) {
      if (source.kind !== "cosmos" || source.workItemId !== undefined || source.correlationId !== undefined ||
          typeof source.policy !== "string" || source.policy.length > 240 ||
          isAbsolute(source.policy) || !/^[A-Za-z0-9._/\\ -]+\.json$/u.test(source.policy) ||
          /(?:^|[/\\])(?:\.git|node_modules|\.auth|\.env(?:\.[^/\\]*)?)(?:[/\\]|$)/iu.test(source.policy) ||
          typeof source.policySha256 !== "string" || !/^[a-f0-9]{64}$/u.test(source.policySha256)) {
        throw new Error("Repository-scoped production Cosmos evidence requires a reviewed JSON policy and SHA256, without fixed incident identifiers.");
      }
    } else if (!Number.isSafeInteger(source.workItemId) || source.workItemId < 1 ||
        typeof source.correlationId !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(source.correlationId)) {
      throw new Error("Fixed production evidence requires an exact workItemId/correlationId.");
    }
    ids.add(source.id);
    const helper = apiSessionHelper(repository, source.helper);
    const revision = createHash("sha256").update(readFileSync(helper)).digest("hex");
    if (revision !== source.helperSha256) {
      throw new Error(`Production evidence reader ${source.id} changed; review its source and update the approved helper hash.`);
    }
    if (repositoryScope) {
      const policy = setupPath(repository, source.policy);
      const info = lstatSync(policy);
      if (!info.isFile() || info.nlink !== 1 || info.size > 65536) {
        throw new Error("Production evidence policies require contained, unlinked JSON files no larger than 64 KiB.");
      }
      const bytes = readFileSync(policy);
      const policyRevision = createHash("sha256").update(bytes).digest("hex");
      if (policyRevision !== source.policySha256) {
        throw new Error(`Production evidence policy ${source.id} changed; review its source and approved hash.`);
      }
      try { JSON.parse(bytes.toString("utf8")); } catch {
        throw new Error("The reviewed production evidence policy is not valid JSON.");
      }
      return {
        id: source.id, kind: source.kind, environment: "production", readOnly: true,
        scope: "repository", helper: source.helper, revision,
        policy: source.policy, policyRevision
      };
    }
    return {
      id: source.id, kind: source.kind, environment: "production", readOnly: true,
      workItemId: source.workItemId, correlationId: source.correlationId,
      helper: source.helper, revision
    };
  });
}

export function productionEvidenceFor(plan, workItemId) {
  return plan.allowProductionEvidence
    ? (plan.productionEvidence ?? []).filter(source =>
      source.scope === "repository" || source.workItemId === workItemId)
      .map(source => source.scope === "repository" ? { ...source, workItemId } : source)
    : [];
}

export function productionEvidenceContext(sources) {
  if (!sources.length) { return ""; }
  return [
    "Reviewed production incident readers (explicit --allow-production-evidence watcher approval):",
    JSON.stringify(sources),
    "Fixed readers require their exact bound workItemId and correlationId: verify the SHA256 revision, then invoke the helper with --source <id> --ticket <workItemId> --correlation <correlationId> --revision <revision>. Repository-scoped Cosmos readers instead bind the reviewed helper and JSON policy hashes, with the current workItemId supplied above. Read their source/usage; discover policy sources with node <helper> --policy <policy>, generate a private issue plan for this workItemId with observed identifiers and the discovered policyRevision, then preview with --policy <policy> --plan <plan>. Execute only with --execute --allow-production-evidence when normal permissions allow. Use only the policy's exact resources, containers, scalar fields, filters and enforced limits; no arbitrary SQL, unfiltered scans, policy/helper edits or business-data writes. Missing identifiers require a bounded evidence-grounded discovery or an explicit blocker, not invented values. Try each matching reader; preserve a denied Cosmos container's failure and continue with the other approved reader. Preserve sanitized status, reason, time and correlation evidence, not raw records or credentials. Never grant roles, change identity or install connectors.",
    "No production application testing or business-data writes are authorized. This bounded diagnostic exception does not change the selected non-production application test environment or inherit host-session permissions. Verify actual evidence independently before claiming a finding; missing access or saved-state inconsistencies do not prove a causal defect."
  ].join("\n");
}
