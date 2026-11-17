# Private benchmark bundles

`bench export` freezes the inputs of a finished run for later offline replay.
It makes no network or model request, executes no acceptance checks, and never
writes to the source state. `bench verify` reads a bundle without changing it.

## Commands

```sh
node host/cli/index.ts bench export \
  --state-dir "$HOME/.herdr/tmp/measure-state" \
  --run <full-run-id> --out <new-private-directory>
node host/cli/index.ts bench verify <private-directory>
```

Export reads local Git objects from the current checkout. `--repository <checkout>`
selects another checkout. The recorded base and admission workflow commit must
exist there. Export never fetches, substitutes current main, or uses a cached
review tree. The output's parent directory must exist.

Both commands print `ok <manifest-sha256>` on success. Exit codes are 0 for
success, 1 for invalid or unavailable evidence, and 2 for invalid arguments.
Failures name the failed binding or file, never check contents.

Export requires the finished run's frozen local ledger row, admitted issue
snapshot, verified contract, and accepted private suite. It refuses missing or
corrupt evidence rather than inventing a contract or checks for an early stop.
It also preserves the round-zero patch when one exists. A finished run need not
have landed. Released and failed runs retain their original outcomes.

## TaskBundle v1

`src/bench/bundle.ts` defines `TaskBundle` and `BundleManifest` before the exporter.
`task.json` binds the run, repository, issue, snapshot digest, contract digest,
acceptance digest, base SHA, and base archive digest to these files:

| Path | Purpose |
| --- | --- |
| `builder/input.json` | Fixed allowlist of builder inputs, with no oracle path. |
| `builder/issue.json` | Admission-time title and body. |
| `builder/contract.json` | Canonical stored contract, with its original digest. |
| `builder/base.tar` | `git archive --format=tar` of the recorded original base. |
| `builder/WORKFLOW.md` | Exact workflow bytes at that base. |
| `policy/gates.json` | Exact gate policy at that base. Gate implementations and other policy files remain in the base archive. |
| `oracle/` | Stored suite, manifest, canary, receipt, and exact check files. |
| `original/row.json` | Original frozen ledger row, including outcome and observed models. |
| `original/admission.json` | Original admitted receipt and issue snapshot. |
| `original/contract-receipt.json` | Original contract binding. |
| `original/WORKFLOW.md` | Digest-checked admission workflow, which can differ from the base workflow. |
| `original/models.json` | Requested stage and seat models, fallbacks, budgets, accept thinking, and ledger model observations. |
| `original/patch.diff`, `original/patch-receipt.json` | Optional historical round-zero result, never a builder input. |

Thinking outside accept was not recorded explicitly. The bundle labels it
`unavailable:not_recorded`, rather than inferring it from today's SDK defaults.
The pinned workflow and ledger observations do not establish every historical
hot-reloaded setting or a provider backend version.

Only the files named by `builder/input.json` are builder inputs. Do not mount the
bundle root, manifest, `original/`, `policy/`, or `oracle/` into a builder.
The base archive is historical source, not a sandbox-ready mount. A replay driver
must apply the existing checkout sanitization, including removal of published
`test/acceptance/` paths, before mounting it. The new private suite stays outside
that tree. Export does not run a benchmark or install dependencies or runtimes.

## Integrity and privacy

Every directory has mode 0700 and every file has mode 0600. Export refuses an
existing output, including a symlink, and never replaces its contents. A failed
write removes only the new output it created. The source state stays read-only.

`manifest.json` lists every payload file with its relative path, byte length,
and SHA-256, sorted by path. It excludes itself and `manifest.sha256`.
`manifest.sha256` holds the digest of the exact canonical manifest bytes plus
one LF. Retain the printed digest separately as the bundle's identity. The
sidecar detects corruption, not an attacker replacing a bundle and its sidecar.
There are no timestamps in the bundle index, so unchanged inputs produce the
same manifest digest.

Verification rejects unsafe paths, symlinks, non-private modes, missing or
unlisted files, and mismatched digests. It also checks the task's independent
base digest, contract and admission bindings, ledger artifact bindings, the
fixed builder input allowlist, and the complete oracle contents. It reads at
most 256 MiB per file and 512 MiB per bundle.

