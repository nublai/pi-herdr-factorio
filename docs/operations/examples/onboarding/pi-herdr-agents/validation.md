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

## Validate held-out exclusions

### Step 1: Check the target's own configs and tools

Use an isolated checkout of the tree that will become the target's main: the onboarding branch head before the onboarding PR merges, or main after it. Install dependencies from its lockfile. A target whose main does not yet carry the gate policy and the exclusions fails this step on main with `invalid_gate_manifest` or a dirty-file check. That is expected until the onboarding branch is used. For Agents after onboarding, prepare it with a public clone:

```bash
TARGET_MAIN=$(mktemp -d "$HOME/.herdr/tmp/onboarding-main-XXXXXX")
export TARGET_MAIN
git clone --depth=1 --branch main https://github.com/giuseppecrj/pi-herdr-agents.git "$TARGET_MAIN"
(cd "$TARGET_MAIN" && TMPDIR=$HOME/.herdr/tmp systemd-run --user --scope --quiet -p MemoryMax=8G -p MemorySwapMax=0 -- npm ci --ignore-scripts)
git -C "$TARGET_MAIN" rev-parse HEAD
```

For another target, adapt the clone URL and dependency installation. Run the command below from the product checkout. It copies the target twice, without `.git` or `node_modules`, and shares only the installed target dependencies. The tooling copy stays unplanted, so the gate's `-c /g/tooling/...` config and plugins remain outside the checked tree. The policy comes from that target copy (its `.github/factory/gates/gates.json`), not from this example. Never point it at a factory candidate branch. It does not apply the exclusion patch for you.

```bash
TMPDIR=$HOME/.herdr/tmp systemd-run --user --scope --quiet -p MemoryMax=8G -p MemorySwapMax=0 -- \
  node --experimental-strip-types --input-type=module <<'NODE'
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { gatePolicyOf } from './host/gates/manifest.ts';

assert.ok(process.env.TARGET_MAIN, 'export TARGET_MAIN to an isolated target main checkout with installed dependencies');
const source = resolve(process.env.TARGET_MAIN);
const scratch = mkdtempSync(join(tmpdir(), 'onboarding-target-'));
const tree = join(scratch, 'target');
const tooling = join(scratch, 'tooling');
try {
	for (const copy of [tree, tooling]) {
		cpSync(source, copy, {
			recursive: true,
			filter: path => !['.git', 'node_modules'].includes(basename(path)),
		});
		symlinkSync(join(source, 'node_modules'), join(copy, 'node_modules'), 'dir');
	}
	const ordinary = ['lint', 'format:check', 'typecheck'].map(name => ({
		name: `ordinary ${name}`, argv: ['npm', 'run', name],
	}));
	const gates = gatePolicyOf(tooling).checks
		.filter(check => ['lint', 'format', 'typecheck'].includes(check.name))
		.map(check => ({
			name: `gate ${check.name}`,
			argv: check.argv.map(arg => arg
				.replaceAll('/g/tooling/', `${tooling}/`)
				.replaceAll('/w/', `${tree}/`)),
		}));
	assert.equal(gates.length, 3, 'target main must supply lint, format and typecheck gates');
	const heldout = join(tree, 'test/acceptance/999999/checks');
	mkdirSync(heldout, { recursive: true });
	writeFileSync(join(heldout, 'dirty.mjs'), "export const dirty={value:typeof 1};debugger;\n");
	writeFileSync(join(heldout, 'dirty.ts'), 'export const dirty: string=1;\n');
	let failed = 0;
	for (const check of [...ordinary, ...gates]) {
		const result = spawnSync(check.argv[0], check.argv.slice(1), {
			cwd: tree, env: process.env, encoding: 'utf8', timeout: 120_000,
		});
		assert.ifError(result.error);
		assert.equal(result.signal, null, check.name);
		console.log(`${check.name}: exit ${result.status}`);
		if (result.status !== 0) {
			failed++;
			console.error(result.stdout.slice(-2000), result.stderr.slice(-2000));
		}
	}
	assert.equal(failed, 0, `${failed} target static checks rejected the planted held-out files`);
	console.log('PASS: target main ignores held-out files in all six static checks');
} finally {
	rmSync(scratch, { recursive: true, force: true });
}
NODE
```

Require all six commands to exit 0. Missing exclusions must fail this command. The `.mjs` file exercises Agents' real `typeof` lint rule and formatter; the `.ts` file exercises its typechecker. For other targets, adapt the lint violation and extensions to their enabled rules and inputs. Do not plant files in a live controller checkout. After validation, remove the isolated clone with `rm -rf -- "$TARGET_MAIN"` and `unset TARGET_MAIN`.

This is target-tool host evidence, not pinned-image or live qualification. Run ordinary CI on the exact onboarding PR head too.

### Step 2: Check the example's documented patch

The onboarding test runs this second command hermetically. It validates the example patch, not a target's onboarding state.

Run this from the product checkout with its installed dependencies. It uses only the example files, local static tools, and a synthetic target under `TMPDIR`. It never reads an Agents checkout, installs packages, or contacts a VM.

The procedure applies the README's additive config patch to synthetic configs. It runs the example policy's three static checks with local paths substituted for `/g` and `/w`. It also runs the target-shaped ordinary npm scripts. The synthetic lint rule is built-in `no-debugger`, so this check needs no target plugins. Target CI must still verify the target's real rules and dependencies.

