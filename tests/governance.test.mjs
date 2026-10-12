import test from "node:test";
import assert from "node:assert/strict";
import {
  readFileSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { GitHub } from "../src/api.ts";
import { validateContract, stable } from "../src/contract.ts";
import {
  Governance,
  desired,
  policy,
  validateSnapshot,
  loadSnapshot,
  saveSnapshot,
  markdown,
} from "../src/policy.ts";
import { repository, localChecks, main } from "../src/cli.ts";
const contract = JSON.parse(readFileSync("governance-contract.json", "utf8"));
const clone = (x) => structuredClone(x);
const repo = "tester/repo";
const base = "/repos/" + repo;
const want = desired(contract);
const dir = mkdtempSync(join(tmpdir(), "governance-tests-"));
test.after(() => rmSync(dir, { recursive: true, force: true }));
let counter = 0;
const snapshotPath = () => join(dir, `snapshot-${++counter}.json`);
class Mock {
  constructor(rules = []) {
    this.rules = new Map(rules.map((r) => [r.id, clone(r)]));
    this.calls = [];
    this.next = 100;
    this.hook = undefined;
    this.branch = "main";
  }
  async request(method, path, body) {
    this.calls.push({ method, path, body: clone(body) });
    const intercepted = await this.hook?.(method, path, body);
    if (intercepted !== undefined) return intercepted;
    if (path === base && method === "GET")
      return {
        full_name: repo,
        default_branch: this.branch,
        allow_squash_merge: true,
      };
    if (path.startsWith(base + "/branches/") && method === "GET")
      return { name: this.branch, commit: { sha: "a".repeat(40) } };
    const id = Number(path.split("/").at(-1));
    if (method === "GET") {
      if (!this.rules.has(id)) throw new Error("missing");
      return clone(this.rules.get(id));
    }
    if (method === "POST") {
      const id = ++this.next;
      this.rules.set(id, {
        ...clone(body),
        id,
        source_type: "Repository",
        source: repo,
      });
      return { id };
    }
    if (method === "PUT") {
      this.rules.set(id, {
        ...clone(body),
        id,
        source_type: "Repository",
        source: repo,
      });
      return { id };
    }
    if (method === "DELETE") {
      this.rules.delete(id);
      return null;
    }
    throw new Error("Unexpected request");
  }
  async list(path) {
    this.calls.push({ method: "GET", path });
    return [...this.rules.values()].map((r) => ({
      id: r.id,
      name: r.name,
      source_type: r.source_type,
      source: r.source,
    }));
  }
  writes() {
    return this.calls.filter((c) => c.method !== "GET");
  }
}
const record = (id, p) => ({
  ...clone(p),
  id,
  source_type: "Repository",
  source: repo,
});
const obsolete = {
  ...want,
  name: contract.obsolete_managed_ruleset_name,
  rules: [{ type: "non_fast_forward" }],
};
const unmanaged = record(9, { ...want, name: "unmanaged-do-not-touch" });

test("strict contract validation rejects unknown, unsafe and conflicting policies", () => {
  assert.deepEqual(validateContract(contract), contract);
  const invalid = [
    { version: 2 },
    { rules: [{ type: "unknown" }] },
    { unknown: true },
    { ruleset_name: contract.obsolete_managed_ruleset_name },
    { ruleset_name: "outside" },
    { managed_name_prefix: "a" },
    { branch: "refs/heads/*" },
    { branch: "main" },
    { branch: "refs/heads/../x" },
    { branch: "refs/heads/a//b" },
    { branch: "refs/heads/a.lock" },
    { required_status_checks: [""] },
    { required_status_checks: ["test", "test"] },
    { required_status_checks: ["test"] },
    { required_status_checks: ["test", "package", "other"] },
    { strict: "true" },
    { enforcement: "disabled" },
    { pull_request: false },
    { required_linear_history: false },
    { block_force_pushes: false },
    { block_deletions: false },
    { required_review_thread_resolution: false },
    { allowed_merge_method: "merge" },
    { required_approving_review_count: -1 },
    { bypass_actors: [{}] },
    {
      bypass_actors: [
        { actor_id: 1, actor_type: "User", bypass_mode: "always" },
      ],
    },
    {
      bypass_actors: [
        { actor_id: 1, actor_type: "Team", bypass_mode: "invalid" },
      ],
    },
    { unmanaged_settings: "replace" },
  ];
  for (const patch of invalid)
    assert.throws(() => validateContract({ ...contract, ...patch }));
  const missing = clone(contract);
  delete missing.strict;
  assert.throws(() => validateContract(missing), /Missing/);
  assert.throws(() => validateContract(null));
  const actor = {
    actor_id: 2,
    actor_type: "Team",
    bypass_mode: "pull_request",
  };
  assert.equal(
    validateContract({ ...contract, bypass_actors: [actor] }).bypass_actors
      .length,
    1,
  );
  assert.throws(
    () => validateContract({ ...contract, bypass_actors: [actor, actor] }),
    /Duplicate/,
  );
});

test("policy normalization and recovery validation reject unsupported rules and unsafe targets", () => {
  assert.deepEqual(policy(want), want);
  for (const change of [
    { rules: [{ type: "unsupported", parameters: {} }] },
    { rules: [{ type: "deletion", parameters: {} }] },
    { target: "tag" },
    { conditions: { ref_name: { include: ["~ALL"], exclude: [] } } },
    { rules: [{ type: "deletion" }, { type: "deletion" }] },
    { conditions: { ref_name: { include: [], exclude: [] } } },
  ])
    assert.throws(() => policy({ ...want, ...change }));
  const altered = clone(want);
  const checks = altered.rules.find((r) => r.type === "required_status_checks");
  checks.parameters.required_status_checks[0].integration_id = null;
  assert.deepEqual(policy(altered), want);
  checks.parameters.required_status_checks[0].integration_id = 42;
  assert.notDeepEqual(policy(altered), want);
});

test("API paginates safely and validates list shape", async () => {
  const paths = [];
  const client = new GitHub("fake-test-credential", {
    fetcher: async (url) => {
      paths.push(url);
      return Response.json(
        paths.length === 1
          ? Array.from({ length: 100 }, (_, id) => ({ id }))
          : [{ id: 101 }],
      );
    },
  });
  assert.equal(
    (await client.list(base + "/rulesets?includes_parents=true")).length,
    101,
  );
  assert.match(paths[1], /includes_parents=true&per_page=100&page=2$/);
  await assert.rejects(
    new GitHub("fake", { fetcher: async () => Response.json({}) }).list(
      base + "/rulesets",
    ),
    /Malformed/,
  );
  await assert.rejects(client.request("GET", "https://evil.invalid"), /Unsafe/);
  assert.throws(() => new GitHub(" "), /Credential/);
});

test("API bounds retries, honors numeric and date Retry-After, redacts bodies and transport errors", async () => {
  const sleeps = [];
  let calls = 0;
  const client = new GitHub("fake", {
    now: () => 0,
    sleep: async (ms) => sleeps.push(ms),
    fetcher: async () => {
      calls++;
      if (calls === 1)
        return new Response("secret response", {
          status: 429,
          headers: { "retry-after": "2" },
        });
      if (calls === 2)
        return new Response("secret response", {
          status: 403,
          headers: { "retry-after": "Thu, 01 Jan 1970 00:00:03 GMT" },
        });
      if (calls === 3) return new Response("secret response", { status: 503 });
      return Response.json({ ok: true });
    },
  });
  assert.deepEqual(await client.request("GET", base), { ok: true });
  assert.deepEqual(sleeps, [2000, 3000, 1000]);
  for (const status of [401, 403, 422, 500]) {
    let count = 0;
    const failing = new GitHub("fake", {
      sleep: async () => {},
      fetcher: async () => {
        count++;
        return new Response("VERY_SECRET", { status });
      },
    });
    await assert.rejects(
      failing.request("GET", base),
      (e) =>
        e.message.includes(String(status)) &&
        !e.message.includes("VERY_SECRET"),
    );
    assert.equal(count, status === 500 ? 4 : 1);
  }
  let count = 0;
  const transport = new GitHub("fake", {
    sleep: async () => {},
    fetcher: async () => {
      count++;
      throw new Error("VERY_SECRET");
    },
  });
  await assert.rejects(transport.request("GET", base), /transport failure/);
  assert.equal(count, 4);
  count = 0;
  await assert.rejects(
    transport.request("POST", base + "/rulesets", {}),
    /transport failure/,
  );
  assert.equal(count, 1);
  await assert.rejects(
    new GitHub("fake", {
      fetcher: async () => new Response("not JSON"),
    }).request("GET", base),
    /Malformed/,
  );
  await assert.rejects(
    new GitHub("fake", {
      fetcher: async () =>
        new Response("", { status: 429, headers: { "retry-after": "100" } }),
    }).request("GET", base),
    /bounded/,
  );
  assert.equal(
    await new GitHub("fake", {
      fetcher: async () => new Response(null, { status: 204 }),
    }).request("DELETE", base),
    null,
  );
});

test("timeouts use abort signal and never expose transport material", async () => {
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    const api = new GitHub("fake", {
      timeout: 5,
      sleep: async () => {},
      fetcher: async (_url, options) =>
        new Promise((_resolve, reject) =>
          options.signal.addEventListener("abort", () =>
            reject(new Error("SENSITIVE")),
          ),
        ),
    });
    await assert.rejects(api.request("GET", base), /transport failure/);
  } finally {
    clearTimeout(keepAlive);
  }
});

