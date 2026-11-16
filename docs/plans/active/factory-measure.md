# Factory measurement plan

The factory records tokens and outcomes, but nobody can say what a run costs in dollars, where a run's time goes, or whether a factory change made results better. This program serves the owner, who decides what to change next, and the coordinator, who has to prove each change.

The rule it enforces is that every claim about a factory change comes with a number, and that number comes from a stated method with stated coverage.

The PRs are M1 to M6:
- **M1.** Prices runs.
- **M2.** Records the facts that are missing today.
- **M3.** Shows a scoreboard.
- **M4.** Exports past runs as benchmark tasks.
- **M5.** Replays those tasks offline.
- **M6.** Compares configurations and runs the first two experiments.

## How to read this

One box is one unit of work. Every box names the evidence that checks it. A nested box is a sub-step of the box above it. Check a box only when its evidence exists, a file, a log line, a screenshot, a test run, or a SHA. The body is a how-to. The appendices explain and record.

The program runs the poteto-mode playbook `playbooks/autopilot-full.md`. The coordinator merges each verified PR only under an owner grant that names this program. M2 changes controller recording, so it also waits for the root session's relayed independent Claude review before merge. M5 and M6 spend model tokens on the bench host only under the owner's spend grant in Appendix C.

Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

## Program checklist

### Arm the program

- [ ] State the protocol and this plan to the operator, then stop. Start execution only on the operator's explicit go.
- [ ] Get the owner's four decisions in Appendix C before M2, M5 and M6 start. Record each in `docs/decisions.tsv`.
- [ ] Read these from the installed skill directories at program start. Re-read them at every audit.
  - [ ] The poteto-mode playbook `playbooks/autopilot-full.md`.
  - [ ] The swarm skill, `/home/g/.pi/agent/npm/node_modules/pi-herdr-pstack/skills/pstack/swarm/SKILL.md`.
  - [ ] The control skill, `.pi/skills/verify-factory/SKILL.md`.
  - [ ] The poteto-mode playbook `playbooks/opening-a-pr.md`.
  - [ ] The benchmark checklist, `/home/g/.pi/agent/npm/node_modules/pi-herdr-pstack/skills/pstack/benchmark-checklist/SKILL.md`.
  - [ ] The principle leaf, `/home/g/.pi/agent/npm/node_modules/pi-herdr-pstack/skills/pstack/principle-explain-the-number/SKILL.md`.
  - [ ] The phase 2 common rules, `../pi-herdr-factorio-trails/phase2/common-rules.md`.
- [ ] Run the audit at every child delivery, at every stall or no-progress advisory, and on the operator's request. Nothing schedules it, so never promise a timed cadence and never leave the audit to memory.
- [ ] Use this audit prompt, verbatim. "Re-read the execution playbook. Audit the operation against it and fix drift in this audit. Check every active lane and judge progress by side effects only. Cancel a stuck lane and launch its fresh replacement now. Then post a short status message to the operator in chat only when the audit found a tracked change that no earlier status message reported, such as a PR opened, a code-ready head, a round launched or closed, a verdict, a merge, a stuck agent and the action taken, a blocker added or cleared, or a decision only the operator can make. Name every such change and nothing else. Do not repeat a table, the merged list, or an unchanged blocker. If the audit found none, end the turn with no reply text. Either way, log this audit's row in your decision trail. The row names the items reported, or none."
- [ ] On the operator's hold or stand-down, cancel every running child with `subagent_cancel` at once and launch nothing new.

### Launch owner rounds

- [ ] Give each PR one owner role with the full lifecycle the execution playbook names. Each round of it is a fresh leaf child the root launches. Owners build with `task:coding`. Audit lanes use an exact Claude or Grok model, a family other than the author's.
- [ ] Follow this dependency graph. Start dependent work only after its parent merges.
  - [ ] M1, M2 and M4 are independent and first. All three branch from `main`.
  - [ ] M3 after M1 and M2.
  - [ ] M5 after M1 and M4.
  - [ ] M6 after M3 and M5.
- [ ] Hold the file boundaries.
  - [ ] M1 touches only `src/core/tariff*`, `host/cli/`, `test/src/core/`, `test/host/cli/` and `docs/operations/metrics.md`.
  - [ ] M2 touches only `host/sandbox/run-stage.ts`, `host/sandbox/result.ts`, `host/controller/`, `src/controller/`, `src/ledger/`, their tests and `docs/operations/ledger.md`.
  - [ ] M4 and M5 touch only `src/bench/`, `host/bench/`, `host/cli/`, their tests and `docs/operations/bench.md`.
  - [ ] Every new file gets its `scripts/layout-baseline.json` row in the same PR.
