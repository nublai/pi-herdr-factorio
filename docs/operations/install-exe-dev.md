# Install Factorio on exe.dev

Giuseppe creates `nubl-factory` from `boldsoftware/exeuntu`. The Shep bridge is optional for factory bring-up. Run Factorio's installer as `exedev` (uid 1000, home `/home/exedev`, passwordless sudo), not as root. This is the default `exe-dev` platform. For the default target the installer refuses an existing `/etc/factory/platform.json` and never writes one.

The default commands install this repository's controller on `nubl-factory`. For a different target, follow [Set up a factory for another repository on a new VM](#set-up-a-factory-for-another-repository-on-a-new-vm).

**No dispatch on any repository until [#837](https://github.com/nublai/pi-herdr-factorio/issues/837) is closed and [#842](https://github.com/nublai/pi-herdr-factorio/issues/842) is fixed.** #842 requires the trusted gate baseline to finish under 360 seconds in the pinned image, without raising the limit. This repository's own suite has never been timed for that baseline. Parser acceptance and a held installation do not close either gate.

This installs a **held** controller, not a cutover. `pi-factorio` was retired and deleted on 2026-11-13 (#734), with its state archived. Production is now `nubl-factory`, held between pilot rounds; `~/factory-state/install-exe-dev.commit` on the VM records the installed commit. Routine access is read-only; upgrades, bridge installation, enabling dispatch and fixture runs each need Giuseppe's explicit go. A hold blocks new dispatch, not observation of existing runs.

## Attach integrations

Run these on your computer, not inside the VM:

```bash
ssh exe.dev integrations add github --name nubl-factory-repo --repository nublai/pi-herdr-factorio --attach vm:nubl-factory
```

Models need no command, because the `llm` integration is attached to every VM (`auto:all`). Check with `ssh exe.dev integrations list`. If the repository integration already exists, attach it instead of adding it again:

```bash
ssh exe.dev integrations attach nubl-factory-repo vm:nubl-factory
```

A newly added or re-attached integration can take a minute or two to reach the VM. Until then reads answer 403, and `--check` refuses `github_integration`, so wait and run it again. Keep the GitHub bot identity. Do not use `--act-as-user`, `--readonly`, `gh auth login` or a token. Git and GitHub reads use `github.int.exe.xyz`; models use `llm.int.exe.xyz`. No credential is installed or printed.

## One command

SSH to `exedev@nubl-factory.exe.xyz`. Set `C` to the full lowercase 40-character SHA published in `nublai/pi-herdr-factorio`:

```bash
C=<sha>; curl -fsSL https://raw.githubusercontent.com/nublai/pi-herdr-factorio/$C/host/install/install-exe-dev.sh | bash -s -- "$C"
```

The selected revision must include the repository rename in the platform allowlist and a valid trusted workflow on `main`. The installer refuses to start a controller whose platform does not allow the requested repository.

`--vm name` changes only the VM name in preflight fix instructions (default `nubl-factory`), not the host being installed.

## Check only

```bash
curl -fsSL https://raw.githubusercontent.com/nublai/pi-herdr-factorio/<commit>/host/install/install-exe-dev.sh | bash -s -- --check --vm nubl-factory
```

`--check` needs no commit argument. It only reads local prerequisites and performs a repository GET and an OpenAI models-list GET, never a model inference. Its namespace and bubblewrap smoke tests run `true` with the host filesystem read-only. It never clones, provisions, creates state, enables linger, installs a unit or restarts a service. Exit 0 means preflight passed; exit 1 prints a named refusal and a fix. Remote error bodies are suppressed.

Preflight requires x86_64 Linux, both exe.dev integration names resolving to the link-local edge, the normal VM user, passwordless broad sudo (`sudo -n true`), bubblewrap >= 0.9.0, working unprivileged namespaces and bubblewrap, systemd/logind, attached GitHub and model routes, and at least 4 GiB plus 100,000 free inodes on each filesystem containing the home, `/var/lib` and `/tmp`. Missing commands name their apt package. Preflight changes no configuration; sudo and network probes may generate ordinary system audit logs.

## Set up a factory for another repository on a new VM

Use one controller per target repository on a separate VM. Keep `nubl-factory` held and untouched. These steps describe `giuseppecrj/pi-herdr-agents`; replace that slug consistently for another target.

1. **Giuseppe:** authorize the new VM and held install. Recommended: the authorized agent creates a fresh x86_64 `boldsoftware/exeuntu` VM with `ssh exe.dev new --name=<vm> --comment=repo2-factory --no-email --json`. The agent's key automatically tags VMs it creates `tester`. The agent then joins it to the tailnet through the installed `exe-dev-test-vm` skill, never interactive Tailscale login. Alternatively, Giuseppe creates the VM and tags it `tester` himself before agent access. The agent cannot tag a VM Giuseppe created. Never copy a production controller.
2. **Giuseppe, on his computer:** authorize the exe.dev GitHub App for the target and attach the repository integration. The exact command is `ssh exe.dev integrations add github --name <vm>-repo --repository <owner/name> --attach vm:<vm>`. For Agents:

   ```bash
   ssh exe.dev integrations add github --name <vm>-repo --repository giuseppecrj/pi-herdr-agents --attach vm:<vm>
   ssh exe.dev integrations list
   ```

   If the correctly scoped integration already exists, use `ssh exe.dev integrations attach <name> vm:<vm>` instead of adding it again. Confirm `llm` is attached through `auto:all`. Keep the bot identity and repository scope. Integration propagation can take a minute or two; rerun preflight after a refusal, not a model inference. The agent's tester key cannot add integrations.
3. **Root:** apply the [Agents onboarding file set and checklist](examples/onboarding/pi-herdr-agents/README.md) to target main under its grant. Set the same reviewed full product SHA in `gates.json`, trusted CI, and the installer. Copy all three gate assets from that revision. Validate the workflow, policy, inventory, and required changes to `test/release-workflow.test.ts`. Root may update the target's README badge and `RELEASING.md` CI references in the same PR. Keep the existing `Checks` job and the example's dependent `check` job so ruleset 27348552 remains satisfied during onboarding. Root opens the PR; Giuseppe merges it after exact-head `Checks` and `check` pass, or Root merges under Giuseppe's explicit grant. Do not change required contexts yet. Giuseppe must confirm the target's second-judge model and spend before Root adds it. The example leaves it unconfigured and fails closed for judge-only scenarios.
4. **Authorized installer operator, as `exedev@<vm>.exe.xyz`:** download the product installer, run `--check` first, then install. `ad6f07f99fa2bf7f6d365b564f55947bad364d06` is the merged R1–R4 schema baseline used by the examples, not a dispatch-qualified revision. Choose Giuseppe's approved full product SHA, including the #837 and #842 fixes before dispatch. Do not use the target main SHA as `C`.

   ```bash
   C=<reviewed-full-40-character-product-sha>
   VM=<new-vm-name>
   URL="https://raw.githubusercontent.com/nublai/pi-herdr-factorio/$C/host/install/install-exe-dev.sh"
   curl -fsSL "$URL" | bash -s -- --check --repo giuseppecrj/pi-herdr-agents --vm "$VM" "$C"
   curl -fsSL "$URL" | bash -s -- --repo giuseppecrj/pi-herdr-agents --vm "$VM" "$C"
   ```

   Require `preflight=ok`, then `installed=<C> held=yes`. A preflight failure stops the sequence. `--vm` changes fix instructions, not the machine. For another target, the product clones anonymously from `https://github.com/nublai/pi-herdr-factorio.git`; the target integration needs no product access. For Factorio's default target, the integration clone is unchanged.
5. **Installer operator:** prove the held installation with target-specific reads on the VM. Save the receipt, checkout SHA, rendered unit, platform file, restart boundary, and current invocation journal.

   ```bash
   export PATH="$HOME/.local/bin:$HOME/.local/share/mise/shims:$PATH"
   GH_HOST=github.int.exe.xyz node /home/exedev/pi-herdr-factorio/host/cli/index.ts workflow-check --json --repo giuseppecrj/pi-herdr-agents
   GH_HOST=github.int.exe.xyz node /home/exedev/pi-herdr-factorio/host/cli/index.ts status --json --state-dir /home/exedev/factory-state --repo giuseppecrj/pi-herdr-agents
   GH_HOST=github.int.exe.xyz node /home/exedev/pi-herdr-factorio/host/cli/index.ts owner-feed --json --state-dir /home/exedev/factory-state --repo giuseppecrj/pi-herdr-agents
   systemctl show factory.service -p ActiveEnterTimestamp -p InvocationID
   invocation=$(systemctl show factory.service -p InvocationID --value)
   sudo journalctl -u factory.service "_SYSTEMD_INVOCATION_ID=$invocation" --no-pager -o cat
   git -C /home/exedev/pi-herdr-factorio rev-parse HEAD
   cat /home/exedev/factory-state/install-exe-dev.commit
   cat /etc/factory/platform.json
   systemctl cat factory.service
   ```

   Require a valid remote target workflow on main, checkout and receipt SHA equal to `C`, and receipt repository equal to the target. Require `controller_ready` in this invocation, a running controller, and `status.json` and `controller.lastTick.at` newer than `ActiveEnterTimestamp`. Compare `.platform.digest` against `.controller.lastTick.platform.digest`; they must match with `repositories: ["giuseppecrj/pi-herdr-agents"]` and no historical aliases. Dispatch must be false with `locally_disabled`. Require a successful controller sandbox preflight (`controller.lastTick.executionEnabled: true` and no `sandbox_unavailable`). Top-level status `executionEnabled` is always false and is not that proof. OwnerFeed must report the selected target without missing-state errors. The shared doctor reads Factorio, so do not use it as Agents repository proof.
6. **Root and Giuseppe:** complete main-backed bootstrap evidence and settings in the [onboarding checklist](examples/onboarding/pi-herdr-agents/README.md). Root supplies exact-head ordinary CI and pinned-image unit qualification under separate grants. Before any bootstrap dispatch, verify #837 is closed, #842 is fixed, and the pins include both fixes. Require timed baseline evidence under 360 seconds in the pinned image without raising the limit; this repository's own baseline has never been timed. Only then collect trusted dispatch/report evidence under its separate grant. After the bootstrap checks exist, Giuseppe updates existing ruleset 27348552 from `Checks` to strict `check` and `factory-gates`, both from App 15368, and removes its always-admin bypass. The onboarding workflow already emits both `Checks` and `check`, so no job rename or unprotected interval is needed. Giuseppe applies the separate approval ruleset and Actions permissions and reads all settings back. Root then creates the five non-enabling labels under its grant. Lifecycle tickets need candidate-bound Linux integration evidence separately; a host/unit pass cannot replace it.
7. **Giuseppe:** verify #837 is closed, #842 is fixed, and the installed/pinned product contains both fixes. Require the timed baseline evidence before dispatch on any repository. Create `factory:enabled`, authorize the first bounded fixture and its spend, and explicitly approve lifting this new VM's local hold. Name the fixture `[<PR>-...]`, authorize its ready-label event separately, and keep full stage allowances. No label or successful install grants dispatch. Capture exact-head gate/report, review, and human-handoff evidence, then restore the hold at the agreed stopping point. Close the fixture under its grant and confirm CLOSED. No step authorizes a `nubl-factory` upgrade or hold-lift.

### Repository selection and reruns

Before stopping any service or provisioning, the pinned installer writes `/etc/factory/platform.json`, root-owned and mode 0644, containing exactly `{"version":1,"platform":"exe-dev","repositories":["owner/name"],"historicalRepositories":{}}`. A rerun accepts only that exact file for the same target. The installer refuses, before any change, a malformed, symlinked, non-root or differently permissioned file, one naming another platform or repository, an existing checkout or unit with no selection file, and a receipt for another repository. A run with no `--repo` or with `--repo nublai/pi-herdr-factorio` on such a VM refuses too. `--check` validates the same file but never writes it. The target still needs its own trusted workflow on `main`.

### Disposable fixture with the R1 installer

Use a separately authorized disposable VM and target such as `nublai/pi-herdr-factorio-layout-fixture`. Its private visibility does not change the bootstrap URL: download from the public **product** at `C`, not the fixture. The fixture main supplies a matching `.github/factory/WORKFLOW.md` and gate policy/assets. Record its independent main SHA. Do not change product platform defaults or derive a product commit that exists only in the fixture repository.

```bash
C=<full-product-sha-published-in-nublai/pi-herdr-factorio>
VM=<disposable-name>
URL="https://raw.githubusercontent.com/nublai/pi-herdr-factorio/$C/host/install/install-exe-dev.sh"
curl -fsSL "$URL" | bash -s -- --check --repo nublai/pi-herdr-factorio-layout-fixture --vm "$VM" "$C"
curl -fsSL "$URL" | bash -s -- --repo nublai/pi-herdr-factorio-layout-fixture --vm "$VM" "$C"
```

Require a singleton for the fixture, product origin `https://github.com/nublai/pi-herdr-factorio.git`, and receipt `<C> nublai/pi-herdr-factorio-layout-fixture`. Keep the hold and attach no production repository integration. Fresh and upgrade proof use separate disposable VMs. An installation fixture is not dispatch or production deployment proof. #837 and #842 still block dispatch on any repository.

Historical pre-R1 layout fixtures used derived product commits and a different bootstrap. Those receipts remain historical, not a current install procedure. An existing old-layout fixture without the R1 singleton refuses a target switch; stop and obtain a separate reviewed migration grant rather than deleting its state or platform file.

## What installation does

After preflight passes, it refuses a dirty, symlinked or wrong-origin checkout. It creates `/home/exedev/factory-state` owned by `exedev` at 0700 and its `disabled` hold before stopping or enabling any service. An existing state directory must already be private and owned by `exedev`; existing hold bytes and metadata are preserved.

It clones and fetches the product into a temporary directory beside `/home/exedev/pi-herdr-factorio`, checks out the exact SHA and verifies `git rev-parse HEAD` against it, before stopping the controller. A failed download leaves any old controller running and no partial new checkout. It re-executes the installer from that verified checkout, so provisioning uses the pinned installer rather than the downloaded bootstrap. For another target it then writes the selection file. It then stops and disables the service, moves a first checkout into place or updates the existing clean checkout, and runs full `host/install/provision.sh`, refreshing checkout dependencies on upgrades. MV3 installs host tools, Pi configuration, linger, the verified root-owned sandbox bundle and `/etc/factory/factory.env`. The installer renders the selected `--repo` into `host/install/factory.service`, installs it and restarts it. `Type=notify` waits for readiness; the installer checks `controller_ready` in that invocation's journal and requires a `status.json` timestamp later than the restart boundary, followed by a running controller's `status --json` with the same freshness requirement and `locally_disabled` with dispatch disabled. Only after those checks does it enable the service for boot.

It prints those reasons and atomically records the successful commit in `factory-state/install-exe-dev.commit`. A failure leaves the hold in place. After a stop, failure cleanup stops and disables the service so a half-provisioned checkout cannot crash-loop on reboot; it reports any cleanup failure explicitly. Fix the reported error and rerun the pinned command to recover. The installer does not roll back shared provisioning changes or lift the hold. Never treat preflight alone as proof of provisioning, cgroup limits, stage execution or an end-to-end install.

### Recover an unreadable or mismatched sandbox bundle

The bundle build sets `umask 022`, regardless of the installer's caller umask. Installed bundle files are world-readable, directories are searchable, and the root-owned tree is read-only. The provisioner checks the installed manifest before switching `current`.

If an existing `assets-<digest>` cannot be read or its manifest digest does not match its name, provisioning refuses with `REFUSE sandbox_bundle` and recovery instructions. It leaves that bundle and `current` unchanged.

Keep the hold and stop the controller before recovery. For a permissions-only failure, inspect the reported bundle and restore read and directory-search permissions with `sudo chmod -R a+rX <bundle>`. Run `node host/bundle/manifest.ts <bundle>` as `exedev` and require its output to match the digest in the directory name. Then rerun the pinned installer.

For a digest mismatch, investigate the changed content. Never delete or replace a bundle that `current` references. Switch `current` to a separately verified bundle while the controller is stopped before removing the damaged bundle and rerunning the pinned installer. If no verified bundle is available, stop and ask the coordinator for a recovery plan.

## Verify

On the VM, as `exedev`:

```bash
cd /home/exedev/pi-herdr-factorio
export PATH="$HOME/.local/bin:$HOME/.local/share/mise/shims:$PATH"
GH_HOST=github.int.exe.xyz node host/cli/index.ts status --json --state-dir /home/exedev/factory-state --repo nublai/pi-herdr-factorio
sudo journalctl -u factory.service -n 100 --no-pager
```

Require `controller.state` to be `running`, `controller.lastTick.dispatch.enabled` to be `false`, and `controller.lastTick.dispatch.reasons` to contain `locally_disabled`. The journal must show `event=controller_ready`. Other reasons, such as a missing repository switch or sandbox preflight, remain visible and need their own checks before release.

From a local checkout with the verification skill:

```bash
S=.pi/skills/verify-factory/scripts
FACTORY_VM=nubl-factory "$S/vm.sh" "$S/doctor.sh"
```

This selects `exedev@nubl-factory.exe.xyz` and `github.int.exe.xyz`. The doctor reports tool versions and a repository read; it does not lift the hold. The separate repository rename must update the doctor's legacy repository probe too.

## Hold and upgrade

Provisioning installs exactly `NODE_VERSION` through mise, currently Node 26.12.1. An upgrade downgrades a host with a newer Node to `NODE_VERSION`; it does not refuse the newer version before provisioning. `nubl-factory` runs Node 26.12.1.

Only Giuseppe decides when to remove `/home/exedev/factory-state/disabled`, after the old controller is drained/stopped and cutover verification is complete. This installer never removes it and never creates or deletes `factory:enabled`.

Upgrade only on a drained controller, following the [drained rollout procedure](human-review.md#roll-forward-from-a-drained-controller) linked from [Factory CLI](factory-cli.md#install-the-service). Then rerun the one command with `C` set to the new full SHA. The state and hold remain; the checkout, dependencies, bundle and unit are updated and the service restarts. With the same successful SHA, clean checkout, matching unit and an active service, rerunning performs preflight, verified-installer re-execution and status reads, retains the hold and skips provisioning and restart. If Giuseppe had lifted it, rerunning creates the hold again. Both paths wait up to two minutes for fresh held controller status, rather than accepting an old snapshot. Do not use the installer to discard local checkout edits or to switch an existing controller to a different repository.

## Shep bridge

The bridge runs as the **same `exedev` user**, reading the private state directly:

```bash
/home/exedev/.local/share/mise/shims/node /home/exedev/pi-herdr-factorio/host/cli/index.ts owner-feed --json --state-dir /home/exedev/factory-state --repo nublai/pi-herdr-factorio
```

No viewer ingress, extra port, token or privileged helper is needed. The bridge is optional for bring-up. If Giuseppe authorizes it, the Shep owner installs it and points it at that command after the checkout exists. For Agents, use `--repo giuseppecrj/pi-herdr-agents` with the same state path and user. Shep owns its feed polling and push delivery; see [OwnerFeed contract](owner-feed.md). The installer does not configure or restart the bridge.