test("planning is deterministic, read-only, minimal and inspects actual default branch", async () => {
  const api = new Mock([record(1, obsolete), unmanaged]);
  const g = new Governance(api, repo, contract);
  const a = g.plan(await g.inspect());
  const b = g.plan(await g.inspect());
  assert.equal(stable(a), stable(b));
  assert.equal(markdown(a), markdown(b));
  assert.equal(api.writes().length, 0);
  assert.deepEqual(
    a.changes.map((c) => c.operation),
    ["create-and-verify", "delete-after-replacement-verification"],
  );
  api.branch = "trunk";
  assert.equal((await g.inspect()).default_branch, "trunk");
  await assert.rejects(
    new Governance(api, repo, {
      ...contract,
      branch: "refs/heads/main",
    }).inspect(),
    /actual default/,
  );
});

test("apply creates and independently verifies replacement before deletion; second apply writes nothing", async () => {
  const api = new Mock([record(1, obsolete), unmanaged]);
  const g = new Governance(api, repo, contract);
  const path = snapshotPath();
  api.hook = async (method) => {
    if (method !== "GET") assert.ok(readFileSync(path, "utf8"));
  };
  assert.equal(await g.apply(path), 2);
  const creation = api.calls.findIndex((c) => c.method === "POST");
  const deletion = api.calls.findIndex((c) => c.method === "DELETE");
  assert.ok(
    api.calls
      .slice(creation + 1, deletion)
      .some((c) => c.method === "GET" && c.path.endsWith("/101")),
  );
  assert.deepEqual(api.rules.get(9), unmanaged);
  const saved = readFileSync(path, "utf8");
  assert.equal(JSON.parse(saved).managed[0].id, 1);
  api.calls = [];
  assert.equal(await g.apply(path), 0);
  assert.equal(api.writes().length, 0);
  assert.equal(readFileSync(path, "utf8"), saved);
  assert.equal(g.plan(await g.inspect()).changes.length, 0);
});