- [ ] Hold the review gate. M3 changes the viewer, an interaction. It waits for the operator's review in chat with screenshots and a video before merge.
- [ ] Hold the spend boundary. No PR dispatches a production ticket or lifts the `nubl-factory` hold. Model spend happens only in M2's fixture lane and on the bench host, each under its own grant.

### PR mechanics, for every PR

- [ ] Use `gh` for every PR operation. Confirm `gh auth status` once. Never require Graphite.
- [ ] Open the PR ready, never draft, per **Opening a PR**, only under the operator's grant that names PR creation. Use `gh pr create --base main`.
- [ ] Run `npm run check` inside the memory cap from the common rules once before the PR-facing push. Push with hooks on, only under the operator's grant that names pushing, by explicit refspec through `../pi-herdr-factorio-trails/bin/checked-push.sh`.
- [ ] Run a manual diff cleanup pass before each commit and `/skill:no-comments` before review.
- [ ] Triage every Bugbot and security-reviewer comment per the poteto-mode reference `references/bugbot-triage.md`.
- [ ] Rebase onto current trunk before the code-ready report and babysit. Keep that merge base in fix rounds. Rebase again only at merge prep, on a `git merge-tree` conflict with trunk, on a CI failure that comes from a change on trunk, or when a known concurrent change to the same files lands.

### Verdict and merge, for every PR

- [ ] At the code-ready head SHA and at each later push that changes the patch, run the swarm per the swarm skill, `/home/g/.pi/agent/npm/node_modules/pi-herdr-pstack/skills/pstack/swarm/SKILL.md`. The root launches the lanes per `references/fan-out.md`. One gates lane runs `npm run check` and the trusted gate lane `gate-lane-host.sh`. The ten live lanes from the PR's **Verify, live** block are verifier lanes on `task:qa` with the Verifier prompt. The perf lane runs the PR's **Verify, perf** block. Two or more audit lanes, each with the full brief and one main focus, such as ledger compatibility with every reader, accounting that never counts a charge twice, or hidden checks that never reach a builder. Each audit lane reads the diff and the receipts and distrusts the PR body. It uses the Reviewer prompt on an exact model from a family other than the author's. The root audits the receipts in the merge-ready report before the verdict. A wording-only change may skip the swarm when the execution playbook says so; a full redesign still needs a fresh swarm.
- [ ] Clean only when every lane is `PASS`. Findings go back to the owner. A defect that a lane filed as a note is a finding. Judge blocking by the execution playbook. A new head gets a fresh swarm and a fresh verdict, except for lane results that stay valid under the patch-id rule in `playbooks/shipping.md`.
- [ ] Merge with `land.sh <pr> <sha> <verdict>` after a verdict comment, a green exact-head `check` and `factory-gates`, and a clean `git merge-tree`, under the patch-id rule in `playbooks/shipping.md`. M2 also needs the root session's relayed Claude review on the PR.

### Boot recipe, for every live lane

Each live lane runs at the PR head. Drive the surface with the CLI and viewer recipes in the verify-factory skill.

- [ ] `git fetch origin <head-branch> && git checkout <head SHA>` in `~/.herdr/worktrees/pi-herdr-factorio/<pr-id>-lane-<n>`, with `node_modules` hard-linked from the root checkout.
- [ ] Use the read-only state snapshot `~/.herdr/tmp/measure-state/` (mode 0700). The root makes it once per program with `rsync -a` from `exedev@nubl-factory.exe.xyz:factory-state/` while the hold is on, and deletes it at program close. Lanes never write to it. Each lane copies what it changes into its own scratch directory.
- [ ] Run every command inside `timeout 900 systemd-run --user --scope --quiet -p MemoryMax=8G -p MemorySwapMax=0 --` with `TMPDIR=$HOME/.herdr/tmp`. A hung run stops the lane and is reported, never rerun.
- [ ] Save every output, screenshot or receipt to `/tmp/swarm-<pr-id>/worker-<n>/<slug>` and return the paths with the report.

## Price every run from its request journal (M1)

**Depends on.** None.

**Files.**

- [ ] Create `src/core/tariff.ts` and `src/core/tariff.json`.
- [ ] Create `host/cli/cost.ts` and register `cost` in `host/cli/index.ts`.
- [ ] Create `test/src/core/tariff.test.ts` and `test/host/cli/cost.test.ts`.
- [ ] Edit `docs/operations/metrics.md` and `scripts/layout-baseline.json`.

**Build.**

- [ ] Pin a tariff in `src/core/tariff.json` for every model in `src/core/models.ts`. Each entry holds input, output, cache-read and cache-write USD per million tokens, any tier, the source package name and version, its file SHA-256 and an as-of date. The seed source is `@earendil-works/pi-ai` 1.4.0 provider data.
- [ ] Add `estimateCost(requests, tariff)` in `src/core/tariff.ts`. It prices each journal result line from `inputTokens` and `outputTokens` by the route's model, returns USD micros labelled `api_equivalent_estimate` with `cache: "not_reported"`, and counts uncertain and missing requests separately instead of as zero.
- [ ] Add `cost --json --state-dir <dir> [--run <id>]`. It reads `stages/<runId>/**/egress.requests.jsonl` and the terminal rows, and prints per stage and per run the tokens, the estimate, the tariff digest and the coverage. It never writes.

