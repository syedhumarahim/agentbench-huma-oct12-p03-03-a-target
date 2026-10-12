# Protected-main governance

This Node.js 22 TypeScript CLI reconciles `governance-contract.json` with GitHub repository rulesets. The contract requires pull requests into the actual default branch, the exact local commit statuses `test` and `package`, strict up-to-date checking, resolved conversations, linear history, and protection against force pushes and deletion. No bypass actors are configured. Pull requests merge by squash under the ruleset's allowed merge method.

## Setup and commands

Use Node.js 22.6 or later and `npm ci`. Development tools are pinned in `package-lock.json`; there are no runtime dependencies. Keep `origin` in the form `https://github.com/OWNER/REPOSITORY.git`, without credentials. SSH and credential-bearing URLs are rejected.

Set `GOVERNANCE_TOKEN_FILE` to a file containing the GitHub token. Only the path belongs in the environment; the token is read and trimmed at runtime. Do not put a token in arguments, remotes, source files, artifacts, credential helpers, or persistent CLI authentication.

- `npm run policy -- plan` reads repository settings, default-branch state, all paginated ruleset summaries and managed details. It also checks the local package scripts and supplied reporter. It writes deterministic `artifacts/governance-plan.json` and `.md`, with no remote mutations.
- `npm run policy -- apply` saves managed recovery state before its first write, creates and independently reads back the replacement, then removes obsolete or duplicate managed rulesets. A drifted canonical ruleset uses a temporary `-replacement` name until cleanup finishes. The verified replacement remains active through cleanup and renaming. A second successful apply makes zero remote writes.
- `npm run policy -- verify` independently inspects remote state. Exit 0 means no changes are required; exit 1 means policy drift. It does not write remote state.
- `npm run policy -- restore` validates and restores only policies recorded in `state/governance-recovery.json`. See recovery below.

Invalid commands, contracts, snapshots, API failures and unsafe state exit 2. Errors omit remote response bodies, request IDs, authorization headers, token values and absolute local paths. Plan outputs have no timestamps and remain byte-identical while the inspected state is unchanged.

## Managed boundary and rollout guarantees

Only repository-owned rulesets whose names begin with the contract's `managed_name_prefix` are managed. Organization/inherited rules and other names are preserved. Prefix ownership is an explicit administrative delegation: do not use it for unrelated rulesets. The CLI never patches repository settings, including visibility, issue settings, merge settings, Actions permissions or other services. A repository must already permit the contract's merge method; the CLI reports a conflict otherwise. Only ruleset endpoints receive policy writes.

Validation rejects unknown keys, unsupported versions or rule types, duplicate desired names and checks, unsafe branch selectors, inconsistent protections and malformed bypass actors. The contract may use `~DEFAULT_BRANCH` or an exact `refs/heads/...` matching the live default branch. Wildcard targets are deliberately unsupported. Live managed policies must use the supported rule schema before the tool can safely snapshot them; unsupported existing managed rules cause a safe stop.

Reads use bounded timeouts, same-origin numeric pagination (100 pages maximum), and at most four attempts for transient or rate-limited failures. Numeric and HTTP-date `Retry-After` values are honored up to a 30-second per-wait bound; longer limits require a later rerun. Permanent authorization/validation errors are not retried. Mutations are never automatically retried because an ambiguous create response may already have committed. Rerun `plan` and `apply` to inspect and resume; a verified matching replacement is reused. Unexpected existing staging policy conflicts require operator review.

Before a destructive cleanup, both the replacement and the old record are read back. A failed verification leaves earlier policies intact. Partial deletion or rename failure leaves the verified replacement active, and a rerun finishes remaining changes. GitHub offers no transaction spanning rulesets: do not run concurrent policy administrators. The CLI checks for concurrent changes before writing and before deleting, but cannot prevent a change between API calls. Newly initialized repositories have no prior policy to recover if the first creation fails.

## Recovery

`state/governance-recovery.json` contains only canonical managed ruleset definitions, their original IDs, repository identity and a digest binding the snapshot to the contract. It has no credentials, server metadata or unrelated settings. It is created exclusively with owner-only file permissions and is never overwritten on reruns. Protect this local file from tampering. Its digest binds the contract, not the authenticity of the snapshot; it is not a signed backup.

Inspect `plan` and the snapshot before recovery. Keep the same tracked contract and correct credential-free origin, then run `npm run policy -- restore`. Missing, malformed, wrong-repository or wrong-contract snapshots stop before any remote writes. Restore matches saved names, recreates missing records (GitHub allocates new IDs), verifies every restored policy, and never deletes policies absent from the snapshot. Thus a newly installed replacement and unmanaged policies remain intact; an empty initial snapshot is a no-op. Existing duplicate restore targets are rejected. If an update or verification fails, restore attempts to reinstate the immediately preceding verified policy and reports whether that rollback was verified. Keep the snapshot if recovery fails and inspect live state before retrying. Restore may intentionally reinstate weaker saved policy; use it only for actual recovery. It is not an undo of repository settings or a purge of newly created policies.

For a future independent rollout, archive the original snapshot outside the repository and deliberately remove the local snapshot only after reviewing its retention and recovery value. The tool does not rotate or silently replace recovery evidence.

## Protected changes and local verification

Make changes on a non-default branch, commit and push it, then open a pull request. From its clean, committed, pushed head run:

```sh
python scripts/report_local_checks.py --token-file PATH
```

The supplied reporter is kept intact. It runs the real `npm test` and `npm run package`, records hashed logs and JSON under `artifacts/local-checks`, and publishes the `test` and `package` commit statuses on that exact SHA. Both must pass; repeat after every head change. Strict checking also requires the branch to be current with its base. Merge only through the pull request using squash, then delete the merged remote working branch. Never bypass or weaken the ruleset to merge. There are no Actions workflows or hosted runners.

`npm test` includes formatting, linting, strict type checking, and mocked tests with coverage gates (90% lines/functions, 80% branches). `npm run package` compiles JavaScript and declarations and checks package contents without publishing. Tests use temporary local repositories, fake credentials and mocked GitHub responses; they do not read live tokens or access live GitHub state. `--local-only` on the reporter runs checks without publishing statuses. Generated build output, recovery state, logs and artifacts are ignored by Git.

## Permissions and limitations

For a fine-grained GitHub token scoped to this repository, planning/verification need repository metadata and contents read plus administration read for rulesets. Apply/restore require administration write. Publishing branches requires contents write, opening/merging a PR requires pull requests write and contents write, and the local reporter requires commit statuses write. Initial repository creation requires account authorization to create the requested repository. Do not broaden credentials automatically when an operation is denied. Public repositories support rulesets; account and organization restrictions may still block an operation.

Required statuses attest to the reported local checks, not an independently trusted hosted runner. Anyone authorized to write statuses could impersonate a context; this rollout uses the supplied reporter honestly and preserves evidence. Contract-required reviews above zero need other reviewers. Unmanaged or inherited rules can impose additional merge conditions; this tool preserves them and does not claim that matching its contract guarantees merge eligibility.

Before public publication, inspect all tracked history and publication/build artifacts for credentials, keys, credential-bearing URLs and sensitive generated files. Scanners cannot establish the absence of every possible secret, so review any redacted finding before publishing. Preserve the original baseline history. After merging, use read-only API inspection and a fresh public clone to verify policy, statuses, branch cleanup, unchanged unrelated settings, clean plans and the full local quality suite.

The rule payload follows GitHub's [repository rulesets API](https://docs.github.com/en/rest/repos/rules?apiVersion=2022-11-28).