test("drifted canonical policy is replaced without PUT weakening; duplicates are cleaned", async () => {
  const api = new Mock([
    record(1, { ...obsolete, name: want.name }),
    record(2, obsolete),
    unmanaged,
  ]);
  const g = new Governance(api, repo, contract);
  assert.equal(await g.apply(snapshotPath()), 4);
  assert.deepEqual(
    api.writes().map((x) => x.method),
    ["POST", "DELETE", "DELETE", "PUT"],
  );
  assert.equal(
    [...api.rules.values()].filter((r) => r.name === want.name).length,
    1,
  );
  api.rules.set(150, record(150, want));
  api.calls = [];
  assert.equal(await g.apply(snapshotPath()), 1);
  assert.deepEqual(
    api.writes().map((x) => x.method),
    ["DELETE"],
  );
});

test("verification failure preserves old policy; partial deletion failure resumes without duplicates", async () => {
  const api = new Mock([record(1, obsolete), unmanaged]);
  const g = new Governance(api, repo, contract);
  const path = snapshotPath();
  api.hook = async (method, path) =>
    method === "GET" && path.endsWith("/101")
      ? record(101, obsolete)
      : undefined;
  await assert.rejects(g.apply(path), /verification failed/);
  assert.ok(api.rules.has(1));
  assert.equal(api.writes().filter((r) => r.method === "DELETE").length, 0);
  api.hook = async (method) => {
    if (method === "DELETE") throw new Error("simulated failure");
  };
  await assert.rejects(g.apply(path), /simulated/);
  assert.ok(api.rules.has(1));
  assert.ok(api.rules.has(101));
  api.hook = undefined;
  api.calls = [];
  assert.equal(await g.apply(path), 1);
  assert.equal(api.writes().filter((r) => r.method === "POST").length, 0);
});