**You see.**

- [ ] `node host/cli/index.ts cost --json --state-dir ~/.herdr/tmp/measure-state` prints 13 runs. The total estimate is within one cent of the prototype's `$8.24` in Appendix A, with tariff digest and coverage fields present.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `test/src/core/tariff.test.ts` covers a priced request, a tier boundary at 272,000 input tokens, an unknown model reported as unpriced, an uncertain charge kept out of the estimate, and a tariff whose digest does not match. Run `npm test -- test/src/core/tariff.test.ts`.
- [ ] `test/host/cli/cost.test.ts` runs the real CLI over a fixture state with two runs and one missing journal. Run `npm test -- test/host/cli/cost.test.ts`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `task:qa` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Run `cost --json` at trunk and head over the snapshot. Trunk lacks the command, so record its usage error and gate the head's 13-run total against Appendix A. Save `cost-total.json`. Pass when trunk refuses the command and the head total matches within one cent.
- [ ] Lane 2. Price run `1bce1bf2` alone with `--run`. Save `cost-1bce1bf2.json`. Pass when the stage estimates sum to the run estimate and the run tokens equal the journal sum.
- [ ] Lane 3. Price run `3d603951`, which has an Anthropic second judge. Save `cost-anthropic.json`. Pass when the Anthropic requests are priced at the Anthropic rate and listed under their own model.
- [ ] Lane 4. Price run `4b281906`, whose ledger charge is uncertain. Save `cost-uncertain.json`. Pass when the output counts the uncertain request separately and labels the run coverage uncertain.
- [ ] Lane 5. Price runs `ac1efe50`, `70871af0` and `f9bd2112`, which each lack one execution receipt. Save `cost-missing.json`. Pass when each run reports its missing coverage and never prints a zero for it.
- [ ] Lane 6. Copy the snapshot, delete one journal file and run `cost`. Save `cost-deleted.json`. Pass when that stage reads `unavailable` rather than zero.
- [ ] Lane 7. Copy the snapshot, set one request's model to one absent from the tariff and run `cost`. Save `cost-unpriced.json`. Pass when that request is unpriced and named.
- [ ] Lane 8. Run `cost` with `--state-dir` naming an empty directory. Save `cost-empty.txt`. Pass when it prints zero runs and exits 0.
- [ ] Lane 9. Run `cost` against the snapshot made read-only with `chmod -R a-w`. Save `cost-readonly.json`. Pass when it succeeds and the snapshot's `sha256sum` manifest is unchanged afterwards.
- [ ] Lane 10. Compare `cost` tokens with `metrics --json --offline` tokens for each run. Save `cost-vs-metrics.txt`. Pass when every exact-coverage run matches and every difference is explained by a lower-bound or uncertain label.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Wall time of `cost --json` over the 13-run snapshot. Trunk lacks the command, so the budget is absolute.
- [ ] Probe. `hyperfine --runs 10 'node host/cli/index.ts cost --json --state-dir ~/.herdr/tmp/measure-state'` at the head, interleaved with `metrics --json --offline` as a same-host reference.
- [ ] Baseline. Record the trunk `metrics --json --offline` time first.
- [ ] Rule. Fail when the `cost` median exceeds 3 seconds or exceeds twice the `metrics` median.

**Review gate.** None. M1 is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, with the verdict still valid under the patch-id rule in `playbooks/shipping.md`.
- [ ] The root merges with `land.sh` under the owner's program grant.

## Record build revisions, repair rounds, controller revision and stage timeline (M2)

**Depends on.** None.

**Files.**

- [ ] Edit `host/sandbox/run-stage.ts` and `host/sandbox/result.ts`.
- [ ] Edit `host/controller/terminal.ts` and the controller files that mark stage boundaries.
- [ ] Edit `src/ledger/schema.ts` and `src/ledger/terminal.ts`.
- [ ] Edit their tests, `docs/operations/ledger.md` and `scripts/layout-baseline.json`.

**Build.**

