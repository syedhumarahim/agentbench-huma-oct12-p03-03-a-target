import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { API } from "./api.ts";
import {
  GovernanceError,
  actors,
  contexts,
  ensure,
  keys,
  name,
  object,
  selector,
  stable,
} from "./contract.ts";
import type { Contract } from "./contract.ts";
export type Rule = { type: string; parameters?: Record<string, unknown> };
export type Policy = {
  name: string;
  target: "branch";
  enforcement: "active" | "disabled" | "evaluate";
  bypass_actors: ReturnType<typeof actors>;
  conditions: { ref_name: { include: string[]; exclude: string[] } };
  rules: Rule[];
};
export type Managed = { id: number; policy: Policy };
export type State = {
  repository: string;
  default_branch: string;
  head: string;
  managed: Managed[];
  unmanaged_ids: number[];
};
export type Snapshot = {
  version: 1;
  repository: string;
  contract_digest: string;
  managed: Managed[];
};
function id(value: unknown): number {
  ensure(
    Number.isSafeInteger(value) && Number(value) > 0,
    "Invalid ruleset ID",
  );
  return Number(value);
}
export function policy(value: unknown, strict = false): Policy {
  const p = object(value);
  if (strict)
    keys(p, [
      "name",
      "target",
      "enforcement",
      "bypass_actors",
      "conditions",
      "rules",
    ]);
  name(p.name);
  ensure(
    p.target === "branch" &&
      ["active", "disabled", "evaluate"].includes(String(p.enforcement)),
    "Unsupported ruleset target or enforcement",
  );
  const cond = object(p.conditions);
  keys(cond, ["ref_name"]);
  const refs = object(cond.ref_name);
  keys(refs, ["include", "exclude"]);
  for (const list of [refs.include, refs.exclude]) {
    ensure(Array.isArray(list), "Malformed branch conditions");
    for (const item of list) selector(item);
    ensure(new Set(list).size === list.length, "Duplicate branch selectors");
  }
  ensure((refs.include as string[]).length > 0, "Empty branch targets");
  ensure(Array.isArray(p.rules), "Malformed rules");
  const rules = p.rules
    .map((value: unknown): Rule => {
      const r = object(value);
      keys(r, ["type", "parameters"]);
      ensure(typeof r.type === "string", "Missing rule type");
      if (
        [
          "deletion",
          "non_fast_forward",
          "required_linear_history",
          "creation",
          "update",
        ].includes(r.type)
      ) {
        ensure(r.parameters === undefined, "Unexpected rule parameters");
        return { type: r.type };
      }
      const params = object(r.parameters);
      if (r.type === "pull_request") {
        keys(params, [
          "required_approving_review_count",
          "dismiss_stale_reviews_on_push",
          "require_code_owner_review",
          "require_last_push_approval",
          "required_review_thread_resolution",
          "allowed_merge_methods",
          "required_reviewers",
          "require_extra_approval_for_unattributed_changes",
        ]);
        ensure(
          Number.isInteger(params.required_approving_review_count) &&
            Number(params.required_approving_review_count) >= 0 &&
            Number(params.required_approving_review_count) <= 6,
          "Invalid rule approval count",
        );
        for (const key of [
          "dismiss_stale_reviews_on_push",
          "require_code_owner_review",
          "require_last_push_approval",
          "required_review_thread_resolution",
        ])
          ensure(
            typeof params[key] === "boolean",
            "Malformed pull-request rule",
          );
        if (params.allowed_merge_methods !== undefined)
          ensure(
            Array.isArray(params.allowed_merge_methods) &&
              params.allowed_merge_methods.length > 0 &&
              params.allowed_merge_methods.every((x: unknown) =>
                ["merge", "squash", "rebase"].includes(String(x)),
              ),
            "Malformed allowed merge methods",
          );
        ensure(
          params.required_reviewers === undefined ||
            (Array.isArray(params.required_reviewers) &&
              params.required_reviewers.length === 0),
          "Nonempty required_reviewers are not supported",
        );
        ensure(
          params.require_extra_approval_for_unattributed_changes ===
            undefined ||
            typeof params.require_extra_approval_for_unattributed_changes ===
              "boolean",
          "Malformed unattributed-changes approval policy",
        );
        return {
          type: r.type,
          parameters: {
            ...params,
            required_reviewers: [],
            require_extra_approval_for_unattributed_changes:
              params.require_extra_approval_for_unattributed_changes ?? true,
            ...(params.allowed_merge_methods
              ? {
                  allowed_merge_methods: [
                    ...(params.allowed_merge_methods as string[]),
                  ].sort(),
                }
              : {}),
          },
        };
      }
      ensure(r.type === "required_status_checks", "Unsupported rule type");
      keys(params, [
        "strict_required_status_checks_policy",
        "required_status_checks",
        "do_not_enforce_on_create",
      ]);
      ensure(
        typeof params.strict_required_status_checks_policy === "boolean",
        "Malformed strict status policy",
      );
      ensure(
        params.do_not_enforce_on_create === undefined ||
          typeof params.do_not_enforce_on_create === "boolean",
        "Malformed status creation policy",
      );
      ensure(
        Array.isArray(params.required_status_checks),
        "Malformed status checks",
      );
      const checks = params.required_status_checks
        .map((item: unknown) => {
          const check = object(item);
          keys(check, ["context", "integration_id"]);
          contexts([check.context]);
          ensure(
            check.integration_id === undefined ||
              check.integration_id === null ||
              (Number.isSafeInteger(check.integration_id) &&
                Number(check.integration_id) > 0),
            "Invalid check integration",
          );
          return {
            context: String(check.context),
            ...(check.integration_id == null
              ? {}
              : { integration_id: check.integration_id }),
          };
        })
        .sort((a, b) => a.context.localeCompare(b.context));
      contexts(checks.map((c) => c.context));
      return {
        type: r.type,
        parameters: {
          strict_required_status_checks_policy:
            params.strict_required_status_checks_policy,
          required_status_checks: checks,
          do_not_enforce_on_create: params.do_not_enforce_on_create ?? false,
        },
      };
    })
    .sort((a, b) => a.type.localeCompare(b.type));
  ensure(
    new Set(rules.map((r) => r.type)).size === rules.length,
    "Duplicate rule types",
  );
  return {
    name: p.name,
    target: "branch",
    enforcement: p.enforcement as Policy["enforcement"],
    bypass_actors: actors(p.bypass_actors).sort((a, b) =>
      stable(a).localeCompare(stable(b)),
    ),
    conditions: {
      ref_name: {
        include: [...(refs.include as string[])].sort(),
        exclude: [...(refs.exclude as string[])].sort(),
      },
    },
    rules,
  };
}
export function desired(c: Contract): Policy {
  return policy({
    name: c.ruleset_name,
    target: "branch",
    enforcement: c.enforcement,
    bypass_actors: c.bypass_actors,
    conditions: { ref_name: { include: [c.branch], exclude: [] } },
    rules: [
      { type: "deletion" },
      { type: "non_fast_forward" },
      { type: "required_linear_history" },
      {
        type: "pull_request",
        parameters: {
          required_approving_review_count: c.required_approving_review_count,
          required_review_thread_resolution:
            c.required_review_thread_resolution,
          dismiss_stale_reviews_on_push: false,
          require_code_owner_review: false,
          require_last_push_approval: false,
          allowed_merge_methods: [c.allowed_merge_method],
        },
      },
      {
        type: "required_status_checks",
        parameters: {
          required_status_checks: c.required_status_checks.map((context) => ({
            context,
          })),
          strict_required_status_checks_policy: c.strict,
        },
      },
    ],
  });
}
export function equivalent(a: Policy, b: Policy, ignoreName = false): boolean {
  return stable(ignoreName ? { ...a, name: b.name } : a) === stable(b);
}
export class Governance {
  constructor(api: API, repository: string, contract: Contract) {
    this.api = api;
    this.repository = repository;
    this.contract = contract;
    this.base = "/repos/" + repository;
  }
  readonly api: API;
  readonly repository: string;
  readonly contract: Contract;
  readonly base: string;
  async inspect(): Promise<State> {
    const repo = object(await this.api.request("GET", this.base));
    ensure(
      repo.full_name === this.repository &&
        typeof repo.default_branch === "string",
      "Malformed repository response",
    );
    selector("refs/heads/" + repo.default_branch);
    ensure(
      this.contract.branch === "~DEFAULT_BRANCH" ||
        this.contract.branch === "refs/heads/" + repo.default_branch,
      "Contract must target the actual default branch",
    );
    ensure(
      repo[`allow_${this.contract.allowed_merge_method}_merge`] === true,
      "Contract merge method is disabled in repository settings",
    );
    const branch = object(
      await this.api.request(
        "GET",
        this.base + "/branches/" + encodeURIComponent(repo.default_branch),
      ),
    );
    const commit = object(branch.commit);
    ensure(
      branch.name === repo.default_branch &&
        typeof commit.sha === "string" &&
        /^[a-f0-9]{40}$/.test(commit.sha),
      "Malformed default branch response",
    );
    const summaries = await this.api.list(
      this.base + "/rulesets?includes_parents=true",
    );
    const managed: Managed[] = [];
    const unmanaged: number[] = [];
    const seen = new Set<number>();
    for (const item of summaries) {
      const r = object(item);
      const ruleId = id(r.id);
      ensure(!seen.has(ruleId), "Duplicate ruleset ID in remote response");
      seen.add(ruleId);
      ensure(
        typeof r.name === "string" && typeof r.source_type === "string",
        "Malformed ruleset summary",
      );
      if (
        !r.name.startsWith(this.contract.managed_name_prefix) ||
        r.source_type !== "Repository" ||
        r.source !== this.repository
      ) {
        unmanaged.push(ruleId);
        continue;
      }
      const full = object(
        await this.api.request("GET", `${this.base}/rulesets/${ruleId}`),
      );
      ensure(
        full.id === ruleId &&
          full.name === r.name &&
          full.source === this.repository &&
          full.source_type === "Repository",
        "Ruleset identity changed during inspection",
      );
      managed.push({ id: ruleId, policy: policy(full) });
    }
    return {
      repository: this.repository,
      default_branch: repo.default_branch,
      head: commit.sha,
      managed: managed.sort((a, b) => a.id - b.id),
      unmanaged_ids: unmanaged.sort((a, b) => a - b),
    };
  }
  plan(state: State): {
    version: number;
    repository: string;
    default_branch: string;
    head: string;
    required_checks: string[];
    unmanaged_ruleset_ids: number[];
    desired: Policy;
    changes: { operation: string; id?: number; name?: string }[];
  } {
    const want = desired(this.contract);
    const matching = state.managed
      .filter((r) => equivalent(r.policy, want, true))
      .sort(
        (a, b) =>
          Number(b.policy.name === want.name) -
            Number(a.policy.name === want.name) || a.id - b.id,
      );
    const keep = matching[0];
    const collision = state.managed.some((r) => r.policy.name === want.name);
    const createName = collision ? want.name + "-replacement" : want.name;
    const changes: { operation: string; id?: number; name?: string }[] = [];
    if (!keep) {
      ensure(
        !state.managed.some((r) => r.policy.name === createName),
        "Conflicting replacement ruleset; inspect managed state before retrying",
      );
      changes.push({ operation: "create-and-verify", name: createName });
    }
    // The verified replacement stays active throughout cleanup and renaming.
    for (const r of state.managed.filter((r) => r.id !== keep?.id))
      changes.push({
        operation: "delete-after-replacement-verification",
        id: r.id,
        name: r.policy.name,
      });
    if ((keep?.policy.name ?? createName) !== want.name)
      changes.push({
        operation: "rename-and-verify",
        ...(keep ? { id: keep.id } : {}),
        name: want.name,
      });
    return {
      version: 1,
      repository: this.repository,
      default_branch: state.default_branch,
      head: state.head,
      required_checks: [...this.contract.required_status_checks].sort(),
      unmanaged_ruleset_ids: state.unmanaged_ids,
      desired: want,
      changes,
    };
  }
  async readVerified(ruleId: number, want: Policy): Promise<void> {
    const current = object(
      await this.api.request("GET", `${this.base}/rulesets/${ruleId}`),
    );
    ensure(
      current.id === ruleId &&
        current.source === this.repository &&
        current.source_type === "Repository" &&
        equivalent(policy(current), want),
      "Independent replacement verification failed; existing policies retained",
    );
  }
  async apply(snapshotPath: string): Promise<number> {
    const initial = await this.inspect();
    const plan = this.plan(initial);
    if (!plan.changes.length) return 0;
    await saveSnapshot(
      snapshotPath,
      this.repository,
      this.contract,
      initial.managed,
    );
    // Reject a concurrent administrative change between planning and first write.
    ensure(
      stable(await this.inspect()) === stable(initial),
      "Remote state changed; rerun planning",
    );
    const want = desired(this.contract);
    let keep = initial.managed
      .filter((r) => equivalent(r.policy, want, true))
      .sort(
        (a, b) =>
          Number(b.policy.name === want.name) -
            Number(a.policy.name === want.name) || a.id - b.id,
      )[0];
    let writes = 0;
    if (!keep) {
      const creation = { ...want, name: plan.changes[0]!.name! };
      const response = object(
        await this.api.request("POST", this.base + "/rulesets", creation),
      );
      writes++;
      keep = { id: id(response.id), policy: creation };
    }
    await this.readVerified(keep.id, keep.policy);
    for (const old of initial.managed.filter((r) => r.id !== keep.id)) {
      // Re-read both sides before each destructive operation; never delete a renamed/unmanaged record.
      await this.readVerified(keep.id, keep.policy);
      await this.readVerified(old.id, old.policy);
      await this.api.request("DELETE", `${this.base}/rulesets/${old.id}`);
      writes++;
    }
    if (keep.policy.name !== want.name) {
      await this.api.request("PUT", `${this.base}/rulesets/${keep.id}`, want);
      writes++;
      await this.readVerified(keep.id, want);
    }
    ensure(
      this.plan(await this.inspect()).changes.length === 0,
      "Final policy verification failed; rerun plan",
    );
    return writes;
  }
  async restore(snapshot: Snapshot): Promise<number> {
    validateSnapshot(snapshot, this.repository, this.contract);
    const state = await this.inspect();
    let writes = 0;
    for (const saved of snapshot.managed) {
      const matches = state.managed.filter(
        (r) => r.policy.name === saved.policy.name,
      );
      ensure(
        matches.length <= 1,
        "Ambiguous restore target; duplicate managed name",
      );
      const current = matches[0];
      if (current && equivalent(current.policy, saved.policy)) continue;
      if (current) {
        await this.readVerified(current.id, current.policy);
        try {
          await this.api.request(
            "PUT",
            `${this.base}/rulesets/${current.id}`,
            saved.policy,
          );
          writes++;
          await this.readVerified(current.id, saved.policy);
        } catch {
          // A failed/ambiguous write may have landed. Recover the just-verified policy.
          try {
            await this.api.request(
              "PUT",
              `${this.base}/rulesets/${current.id}`,
              current.policy,
            );
            await this.readVerified(current.id, current.policy);
          } catch {
            throw new GovernanceError(
              "Restore failed and rollback could not be verified; recovery snapshot retained",
            );
          }
          throw new GovernanceError(
            "Restore failed; preceding verified policy recovered",
          );
        }
      } else {
        const result = object(
          await this.api.request("POST", this.base + "/rulesets", saved.policy),
        );
        writes++;
        await this.readVerified(id(result.id), saved.policy);
      }
    }
    const final = await this.inspect();
    ensure(
      snapshot.managed.every((saved) =>
        final.managed.some((r) => equivalent(r.policy, saved.policy)),
      ),
      "Restored policy verification failed",
    );
    return writes;
  }
}
function digest(c: Contract): string {
  return createHash("sha256").update(stable(c)).digest("hex");
}
export function validateSnapshot(
  value: unknown,
  repository: string,
  contract: Contract,
): Snapshot {
  const s = object(value);
  keys(s, ["version", "repository", "contract_digest", "managed"]);
  ensure(
    s.version === 1 &&
      s.repository === repository &&
      s.contract_digest === digest(contract),
    "Recovery snapshot version, repository or contract mismatch",
  );
  ensure(Array.isArray(s.managed), "Malformed recovery snapshot");
  const managed = s.managed.map((value: unknown) => {
    const r = object(value);
    keys(r, ["id", "policy"]);
    const p = policy(r.policy, true);
    ensure(
      p.name.startsWith(contract.managed_name_prefix),
      "Recovery snapshot includes unmanaged ruleset",
    );
    ensure(
      stable(p) === stable(r.policy),
      "Recovery snapshot must contain canonical policies",
    );
    return { id: id(r.id), policy: p };
  });
  ensure(
    new Set(managed.map((r) => r.id)).size === managed.length,
    "Duplicate recovery snapshot IDs",
  );
  // Duplicate remote names are legitimate recovery evidence; restore refuses ambiguous targets.
  return { version: 1, repository, contract_digest: digest(contract), managed };
}
export async function loadSnapshot(
  path: string,
  repo: string,
  contract: Contract,
): Promise<Snapshot> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new GovernanceError(
      "Recovery snapshot missing, unreadable or malformed",
    );
  }
  return validateSnapshot(value, repo, contract);
}
export async function saveSnapshot(
  path: string,
  repo: string,
  contract: Contract,
  managed: Managed[],
): Promise<void> {
  const snapshot = validateSnapshot(
    {
      version: 1,
      repository: repo,
      contract_digest: digest(contract),
      managed,
    },
    repo,
    contract,
  );
  await mkdir("state", { recursive: true, mode: 0o700 });
  try {
    await writeFile(path, stable(snapshot), { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST")
      throw new GovernanceError("Could not safely save recovery snapshot");
    await loadSnapshot(path, repo, contract);
  }
}
export function markdown(plan: ReturnType<Governance["plan"]>): string {
  return `# Governance plan\n\nRepository: ${plan.repository}\n\nDefault branch: ${plan.default_branch}\n\nRequired local checks: ${plan.required_checks.join(", ")}\n\n${plan.changes.length ? plan.changes.map((c) => `- ${c.operation}: ${c.name ?? c.id}`).join("\n") : "No changes required."}\n`;
}