test("ambiguous POST failure is recovered by reinspection, never blindly retried", async () => {
  const api = new Mock([record(1, obsolete)]);
  const g = new Governance(api, repo, contract);
  const path = snapshotPath();
  api.hook = async (method, _path, body) => {
    if (method === "POST") {
      api.rules.set(101, record(101, body));
      throw new Error("timeout after server commit");
    }
  };
  await assert.rejects(g.apply(path), /timeout/);
  assert.ok(api.rules.has(1));
  api.hook = undefined;
  api.calls = [];
  assert.equal(await g.apply(path), 1);
  assert.equal(api.writes().filter((c) => c.method === "POST").length, 0);
});

test("concurrent policy changes stop mutation and inherited prefixed rules remain unmanaged", async () => {
  const inherited = {
    ...record(8, want),
    source_type: "Organization",
    source: "tester",
  };
  const api = new Mock([inherited, unmanaged]);
  const g = new Governance(api, repo, contract);
  let count = 0;
  api.hook = async (method, path) => {
    if (method === "GET" && path === base && ++count === 2)
      api.rules.set(7, record(7, obsolete));
  };
  await assert.rejects(g.apply(snapshotPath()), /Remote state changed/);
  assert.equal(api.writes().length, 0);
  api.hook = undefined;
  assert.ok((await g.inspect()).unmanaged_ids.includes(8));
});

test("snapshot validation, missing/malformed files and credential-free canonical content", async () => {
  const path = snapshotPath();
  await saveSnapshot(path, repo, contract, [{ id: 1, policy: obsolete }]);
  const saved = await loadSnapshot(path, repo, contract);
  for (const patch of [
    { version: 2 },
    { repository: "other/repo" },
    { contract_digest: "bad" },
    { unknown: true },
    { managed: "bad" },
    { managed: [{ id: 1, policy: { ...want, name: "unmanaged" } }] },
    { managed: [saved.managed[0], saved.managed[0]] },
  ])
    assert.throws(() =>
      validateSnapshot({ ...saved, ...patch }, repo, contract),
    );
  const injected = clone(saved);
  injected.managed[0].policy.token = "SENSITIVE";
  assert.throws(() => validateSnapshot(injected, repo, contract));
  await assert.rejects(loadSnapshot(snapshotPath(), repo, contract), /missing/);
  const malformed = snapshotPath();
  writeFileSync(malformed, "{broken");
  await assert.rejects(loadSnapshot(malformed, repo, contract), /malformed/);
  await assert.rejects(
    saveSnapshot(malformed, repo, contract, []),
    /malformed/,
  );
});

