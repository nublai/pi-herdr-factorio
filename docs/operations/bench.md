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
