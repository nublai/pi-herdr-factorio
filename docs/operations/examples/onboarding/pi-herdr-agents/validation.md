# Local schema and inventory validation

R5 checked these examples with the real `gatePolicyOf`, `manifestOf`, and `parseWorkflow` implementations at product `ad6f07f99fa2bf7f6d365b564f55947bad364d06`.

The target was a read-only `git archive` export of `/home/g/Projects/pi-herdr-agents` at `181728b29f4f4af40d9a5ed3b945421255fa0bf6`, with only the example factory files overlaid in scratch. The source checkout remained unchanged. Scratch lived at `~/.herdr/worktrees/pi-herdr-factorio/r5-scratch` and was deleted after the probe. The probe ran in an 8 GiB memory-capped user scope with no swap and `TMPDIR=$HOME/.herdr/tmp`.

Observed output:

```text
gatePolicyOf=accepted version=2 checks=typecheck,lint,format
parseWorkflow=valid repo=giuseppecrj/pi-herdr-agents
manifestOf=34 files
test/launch.test.ts
test/maestro/async-io.test.ts
test/maestro/audit-herdr-dispatch.test.ts
test/maestro/audit-ownership.test.ts
test/maestro/composition-hooks.test.ts
test/maestro/core-lab.test.ts
test/maestro/core-parent.test.ts
test/maestro/delegated-marker.test.ts
test/maestro/dependency-rule.test.ts
test/maestro/git-handoff-async.test.ts
test/maestro/herdr-available.test.ts
test/maestro/herdr-cli.test.ts
test/maestro/herdr-core-execution.test.ts
test/maestro/herdr-lab.test.ts
test/maestro/herdr-placement-async.test.ts
test/maestro/herdr-socket.test.ts
test/maestro/herdr-surface-provider.test.ts
test/maestro/linux-integration-driver.test.ts
test/maestro/opened-primary-workspace.test.ts
test/maestro/pi-harness-adapter.test.ts
test/maestro/pi-run-session.test.ts
test/maestro/process-identity.test.ts
test/maestro/script-launch.test.ts
test/maestro/sidebar-fixture-ownership.test.ts
test/maestro/specialist-notice.test.ts
test/maestro/startup-failures.test.ts
test/maestro/test-environment.test.ts
test/package-manifest.test.js
test/release-workflow.test.ts
test/sidebar-plugin.test.js
test/system-prompt-mode.test.ts
test/test.ts
test/verify-lab-guards.test.ts
test/worktree-cleanup.test.ts
```

To re-expand, prepare an isolated target copy with this set's `.github/factory/` overlaid. From the product checkout, set `TARGET_COPY` to that copy and run:

```bash
TMPDIR=$HOME/.herdr/tmp systemd-run --user --scope --quiet -p MemoryMax=8G -p MemorySwapMax=0 -- \
  node --experimental-strip-types --input-type=module <<'NODE'
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gatePolicyOf, manifestOf } from './host/gates/manifest.ts';
import { parseWorkflow } from './src/config/parse.ts';
import { EXE_DEV_PLATFORM } from './src/trust/platform.ts';
const tree = process.env.TARGET_COPY;
const policy = gatePolicyOf(tree);
const workflow = parseWorkflow({
  text: readFileSync(`${tree}/.github/factory/WORKFLOW.md`, 'utf8'),
  repo: 'giuseppecrj/pi-herdr-agents',
  env: name => name === 'HOME' ? '/home/exedev' : undefined,
  platform: EXE_DEV_PLATFORM
});
assert.equal(workflow.kind, 'valid');
console.log('gatePolicyOf=accepted version=' + policy.version);
console.log('parseWorkflow=' + workflow.kind);
console.log(manifestOf(tree).tests.join('\n'));
NODE
```

Export `TARGET_COPY` before running the command. Each glob must match a file, and duplicate matches refuse. This is parser and inventory evidence only. The zero tooling SHA is a placeholder, not an installed or executable product pin. No Agents tests, gate execution, VM, integration, or Actions dispatch ran in this probe. The [README qualification checklist](README.md#test-inventory-and-remaining-qualification) remains pending.