test("restore recreates only snapshot records, preserves replacement and unmanaged, is idempotent", async () => {
  const path = snapshotPath();
  await saveSnapshot(path, repo, contract, [{ id: 1, policy: obsolete }]);
  const saved = await loadSnapshot(path, repo, contract);
  const api = new Mock([record(2, want), unmanaged]);
  const g = new Governance(api, repo, contract);
  assert.equal(await g.restore(saved), 1);
  assert.ok(api.rules.has(2));
  assert.deepEqual(api.rules.get(9), unmanaged);
  api.calls = [];
  assert.equal(await g.restore(saved), 0);
  assert.equal(api.writes().length, 0);
  await assert.rejects(g.restore({ ...saved, repository: "bad" }));
  assert.equal(api.writes().length, 0);
});

test("restore updates saved name, rolls back partial failure and retains unrelated policies", async () => {
  const path = snapshotPath();
  await saveSnapshot(path, repo, contract, [{ id: 1, policy: obsolete }]);
  const saved = await loadSnapshot(path, repo, contract);
  const before = { ...want, name: obsolete.name };
  const api = new Mock([record(1, before), record(2, want), unmanaged]);
  const g = new Governance(api, repo, contract);
  let failed = false;
  api.hook = async (method, _path, body) => {
    if (method === "PUT" && !failed) {
      failed = true;
      api.rules.set(1, record(1, body));
      throw new Error("partial failure");
    }
  };
  await assert.rejects(g.restore(saved), /preceding verified policy recovered/);
  assert.deepEqual(policy(api.rules.get(1)), before);
  assert.deepEqual(api.rules.get(9), unmanaged);
  api.hook = undefined;
  assert.equal(await g.restore(saved), 1);
  assert.deepEqual(policy(api.rules.get(1)), obsolete);
  api.rules.set(7, record(7, obsolete));
  await assert.rejects(g.restore(saved), /Ambiguous/);
});

test("restore failures preserve active replacement and report unverifiable rollback", async () => {
  const path = snapshotPath();
  await saveSnapshot(path, repo, contract, [{ id: 1, policy: obsolete }]);
  const saved = await loadSnapshot(path, repo, contract);
  const api = new Mock([record(2, want), unmanaged]);
  const g = new Governance(api, repo, contract);
  api.hook = async (method) => {
    if (method === "POST") throw new Error("failure");
  };
  await assert.rejects(g.restore(saved), /failure/);
  assert.ok(api.rules.has(2));
  assert.deepEqual(api.rules.get(9), unmanaged);
  api.rules.set(1, record(1, { ...want, name: obsolete.name }));
  api.hook = async (method) => {
    if (method === "PUT") throw new Error("failure");
  };
  await assert.rejects(g.restore(saved), /rollback could not be verified/);
  assert.ok(api.rules.has(2));
});

test("remote and local-check validation reject credential URLs and reporter drift", () => {
  assert.equal(repository("https://github.com/tester/repo.git"), repo);
  assert.equal(repository("https://github.com/tester/repo"), repo);
  for (const remote of [
    "https://user:secret@github.com/tester/repo.git",
    "git@github.com:tester/repo.git",
    "https://github.com/tester/repo?token=secret",
    "https://evil.invalid/tester/repo",
  ])
    assert.throws(() => repository(remote), /credential-free/);
  const reporter = readFileSync("scripts/report_local_checks.py", "utf8");
  localChecks({ scripts: { test: "node test", package: "build" } }, reporter);
  assert.throws(() => localChecks({ scripts: {} }, reporter), /Missing/);
  assert.throws(
    () => localChecks({ scripts: { test: "x", package: "y" } }, "bad"),
    /Reporter/,
  );
});