- [ ] Emit `draftRuns`, `draftRevisionTokens` and `draftSkips` in every build receipt, as accept does today (#816).
- [ ] Record repair rounds as authorized, started and completed counts, so `repairRounds` stops reading `unavailable:not_instrumented` for new runs.
- [ ] Write a private append-only `S/timeline/<runId>.jsonl` with the claim, each stage start and end, visible tests, validation, CI wait, handoff, ready-for-review and terminal times.
- [ ] Add ledger row version 6 with `controllerRevision`, read from `install-exe-dev.commit`, and a timeline summary of model time, check time, CI wait and owner wait. Old rows stay byte-identical, and every reader accepts versions 1 to 6.

**You see.**

- [ ] A fixture run on the disposable VM produces a version 6 terminal row whose `controllerRevision` equals the installed SHA, whose build receipt carries `draftRuns`, and whose timeline intervals sum to the claim-to-terminal time within 2 seconds.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `test/host/sandbox/runner.test.ts` gains build receipt cases for a revision, a skip and no revision. Run `npm test -- test/host/sandbox/runner.test.ts`.
- [ ] `test/src/ledger/` gains version 6 parse and round-trip cases, plus reading every version 1 to 5 fixture unchanged. Run `npm test -- test/src/ledger/`.
- [ ] `test/integration/` gains a controller case that runs through a repair round and checks the timeline and `repairRounds`. Run `npm test -- test/integration/`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `task:qa` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Install trunk then head on the disposable VM against `nublai/pi-herdr-factorio-layout-fixture`, each held, and run one fixture issue under the fixture grant. Save `row-trunk.json` and `row-head.json`. Pass when trunk writes a version 5 row and head writes a version 6 row with the same outcome fields.
- [ ] Lane 2. Read the head fixture run's build receipt. Save `build-receipt.json`. Pass when `draftRuns` is present and matches the session's prompt count.
- [ ] Lane 3. Read the head fixture run's timeline. Save `timeline.jsonl`. Pass when stages appear in order and the intervals sum to claim-to-terminal within 2 seconds.
- [ ] Lane 4. Restart `factory.service` during the fixture run's build. Save `timeline-restart.jsonl`. Pass when the timeline continues after recovery with no duplicate stage end.
- [ ] Lane 5. Run `metrics --json --offline` over the fixture ledger including the version 6 row. Save `metrics-v6.json`. Pass when it counts the row and reports no parse error.
- [ ] Lane 6. Run `owner-feed --json` on the disposable VM after the fixture run. Save `feed-v6.json`. Pass when the feed is OwnerFeed v1 with unchanged field names.
- [ ] Lane 7. Run the viewer's evidence page for the fixture run. Save `evidence-v6.png`. Pass when it renders the run without an error banner.
- [ ] Lane 8. Read the published `factory/ledger` line for the fixture run. Save `ledger-line.json`. Pass when it matches the local row byte for byte and holds no model text.
- [ ] Lane 9. Read the snapshot's 13 production rows with the head's reader. Save `old-rows.txt`. Pass when every row parses and its bytes are unchanged.
- [ ] Lane 10. Run `explain --json` on the fixture run. Save `explain-v6.json`. Pass when it reports the controller revision and repair-round counts.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Controller tick duration and the longest gap between `event=tick` lines during the fixture run, at trunk and head.
- [ ] Probe. The same fixture issue at trunk and at head on the same disposable VM, one after the other, reading `journalctl -u factory.service`.
- [ ] Baseline. Record the trunk p95 tick duration and longest tick gap first.
- [ ] Rule. Fail when the head p95 tick duration exceeds trunk by more than 10 percent, or any tick gap exceeds 90 seconds.

**Review gate.** None. M2 is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] The root session's relayed independent Claude review is posted on the PR.
- [ ] Rebased onto current trunk after the verdict, with the verdict still valid under the patch-id rule in `playbooks/shipping.md`.
- [ ] The root merges with `land.sh` under the owner's program grant. The production upgrade waits for the owner's held-upgrade go.

## Show a scoreboard in the CLI and the viewer (M3)

**Depends on.** M1 and M2.

**Files.**

- [ ] Create `src/views/scoreboard.ts` and `host/cli/scoreboard.ts`, and register `scoreboard` in `host/cli/index.ts`.
- [ ] Edit `host/viewer/` to add a Scoreboard page that follows `DESIGN.md` tokens.
- [ ] Create `test/src/views/scoreboard.test.ts` and viewer tests. Edit `docs/operations/metrics.md`, `docs/operations/viewer.md` and `scripts/layout-baseline.json`.

**Build.**

- [ ] Build `scoreboard(rows, receipts, tariff)` in `src/views/scoreboard.ts`. It groups runs by controller revision, ticket, stage, model and failure class, and reports the ready-PR rate, the landed rate, the estimated dollars per run and per landed PR, tokens and time by stage, and coverage. Unknown values stay unknown.
- [ ] Add `scoreboard --json [--since <date>] [--by revision|stage|failure|model]`. It is read-only.
- [ ] Add the viewer page with the same numbers, on loopback only.

**You see.**

