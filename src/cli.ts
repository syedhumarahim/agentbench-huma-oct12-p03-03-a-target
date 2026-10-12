import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { GitHub } from "./api.ts";
import {
  GovernanceError,
  ensure,
  object,
  stable,
  validateContract,
} from "./contract.ts";
import { Governance, loadSnapshot, markdown } from "./policy.ts";

export function repository(remote: string): string {
  const match =
    /^https:\/\/github\.com\/([A-Za-z0-9_-][A-Za-z0-9_.-]*\/[A-Za-z0-9_-][A-Za-z0-9_.-]*?)(?:\.git)?$/.exec(
      remote,
    );
  ensure(
    match && !match[1]!.includes(".."),
    "Origin must be a credential-free GitHub HTTPS URL",
  );
  return match[1]!;
}
export function localChecks(pkg: unknown, reporter: string): void {
  const scripts = object(object(pkg).scripts);
  for (const check of ["test", "package"])
    ensure(
      typeof scripts[check] === "string" && scripts[check].trim().length > 0,
      "Missing local test or package script",
    );
  // Inspect the supplied reporter without executing Python or trusting external commands.
  ensure(
    /COMMANDS\s*=\s*\{\s*'test':\s*\['npm',\s*'test'\],\s*'package':\s*\['npm',\s*'run',\s*'package'\]\s*\}/.test(
      reporter,
    ),
    "Reporter does not declare the exact test and package checks",
  );
}
async function json(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new GovernanceError(
      "Required local JSON file is missing or malformed",
    );
  }
}
export async function main(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const command = args[0];
  if (!command || command === "help" || command === "--help") {
    console.log(
      "Usage: npm run policy -- <plan|apply|verify|restore>\nSet GOVERNANCE_TOKEN_FILE to the credential file path. Recovery: state/governance-recovery.json",
    );
    return 0;
  }
  ensure(
    args.length === 1 &&
      ["plan", "apply", "verify", "restore"].includes(command),
    "Unknown command or arguments; use plan, apply, verify or restore",
  );
  const contract = validateContract(await json("governance-contract.json"));
  localChecks(
    await json("package.json"),
    await readFile("scripts/report_local_checks.py", "utf8"),
  );
  let remote: string;
  try {
    remote = execFileSync("git", ["remote", "get-url", "origin"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    throw new GovernanceError("Could not read origin Git remote");
  }
  const repo = repository(remote);
  let token: string;
  try {
    ensure(env.GOVERNANCE_TOKEN_FILE, "Missing token file");
    token = (await readFile(env.GOVERNANCE_TOKEN_FILE, "utf8")).trim();
  } catch {
    throw new GovernanceError(
      "Set GOVERNANCE_TOKEN_FILE to a readable credential file",
    );
  }
  const governance = new Governance(new GitHub(token), repo, contract);
  const snapshot = "state/governance-recovery.json";
  if (command === "restore") {
    console.log(
      stable({
        command,
        writes: await governance.restore(
          await loadSnapshot(snapshot, repo, contract),
        ),
      }).trim(),
    );
    return 0;
  }
  if (command === "apply") {
    console.log(
      stable({ command, writes: await governance.apply(snapshot) }).trim(),
    );
    return 0;
  }
  const plan = governance.plan(await governance.inspect());
  if (command === "plan") {
    await mkdir("artifacts", { recursive: true });
    await writeFile("artifacts/governance-plan.json", stable(plan));
    await writeFile("artifacts/governance-plan.md", markdown(plan));
  }
  console.log(stable({ command, changes: plan.changes.length }).trim());
  return command === "verify" && plan.changes.length > 0 ? 1 : 0;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      // The top-level boundary must also sanitize filesystem/Git/runtime exceptions.
      console.error(
        error instanceof GovernanceError
          ? error.message
          : "Governance command failed. Check the contract, local checks, credential permissions, remote state and recovery snapshot. No remote response or credential was logged.",
      );
      process.exitCode = 2;
    });
}
