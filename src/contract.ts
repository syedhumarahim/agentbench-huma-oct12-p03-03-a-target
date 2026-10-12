export type Actor = {
  actor_id: number;
  actor_type: "Integration" | "Team" | "RepositoryRole" | "OrganizationAdmin";
  bypass_mode: "always" | "pull_request";
};
export type Contract = {
  version: 1;
  managed_name_prefix: string;
  ruleset_name: string;
  obsolete_managed_ruleset_name: string;
  branch: string;
  enforcement: "active";
  required_status_checks: string[];
  strict: boolean;
  pull_request: true;
  required_approving_review_count: number;
  required_review_thread_resolution: true;
  required_linear_history: true;
  block_force_pushes: true;
  block_deletions: true;
  bypass_actors: Actor[];
  allowed_merge_method: "squash" | "rebase";
  unmanaged_settings: "preserve";
};
export class GovernanceError extends Error {}
export function ensure(condition: unknown, message: string): asserts condition {
  if (!condition) throw new GovernanceError(message);
}
export function object(value: unknown): Record<string, unknown> {
  ensure(
    value !== null && typeof value === "object" && !Array.isArray(value),
    "Expected an object",
  );
  return value as Record<string, unknown>;
}
export function keys(value: Record<string, unknown>, allowed: string[]): void {
  ensure(
    Object.keys(value).every((key) => allowed.includes(key)),
    "Unknown keys are not permitted",
  );
}
export function name(value: unknown): asserts value is string {
  ensure(
    typeof value === "string" &&
      /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(value),
    "Invalid ruleset or repository name",
  );
}
export function selector(value: unknown): asserts value is string {
  ensure(
    typeof value === "string" &&
      (value === "~DEFAULT_BRANCH" ||
        /^refs\/heads\/[A-Za-z0-9_-][A-Za-z0-9_./-]*$/.test(value)),
    "Malformed branch selector or unsafe wildcard target",
  );
  ensure(
    !value.includes("..") &&
      !value.includes("//") &&
      !value.endsWith("/") &&
      !value.endsWith(".") &&
      !value.endsWith(".lock"),
    "Malformed branch selector",
  );
}
export function actors(value: unknown): Actor[] {
  ensure(Array.isArray(value), "bypass_actors must be an array");
  const result = value.map((item: unknown) => {
    const a = object(item);
    keys(a, ["actor_id", "actor_type", "bypass_mode"]);
    ensure(
      Number.isSafeInteger(a.actor_id) && Number(a.actor_id) > 0,
      "Invalid bypass actor ID",
    );
    ensure(
      ["Integration", "Team", "RepositoryRole", "OrganizationAdmin"].includes(
        String(a.actor_type),
      ),
      "Unsupported bypass actor type",
    );
    ensure(
      ["always", "pull_request"].includes(String(a.bypass_mode)),
      "Unsupported bypass mode",
    );
    return a as Actor;
  });
  ensure(
    new Set(result.map((a) => `${a.actor_type}:${a.actor_id}`)).size ===
      result.length,
    "Duplicate bypass actors",
  );
  return result;
}
export function contexts(value: unknown): string[] {
  ensure(
    Array.isArray(value) && value.length > 0,
    "Status checks must not be empty",
  );
  ensure(
    value.every(
      (v: unknown) =>
        typeof v === "string" &&
        /^[A-Za-z0-9][A-Za-z0-9 _./-]{0,99}$/.test(v) &&
        v.trim() === v,
    ),
    "Invalid or empty status-check name",
  );
  ensure(new Set(value).size === value.length, "Duplicate status checks");
  return value as string[];
}
export function validateContract(value: unknown): Contract {
  const c = object(value);
  const required = [
    "version",
    "managed_name_prefix",
    "ruleset_name",
    "obsolete_managed_ruleset_name",
    "branch",
    "enforcement",
    "required_status_checks",
    "strict",
    "pull_request",
    "required_approving_review_count",
    "required_review_thread_resolution",
    "required_linear_history",
    "block_force_pushes",
    "block_deletions",
    "bypass_actors",
    "allowed_merge_method",
    "unmanaged_settings",
  ];
  keys(c, required);
  ensure(
    required.every((key) => key in c),
    "Missing required contract key",
  );
  ensure(c.version === 1, "Unsupported contract version");
  name(c.managed_name_prefix);
  name(c.ruleset_name);
  name(c.obsolete_managed_ruleset_name);
  ensure(
    c.managed_name_prefix.endsWith("-") && c.managed_name_prefix.length >= 4,
    "Unsafe managed-name prefix",
  );
  ensure(
    c.ruleset_name.startsWith(c.managed_name_prefix) &&
      c.obsolete_managed_ruleset_name.startsWith(c.managed_name_prefix),
    "Ruleset names must be in managed scope",
  );
  ensure(
    c.ruleset_name !== c.obsolete_managed_ruleset_name &&
      c.obsolete_managed_ruleset_name !== c.ruleset_name + "-replacement",
    "Duplicate or conflicting managed ruleset names",
  );
  ensure(
    c.ruleset_name.length <= 88,
    "Ruleset name leaves no room for replacement suffix",
  );
  selector(c.branch);
  ensure(
    c.enforcement === "active" && c.unmanaged_settings === "preserve",
    "Policy must be active and preserve unmanaged settings",
  );
  for (const key of [
    "pull_request",
    "required_review_thread_resolution",
    "required_linear_history",
    "block_force_pushes",
    "block_deletions",
  ])
    ensure(c[key] === true, `Conflicting policy: ${key} must be true`);
  ensure(typeof c.strict === "boolean", "strict must be boolean");
  ensure(
    Number.isInteger(c.required_approving_review_count) &&
      Number(c.required_approving_review_count) >= 0 &&
      Number(c.required_approving_review_count) <= 6,
    "Invalid approval count",
  );
  ensure(
    ["squash", "rebase"].includes(String(c.allowed_merge_method)),
    "Merge method conflicts with linear history",
  );
  const checks = contexts(c.required_status_checks);
  ensure(
    checks.length === 2 &&
      checks.includes("test") &&
      checks.includes("package"),
    "Required checks must be exactly test and package",
  );
  actors(c.bypass_actors);
  return c as Contract;
}
export function stable(value: unknown): string {
  function sort(v: unknown): unknown {
    if (Array.isArray(v)) return v.map(sort);
    if (v !== null && typeof v === "object")
      return Object.fromEntries(
        Object.entries(v)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, x]) => [k, sort(x)]),
      );
    return v;
  }
  return JSON.stringify(sort(value), null, 2) + "\n";
}