- [ ] `scoreboard --json` over the snapshot shows 13 runs, 5 landed, 7 failed and 1 released, with an estimated cost per landed PR and its coverage label. The viewer page shows the same table.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `test/src/views/scoreboard.test.ts` covers grouping, unknown coverage, a run with no landing, a version 5 row without a controller revision, and a released run. Run `npm test -- test/src/views/scoreboard.test.ts`.
- [ ] Viewer tests cover the page's HTTP guards and its escaping of issue titles. Run `npm test -- test/host/viewer/`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `task:qa` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Run `metrics --json --offline` at trunk and head, then `scoreboard --json` at head over the snapshot. Save `scoreboard.json`. Pass when trunk metrics are unchanged at head and the scoreboard shows 5 landed, 7 failed and 1 released.
- [ ] Lane 2. Group by revision. Save `by-revision.json`. Pass when the version 5 rows group under an `unknown` revision rather than a guessed one.
- [ ] Lane 3. Group by failure class. Save `by-failure.json`. Pass when the classes match the recon table in Appendix A.
- [ ] Lane 4. Group by stage. Save `by-stage.json`. Pass when the build stage holds the largest token share and the sums match `cost`.
- [ ] Lane 5. Filter with `--since 2026-11-15`. Save `since.json`. Pass when only runs that started on or after that date appear.
- [ ] Lane 6. Open the viewer page in a browser on the VM's loopback through the verify-factory viewer recipe. Save `scoreboard-page.png`. Pass when the table matches lane 1.
- [ ] Lane 7. Send a cross-origin request to the page. Save `cross-origin.txt`. Pass when it is refused like every other viewer route.
- [ ] Lane 8. Add a fixture issue title containing markup to a snapshot copy and open the page. Save `escaped.png`. Pass when the title renders as text.
- [ ] Lane 9. Open the page at a narrow width of 390 pixels. Save `narrow.png`. Pass when the table scrolls instead of overflowing, per `DESIGN.md`.
- [ ] Lane 10. Run `scoreboard` on the snapshot made read-only. Save `readonly.txt`. Pass when it succeeds and the snapshot manifest is unchanged.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Wall time of `scoreboard --json` and the page's server response time over the snapshot.
- [ ] Probe. `hyperfine --runs 10` on the CLI, and 20 interleaved `curl -w '%{time_total}'` requests to the page and to the existing dashboard page.
- [ ] Baseline. Record the trunk dashboard page response time first.
- [ ] Rule. Fail when the CLI median exceeds 3 seconds, or the page median exceeds twice the dashboard median.

**Review gate.** The operator reviews before merge.

- [ ] Copy lane 6 and lane 9 screenshots into `../pi-herdr-factorio-trails/measure/M3-review-page.png` and `M3-review-narrow.png`.
- [ ] Record a 30 to 60 second video of the scoreboard page and the CLI at the PR head. Save it as `../pi-herdr-factorio-trails/measure/M3-review.mp4`.
- [ ] Post the screenshots and the video in chat for the operator. Stop at merge-ready. Wait for the operator's click.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, with the verdict still valid under the patch-id rule in `playbooks/shipping.md`.
- [ ] The root merges with `land.sh` after the operator's review.

## Export past runs as private benchmark tasks (M4)

**Depends on.** None.

**Files.**

- [ ] Create `src/bench/bundle.ts`, `host/bench/export.ts` and `host/cli/bench.ts`, and register `bench` in `host/cli/index.ts`.
- [ ] Create `test/src/bench/bundle.test.ts` and `test/host/bench/export.test.ts`.
- [ ] Create `docs/operations/bench.md`. Edit `scripts/layout-baseline.json`.

**Build.**

- [ ] Define the task bundle in `src/bench/bundle.ts`. It holds the issue snapshot, contract and digest, hidden acceptance suite and checks, base SHA with a `git archive` tree and its digest, the gate policy and `WORKFLOW.md` at that base, the original requested models and thinking, the original outcome, and a manifest with the SHA-256 of every file.
- [ ] Add `bench export --state-dir <dir> --run <id> --out <dir>` and `bench verify <bundle>`. Export writes mode 0700 directories and 0600 files, refuses an existing output, and keeps hidden checks in a separate `oracle/` directory the builder input never names.

**You see.**

