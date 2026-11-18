import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { apiSessionHelper } from "./api-authentication.js";
import { configuredValidationEnvironments, validateTargetEnvironment } from "./validation-environments.js";

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