test("CLI exit behavior in temporary repositories never exposes local paths or credentials", async () => {
  assert.equal(await main(["help"], {}), 0);
  await assert.rejects(main(["unknown"], {}), /Unknown/);
  const local = join(dir, "cli");
  mkdirSync(local);
  execFileSync("git", ["init", "-q", local]);
  execFileSync("git", [
    "-C",
    local,
    "remote",
    "add",
    "origin",
    "https://bad:VERY_SECRET@github.com/tester/repo.git",
  ]);
  writeFileSync(
    join(local, "governance-contract.json"),
    JSON.stringify(contract),
  );
  writeFileSync(
    join(local, "package.json"),
    JSON.stringify({ scripts: { test: "x", package: "y" } }),
  );
  mkdirSync(join(local, "scripts"));
  writeFileSync(
    join(local, "scripts/report_local_checks.py"),
    readFileSync("scripts/report_local_checks.py"),
  );
  const cli = resolve("src/cli.ts");
  const run = (...args) =>
    spawnSync(process.execPath, ["--experimental-strip-types", cli, ...args], {
      cwd: local,
      encoding: "utf8",
      env: { PATH: process.env.PATH, NODE_NO_WARNINGS: "1" },
    });
  assert.equal(run("help").status, 0);
  assert.equal(run("invalid").status, 2);
  const bad = run("plan");
  assert.equal(bad.status, 2);
  assert.ok(!bad.stderr.includes("VERY_SECRET"));
  assert.ok(!bad.stderr.includes(local));
  writeFileSync(join(local, "governance-contract.json"), "{}");
  assert.match(run("plan").stderr, /Missing required/);
});

test("CLI integration plans deterministically, applies once, verifies drift and restores with offline fetch", () => {
  const local = join(dir, "cli-offline");
  mkdirSync(local);
  execFileSync("git", ["init", "-q", local]);
  execFileSync("git", [
    "-C",
    local,
    "remote",
    "add",
    "origin",
    "https://github.com/tester/repo.git",
  ]);
  writeFileSync(
    join(local, "governance-contract.json"),
    JSON.stringify(contract),
  );
  writeFileSync(
    join(local, "package.json"),
    JSON.stringify({ scripts: { test: "x", package: "y" } }),
  );
  mkdirSync(join(local, "scripts"));
  writeFileSync(
    join(local, "scripts/report_local_checks.py"),
    readFileSync("scripts/report_local_checks.py"),
  );
  writeFileSync(join(local, "fake-credential"), "  offline-test-value\n");
  writeFileSync(join(local, "remote.json"), "[]");
  const fixture = join(local, "mock-fetch.mjs");
  writeFileSync(
    fixture,
    `
import {readFileSync, writeFileSync, appendFileSync} from 'node:fs';
globalThis.fetch = async (url, options) => {
  if (!url.startsWith('https://api.github.com/repos/tester/repo')) throw new Error('Unexpected URL');
  appendFileSync('calls.txt', options.method + '\\n');
  const rules = JSON.parse(readFileSync('remote.json','utf8'));
  const path = new URL(url).pathname;
  const id = Number(path.split('/').at(-1));
  if (options.method === 'GET') {
    if(path === '/repos/tester/repo') return Response.json({full_name:'tester/repo',default_branch:'main',allow_squash_merge:true});
    if(path.includes('/branches/')) return Response.json({name:'main',commit:{sha:'a'.repeat(40)}});
    if(path.endsWith('/rulesets')) return Response.json(rules);
    return Response.json(rules.find(r=>r.id===id));
  }
  if (options.method === 'POST') {
    const value={...JSON.parse(options.body),id:100,source:'tester/repo',source_type:'Repository'};
    rules.push(value); writeFileSync('remote.json',JSON.stringify(rules)); return Response.json(value);
  }
  throw new Error('Unexpected mutation');
};
`,
  );
  const cli = resolve("src/cli.ts");
  const run = (command, credential = "fake-credential") =>
    spawnSync(
      process.execPath,
      ["--experimental-strip-types", "--import", fixture, cli, command],
      {
        cwd: local,
        encoding: "utf8",
        env: {
          PATH: process.env.PATH,
          NODE_NO_WARNINGS: "1",
          GOVERNANCE_TOKEN_FILE: credential,
          NODE_V8_COVERAGE: process.env.NODE_V8_COVERAGE ?? "",
        },
      },
    );
  assert.equal(run("verify").status, 1);
  assert.equal(run("plan").status, 0);
  const plan = readFileSync(join(local, "artifacts/governance-plan.json"));
  const md = readFileSync(join(local, "artifacts/governance-plan.md"));
  assert.equal(run("plan").status, 0);
  assert.deepEqual(
    readFileSync(join(local, "artifacts/governance-plan.json")),
    plan,
  );
  assert.deepEqual(
    readFileSync(join(local, "artifacts/governance-plan.md")),
    md,
  );
  assert.ok(
    readFileSync(join(local, "calls.txt"), "utf8")
      .split("\n")
      .every((m) => !m || m === "GET"),
  );
  assert.equal(run("restore").status, 2);
  assert.equal(run("plan", "missing").status, 2);
  assert.equal(run("apply").status, 0);
  writeFileSync(join(local, "calls.txt"), "");
  assert.equal(run("apply").status, 0);
  assert.equal(run("verify").status, 0);
  assert.equal(run("restore").status, 0);
  assert.ok(
    readFileSync(join(local, "calls.txt"), "utf8")
      .split("\n")
      .every((m) => !m || m === "GET"),
  );
});