- [ ] Exporting the latest run of each of the 7 pilot tickets gives 7 bundles, and `bench verify` prints `ok` for each with its manifest digest.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `test/src/bench/bundle.test.ts` covers manifest digests, a tampered file, a missing oracle file and a base tree that does not match its digest. Run `npm test -- test/src/bench/bundle.test.ts`.
- [ ] `test/host/bench/export.test.ts` runs the real CLI over a fixture state and checks file modes. Run `npm test -- test/host/bench/export.test.ts`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `task:qa` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Trunk lacks `bench`, so record its usage error and gate export of run `1bce1bf2` at head. Save `export-1bce1bf2.txt`. Pass when trunk refuses and the head bundle verifies.
- [ ] Lane 2. Export all 7 tickets' latest runs. Save `export-all.txt`. Pass when all 7 verify.
- [ ] Lane 3. Export run `4b281906`, whose base `65ff2fd` has no cached review tree. Save `export-old-base.txt`. Pass when the base tree comes from the local Git object and its digest is recorded.
- [ ] Lane 4. Change one byte of an exported check and run `bench verify`. Save `tamper.txt`. Pass when verify names the file and exits nonzero.
- [ ] Lane 5. Export into an existing directory. Save `exists.txt`. Pass when export refuses and writes nothing.
- [ ] Lane 6. List the builder input files the bundle names. Save `builder-inputs.txt`. Pass when no path under `oracle/` appears.
- [ ] Lane 7. Check modes with `find <bundle> -printf '%m %p\n'`. Save `modes.txt`. Pass when directories are 700 and files are 600.
- [ ] Lane 8. Compare the bundle's contract digest with the ledger row's. Save `digests.txt`. Pass when all 7 match.
- [ ] Lane 9. Export from the snapshot made read-only. Save `readonly.txt`. Pass when export succeeds and the snapshot manifest is unchanged.
- [ ] Lane 10. Export a released run, `3d603951`. Save `released.txt`. Pass when the bundle records outcome `released` and still verifies.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Wall time and disk size of exporting one bundle.
- [ ] Probe. `hyperfine --runs 5` on exporting run `1bce1bf2` into fresh directories, with `du -sh` on each bundle. Interleave it with `git archive` of the same base as the floor.
- [ ] Baseline. Record the `git archive` time and size first.
- [ ] Rule. Fail when export takes more than 60 seconds, or a bundle is more than twice the base archive size plus 10 MiB.

**Review gate.** None. M4 is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, with the verdict still valid under the patch-id rule in `playbooks/shipping.md`.
- [ ] The root merges with `land.sh` under the owner's program grant.

## Replay a task offline on the bench host (M5)

**Depends on.** M1 and M4.

**Files.**

- [ ] Create `src/bench/variant.ts`, `src/bench/trial.ts` and `host/bench/run.ts`. Edit `host/cli/bench.ts`.
- [ ] Create `test/src/bench/variant.test.ts`, `test/src/bench/trial.test.ts` and `test/host/bench/run.test.ts`.
- [ ] Edit `docs/operations/bench.md` and `scripts/layout-baseline.json`.

**Build.**

- [ ] Define a variant in `src/bench/variant.ts`. It names exactly one declared dimension, a stage's model, one replaced file under `skills/` with its digest, or `buildRevision` set to `on` or `off`, and pins everything else. Stage thinking and arbitrary factory revisions are out of v1.
- [ ] Add `bench run --bundle <dir> --variant <file> --state-dir <scratch> --token-cap <n>`. It runs build, visible tests, the trusted gates in the pinned image, held-out validation and both review judges against the bundle, with no GitHub access and no markers. It reuses the sandbox, gate and review components and writes a trial record with outcome, tokens, the M1 estimate and wall time.
- [ ] Refuse to start when the bench host's `factory.service` is present, when the state directory is a production one, or when the cap would be exceeded.

**You see.**

- [ ] On the bench host, `bench run` of the #430 bundle with the baseline variant writes a trial record with an outcome, tokens and an estimate, and no GitHub request appears in the gateway audit.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `test/src/bench/variant.test.ts` refuses a variant that changes two dimensions or none. Run `npm test -- test/src/bench/variant.test.ts`.
- [ ] `test/host/bench/run.test.ts` drives `bench run` with a fake model gateway through build, validation and review. Run `npm test -- test/host/bench/run.test.ts`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `task:qa` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Trunk lacks `bench run`, so record its usage error and gate one baseline trial of the #430 bundle on the bench host. Save `trial-430.json`. Pass when trunk refuses and the head trial completes with an outcome.
- [ ] Lane 2. Read the bench host's gateway audit for that trial. Save `audit-430.txt`. Pass when only model routes appear and no GitHub route does.
- [ ] Lane 3. List the builder sandbox's visible files during the trial. Save `sandbox-files.txt`. Pass when no `oracle/` file is visible.
- [ ] Lane 4. Run a trial with a token cap below one build. Save `capped.json`. Pass when it ends `budget_exhausted` and spends no more than the cap.
- [ ] Lane 5. Run a trial with a two-dimension variant. Save `bad-variant.txt`. Pass when it refuses before any model call.
- [ ] Lane 6. Point `--state-dir` at a copy of production state. Save `prod-state.txt`. Pass when it refuses.
- [ ] Lane 7. Run the #399 bundle, which originally landed. Save `trial-399.json`. Pass when the trial reaches review with gates passing or records a stated failure.
- [ ] Lane 8. Compare the trial's M1 estimate with the gateway audit tokens. Save `estimate-check.txt`. Pass when tokens match exactly and the estimate is their priced sum.
- [ ] Lane 9. Kill `bench run` during build and run it again with the same state. Save `resume.txt`. Pass when the second run either resumes or refuses with a named reason, and never counts the first run's charge twice.
- [ ] Lane 10. Confirm `nubl-factory` is untouched during the lanes. Save `prod-untouched.txt`. Pass when its hold file, `NRestarts=0` and `dispatch=false` hold before and after.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Trial wall time per stage for the #430 bundle, against the original production run `1bce1bf2` stage times.
- [ ] Probe. Three baseline trials of the #430 bundle on the bench host, reading each trial record's stage times.
- [ ] Baseline. Record the production run's stage times from its receipts first.
- [ ] Rule. Fail when any stage's median trial time exceeds 1.5 times the production stage time, or a trial exceeds the production build wall.