Bundles are write-once exports with digest verification, not filesystem-enforced
immutable files. Keep them private and out of Git, PR artifacts, public logs,
and builder mounts. Delete disposable verification bundles after use because
they contain hidden checks. These commands do not change OwnerFeed or require
a Shep bridge update.

## Replay one task

`bench run` executes one trial without GitHub, issue markers, a controller,
or ledger publication. It uses the real `runStage` and sandbox host, visible-test
runner, `checkCandidate` with the digest-pinned Docker image, and the production
review prompts, seat selection, parsers, family labels and blocking rules.
Held-out checks run only in the trusted gate tree. Both judges run in fresh
sessions, even when there are no judge-only scenarios. An unconfigured second
judge produces a named failure, never a fabricated independent pass.

```sh
node host/cli/index.ts bench run --bundle "$BUNDLE" --variant "$VARIANT" \
  --state-dir "$HOME/bench/trials/430-01" --token-cap 540000 \
  --assets-dir "$ASSETS"
```

`--assets-dir <dir>` selects the installed sandbox assets. Without it, the driver
locates the bundle under `/var/lib/factory-sandbox`. Its manifest must match
`pins.assetsDigest`. For skill variants, use the real directory path, not a
symlink such as `current`.

The command prints BenchTrial v1 JSON and writes the same bytes to `trial.json`
with `trial.sha256`. Exit 0 means that a trial record exists, not that the task
passed. Read `outcome.kind`. Setup refusals exit 1; invalid CLI syntax exits 2.
Use a fresh state directory for each independent repetition.

### BenchVariant v1

`src/bench/variant.ts` parses a strict object with `version: 1`,
`kind: "factory_benchmark_variant"`, a short `name`, `pins`, and one `change`.
Unknown or duplicate keys fail before a model call. `pins` binds the task
manifest, executing factory commit, installed assets, original admission
workflow and M1 tariff by digest. The checkout must be clean. Budgets, guidance,
seat models and fallbacks come from that frozen workflow. Model observations
come from each new receipt, not the original outcome.

Exactly one dimension must be declared. These are the only v1 choices:

- `{"kind":"model","stage":"build","model":"openai/gpt-6.1-terra"}`
  changes the build or review stage's primary model. Explicit review-seat models
  stay pinned. Selecting the unchanged primary model is refused.
- `{"kind":"skill","path":"skills/build/SKILL.md","file":"./build.md","digest":"<sha256>"}`
  replaces one existing regular file under `skills/` in a trial-local asset copy.
  `file` resolves relative to the variant file. Its bytes must match `digest`
  and differ from the original. The driver refuses a variant file or replacement
  whose real path is inside the task bundle, including `oracle/`. It also refuses
  symlinks anywhere in the installed skill file's path, including its directories
  and the assets root. The installed bundle stays unchanged. The trial records
  the resulting assets digest as well as the original pin.
- `{"kind":"buildRevision","value":"on"}` or `"off"` selects #813's single
  in-session build revision. `on` uses `workspaceTestEdits(..., true)` because the
  driver mounts the sanitized repair tree even for round zero. Production's
  round-zero check compares its base workspace without that flag. The repair
  flag excludes published `test/acceptance/` paths removed by sanitization, so
  both checks identify the same edited existing non-replaceable tests. `off` omits `draftCheck` from the
  build input. `on` is the baseline.
  The declared selector is required even for that baseline; an absent selector
  is not a variant.
- `{"kind":"respec","value":"on"}` runs fresh specify and accept stages before
  build. It implies `buildRevision: on`; it cannot be combined with a model,
  skill, issue-text, base, or revision-off change.

Stage thinking and arbitrary factory revisions are out of v1. The executing
factory revision is a fixed pin, not a selectable experiment dimension.
Thinking outside accept was not historically recorded. Trials label it
`runtime_default:not_historically_recorded` and retain the pinned runtime.

### Re-specify a frozen task

For an authorized respec experiment, keep the baseline's pins and replace only
its name and selector, for example `name: "respec-401"` and
`change: {"kind":"respec","value":"on"}`. Use the same `bench run` command and
a fresh private state directory for each repetition. The input remains the
bundle's original base and unchanged admission snapshot, not current main or
live issue text. Never edit a generated contract or inject `replacesTests`.
An absent replacement list is valid, including for #789's build-only scope.

