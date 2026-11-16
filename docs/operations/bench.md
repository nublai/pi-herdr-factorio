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
  --state-dir "$HOME/bench/trials/430-01" --token-cap 540000
```

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
  and differ from the original. The installed bundle stays unchanged. The trial
  records the resulting assets digest as well as the original pin.
- `{"kind":"buildRevision","value":"on"}` or `"off"` selects #813's single
  in-session build revision. `on` passes the same unrun-test-edit check as the
  executor. `off` omits `draftCheck` from the build input. `on` is the baseline.
  The declared selector is required even for that baseline; an absent selector
  is not a variant.

Stage thinking and arbitrary factory revisions are out of v1. The executing
factory revision is a fixed pin, not a selectable experiment dimension.
Thinking outside accept was not historically recorded. Trials label it
`runtime_default:not_historically_recorded` and retain the pinned runtime.

### State, isolation and accounting

The state root must be private, owned by the caller, and initially empty.
A production copy, symlink root, bundle overlap or any other non-bench state
is refused. The command checks both system and user `factory.service` LoadState;
a present service, even stopped or masked, refuses execution. An unreadable
service probe also refuses.

A write-once claim binds the bundle, variant and cap before preparation.
The driver reconstructs local Git commits from the archived tree for gates;
these are not the historical commit or a GitHub CI run. `ciRunId: 0` in private
review inputs explicitly means no CI exists. Local gate evidence is labelled
separately, never promoted to hosted-CI proof.

Only the sanitized workspace enters the builder sandbox. The bundle root,
`oracle/`, trial records, local Git repository and trusted receipts are not
mounts. Existing published `test/acceptance/` files are removed by
`prepareRepairTree`. Review uses a separate sanitized patch tree. The model
stages get model and read-only npm routes only; neither has a GitHub route.
Dependency downloads can occur, so offline here means offline from GitHub,
not disconnected from the model integration or npm registry.

Every model stage reserves request input plus bounded output against the
remaining trial cap, including the second judge's 30,000-token limit. This uses
the gateway's existing text-request reservation and its documented 1,024-token
hidden-prompt assumption. Review seats share the workflow's turns, wall and
120,000 tokens. A cap below the first request ends `budget_exhausted` without
forwarding it. No cap is silently raised.

BenchTrial v1 binds its independent ID to the task and variant. It records the
outcome, per-stage wall time, total wall time, requested and observed seat models,
family evidence, and journal-derived accounting. Each execution journal is
counted once. Receipt and journal usage are reconciled by maximum, not added.
Unsettled dispatch bounds remain uncertain charges. M1 prices observed requests
as `api_equivalent_estimate`; `billedSpend` is always `unavailable`, and missing
or uncertain coverage is not a zero-cost success. Trials never write production
accounting or scoreboard rows.

Repeating the same completed invocation returns its digest-checked record
without new calls or charges. Interrupted or concurrent invocations refuse with
`trial_incomplete_refusing_resume`, rather than issuing a fresh allowance.
Retain that directory and its journals as incomplete evidence. Do not remove its
claim to force a restart. Run a new, separately budgeted trial if authorized.

## Install and run on nubl-bench

Only the coordinator runs this procedure under the bench-host and spend grants.
Use the separate `nubl-bench` host with the `llm` integration only. Do not install
a GitHub integration, GitHub token, `factory.service`, or the production installer.
Do not copy production state to the bench host. Transfer only private verified
task bundles and a Git bundle of the desired committed factory checkout.

1. Install Node 26.12.1, Git, bubblewrap 0.9.0 or newer, and Docker. Make the Docker
   daemon available to the bench operator, then sign in again if group access
   changed. Enable the user's systemd manager with
   `sudo loginctl enable-linger "$USER"`. Confirm `bwrap --version`,
   `docker info`, and `systemd-run --user --scope --quiet true` succeed.
2. Clone the transferred Git bundle locally. Use the exact approved commit.

   ```sh
   git clone /private/factory-source.bundle "$HOME/factory-bench"
   cd "$HOME/factory-bench"
   git checkout --detach <approved-commit>
   npm ci --ignore-scripts --no-audit --no-fund
   bash host/install/provision.sh sandbox
   docker pull node@sha256:6d2c7d5d074bf72f81ddc252b4fbb5d625bc028eeda49cb4b8c2ff8eda1ee617
   ```

   `sandbox` builds only assets. Do not run provisioning without that argument
   or run `install-exe-dev.sh`. Installation downloads public runtime assets and
   registry dependencies but performs no GitHub API authentication.
3. Set the private task and variant paths. Generate the baseline's pins from
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

4. Run the replay command above. Keep `trial.json`, native runtime receipts,
   request journals, gateway audits, visible results and gate receipts private.
   Sum all trial charges against the program grant, including incomplete trials.
   Stop and report at the owner's 80-percent threshold. The CLI's cap is per
   trial, not a replacement for that program-wide accounting.

Local fake-gateway tests establish composition, parsing, cap refusal and
accounting. They do not establish model quality, native bench-host behavior,
GitHub isolation on the VM, or the M5 performance budget. The coordinator runs
those live and performance lanes separately.
