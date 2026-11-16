# pi-herdr-factorio

A ticket-triggered software factory for [Pi](https://github.com/earendil-works/pi), built on [pi-herdr-pstack](https://github.com/giuseppecrj/pi-herdr-pstack).

Status: in development. The controller runs on one exe.dev VM, `nubl-factory`, against this repository only. It runs real tickets in owner-approved pilot rounds (#735) and is held between them. Its PRs wait at `factory:review`, and the owner merges them.

A maintainer labels a GitHub issue. The factory specifies the work, writes hidden acceptance checks, builds a patch in a sandbox, validates it with trusted gates, reviews it, and opens a PR. It never merges. Linear support is planned (#717).

## Where things live

Each folder has a `README.md` that says what belongs in it and where new files go.

| Folder | What it holds |
| --- | --- |
| `src/` | The factory's rules: runs, stages, contracts, the ledger and the controller's decisions. |
| `host/` | Host execution: the CLI, controller loop, sandboxes, gateway, gates, viewer and installer. |
| `extension/` | The Pi extension that adds `/factory`. |
| `skills/` | Stage skills that ship in the sandbox bundle. |
| `test/` | Tests, fixtures and published held-out suites. |
| `docs/` | Decisions, plans, runbooks, models and historical evidence. |
| `scripts/` | Repository tools, including the layout and decisions guards. |
| `tools/` | The vendored lint plugin. |
| `.pi/` | Coordinator skills for Pi sessions in this checkout. |
| `.github/` | CI workflows and the trusted factory gate configuration. |
| `research/` | The original design research. Historical. |

`npm run check` runs typecheck, lint, format, both guards and every test.

## Set up

- [Install Factorio on exe.dev](docs/operations/install-exe-dev.md) is the runbook. It covers integrations, the one pinned install command, verification, the hold, upgrades and the Shep bridge.
- [Factory CLI](docs/operations/factory-cli.md) covers the controller and its commands. [Platform profile](docs/operations/platform.md) covers the host profile. [Review and merge a factory PR](docs/operations/human-review.md) covers the owner's side, including repository rulesets.
- The factory runs only against `nublai/pi-herdr-factorio` today. Setting it up for another repository on a new VM is not supported yet.

## Records

`docs/plans/active/factory-v1.md` tracks what is built and what remains, and `docs/decisions.tsv` records every decision and verdict. `docs/operations/` documents how to run each part. `research/SYNTHESIS.md` is the original design research. `research/reports/` holds the evidence behind it. Upstream skill captures stay local; `research/PROVENANCE.md` records their URLs, pinned SHAs and licenses, because several upstreams carry no license.