test("API pagination caps runaway responses and rate reset is respected", async () => {
  const items = Array.from({ length: 100 }, (_, id) => ({ id }));
  await assert.rejects(
    new GitHub("fake", { fetcher: async () => Response.json(items) }).list(
      base + "/rulesets",
    ),
    /pagination limit/,
  );
  let calls = 0;
  const delays = [];
  const api = new GitHub("fake", {
    now: () => 1000,
    sleep: async (ms) => delays.push(ms),
    fetcher: async () =>
      ++calls === 1
        ? new Response("", {
            status: 403,
            headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "3" },
          })
        : Response.json([]),
  });
  await api.request("GET", base);
  assert.deepEqual(delays, [2000]);
});

test("failed rename leaves active replacement, rerun completes; conflicting staging name blocks writes", async () => {
  const api = new Mock([record(1, { ...obsolete, name: want.name })]);
  const g = new Governance(api, repo, contract);
  const path = snapshotPath();
  api.hook = async (method) => {
    if (method === "PUT") throw new Error("rename failed");
  };
  await assert.rejects(g.apply(path), /rename failed/);
  assert.equal(api.rules.get(101).enforcement, "active");
  api.hook = undefined;
  assert.equal(await g.apply(path), 1);
  assert.equal(api.rules.get(101).name, want.name);
  const conflict = new Mock([
    record(1, { ...obsolete, name: want.name }),
    record(2, { ...obsolete, name: want.name + "-replacement" }),
  ]);
  await assert.rejects(
    new Governance(conflict, repo, contract).apply(snapshotPath()),
    /Conflicting replacement/,
  );
  assert.equal(conflict.writes().length, 0);
});

test("GitHub pull-request readback defaults normalize without losing explicit policy", () => {
  const response = clone(want);
  const params = response.rules.find(
    (r) => r.type === "pull_request",
  ).parameters;
  delete params.required_reviewers;
  delete params.require_extra_approval_for_unattributed_changes;
  assert.deepEqual(policy(response), want);
  params.required_reviewers = [];
  params.require_extra_approval_for_unattributed_changes = true;
  assert.deepEqual(policy(response), want);
  params.require_extra_approval_for_unattributed_changes = false;
  assert.notDeepEqual(policy(response), want);
  params.required_reviewers = [{ reviewer_id: 1 }];
  assert.throws(() => policy(response), /required_reviewers/);
  params.required_reviewers = [];
  params.require_extra_approval_for_unattributed_changes = "invalid";
  assert.throws(() => policy(response), /unattributed/);
});
