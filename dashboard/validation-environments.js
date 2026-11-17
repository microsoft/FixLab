export function configuredValidationEnvironments(profile) {
  const configured = Array.isArray(profile?.environments)
    ? profile.environments
    : Object.keys(profile?.environments ?? {});
  const environments = [];
  const seen = new Set();
  for (const value of configured) {
    if (typeof value !== "string") {
      continue;
    }
    const environment = value.trim();
    const normalized = environment.toLowerCase();
    if (!environment || environment.length > 64 ||
        ["prod", "prd", "production"].includes(normalized) || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    environments.push(environment);
  }
  return environments;
}

export function validateTargetEnvironment(value, environments) {
  if (value === undefined || value === null || value === "") {
    return "";
  }
  if (typeof value !== "string") {
    throw new Error("targetEnvironment must be a string");
  }
  const requested = value.trim();
  if (["prod", "prd", "production"].includes(requested.toLowerCase())) {
    throw new Error("targetEnvironment must be a non-production environment");
  }
  const selected = environments.find(
    environment => environment.toLowerCase() === requested.toLowerCase()
  );
  if (!selected) {
    throw new Error("targetEnvironment must be one of the repository profile environments");
  }
  return selected;
}