**Review gate.** None. M5 is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, with the verdict still valid under the patch-id rule in `playbooks/shipping.md`.
- [ ] The root merges with `land.sh` under the owner's program grant.

## Compare configurations and run the first two experiments (M6)

**Depends on.** M3 and M5.

**Files.**

- [ ] Create `src/bench/compare.ts` and `test/src/bench/compare.test.ts`. Edit `host/cli/bench.ts` and `docs/operations/bench.md`.
- [ ] Create `../pi-herdr-factorio-trails/measure/experiments/` for the trial records and reports.

**Build.**

- [ ] Add `bench compare <trials...>`. It pairs trials by task, refuses pairs whose variants differ in an undeclared dimension, and reports per variant the pass rate with its count, the median tokens, the median estimate and the per-task differences. It never reports a ratio for unlike tasks.
- [ ] Run experiment one, repeatability. Run the baseline variant three times on each of the 7 bundles.
- [ ] Run experiment two, #813. Run the #430 bundle with `buildRevision` off and on, three trials each.

**You see.**

- [ ] `bench compare` prints the repeatability spread per task and the #813 comparison with its counts. The report in `../pi-herdr-factorio-trails/measure/experiments/` says what the numbers support and what they do not.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `test/src/bench/compare.test.ts` covers pairing, an undeclared difference, a task missing from one side and a variant with fewer than three trials. Run `npm test -- test/src/bench/compare.test.ts`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `task:qa` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Trunk lacks `bench compare`, so record its usage error and gate the head's comparison of experiment one. Save `compare-repeat.txt`. Pass when trunk refuses and the head reports all 7 tasks with three trials each.
- [ ] Lane 2. Recompute experiment one's pass rates by hand from the trial records. Save `hand-check.txt`. Pass when they match the comparison.
- [ ] Lane 3. Compare experiment two. Save `compare-813.txt`. Pass when it reports `buildRevision` off and on for the #430 task with three trials each and per-trial outcomes.
- [ ] Lane 4. Read experiment two's build receipts. Save `revision-exposure.txt`. Pass when it separates `buildRevision` off and on and states how many on trials fired the #813 revision, using M2's `draftRuns`.
- [ ] Lane 5. Compare a trial pair with two different changed dimensions. Save `refuse.txt`. Pass when compare refuses and names both dimensions.
- [ ] Lane 6. Compare with one task missing on one side. Save `missing-task.txt`. Pass when the task is reported missing, not dropped.
- [ ] Lane 7. Sum the experiments' tokens. Save `spend.txt`. Pass when the total is within the owner's spend grant.
- [ ] Lane 8. Read the report's claims against the benchmark checklist. Save `claims-check.txt`. Pass when each claim names its count and spread, and none states an improvement the counts cannot support.
- [ ] Lane 9. Run `scoreboard --json` beside the bench results. Save `scoreboard-vs-bench.txt`. Pass when bench trials never appear in production scoreboard rows.
- [ ] Lane 10. Confirm `nubl-factory` is untouched. Save `prod-untouched.txt`. Pass when its hold, `NRestarts=0` and `dispatch=false` hold before and after.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Wall time of `bench compare` over all trial records, and total experiment wall time on the bench host.
- [ ] Probe. `hyperfine --runs 10` on `bench compare`, and the trial records' start and end times.
- [ ] Baseline. Record the `scoreboard --json` time on the same host first.
- [ ] Rule. Fail when `bench compare` exceeds 3 seconds, or the experiments exceed 12 hours of bench host time.

**Review gate.** None. M6 is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, with the verdict still valid under the patch-id rule in `playbooks/shipping.md`.
- [ ] The root merges with `land.sh` under the owner's program grant, and posts the experiment report to the operator.

## Close the program

- [ ] Every box above is checked with its evidence.
- [ ] Delete `~/.herdr/tmp/measure-state/` and the disposable M2 VM, and confirm both are gone.
- [ ] Reply to the operator with the report the execution playbook names, including both experiments' results.