```bash
TMPDIR=$HOME/.herdr/tmp systemd-run --user --scope --quiet -p MemoryMax=8G -p MemorySwapMax=0 -- \
  node --experimental-strip-types --input-type=module <<'NODE'
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { gatePolicyOf } from './host/gates/manifest.ts';

const example = resolve('docs/operations/examples/onboarding/pi-herdr-agents');
const scratch = mkdtempSync(join(tmpdir(), 'onboarding-static-'));
const tree = join(scratch, 'target');
const tooling = join(scratch, 'tooling');
const modules = resolve('node_modules');
const env = { ...process.env, PATH: `${modules}/.bin:${process.env.PATH}` };

function put(path, text) {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, text);
}

function run(name, argv, expected) {
	const result = spawnSync(argv[0], argv.slice(1), {
		cwd: tree, env, encoding: 'utf8', timeout: 30_000,
	});
	assert.ifError(result.error);
	assert.equal(result.signal, null, name);
	assert.equal(result.status === 0, expected === 0, `${name}\n${result.stdout.slice(-500)}\n${result.stderr.slice(-500)}`);
	console.log(`${name}: exit ${result.status}`);
}

try {
	cpSync(join(example, '.github'), join(tree, '.github'), { recursive: true });
	for (const dir of ['pi-extension', 'maestro', 'plugins', 'scripts', 'skills', 'tools', '.pi/skills'])
		mkdirSync(join(tree, dir), { recursive: true });
	put(join(tree, 'package.json'), JSON.stringify({
		type: 'module', scripts: {
			lint: 'oxlint pi-extension test maestro plugins scripts',
			'format:check': 'biome format pi-extension test maestro plugins scripts',
			typecheck: 'tsc -p .',
		},
	}));
	put(join(tree, 'biome.json'), `{
  "files": {
    "includes": [
      "pi-extension/**",
      "test/**",
      "maestro/**",
      "plugins/**",
      "scripts/**",
      "!**/*.md"
    ]
  },
  "formatter": { "enabled": true },
  "linter": { "enabled": false },
  "assist": { "enabled": false }
}
`);
	put(join(tree, 'tsconfig.json'), `{
  "compilerOptions": { "strict": true, "noEmit": true, "types": [] },
  "include": ["pi-extension/**/*.ts", "test/**/*.ts"],
  "exclude": ["node_modules"]
}
`);
	put(join(tree, 'oxlint.config.ts'), `export default {
	ignorePatterns: [
		"tools/oxlint/anti-slop/**",
	],
	rules: { "no-debugger": "error" },
};
`);
	put(join(tree, 'test/test.ts'), 'export const clean = 1;\n');
	put(join(tooling, 'oxlint.config.ts'), readFileSync(join(tree, 'oxlint.config.ts')));
	const ordinary = ['lint', 'format:check', 'typecheck'].map(name => ({
		name: `ordinary ${name}`, argv: ['npm', 'run', name],
	}));
	const gates = gatePolicyOf(tree).checks.map(check => ({
		name: `gate ${check.name}`,
		argv: check.argv.map(arg => arg
			.replace('/g/tooling/node_modules', modules)
			.replace('/g/tooling/', `${tooling}/`)
			.replace('/w/', `${tree}/`)),
	}));
	const checks = [...ordinary, ...gates];
	for (const check of checks) run(`clean ${check.name}`, check.argv, 0);

	const dirty = 'export const dirty: string=1;debugger;\n';
	const heldout = join(tree, 'test/acceptance/154/checks');
	put(join(heldout, 'dirty.test.ts'), dirty);
	put(join(heldout, 'dirty.test.mjs'), "export const dirty={value:'bad'};debugger;\n");
	for (const check of checks)
		run(`before ${check.name}`, check.argv, check.name === 'gate lint' ? 0 : 1);
	const lint = gates.find(check => check.name === 'gate lint');
	assert.ok(lint);
	const withoutIgnore = lint.argv.slice();
	const ignore = withoutIgnore.indexOf('--ignore-pattern');
	assert.notEqual(ignore, -1);
	withoutIgnore.splice(ignore, 2);
	run('gate lint without argv exclusion', withoutIgnore, 1);

	const patch = readFileSync(join(example, 'README.md'), 'utf8').match(/```diff\n([\s\S]*?)\n```/);
	assert.ok(patch, 'README must include the static-check exclusion patch');
	const applied = spawnSync('git', ['apply', '--unidiff-zero', '-'], {
		cwd: tree, input: patch[1] + '\n', encoding: 'utf8',
	});
	assert.equal(applied.status, 0, applied.stderr);
	put(join(tooling, 'oxlint.config.ts'), readFileSync(join(tree, 'oxlint.config.ts')));
	for (const check of checks) run(`held-out ${check.name}`, check.argv, 0);
	for (const neighbor of ['test/acceptance-other.test.ts', 'test/accept/dirty.test.ts']) {
		put(join(tree, neighbor), dirty);
		for (const check of checks) run(`${neighbor} ${check.name}`, check.argv, 1);
		rmSync(join(tree, neighbor));
	}
	console.log('PASS: all four exclusions work and neighboring paths remain checked');
} finally {
	rmSync(scratch, { recursive: true, force: true });
}
NODE
```

Require all 31 command assertions to pass. Clean-tree checks must exit 0. Before the config patch, ordinary lint, format, and typecheck must reject the planted files, as must gate format and typecheck. The existing gate lint argv must ignore them, but removing its exclusion must fail. After the patch, all six static commands must exit 0 with the dirty held-out files still present. Each neighboring-path control must then fail all six commands. TypeScript reports these type errors with exit 2, while lint and format report exit 1.

The final line must be:

```text
PASS: all four exclusions work and neighboring paths remain checked
```

This second step is hermetic example-patch evidence, not target-tool, pinned-image, or live qualification. Step 1 is required to detect missing exclusions in the target. A gate run without a held-out suite does not prove exclusions.
