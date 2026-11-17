# Apply the Agents onboarding set

Root applies this set to `giuseppecrj/pi-herdr-agents` under its target-onboarding grant. This directory is an example, not an installed target or permission to change GitHub settings.

**No dispatch on any repository, including bootstrap dispatch, until [Factorio #837](https://github.com/nublai/pi-herdr-factorio/issues/837) is closed and [#842](https://github.com/nublai/pi-herdr-factorio/issues/842) is fixed.** The selected product must contain both fixes. #842 requires the trusted gate baseline to finish under 360 seconds in the pinned image without raising the limit. Factorio's own suite has never been timed for that baseline. Keep the new controller held. Leave `nubl-factory` untouched.

## Apply in this order

| Step | Owner | Action | Completion evidence |
| --- | --- | --- | --- |
| 1 | Giuseppe, then authorized agent | Authorize a new VM and held install. Prefer agent creation, which automatically gets `tester`, then tailnet setup through `exe-dev-test-vm`. If Giuseppe creates it, he must tag it `tester` himself. Follow [runbook step 1](../../../install-exe-dev.md#set-up-a-factory-for-another-repository-on-a-new-vm). | Fresh VM identity, tester tag and tailnet proof. No production copy. |
| 2 | Giuseppe | Authorize and attach the target GitHub integration on his computer. Attach an existing correctly scoped integration rather than adding it again. Confirm `llm` through `auto:all`, without inference, as in runbook step 2. | Integration-list readback. The agent's key cannot attach integrations. |
| 3 | Root and Giuseppe | Review current target main. This set was checked against Agents `181728b29f4f4af40d9a5ed3b945421255fa0bf6` and Factorio `ad6f07f99fa2bf7f6d365b564f55947bad364d06` (R1–R4). Reconcile later changes. Giuseppe approved the Anthropic second judge and its spend on 2026-11-17; the example WORKFLOW already sets it. Root selects the reviewed product SHA, replaces both placeholders in `gates.json` and `ci.yml`, and refreshes the three gate assets. | Recorded full SHAs, scripts and inventory, target-specific model/spend approval, pin equality and three byte comparisons. Product commit published in `nublai/pi-herdr-factorio`. |
| 4 | Root | Copy this directory's `.github/` tree to Agents. Apply the [release-workflow test changes](release-workflow-test.md). Update the target README badge and `RELEASING.md` CI references as described below. | Target diff contains the seven onboarding files, the release-workflow test edit, and those two doc corrections only. No dependency, engine, or unrelated workflow changes. |
| 5 | Root opens; Giuseppe merges | Run the real workflow and gate parsers, expand the four globs, and run ordinary CI. Root opens the onboarding PR under its grant. Giuseppe merges after exact-head `Checks` and `check` pass, or Root merges under Giuseppe's explicit grant. Keep ruleset 27348552 unchanged at this step. | Parser outputs, exact inventory, both green contexts, reviewed diff and main merge SHA. No admin bypass is needed for the context transition. |
| 6 | Authorized installer operator | Run `--check`, install held at the same product SHA, and prove readiness through runbook steps 4–5. | Fresh current-invocation readiness, singleton target, product/receipt pin, target workflow, sandbox preflight, held status and OwnerFeed evidence. |
| 7 | Root, under separate verification grants | After #837 closes and #842 is fixed, verify both fixes are pinned and require timed baseline evidence under 360 seconds in the pinned image without raising the limit. Then prove the main-backed trusted workflow/report protocol and pinned-image host/unit suite before enabling. | Baseline timing, exact target main, candidate, product, nonce, run and reporter-owned check ID, App 15368 and held-out bindings. No model calls for gate qualification. |
| 8 | Giuseppe | After main-backed bootstrap checks exist, update ruleset 27348552 and apply the separate approval ruleset and Actions settings below. | Settings readback and actual required checks on a normal PR and a factory-shaped head. |
| 9 | Root | Create the five non-enabling labels below, under the target grant. | Repository label-list readback. `factory:enabled` remains absent. |
| 10 | Giuseppe | Verify #837 is closed, #842 is fixed, both fixes are installed/pinned, and timed baseline evidence exists. Create `factory:enabled`, authorize the first fixture and its spend, then explicitly approve lifting this VM's hold. | Recorded grants, ready-label event, exact-head report and review, human handoff, hold restored at the agreed end. |

A parser pass is schema evidence, not live qualification. The example WORKFLOW sets the approved Anthropic second judge and intentionally has no cadence, trigger, scorers, grader, or replay configuration. All seven stage budgets are explicit. Keep all other model stages on OpenAI and the 800,000-token run cap unchanged.

## Copy and pin the files

Destinations are relative to the Agents root:

- `.github/factory/WORKFLOW.md`
- `.github/factory/gates/gates.json`
- `.github/factory/gates/freeze.mjs`
- `.github/factory/gates/reporter.mjs`
- `.github/factory/gates/scan-rules.json`
- `.github/workflows/check.yml`
- `.github/workflows/ci.yml`

The three included gate assets are exact bytes from product `ad6f07f99fa2bf7f6d365b564f55947bad364d06`. When selecting a newer product, refresh them from a local product checkout that has that commit:

```bash
C=<reviewed-full-product-sha>
PRODUCT=<local-factorio-checkout>
TARGET=<authorized-agents-checkout>
for F in freeze.mjs reporter.mjs scan-rules.json; do
  git -C "$PRODUCT" show "$C:.github/factory/gates/$F" > "$TARGET/.github/factory/gates/$F"
  git -C "$PRODUCT" show "$C:.github/factory/gates/$F" | cmp - "$TARGET/.github/factory/gates/$F"
done
```

The general copy form is `git show <sha>:<path>`. Do not reformat these assets. Do not copy `scan.ts`, a gates-local `biome.json`, or any Factorio source into Agents.

`ci.yml` is byte-identical to [the target CI template](../../target-ci.yml). Product and target are separate checkouts. The product SHA pins executable files, package manifest, and lockfile, not installed `node_modules`; installation with `npm ci` is part of the trust assumption. The pinned CI checkout and installer's stop-before-change order are the trust anchors. The disk-byte self-check occurs after modules load and is not an independent code-loading boundary. #837 tracks the base-qualification gap as well as v2 config and suffix-less test gaps.

`check.yml` preserves Agents' Linux job ID `checks` and display name `Checks`, commands, Node 26.12.1 and action pins. A new job named `check` depends on `checks` and uses `if: always()`. It fails unless `needs.checks.result` is `success`, so a failed or skipped Linux suite cannot produce a skipped required check that GitHub accepts. It reports success under the factory's required name without rerunning the suite. Keep both jobs after onboarding. Windows remains non-blocking. Compatibility depends on successful `check`: ordinary PRs get `factory-gates`, while `factory/pr/*`, `factory/run/*`, and integration-bot PRs get only `factory-compatibility`. Compatibility never certifies a factory candidate.

The target README badge points to `ci.yml`, and `RELEASING.md` lines 22–23 describe that workflow and its `Checks` job. Root may correct both in the same onboarding PR. Point the ordinary CI badge and references to `check.yml`, retain the Linux job name `Checks`, and describe `ci.yml` as trusted dispatch rather than ordinary CI.

There is no `npm run check` in Agents. Required ordinary CI runs:

```bash
npm ci --ignore-scripts
npm run format:check
npm run docs:tools:check
npm run lint
npm run typecheck
npm test
npm pack --dry-run
git diff --check
```

Keep docs generation, package preview, and whitespace checks in ordinary `check`. The trusted policy runs typecheck, lint, format, install, baseline, main, candidate, and held-out tests. It omits Factorio-only layout and decisions checks rather than replacing them with no-ops. It does not claim main-owned parity for the three ordinary-only checks.

## Labels

Root creates these labels and records their readback:

| Label | Purpose |
| --- | --- |
| `factory:ready` | Authorized issue intake |
| `factory:needs-info` | Clarification |
| `factory:review` | Ready PR |
| `factory:proposed` | Maintenance or feedback proposal |
| `factory:defect` | Measurement |

Giuseppe alone creates or deletes `factory:enabled`. It is a repository-label existence switch, not an issue label. Its existence does not remove the local hold. Root must not create it during onboarding.

## Rulesets and Actions settings

Giuseppe owns these changes and saves settings readback. Use the [human review procedure](../../../human-review.md#bootstrap-and-enable-protection-as-the-owner), with main-backed bootstrap evidence before enforcing required contexts.

The existing active **Protect main** ruleset, ID **27348552**, requires `Checks` from App **15368** and lets admin role 5 always bypass. Do not remove that requirement before the onboarding PR merges. The example emits both `Checks` and `check` on that PR and every later PR, so the existing protection stays satisfied without bypass. After step 7, Giuseppe edits that same ruleset in step 8:

- Replace required context `Checks` with `check` and `factory-gates`, both bound to GitHub Actions App **15368**. Enable strict up-to-date checks. Remove the always-admin bypass. Keep the PR requirement, deletion and force-push protection, and allow only squash merges. Read back ruleset 27348552 and confirm it is active on `refs/heads/main` with no bypass. No workflow rename accompanies this edit; both old and new contexts already exist.
- The controller requires exactly one successful App 15368 `check` at the promoted head (`host/controller/candidate-port.ts`, publication integrity checks). Its trusted-report validator separately requires `factory-gates` from App 15368 (`src/candidate/validation.ts`, `collectTrustedReport`). `Checks` alone is not a supported substitute. The dependent `check` job supplies the exact name without duplicating the unit suite.
- Separate active one-approval rule with stale dismissal. If Giuseppe chooses the documented admin policy, only admin role 5 gets the PR-only exception. That exception does not bypass integrity checks.
- Enable Actions and permit the pinned checkout, setup-node, upload-artifact, and download-artifact actions. Default workflow permissions remain read-only. Disable Actions creating and approving PRs. The trusted `report` job explicitly requests only `actions: read` and `checks: write` beyond workflow-level `contents: read`.
- Preserve the separate report job without candidate checkout or execution. Use `github.token`, not a custom App secret, private key, personal token, or model credentials.
- Authorize the exe.dev App's target access for repository, issue and permission reads; refs, commits, contents, issues, PRs, comments, labels and reviewer writes; Actions dispatch/read and artifact/check reads. Verify actual integration access under its grant. No factory merge authority is needed.

The dispatcher is `exe-dev-github-integration[bot]`; the reporter is GitHub Actions App 15368. They are different identities. Keep `linux-integration.yml` and `publish.yml` unchanged.

## Test inventory and remaining qualification

The four configured globs are `test/test.ts`, `test/*.test.ts`, `test/*.test.js`, and `test/maestro/*.test.ts`. The [local validation record](validation.md) lists the exact 34 files at Agents `181728b29f4f4af40d9a5ed3b945421255fa0bf6`. Re-expand after target changes.

Before enabling, Root must prove those host/unit tests under the pinned image, read-only tree, frozen reporter, concurrency 3, and 60-second per-file limit. The gate has no network, 4 GiB RAM, 512 PIDs, and 1 GiB tmpfs. Local parser and inventory checks do not prove this compatibility.

Exclude `test/integration/*.test.ts` and benchmark drivers. Agents' separate Linux integration workflow uses real Herdr/Pi lifecycle tests, a 45-minute bound, and seven-day evidence. The unit suite gates every ticket. A ticket that touches Herdr lifecycle code also needs Agents' `linux-integration` workflow green on its PR before Giuseppe merges, as he decided on 2026-11-17; a post-main run alone cannot certify a candidate. Do not add `check:maestro-pin` to git-free exported-tree gates: it needs Git ancestry and is not in ordinary CI's command list.