## Appendix A. Prototype evidence

The recon is `../pi-herdr-factorio-trails/measure/recon.md`, read-only, from 2026-11-16.

- **The factory records more than tokens.** Ledger rows carry versioned outcomes, failure classes, stage summaries and efficiency facts. A seven-day metric and sampled scorers already exist. M3 builds on them rather than replacing them.
- **The pilot history is 13 runs on 7 tickets.** 5 landed, 7 failed and 1 released, charged 3,885,519 tokens. Every run kept its issue snapshot, contract, hidden suite, patch and model receipts.
- **Every historical base is reachable.** Four runs use bases that production's checkout lacks, three distinct commits (`65ff2fd`, `7beb8b9` and `32714ff`). The coordinator found all three in the local checkout.
- **Dollars can be estimated now.** Every run's `egress.requests.jsonl` holds `inputTokens` and `outputTokens` per request. Priced at `@earendil-works/pi-ai` 1.4.0 rates with no cache discount, 3,610,127 input and 101,957 output tokens come to about $8.24 for 13 runs. That is $0.34 to $0.94 a run, or about $1.65 per landed PR. This is an API-equivalent estimate, not billed spend.
- **Some charges are not in the journal.** Run `4b281906` shows 143,784 journal tokens against a 317,219-token uncertain ledger charge. M1 reports the gap instead of choosing one.
- **Cached tokens are rare.** In the 16 surviving session files, 27 of 217 assistant messages had cached reads, so a no-cache estimate overstates cost only slightly.
- **No offline replay exists.** The existing replay driver is a live GitHub fixture workflow, and its comparator refuses differing models. M4 to M6 add the offline path.
- **Unproven until M5 runs.** Whether a trial reproduces a production stage time, and how much outcomes vary between identical trials. Experiment one measures the second.

## Appendix B. Alternatives rejected

- **Add cost to OwnerFeed for Shep now.** Rejected for this program, because OwnerFeed changes involve another project. The scoreboard ships in the CLI and viewer first. A feed field can follow through root.
- **Use billed spend.** No billing source reaches the factory, and the subscription is not free. The estimate is labelled as one, and billed spend stays `unavailable`.
- **Reuse the live replay driver.** It posts to GitHub, stops production and refuses model differences. Benchmarks need none of those.
- **Run benchmarks on `nubl-factory`.** They would compete with production for the one controller host and the hold, so a separate bench host keeps production quiet.
- **Measure #813 from production rounds.** Two production runs of #430 had different bases, contracts and checks, so they cannot isolate #813.

## Appendix C. Risks

- **The owner decides four things before M2, M5 and M6 start.**
  - [ ] What cost means. Recommended is the API-equivalent estimate, labelled as one.
  - [ ] The bench host. Recommended is a new exe.dev VM, `nubl-bench`, with only the `llm` integration and no GitHub integration.
  - [ ] The M5 and M6 spend grant. Recommended is 15 million tokens on the bench host, about $35 at the pinned rates.
  - [ ] The M2 fixture lane. Recommended is one disposable VM and one fixture issue on `nublai/pi-herdr-factorio-layout-fixture`, about 400,000 tokens.
- **M2 changes the public ledger.** The owner watches that version 1 to 5 rows stay byte-identical and that metrics and the feed still read them. Root's Claude review covers it.
- **Hidden checks in bundles.** Bundles copy private acceptance checks off the production host. M4 keeps them in `oracle/`, at 0600, and never in builder input. The audit lanes check this.
- **Small samples.** Three trials per task cannot prove a small improvement. M6's report must say so, per the benchmark checklist.
- **Model drift.** A model name can stay the same while the provider changes it. Trial records keep the observed model and date, and M6 compares only trials run close together.

## Appendix D. Links and reading list

- Read before editing:
  - `docs/operations/ledger.md`
  - `docs/operations/metrics.md`
  - `docs/operations/sandbox.md`
  - `docs/operations/factory-cli.md`
  - `DESIGN.md` (M3)
  - the recon in Appendix A
- Run the how skill, `/home/g/.pi/agent/npm/node_modules/pi-herdr-pstack/skills/pstack/how/SKILL.md`, before M2 and M5.
- Run the interrogate skill, `/home/g/.pi/agent/npm/node_modules/pi-herdr-pstack/skills/pstack/interrogate/SKILL.md`, on M5's isolation of hidden checks.
- Keep the trail at `../pi-herdr-factorio-trails/measure/decisions.tsv`, per the show-me-your-work skill, `/home/g/.pi/agent/npm/node_modules/pi-herdr-pstack/skills/pstack/show-me-your-work/SKILL.md`.
- Issues are #816 (build revision facts) and #735 (pilot).
