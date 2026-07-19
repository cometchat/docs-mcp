// Read an env var treating empty or whitespace-only values as unset.
// Orchestrators (ECS task definitions, PaaS dashboards, sandboxes) commonly
// inject declared-but-empty variables, which must not override defaults.
export function envVar(name: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v.trim() === "" ? undefined : v;
}