This mode uses production's `runSpecify`: draft, separate critique, optional
revision, and exact named-test declaration checks. Unknown or ambiguous test
names refuse. Questions end the trial locally; nothing is posted. The generated
draft is wrapped unchanged in a new trial-bound contract envelope. As in
production, its rendered summary must fit the GitHub comment limit even though
the bench does not post it. Specify and accept share a fresh authoring checkout
from the offline archive adapter, with production's complete file list, including
`.github/` and published `test/acceptance/` paths. Build and review still use
separate sanitized trees.

Accept uses `runStage`, the frozen workflow's model, fallback, budget and accept
reasoning effort, and `controllerDraftChecker`. Specify and accept retry failed
or malformed attempts up to the frozen workflow's `maxAttempts`, default 3,
through production's shared decision in `src/controller/retry.ts`. Questions,
provider refusals and budget exhaustion do not retry. Every attempt charges the
trial cap. Each launch's token allowance is the lowest of its stage allowance,
the frozen workflow's `maxTokensPerRun` less the trial's spend so far, and the
remaining trial cap. The retry decision uses the lower of the two run caps. Each
retry first waits production's backoff: 10 seconds, doubling per retry up to the
workflow's `maxBackoffMs`.
Ordinary stage failures get production's fresh per-attempt stage allowance.
As in production, accept's wall allowance is charged only for accept stage
execution (the `wallMs` in each attempt's receipt) and for the refused suite's
base checks. Retry backoff and prompt preparation are never charged. Final base
qualification gets the lower of 180 seconds and that remaining allowance. Once
accept receives base feedback, later attempts share its remaining 100,000 tokens
and that wall allowance.
Each attempt has a separate receipt, journal and entry in trial `stages`.
Its archive adapter serves only the frozen repository and SHA from a locally
generated gzip archive. It has no GitHub fallback. Judge-only gate/execution demands and new-behavior checks that
read preserved test source retain production's refusals.

Draft feedback is not qualification. The final suite receives a fresh canary and
must pass `runHeldoutBase` plus `assessBase` before build: two agreeing base
executions, executable new behavior assertion-red and preservation green, with
no load, runtime, skip, todo, cancellation or tamper failure. Draft and final
base checks use production's `localRunner` (bubblewrap), including dependency
and detail-reporter mounts; candidate gates still use the pinned Docker image.
Final qualification has at most 180 seconds and only the remaining accept wall
time. An author-fixable base refusal gets production's one accept feedback retry,
subject to the workflow's attempt limit. The retry uses the shared refusal policy,
bounded feedback and previous-suite prompt. All accept attempts and base checks then share
the accept wall allowance and 100,000-token allowance, and the same trial cap.
The second accept attempt has its own `runtime/accept-retry/` receipt and journal;
later attempts use `runtime/accept-<attempt>/`. Specify retries use
`runtime/specify-<attempt>/`, retaining their draft, review and revision leaves.
A second base refusal stops the trial. It uses production's systemd scope with 2G memory, 512 tasks, 100% CPU,
and stop-on-abort through `localRunner`. The build and visible-test deadline
starts separately at build start. This deadline change also applies to baseline,
model and skill trials; their visible-test allowance no longer starts at trial
start.

The fresh contract, suite, canary-bearing check bytes and digests flow through
visible tests, replacement policy, gates and review. The old oracle is verified
as part of the frozen bundle, but never reused for respec validation. Private
artifacts live under `respec/`; `respec/base-receipt.json` and its digest retain
the final qualification. Each base check also retains its receipt and digest under
`respec/accept-base-<attempt>/`. A retried suite is retained under
`respec/accept-base-<attempt>/acceptance/`; the current suite stays in `respec/acceptance/`.
Trial `respec` metadata records frozen base/archive and
snapshot bindings, generated digests, effective accept effort and per-session
requested/observed model evidence. `baseRetryReason` records the first base
refusal that granted an accept feedback retry, or null if none was granted.
Older respec records without this field parse with null. Early failures may have
null artifacts; successful records require complete proof and authoring-stage
evidence. Records without `respec` metadata still parse.

Before authorized model trials, the coordinator must qualify the bench host's
local-bwrap accept-base lane as well as the Docker preflight below. Require a
real assertion-red new-behavior check and preservation-green check on the
archived base, with the detail reporter and dependencies mounted. Scripted local
tests establish composition only, not that native host qualification.

For #401 and #789, attempt three fresh trials each only under the current spend
grant. Before every launch, tally completed and incomplete directories with
`bench spend` and require the full 540,000-token trial cap to fit below the
12,000,000-token program stop. Stop and report if it does not fit; do not shrink
allowances. No trial dispatches a production ticket.

### State, isolation and accounting

The state root must be private, owned by the caller, and initially empty.
A production copy, symlink root, bundle overlap or any other non-bench state
is refused. The command checks both system and user `factory.service` LoadState;
a present service, even stopped or masked, refuses execution. An unreadable
service probe also refuses. With the real Docker gate runner, the caller's uid
must equal the gate container's uid, 1001. A mismatch refuses with
`gate_runner_uid_mismatch` before a claim or any model call.

A write-once claim binds the bundle, variant and cap before preparation.
The driver reconstructs local Git commits from the archived tree for gates;
these are not the historical commit or a GitHub CI run. `ciRunId: 0` in private
review inputs explicitly means no CI exists.

### Production parity and remaining differences

Build uses production's `sourceExcerpts` for the contract files and evidence,
with the recorded repository and base SHA as the checkout identity. The excerpts
enter the same `buildPrompt` and installed build-skill decorator. As in production,
contracts naming more than eight files enable the `subagent` tool. Smaller
contracts do not. The declared variant is the only selected change to those
pinned inputs, not a claim that today's runtime matches the historical runtime.

The local base commit preserves every archived file, including tracked files
that `.gitignore` would exclude. Candidate construction stages the collected
patch's explicit `changedPaths` and the private suite paths with
`git --literal-pathspecs add -f`. Ignored additions and deletions therefore
reach the gates, as they do in
production's explicit-path Git Data publication. The gate input carries the
contract's `replacesTests` and its production `replacementDigest`. The same
`checkCandidate` checks the tree against the archived gate policy in the pinned
image. Local commit identities and ancestry differ from production publication;
the gate source and candidate file trees do not depend on `.gitignore`.

Each review seat receives evidence from that successful local gate receipt
inside `<trusted-pipeline-evidence>`, not from builder output or an appendix.
It has production's `TrustedEvidence` structure: candidate and gate SHAs, patch,
acceptance and held-out digests, receipt fingerprints, each check's exit code and
duration, baseline and main test globs, and held-out file and test totals.
The `run` field labels the source `bench-local trusted gates` and states that
there is no GitHub CI run or report. `ciRunId`, `ci.runId` and `ci.reportId` are
zero sentinels. The schema requires `ci.conclusion: "success"`; here it describes
only the local gate result. Both `gateReceiptDigest` and `reportDigest` fingerprint
the exact local gate receipt bytes, because no hosted report exists.

Production binds its evidence to a controller-verified GitHub CI report as well
as the trusted gate receipt. The bench has no such report and does not fabricate
one. The prompt explicitly corrects its shared production introduction's CI
wording. Criteria about local trusted check results have evidence; criteria
specifically requiring hosted CI remain unverifiable. Neither receipt
fingerprint claims GitHub provenance.

A baseline, model or skill trial reuses the accepted contract and suite and
does not rerun specify, accept or production's base qualification. A respec trial
adds fresh specify, accept and final base qualification as described above.
Neither mode runs tree-disagreement diagnosis, controller repair rounds,
publication or handoff. Only the selected in-session build revision runs.
The factory commit, installed assets and workflow are pinned, but provider
backend drift and unrecorded historical thinking remain replay limits.
Neither mode measures a full historical controller run.

Only the sanitized workspace enters the builder sandbox. The bundle root,
`oracle/`, trial records, local Git repository and trusted receipts are not
mounts. Existing published `test/acceptance/` files are removed by
`prepareRepairTree`. Production's round-zero builder sees earlier published
`test/acceptance/` suites; the bench strips them even for round zero. Review uses
a separate sanitized patch tree. The model stages get model and read-only npm
routes only; neither has a GitHub route.
Dependency downloads can occur, so offline here means offline from GitHub,
not disconnected from the model integration or npm registry.

As in production, only the second judge reserves request input plus bounded
output before forwarding, within its 30,000-token limit and the remaining trial
cap. Reservation uses the gateway's text-request classifier and its documented
1,024-token hidden-prompt assumption. Other stages bound output to the remaining
cap and close the gateway when charged usage reaches it. A trial can overrun its
cap by the input of the one request that crosses it, as production can. A cap
below the first build request does not prevent forwarding that request. Review
seats share the workflow's turns, wall and 120,000 tokens. No cap is silently
raised.

BenchTrial v1 binds its independent ID to the task and variant. It records the
outcome, per-stage wall time, total wall time, requested and observed seat models,
family evidence, and journal-derived accounting. Each execution journal is
counted once. Nested `specify/draft`, `specify/review` and optional
`specify/revision` journals, including fallback requests, are priced as leaves,
never added to their aggregate specify receipt. A higher aggregate charge
remains a floor with incomplete price coverage. Receipt and journal usage are
reconciled by maximum, not added.
Unsettled dispatch bounds remain uncertain charges. M1 prices observed requests
as `api_equivalent_estimate`; `billedSpend` is always `unavailable`, and missing
or uncertain coverage is not a zero-cost success. Trials never write production
accounting or scoreboard rows.

Repeating the same completed invocation returns its digest-checked record
without new calls or charges. Interrupted or concurrent invocations refuse with
`trial_incomplete_refusing_resume`, rather than issuing a fresh allowance.
Retain that directory and its journals as incomplete evidence. Do not remove its
claim to force a restart. Run a new, separately budgeted trial if authorized.

## Compare trial directories

```sh
node host/cli/index.ts bench compare "$HOME/bench/trials/430-01" "$HOME/bench/trials/430-02"
node host/cli/index.ts bench spend "$HOME/bench/trials/"*
```

Both commands print JSON and only read local files. They make no model, GitHub,
or VM requests. Each argument is a trial state directory, not a task bundle
or a `trial.json` path. They reject duplicate directory aliases. Completed
records require a matching `trial.sha256` and strict `parseBenchTrial` validation.
Unknown or duplicate keys, malformed nested fields, coverage kinds inconsistent
with their counts, unavailable coverage with a numeric estimate, and broken
trial, variant, token, time, or pin bindings fail. Judge `fallbackRecord` is
rejected because the bench writer does not emit it. Resume uses the same parser
and also checks the record against the invocation's claim binding.

### BenchComparison v1

`src/bench/compare.ts` defines the comparison. Variant names identify report
columns. Use the same name and treatment across repetitions and tasks. Tasks
are keyed by `originalRunId`, not issue number. Different historical runs of
one issue are different tasks. Trials of the same task must use the same
bundle, issue, cap, factory revision, workflow, tariff, original assets, Node
version, platform, gate runner, and thinking label.

The selected model, skill file digest, `respec`, or `buildRevision` value is the only
permitted difference between variants. `buildRevision: on` is the baseline
and can pair with one model or skill treatment because those treatments also
leave the revision enabled. Respec can pair only with that on baseline or
respec repetitions. Respec versus a model, skill or revision-off treatment
changes two dimensions and fails. Respec repetitions compare frozen base,
archive and snapshot bindings, not generated contract, suite or base-receipt
digests, which may vary. Those output digests remain in each trial's comparison
provenance; suite text and canaries do not enter the report.
Historical M6 results with a different factory pin remain incomparable. Six new
respec trials measure end-to-end re-spec repeatability, not #807's isolated
effect; old results are context only. An off treatment paired with a model
treatment changes two dimensions and fails. Different model stages or skill paths also
fail. Skill treatments may change the resulting runtime assets digest, never
the original assets pin. The local replacement `file` path is not a treatment
because its bytes are pinned by digest. Within a named variant, the treatment
and resulting runtime assets must remain fixed for each task.

An incompatible input fails before printing a report. The error lists every
differing undeclared dimension, including pin and runtime field names. The
command never silently excludes an incompatible trial.

The JSON contains `variants` and `tasks`. Reports include:

- The pass count, candidate-failure count, harness-failure count, incomplete
  count, `n`, and pass rate. Every recorded outcome remains in the denominator.
  `failureClasses` uses the factory's existing classes. Candidate check and
  policy failures are `candidate`; blocking or unverifiable review judgments
  are `review`. Specify questions are `input`, a specification needs-info outcome
  counted with candidate failures, never a harness failure. Author-fixable base
  refusals use `base`. Malformed model, specify or accept output uses `attempts`.
  Both count with candidate failures, not harness failures. Stage reasons retain
  the exit kind, such as `specify_failed_malformed` or `accept_failed_crashed`.
  The `crashed` and `aborted` exits are `infrastructure`. The `error` exit
  defaults to `attempts`, matching production's stage-failure retry exhaustion.
  Reasons append a named diagnostic when available, for example
  `accept_failed_error:accept_tool_limit`. The model guard diagnostics
  `accept_tool_limit`, `accept_request_limit` and `accept_length` remain `attempts`.
  Only these explicit error diagnostics count as `infrastructure`:
  `prompt_response_failed`, `secret-in-request`, `upstream-error`,
  `upstream-timeout`, `audit-unavailable`, `response-blocked`, `redirect-refused`,
  `upstream-address-refused`, `provider-http-error`, `rate-limited` and `route-closed`. The bench observes failed prompt responses
  without changing the production runner. It retains receipt diagnostics and,
  when none exists, reads the last model gateway audit result. A secret alert
  always stops the stage. An earlier transport error followed by a successful
  request does not turn a later model failure into a harness failure.
  When stage retries run out on an `error` exit, a last model request that the
  gateway forwarded with status 429 or at least 500 appends `provider-http-error`,
  which counts as `infrastructure`, as do the gateway's own `rate-limited` and
  `route-closed` denials. The audit reason, when present, wins over the status.
  A later successful model request clears an earlier HTTP error, and npm
  requests never change it.
  For legacy `model_failed`, `specify_failed` and `accept_failed` reasons,
  comparison reads the stored stage receipt, including a failed specify leaf
  or the retried accept stage. Without an exit receipt, it uses `attempts`,
  production's stage-failure class, rather than assume a harness fault.
  Comparison never rewrites the stored trial or its digest.
  Missing or malformed evidence is `missing_evidence`, caps
  are `budget`, provider refusals are `provider`, and execution failures such
  as a base runner error or timeout remain `infrastructure`. Install and baseline failures are harness failures, not
  candidate failures. Each trial also reports its class and original reason.
- Token and wall-time medians, minima, maxima, and counts.
- A median labelled `api_equivalent_estimate`, minima and maxima, its coverage
  label and coverage counts, `known` (numeric estimates), and `n` (all trials).
  Null estimates stay unknown. The median uses only known estimates. If any
  estimate is unknown, a numeric median is `uncertain`, not a lower bound on
  the full sample's median. When all estimates are known, partial prices can
  yield a `lower_bound`; uncertain prices yield `uncertain`. No known estimates
  means a null median with `unavailable` coverage. `billedSpend` stays
  `unavailable`.
- Each variant's task IDs, `commonTasks` counts against every other variant,
  and `mixedPins` when its pooled trials have differing pins, including bundle
  pins. A top-level limitation names each variant covering fewer tasks than
  another. These pooled summaries are not controlled comparisons.
- `fewerThanThreeTrials` on each variant and each task's variant column.

Each task retains every variant column. An absent side has `status: "missing"`,
`n: 0`, and null medians, rather than disappearing from the report. Present
columns include each trial's outcome, dates, model observations, and estimate
coverage. Differences are right minus left within the same task. Missing sides
produce null differences. Each delta has its own coverage label. An estimate
or token delta is labelled `exact` only when both sides have exact estimate
coverage; otherwise it is `uncertain`. Token labels conservatively retain
pricing gaps as well as charge gaps. Pass-rate deltas are exact counts when
both sides exist. `tokensSpread` and the estimate delta's `spread` put both
sides' minima, maxima, medians and counts beside the difference, so a gap can
be compared with run-to-run variation. Estimate ranges cover only `known`
estimates and carry the same coverage warning as the median. There are no
cross-task differences or ratios.
Variant-wide summaries can cover different task sets and are descriptive,
not evidence of an improvement. Three trials cannot establish a small effect.
Provider backend versions remain unpinned even when observed model names match.

### Tally recorded charges

`bench compare` leaves incomplete claimed directories out of its statistics
and names them in `excludedIncomplete.directories`, with their count in `n`.
It validates their claim bindings first; an arbitrary directory or corrupt
completed record still fails. An all-incomplete input reports no variants or
tasks and names every excluded directory. `bench spend` includes these
incomplete directories in its charge tally. For a completed trial it uses
`accounting.chargedTokens` once and does not add its runtime receipts again. Copied completed trial IDs are refused.
For an incomplete trial it reads each runtime execution's receipt, high-water
usage, request journal, and audit through the production `executionCharge`
reader. That reader reconciles overlapping charges by maximum, retains
uncertain dispatch bounds, and avoids adding aggregate receipts to their leaves.
Journal coverage follows the nested specify leaf directories too; absent leaves
or an aggregate charge above the observed leaf total remain lower-bound evidence.
Each trial reports charge `coverage` and `unavailableStages`. A missing or
unreadable stage journal makes a numeric charge `lower_bound`, even when
another stage or a receipt is readable; no recorded charges means `unavailable`.
Unsettled dispatches also remain visible through `uncertain`.

The output reports `chargedTokens`, completed and incomplete trial counts,
`uncertainTrials`, and `unavailableTrials`. A directory with no recorded charge
has null tokens, not a claimed zero. The total is labelled
`coverage: "recorded_charges_only"`. It is not evidence that an interrupted
request incurred no later charge. Retain incomplete directories and reread them
when late usage settles. Dollar billing remains `unavailable`. This command
neither grants another trial nor changes a token allowance.

## Install and run on nubl-bench

Only the coordinator runs this procedure under the bench-host and spend grants.
Use the separate `nubl-bench` host with the `llm` integration only. Do not install
a GitHub integration, GitHub token, `factory.service`, or the production installer.
Do not copy production state to the bench host. Transfer only private verified
task bundles and a Git bundle of the desired committed factory checkout.

1. Install Git, bubblewrap 0.9.0 or newer, and Docker. Create a dedicated bench
   user with uid 1001 in the docker group, then enable its systemd manager:

   ```sh
   sudo useradd -m -u 1001 -G docker bench
   sudo loginctl enable-linger bench
   sudo -iu bench
   ```

   The trusted gate container runs as uid 1001, like the GitHub Actions runner.
   Its bind mounts belong to the bench user. A different uid cannot read
   `/archives` or write `/cache` and `/w`, even with a less restrictive umask.
   Keep `umask 077`. Run every remaining installation and trial command as
   `bench`, with its own home directory and private transferred files.

   Install Node 26.12.1 for `bench`. For a mise installation, use
   `mise use --global node@26.12.1`. SSH sessions do not reliably load the login
   shell's PATH. Set the installed Node path and systemd runtime directory
   explicitly in every session and script, including non-interactive SSH:

   ```sh
   export PATH="$HOME/.local/share/mise/installs/node/26.12.1/bin:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin"
   export XDG_RUNTIME_DIR="/run/user/$(id -u)"
   ```

   Confirm `id -u` prints `1001`, and `node --version` prints `v26.12.1`.
   Confirm `bwrap --version`, `docker info`, and
   `systemd-run --user --scope --quiet true` succeed.
2. On the source checkout, create the transfer bundle from a branch ref.
   The canonical `m5-bench-run` branch is one such ref.

   ```sh
   mkdir -p "$HOME/private"
   git bundle create "$HOME/private/factory-source.bundle" refs/heads/m5-bench-run
   ```

   Transfer the bundle to the bench user's `$HOME/private/factory-source.bundle`.
   As `bench`, clone that local file. Use the exact approved commit.

   ```sh
   git clone "$HOME/private/factory-source.bundle" "$HOME/factory-bench"
   cd "$HOME/factory-bench"
   git checkout --detach <approved-commit>
   npm ci --ignore-scripts --no-audit --no-fund
   bash host/install/provision.sh sandbox
   docker pull node@sha256:6d2c7d5d074bf72f81ddc252b4fbb5d625bc028eeda49cb4b8c2ff8eda1ee617
   ```

   A bundle containing only a ref outside `refs/heads/` clones with an empty
   worktree. For such a bundle, fetch its exact ref explicitly, then check out
   `FETCH_HEAD` before installing dependencies:

   ```sh
   git fetch "$HOME/private/factory-source.bundle" <bundled-ref>
   git checkout --detach FETCH_HEAD
   git rev-parse HEAD
   ```

   Confirm that HEAD equals the approved commit.

   `sandbox` builds only assets. Do not run provisioning without that argument
   or run `install-exe-dev.sh`. Installation downloads public runtime assets and
   registry dependencies but performs no GitHub API authentication.
3. Before the first trial, run this no-model preflight on the installed checkout
   as `bench`. It exercises the trusted gates' dependency prefetch and offline
   install in the pinned Docker image under the trial's umask:

   ```sh
   cd "$HOME/factory-bench"
   umask 077
   mkdir -p "$HOME/bench"
   sha=$(git rev-parse HEAD)
   node host/cli/index.ts gates --repository "$PWD" \
     --gate-sha "$sha" --candidate-sha "$sha" \
     --nonce bench-smoke --output "$HOME/bench/gate-smoke" \
     --replacements '[]' \
     --replacements-digest 4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945
   ```

   Require exit 0 and `status: "passed"` in
   `$HOME/bench/gate-smoke/receipt.json`, including an `install` check with
   `exitCode: 0`. Stop on any failure. Do not spend model tokens until this
   preflight passes. It makes npm registry requests but no model requests.

   The 360-second gate limit applies to `baseline_tests` only, not to the
   preflight's total wall time. The runner derives every later check's deadline
   from the measured baseline. Record every check's duration with the trial
   evidence.

   Size the host with that limit in mind. At `76826ef`, `baseline_tests` took
   about 177 seconds on 4 vCPU and about 312 seconds on 2 vCPU. That leaves a
   thin margin at 2 vCPU, which is the bench's resting size. Each trial's
   validation runs the same gate. If a growing suite pushes the baseline near
   360 seconds, ask the owner to resize the VM before a trial series. Never
   raise the limit.
4. Set the private task and variant paths. Generate the baseline's pins from
   the installed files, not from a copied example.

   ```sh
   umask 077
   mkdir -p "$HOME/bench/trials"
   export FACTORY_PLATFORM=exe-dev
   export BUNDLE="$HOME/bench/tasks/430"
   export VARIANT="$HOME/bench/baseline-430.json"
   export ASSETS="$(readlink -f /var/lib/factory-sandbox/current)"
   node host/cli/index.ts bench verify "$BUNDLE"
   node --input-type=module > "$VARIANT" <<'JS'
   import { execFileSync } from 'node:child_process';
   import { readFileSync } from 'node:fs';
   import { join } from 'node:path';
   import { verifyBundle } from './host/bench/export.ts';
   import { manifestDigest } from './host/bundle/manifest.ts';
   import { digestOf } from './src/core/run.ts';
   import { PINNED_TARIFF, tariffDigest } from './src/core/tariff.ts';
   const pins = {
     bundleDigest: verifyBundle(process.env.BUNDLE).manifestDigest,
     factoryRevision: execFileSync('git', ['rev-parse', 'HEAD'], {encoding:'utf8'}).trim(),
     assetsDigest: await manifestDigest(process.env.ASSETS),
     workflowDigest: digestOf(readFileSync(join(process.env.BUNDLE, 'original/WORKFLOW.md'))),
     tariffDigest: tariffDigest(PINNED_TARIFF)
   };
   process.stdout.write(JSON.stringify({version:1, kind:'factory_benchmark_variant',
     name:'baseline-430', pins, change:{kind:'buildRevision', value:'on'}}, null, 2)+'\n');
   JS
   ```

5. Run the replay command above. Keep `trial.json`, native runtime receipts,
   request journals, gateway audits, visible results and gate receipts private.
   Sum all trial charges against the program grant, including incomplete trials.
   Stop and report at the owner's 80-percent threshold. The CLI's cap is per
   trial, not a replacement for that program-wide accounting.

Local fake-gateway tests establish composition, parsing, cap refusal and
accounting. They do not establish model quality, native bench-host behavior,
GitHub isolation on the VM, or the M5 performance budget. The coordinator runs
those live and performance lanes separately.
