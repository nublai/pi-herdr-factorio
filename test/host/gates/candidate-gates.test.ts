import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
	chmodSync,
	cpSync,
	existsSync,
	globSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { checkCandidate, receiptPasses } from "../../../host/gates/gates.ts";
import {
	exportTree,
	heldoutDigest,
	materializeCandidate,
	materializeFromDirectories,
	replacementDigest,
	replacementsOf,
} from "../../../host/gates/materialize.ts";
import { runDraftBase, runHeldoutBase } from "../../../host/gates/base.ts";
import {
	manifestOf,
	validateDependencies,
} from "../../../host/gates/manifest.ts";
import { type GateRunner } from "../../../host/gates/runner.ts";
import {
	assessBase,
	classifyFailure,
} from "../../../src/candidate/diagnosis.ts";
import { isGitSha } from "../../../src/config/schema.ts";
import {
	blocksReview,
	candidateReviewPrompt,
	type JudgmentOutcome,
	replacementScenarios,
	scenarioJudgments,
	SECOND_JUDGE,
} from "../../../src/candidate/review.ts";
import { trustedVisiblePlan } from "../../../src/candidate/build.ts";
import { writeAcceptance } from "../../../src/contract/acceptance.ts";
import {
	declaresTest,
	parseSpecifyOutput,
} from "../../../src/contract/parse.ts";
import {
	contractBytes,
	contractDigestOf,
	type Contract,
	type ReplacedTest,
} from "../../../src/contract/contract.ts";
import { objectOf, parseJson } from "../../../src/core/json.ts";
import { digestOf } from "../../../src/core/run.ts";
import { isRepoSlug } from "../../../src/trust/platform.ts";
import { passingVerdict } from "../../helpers.ts";

function gitSha(text: string) {
	assert.ok(isGitSha(text));

	return text;
}

function repo(t: { after(fn: () => void): void }) {
	const root = mkdtempSync(join(tmpdir(), "factory-gates-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));

	const git = (...args: string[]) =>
		execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();

	git("init", "-q");
	git("config", "user.name", "Gate test");
	git("config", "user.email", "gate@example.invalid");

	const put = (path: string, text: string) => {
		mkdirSync(dirname(join(root, path)), { recursive: true });
		writeFileSync(join(root, path), text);
	};

	put("package.json", '{"name":"mini","version":"1.0.0","type":"module"}');
	put(
		"package-lock.json",
		'{"name":"mini","version":"1.0.0","lockfileVersion":3,"packages":{"":{"name":"mini","version":"1.0.0"}}}',
	);
	put("src/value.ts", 'export const value = "main";\n');
	put(
		"test/src/example/value.test.ts",
		'import assert from "node:assert/strict"; import {test} from "node:test"; import {value} from "../../../src/value.ts"; test("value",()=>assert.equal(value,"main"));\n',
	);
	put(
		".github/factory/gates/gates.json",
		JSON.stringify({
			version: 1,
			checks: [
				{ name: "typecheck", argv: ["node", "-e", "0"] },
				{ name: "lint", argv: ["node", "-e", "0"] },
				{ name: "format", argv: ["node", "-e", "0"] },
				{ name: "layout", argv: ["node", "-e", "0"] },
				{ name: "decisions", argv: ["node", "-e", "0"] },
			],
			testGlobs: ["test/src/**/*.test.ts"],
		}),
	);
	put(
		".github/factory/gates/freeze.mjs",
		readFileSync(".github/factory/gates/freeze.mjs", "utf8"),
	);
	put(
		".github/factory/gates/reporter.mjs",
		readFileSync(".github/factory/gates/reporter.mjs", "utf8"),
	);
	put(".github/factory/gates/biome.json", "{}");
	put(
		".github/factory/gates/scan-rules.json",
		readFileSync(".github/factory/gates/scan-rules.json", "utf8"),
	);
	put(".oxlintrc.json", "{}");
	git("add", ".");
	git("commit", "-qm", "main");
	const gateSha = git("rev-parse", "HEAD");

	return {
		root,
		git,
		put,
		gateSha,
		commit: () => {
			git("add", "-A");
			git("commit", "-qm", "candidate");

			return git("rev-parse", "HEAD");
		},
	};
}

const miniRunner: GateRunner = {
	kind: "test-process",
	async run(input) {
		const args = input.argv.map((a) =>
			a
				.replaceAll("/g/", `${input.gates}/`)
				.replaceAll("/w/", `${input.tree}/`),
		);

		try {
			return {
				exitCode: 0,
				stdout: execFileSync(args[0] ?? "node", args.slice(1), {
					cwd: input.tree,
					encoding: "utf8",
					env: { PATH: process.env.PATH, HOME: "/tmp" },
					timeout: 10000,
				}),
				stderr: "",
			};
		} catch (e) {
			assert.ok(e instanceof Error);

			return { exitCode: 1, stdout: "", stderr: e.message };
		}
	},
};

test("merged tree routes imports to candidate source and preserves every unnamed main test and config", async (t) => {
	const f = repo(t);
	f.put("src/value.ts", 'export const value = "candidate";\n');
	f.put(".gitattributes", "src/value.ts export-ignore\n");
	f.put("test/src/example/value.test.ts", "deleted regression\n");
	f.put("test/new.test.ts", "new\n");
	f.put("src/biome.json", "{}");
	f.put("tsconfig.json", "weak\n");
	const sha = f.commit();
	const dest = join(f.root, "out");

	const result = await materializeCandidate({
		repository: f.root,
		gateSha: f.gateSha,
		candidateSha: sha,
		dest,
		replacements: [],
	});

	assert.match(readFileSync(join(dest, "src/value.ts"), "utf8"), /candidate/);
	assert.match(
		readFileSync(join(dest, "test/src/example/value.test.ts"), "utf8"),
		/assert.equal/,
	);
	assert.equal(readFileSync(join(dest, "test/new.test.ts"), "utf8"), "new\n");
	assert.ok(result.ignoredChanges.includes("src/biome.json"));
	assert.equal(existsSync(join(dest, "src/biome.json")), false);
});

test("merged tree takes candidate documentation outside .github while main keeps its workflow docs", async (t) => {
	const f = repo(t);
	f.put("docs/guide.md", "main guide\n");
	f.put("docs/old.md", "old\n");
	f.put(".github/notes.md", "main notes\n");
	const gateSha = f.commit();

	f.put("docs/guide.md", "candidate guide\n");
	f.put("docs/new.md", "new\n");
	f.put("README.md", "candidate readme\n");
	f.put(".github/notes.md", "candidate notes\n");
	rmSync(join(f.root, "docs/old.md"));
	const sha = f.commit();
	const dest = join(f.root, "out");

	const result = await materializeCandidate({
		repository: f.root,
		gateSha,
		candidateSha: sha,
		dest,
		replacements: [],
	});

	assert.equal(
		readFileSync(join(dest, "docs/guide.md"), "utf8"),
		"candidate guide\n",
	);

	assert.equal(readFileSync(join(dest, "docs/new.md"), "utf8"), "new\n");
	assert.equal(
		readFileSync(join(dest, "README.md"), "utf8"),
		"candidate readme\n",
	);
	assert.equal(existsSync(join(dest, "docs/old.md")), false);

	assert.equal(
		readFileSync(join(dest, ".github/notes.md"), "utf8"),
		"main notes\n",
	);

	assert.deepEqual(result.ignoredChanges, [".github/notes.md"]);
});

test("merged tree takes candidate scripts but still drops nested config inside them", async (t) => {
	const f = repo(t);
	f.put("scripts/x.sh", "main x\n");
	f.put("scripts/y.sh", "main y\n");
	const gateSha = f.commit();

	f.put("scripts/x.sh", "candidate x\n");
	f.put("scripts/biome.json", "{}");
	rmSync(join(f.root, "scripts/y.sh"));
	const sha = f.commit();
	const dest = join(f.root, "out");

	const result = await materializeCandidate({
		repository: f.root,
		gateSha,
		candidateSha: sha,
		dest,
		replacements: [],
	});

	assert.equal(
		readFileSync(join(dest, "scripts/x.sh"), "utf8"),
		"candidate x\n",
	);
	assert.equal(existsSync(join(dest, "scripts/y.sh")), false);
	assert.equal(existsSync(join(dest, "scripts/biome.json")), false);
	assert.deepEqual(result.ignoredChanges, ["scripts/biome.json"]);
});

test("merged tree takes maintained skills and formal TypeScript, never private Pi state or acceptance", async (t) => {
	const f = repo(t);
	const probe = ".pi/skills/verify-factory/probes/p/probe.ts";
	f.put(probe, "main probe\n");
	f.put(".pi/skills/verify-factory/probes/p/README.md", "main readme\n");
	f.put(".pi/skills/verify-factory/scripts/gone.ts", "main\n");
	f.put("docs/models/journey/view.ts", "main view\n");
	f.put("docs/models/journey/Journey.tla", "main model\n");
	f.put("test/acceptance/1/checks/a.test.ts", "main acceptance\n");
	const gateSha = f.commit();

	f.put(probe, "candidate probe\n");
	f.put(".pi/skills/verify-factory/probes/p/README.md", "candidate readme\n");
	rmSync(join(f.root, ".pi/skills/verify-factory/scripts/gone.ts"));
	f.put(".pi/skills/verify-factory/biome.json", "{}");
	f.put("docs/models/journey/view.ts", "candidate view\n");
	f.put(".pi/daily-log/2026-11-12.md", "private log\n");
	f.put(".pi/loops/loop.json", "{}");
	f.put(".pi/sessions/s.jsonl", "{}\n");
	const sha = f.commit();
	const dest = join(f.root, "out");

	const result = await materializeCandidate({
		repository: f.root,
		gateSha,
		candidateSha: sha,
		dest,
		replacements: [],
	});

	assert.equal(readFileSync(join(dest, probe), "utf8"), "candidate probe\n");

	assert.equal(
		readFileSync(
			join(dest, ".pi/skills/verify-factory/probes/p/README.md"),
			"utf8",
		),
		"candidate readme\n",
	);

	assert.equal(
		readFileSync(join(dest, "docs/models/journey/view.ts"), "utf8"),
		"candidate view\n",
	);

	assert.equal(
		readFileSync(join(dest, "docs/models/journey/Journey.tla"), "utf8"),
		"main model\n",
	);

	for (const path of [
		".pi/skills/verify-factory/scripts/gone.ts",
		".pi/skills/verify-factory/biome.json",
		".pi/daily-log",
		".pi/loops",
		".pi/sessions",
	])
		assert.equal(existsSync(join(dest, path)), false, path);

	assert.deepEqual(result.newTests, []);

	assert.deepEqual(result.ignoredChanges, [
		".pi/daily-log/2026-11-12.md",
		".pi/loops/loop.json",
		".pi/sessions/s.jsonl",
		".pi/skills/verify-factory/biome.json",
	]);
});

for (const path of [
	"docs/decisions.tsv",
	"scripts/decisions-checkpoint.json",
]) {
	for (const change of ["add", "edit", "delete", "mode"]) {
		test(`gate refuses coordinator-only ${path} ${change}`, {
			timeout: 30_000,
		}, async (t) => {
			const f = repo(t);

			if (change !== "add") f.put(path, "main\n");
			const gateSha = change === "add" ? f.gateSha : f.commit();

			if (change === "delete") rmSync(join(f.root, path));
			else if (change === "mode") chmodSync(join(f.root, path), 0o755);
			else f.put(path, "malformed\trow\n");
			const candidateSha = f.commit();

			const receipt = await checkCandidate({
				repository: f.root,
				gateSha,
				candidateSha,
				nonce: "protected",
				output: join(f.root, "result"),
				runner: miniRunner,
				install: false,
			});

			assert.equal(receipt.status, "failed");
			assert.equal(receipt.reason, "protected_path_changed");
			assert.equal(receipt.checks.length, 0);
		});
	}
}

test("gate refuses a valid decisions append with an advanced checkpoint", {
	timeout: 30_000,
}, async (t) => {
	const f = repo(t);
	const file = "docs/decisions.tsv";
	const header = "ts\tphase\tdecision\twhy\tevidence\tresult\n";
	f.put(file, header);

	const checkpoint = (text: string) =>
		JSON.stringify({
			file,
			rows: text.split("\n").length - 2,
			bytes: Buffer.byteLength(text),
			sha256: digestOf(text),
		});

	f.put("scripts/decisions-checkpoint.json", checkpoint(header));
	const gateSha = f.commit();
	const text = `${header}2026-11-15T00:00:00Z\tphase\tdecision\twhy\tevidence\tresult\n`;
	f.put(file, text);
	f.put("scripts/decisions-checkpoint.json", checkpoint(text));

	const receipt = await checkCandidate({
		repository: f.root,
		gateSha,
		candidateSha: f.commit(),
		nonce: "protected",
		output: join(f.root, "result"),
		runner: miniRunner,
		install: false,
	});

	assert.equal(receipt.status, "failed");
	assert.equal(receipt.reason, "protected_path_changed");
});

test("a candidate defect cannot pass preserved regression tests; receipts bind both SHAs", async (t) => {
	const f = repo(t);
	f.put("src/value.ts", 'export const value = "wrong";\n');
	f.put("test/src/example/value.test.ts", "// no test\n");
	const candidateSha = f.commit();

	const receipt = await checkCandidate({
		repository: f.root,
		gateSha: f.gateSha,
		candidateSha,
		nonce: "unit",
		output: join(f.root, "result"),
		runner: miniRunner,
		install: false,
	});

	assert.deepEqual(
		objectOf(
			parseJson(readFileSync(join(f.root, "result", "receipt.json"), "utf8")),
		)?.testGlobs,
		["test/src/**/*.test.ts"],
	);
	assert.equal(receipt.gateSha, f.gateSha);
	assert.equal(receipt.candidateSha, candidateSha);
	assert.equal(receipt.status, "failed");
	assert.equal(
		receipt.checks.find((c) => c.name === "main_tests")?.exitCode,
		1,
	);
});

test("contract replacement is exact, digest checked, and new tests still veto", async (t) => {
	const f = repo(t);
	f.put("src/value.ts", 'export const value = "changed";\n');
	f.put(
		"test/src/example/value.test.ts",
		'import assert from "node:assert/strict"; import {test} from "node:test"; import {value} from "../../../src/value.ts"; test("changed",()=>assert.equal(value,"changed"));\n',
	);
	const candidateSha = f.commit();

	const replacements = [
		{
			path: "test/src/example/value.test.ts",
			reason: "Intentional behavior change",
		},
	];

	const receipt = await checkCandidate({
		repository: f.root,
		gateSha: f.gateSha,
		candidateSha,
		nonce: "unit",
		output: join(f.root, "result"),
		runner: miniRunner,
		install: false,
		replacements,
		replacementsDigest: replacementDigest(replacements),
	});

	assert.equal(receipt.status, "passed");
	assert.deepEqual(
		receipt.replacedTests.map(({ path, reason }) => ({ path, reason })),
		replacements,
	);
	f.put(
		"test/new.cases.ts",
		'import {test} from "node:test"; test("new failure",()=>{throw new Error("FAIL");});\n',
	);

	const failing = await checkCandidate({
		repository: f.root,
		gateSha: f.gateSha,
		candidateSha: f.commit(),
		nonce: "unit",
		output: join(f.root, "new-result"),
		runner: miniRunner,
		install: false,
		replacements,
		replacementsDigest: replacementDigest(replacements),
	});

	assert.equal(failing.status, "failed");
	assert.equal(
		failing.checks.find((c) => c.name === "candidate_tests")?.exitCode,
		1,
	);
});

test("dependency validation rejects non-registry locations, missing integrity and unbounded manifests", () => {
	const manifest = {
		name: "mini",
		version: "1",
		dependencies: { pkg: "1.0.0" },
	};

	const lock = {
		lockfileVersion: 3,
		packages: {
			"": manifest,
			"node_modules/pkg": {
				version: "1.0.0",
				resolved: "https://registry.npmjs.org/pkg/-/pkg-1.0.0.tgz",
				integrity: `sha512-${Buffer.alloc(64).toString("base64")}`,
			},
		},
	};

	assert.equal(
		validateDependencies(JSON.stringify(manifest), JSON.stringify(lock)).length,
		1,
	);

	for (const resolved of [
		"git+https://github.com/evil/x",
		"file:../x",
		"https://evil.invalid/x",
		"https://evil.invalid/pkg/-/pkg-1.0.0.tgz",
		"https://registry.npmjs.org@evil.invalid/x",
	]) {
		assert.throws(
			() =>
				validateDependencies(
					JSON.stringify(manifest),
					JSON.stringify({
						...lock,
						packages: {
							...lock.packages,
							"node_modules/pkg": {
								...lock.packages["node_modules/pkg"],
								resolved,
							},
						},
					}),
				),
			/dependency/,
		);
	}
});

for (const cheat of [
	"assert",
	"exit",
	"reallyExit",
	"exitHook",
	"skip",
	"todo",
	"only",
]) {
	test(`rejects test-process cheat ${cheat} without trusting stdout`, async (t) => {
		const f = repo(t);

		const bodies = new Map(
			Object.entries({
				assert:
					'import assert from "node:assert/strict"; assert.equal = () => {};',
				exit: "process.exit(0);",
				reallyExit: "process.reallyExit(0);",
				exitHook:
					'process.on("exit",()=>{process.exitCode=0;}); test("bad",()=>{throw new Error("fail");});',
				skip: 'test.skip("skip",()=>{});',
				todo: 'test.todo("todo");',
				only: 'test.only("only",()=>{});',
			}),
		);

		f.put(
			"test/cheat.test.ts",
			`import {test} from "node:test"; ${bodies.get(cheat)}\n`,
		);

		const receipt = await checkCandidate({
			repository: f.root,
			gateSha: f.gateSha,
			candidateSha: f.commit(),
			nonce: "unit",
			output: join(f.root, "result"),
			runner: miniRunner,
			install: false,
		});

		assert.equal(receipt.status, "failed");

		if (receipt.reason !== "runtime_patching")
			assert.equal(
				receipt.checks.find((c) => c.name === "candidate_tests")?.exitCode,
				1,
			);
	});
}

for (const [name, body, bad] of [
	[
		"ordinary prose diagnostics",
		'test("prose", (t) => t.diagnostic("Require a receipt only if the criterion explicitly requires that execution."));',
		false,
	],
	["Node's test-only warning", 'test.only("focused", () => {});', true],
] as const) {
	test(`trusted reporter handles ${name}`, (t) => {
		const f = repo(t);
		f.put(
			"test/diagnostic.test.ts",
			`import {test} from "node:test"; ${body}\n`,
		);

		const output = execFileSync(
			process.execPath,
			[
				"--import",
				"./.github/factory/gates/freeze.mjs",
				"--test",
				"--test-reporter",
				"./.github/factory/gates/reporter.mjs",
				"test/diagnostic.test.ts",
			],
			{
				cwd: f.root,
				encoding: "utf8",
				env: { PATH: process.env.PATH, HOME: "/tmp" },
			},
		);

		const result = JSON.parse(output);

		assert.equal(result.complete, true);
		assert.deepEqual(result.failures, []);
		assert.deepEqual(Object.values(result.counts), [1]);
		assert.equal(result.bad, bad);
	});
}

function gateInput(f: ReturnType<typeof repo>, candidateSha: string) {
	return {
		repository: f.root,
		gateSha: f.gateSha,
		candidateSha,
		nonce: "unit",
		output: join(f.root, "result"),
		runner: miniRunner,
		install: false,
	};
}

test("preload pins the reporting methods without freezing crypto internals", () => {
	const program = `import assert from "node:assert/strict";
import {Readable} from "node:stream";
import {Serializer,DefaultSerializer} from "node:v8";
import {createCipheriv,createHash} from "node:crypto";
for (const [target,keys] of [[Readable.prototype,["push","read"]],[Serializer.prototype,["writeHeader","writeValue","writeRawBytes","releaseBuffer"]],[DefaultSerializer.prototype,["writeHeader","writeValue","writeRawBytes","releaseBuffer"]],[process.stdout,["write","_write"]]]) for (const key of keys) {
const d=Object.getOwnPropertyDescriptor(target,key); assert.equal(d.writable,false); assert.equal(d.configurable,false);
assert.throws(()=>{target[key]=()=>{};});
}
createCipheriv("aes-256-gcm",Buffer.alloc(32),Buffer.alloc(12)).update("works");
const hash=createHash("sha256"); hash.end("works"); assert.equal(hash.read().toString("hex"),"93f6e11d9ce3e407e0eef9c87aacabf3f31235a92403845bb5093b4c6f01f2e5");
const cipher=createCipheriv("aes-256-gcm",Buffer.alloc(32),Buffer.alloc(12)); cipher.end("works"); assert.equal(cipher.read().length,5);`;

	execFileSync(process.execPath, [
		"--import",
		new URL("../../../.github/factory/gates/freeze.mjs", import.meta.url)
			.pathname,
		"--input-type=module",
		"-e",
		program,
	]);
});

test("visible suite excludes heavy integration tests without losing CI or gate coverage", () => {
	const root = existsSync("/g/tooling/.github/factory/gates/gates.json")
		? "/g/tooling"
		: ".";

	const manifest = JSON.parse(
		readFileSync(join(root, ".github/factory/gates/gates.json"), "utf8"),
	);

	assert.deepEqual(manifest.testGlobs, [
		"test/src/**/*.test.ts",
		"test/host/**/*.test.ts",
		"test/integration/*.test.ts",
	]);
	const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
	assert.equal(
		pkg.scripts.test,
		`node --experimental-strip-types --test --test-concurrency=2 ${manifest.testGlobs
			.slice(0, 2)
			.map((pattern: string) => JSON.stringify(pattern))
			.join(" ")}`,
	);

	for (const pattern of manifest.testGlobs)
		assert.ok(globSync(pattern, { cwd: root }).length > 0);

	const covered = new Set<string>(
		manifest.testGlobs.flatMap((pattern: string) =>
			globSync(pattern, { cwd: root }),
		),
	);

	assert.deepEqual(
		globSync("test/**/*.{test,cases}.ts", { cwd: root }).filter(
			(path) => !path.startsWith("test/acceptance/") && !covered.has(path),
		),
		[],
		"Every test file outside the separately dispatched held-out suite must match a trusted test glob",
	);

	const visible = manifest.testGlobs
		.slice(0, 2)
		.flatMap((pattern: string) => globSync(pattern, { cwd: root }));

	assert.ok(
		!visible.some((path: string) => path.endsWith("replay-driver.test.ts")),
	);
	const integration = globSync("test/integration/*.test.ts", { cwd: root });
	assert.ok(integration.includes("test/integration/replay-driver.test.ts"));
	assert.equal(
		pkg.scripts["test:integration"],
		"node --experimental-strip-types --test --test-concurrency=1 test/integration/*.test.ts",
	);
	assert.match(pkg.scripts.check, /npm test && npm run test:integration$/);
	assert.match(
		readFileSync(join(root, ".github/workflows/check.yml"), "utf8"),
		/run: npm run check/,
	);
	assert.match(
		readFileSync(join(root, ".github/workflows/ci.yml"), "utf8"),
		/node --experimental-strip-types host\/cli\/index\.ts gates/,
	);
});

test("npm visible discovery runs nested src and host tests exactly once and excludes acceptance", (t) => {
	const f = repo(t);
	const root = existsSync("/g/tooling/package.json") ? "/g/tooling" : ".";
	const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
	f.put(
		"package.json",
		JSON.stringify({
			type: "module",
			scripts: {
				test: pkg.scripts.test.replace(
					"--test ",
					"--test --test-reporter=tap ",
				),
			},
		}),
	);

	for (const domain of ["src", "host"])
		f.put(
			`test/${domain}/example/nested/discovery.test.ts`,
			`import {test} from "node:test"; test("nested ${domain}",()=>{throw new Error("NESTED_${domain}");});`,
		);
	f.put(
		"test/acceptance/frozen/checks/held.test.ts",
		'throw new Error("HELD_OUT_LEAK");',
	);

	const result = spawnSync("npm", ["test"], {
		cwd: f.root,
		encoding: "utf8",
		env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: tmpdir() },
	});

	assert.equal(result.status, 1, result.stderr);
	assert.equal(
		(result.stdout.match(/not ok \d+ - nested src/g) ?? []).length,
		1,
	);
	assert.equal(
		(result.stdout.match(/not ok \d+ - nested host/g) ?? []).length,
		1,
	);
	assert.doesNotMatch(result.stdout + result.stderr, /HELD_OUT_LEAK/);
});

test("trusted lint and format check the roots npm run check does, without checking held-out acceptance", () => {
	const root = existsSync("/g/tooling/.github/factory/gates/gates.json")
		? "/g/tooling"
		: ".";

	const manifest = JSON.parse(
		readFileSync(join(root, ".github/factory/gates/gates.json"), "utf8"),
	);

	const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

	const argv = (name: string): string[] =>
		manifest.checks.find((c: { name: string }) => c.name === name).argv;

	const roots = (script: string, tool: string) =>
		script
			.slice(script.indexOf(tool) + tool.length)
			.trim()
			.split(/\s+/);

	const lintRoots = roots(pkg.scripts.lint, "oxlint");
	assert.ok(lintRoots.includes(".pi/skills"));
	assert.ok(lintRoots.includes("docs/models"));
	assert.deepEqual(argv("lint").slice(-lintRoots.length), lintRoots);

	assert.deepEqual(
		argv("lint").slice(
			argv("lint").indexOf("--ignore-pattern"),
			argv("lint").indexOf("--ignore-pattern") + 2,
		),
		["--ignore-pattern", "test/acceptance/**"],
	);

	const formatRoots = roots(pkg.scripts["format:check"], "biome format");
	assert.deepEqual(formatRoots, lintRoots);
	assert.deepEqual(argv("format").slice(-formatRoots.length), formatRoots);
	assert.deepEqual(
		manifest.checks.map((check: { name: string }) => check.name),
		["typecheck", "lint", "format", "layout", "decisions"],
	);

	for (const name of ["layout", "decisions"]) {
		const script = `scripts/check-${name}.mjs`;
		assert.match(
			pkg.scripts.check,
			new RegExp(`npm run check:${name}(?: &&|$)`),
		);
		assert.ok(pkg.scripts[`check:${name}`].endsWith(script));
		assert.deepEqual(argv(name), [
			"node",
			"--experimental-strip-types",
			`/g/tooling/${script}`,
			"--root",
			"/w",
		]);
	}
});

test("removes nested ignore files and candidate-deleted source", async (t) => {
	const f = repo(t);
	f.git("rm", "src/value.ts");

	for (const name of [".gitignore", ".eslintignore", ".prettierignore"])
		f.put(`src/${name}`, "bad.ts\n");
	const dest = join(f.root, "out");
	await materializeCandidate({
		...gateInput(f, f.commit()),
		dest,
		replacements: [],
	});

	for (const name of [
		"value.ts",
		".gitignore",
		".eslintignore",
		".prettierignore",
	])
		assert.equal(existsSync(join(dest, "src", name)), false);
});

test("npmrc edits are policy failures", async (t) => {
	const f = repo(t);
	f.put("src/.npmrc", "registry=https://evil.invalid\n");
	const r = await checkCandidate(gateInput(f, f.commit()));
	assert.equal(r.status, "failed");
	assert.equal(r.reason, "npmrc_changed");
});

test("per-file counts reject extra registrations, except named replacements", async (t) => {
	const f = repo(t);
	f.put(
		"src/value.ts",
		'import {test} from "node:test"; test("extra",()=>{}); export const value = "main";\n',
	);
	const r = await checkCandidate(gateInput(f, f.commit()));
	assert.equal(r.status, "failed");
	f.put("src/value.ts", 'export const value = "main";\n');
	f.put(
		"test/src/example/value.test.ts",
		'import {test} from "node:test"; test("one",()=>{}); test("two",()=>{});\n',
	);

	const replacements = [
		{ path: "test/src/example/value.test.ts", reason: "change count" },
	];

	const replaced = await checkCandidate({
		...gateInput(f, f.commit()),
		replacements,
		replacementsDigest: replacementDigest(replacements),
	});

	assert.equal(replaced.status, "passed");
	assert.match(JSON.stringify(replaced.replacedTests), /beforeDigest/);
	assert.match(JSON.stringify(replaced.replacedTests), /afterDigest/);
});

const PINNED =
	"waits through transient recovery reads after ready was removed, then finishes needs_info";

const RECOVERY_TESTS = "test/src/controller/orchestrator-specify.test.ts";

function recoveryTests(pinned: string, expected: string) {
	return `import assert from "node:assert/strict"; import {test} from "node:test"; import {onReadyRemoved} from "../../../src/recovery.ts";\ntest(${JSON.stringify(pinned)},()=>assert.equal(onReadyRemoved(true),${JSON.stringify(expected)}));\ntest("releases an idle run when ready is removed",()=>assert.equal(onReadyRemoved(false),"released"));\n`;
}

/** A base modelled on #789: a recovering run waits after ready is removed. */
function recoveryRepo(t: { after(fn: () => void): void }) {
	const f = repo(t);
	f.put(
		"src/recovery.ts",
		'export function onReadyRemoved(recovering: boolean) { return recovering ? "needs_info" : "released"; }\n',
	);
	f.put(RECOVERY_TESTS, recoveryTests(PINNED, "needs_info"));
	const gateSha = f.commit();

	return { ...f, gateSha };
}

/** The #789 change: a recovering run is released too, and the pinned test says so. */
function releaseOnLabelRemoval(f: ReturnType<typeof recoveryRepo>) {
	f.put(
		"src/recovery.ts",
		'export function onReadyRemoved(_recovering: boolean) { return "released"; }\n',
	);
	f.put(
		RECOVERY_TESTS,
		recoveryTests(
			"releases a recovering run after ready was removed, aborting its job",
			"released",
		),
	);

	return f.commit();
}

const RECOVERY_REPLACEMENT = {
	path: RECOVERY_TESTS,
	test: PINNED,
	reason: "#789 releases a recovering build when factory:ready is removed",
};

test("a contract naming a pinned test lets the build replace it and the gates accept it, binding the test name", async (t) => {
	const f = recoveryRepo(t);
	const replacements = [RECOVERY_REPLACEMENT];

	const r = await checkCandidate({
		...gateInput(f, releaseOnLabelRemoval(f)),
		replacements,
		replacementsDigest: replacementDigest(replacements),
	});

	assert.equal(r.status, "passed");
	assert.equal(r.replacementsDigest, replacementDigest(replacements));
	assert.deepEqual(
		r.replacedTests.map(({ path, test, reason }) => ({ path, test, reason })),
		replacements,
	);
	assert.equal(r.candidateCounts[RECOVERY_TESTS], 2);
	assert.deepEqual(r.ignoredChanges, []);
});

test("an unlisted change to a pinned test still fails: the gates run the base test", async (t) => {
	const f = recoveryRepo(t);
	const candidateSha = releaseOnLabelRemoval(f);

	for (const replacements of [
		[],
		[
			{
				path: "test/src/example/value.test.ts",
				test: "value",
				reason: "Another file",
			},
		],
	]) {
		const r = await checkCandidate({
			...gateInput(f, candidateSha),
			replacements,
			replacementsDigest: replacementDigest(replacements),
		});

		assert.equal(r.status, "failed");
		assert.equal(r.checks.find((c) => c.name === "main_tests")?.exitCode, 1);
		assert.deepEqual(r.ignoredChanges, [RECOVERY_TESTS]);
	}

	const renamed = [{ ...RECOVERY_REPLACEMENT, test: "another name" }];

	const tampered = await checkCandidate({
		...gateInput(f, candidateSha),
		replacements: [RECOVERY_REPLACEMENT],
		replacementsDigest: replacementDigest(renamed),
	});

	assert.equal(tampered.status, "incomplete");
});

test("the gate's replacement list carries an optional exact test name, one entry per test", () => {
	const item = { path: RECOVERY_TESTS, test: PINNED, reason: "Change" };

	const sibling = {
		...item,
		test: "releases an idle run when ready is removed",
	};

	assert.equal(
		JSON.stringify(replacementsOf(JSON.stringify([sibling, item]))),
		JSON.stringify([sibling, item]),
	);
	assert.equal(
		JSON.stringify(
			replacementsOf(
				'[{"reason":"Change","test":"t","path":"test/a.test.ts"}]',
			),
		),
		'[{"path":"test/a.test.ts","test":"t","reason":"Change"}]',
	);
	assert.equal(
		JSON.stringify(
			replacementsOf('[{"path":"test/a.test.ts","reason":"Legacy"}]'),
		),
		'[{"path":"test/a.test.ts","reason":"Legacy"}]',
	);

	for (const bad of [
		[item, item],
		[{ ...item, test: "" }],
		[{ ...item, test: "two\nlines" }],
		[{ ...item, test: "x".repeat(501) }],
		[{ ...item, test: 3 }],
		[{ ...item, line: 3 }],
	])
		assert.throws(
			() => replacementsOf(JSON.stringify(bad)),
			/invalid_replacements/,
			JSON.stringify(bad),
		);
});

test("#789 end to end: specify names the pinned needs_info test, the build replaces it, the gates pass it and both judges review it", async (t) => {
	const specified = parseSpecifyOutput(
		JSON.stringify({
			kind: "contract",
			summary:
				"Release a recovering round-0 build when factory:ready is removed",
			behavior: ["Removing factory:ready releases a recovering build"],
			exclusions: ["Closing the issue still releases as before"],
			acceptance: [
				{ kind: "new_behavior", text: "A recovering build is released" },
			],
			compatibility: [],
			limits: [],
			files: ["src/recovery.ts"],
			evidence: [],
			replacesTests: [RECOVERY_REPLACEMENT],
		}),
		new Set(["src/recovery.ts", RECOVERY_TESTS]),
	);

	assert.ok(specified.kind === "contract");
	assert.ok(declaresTest(readFileSync(RECOVERY_TESTS, "utf8"), PINNED));

	const repoSlug = "nublai/nubl-factory-fixture";
	assert.ok(isRepoSlug(repoSlug));

	const contract: Contract = {
		version: 2,
		runId: digestOf("789"),
		issue: 789,
		base: { repo: repoSlug, sha: gitSha("a".repeat(40)) },
		snapshot: {
			digest: digestOf("snapshot"),
			source: "unedited",
			eventId: "1",
			eventAt: "2026-11-15T00:00:00Z",
		},
		link: null,
		...specified.draft,
	};

	const dispatched = JSON.stringify(contract.replacesTests);
	const f = recoveryRepo(t);
	const candidateSha = releaseOnLabelRemoval(f);

	const gate = await checkCandidate({
		...gateInput(f, candidateSha),
		replacements: replacementsOf(dispatched),
		replacementsDigest: digestOf(dispatched),
	});

	assert.equal(gate.status, "passed");
	assert.equal(gate.replacedTests[0]?.test, PINNED);

	const scenarios = replacementScenarios(contract);
	assert.deepEqual(
		scenarios.map((s) => s.id),
		["T1"],
	);

	const diff = f.git("diff", f.gateSha, candidateSha);
	assert.ok(diff.includes(JSON.stringify(PINNED)));

	const prompt = candidateReviewPrompt({
		contract,
		diff,
		paths: ["src/recovery.ts", RECOVERY_TESTS],
		judges: scenarios,
		guidance: "",
		verdict: { ...passingVerdict(digestOf(diff)), unjudged: ["T1"] },
	});

	assert.ok(prompt.kind === "ready");
	assert.ok(prompt.prompt.includes('"scenario":"T1","criteria":[],"judge":'));
	assert.ok(
		prompt.prompt.includes(JSON.stringify(JSON.stringify(PINNED)).slice(1, -1)),
	);

	const review = (first: JudgmentOutcome, second: JudgmentOutcome) => ({
		seats: (
			["code-review", "security-review", "simplify", SECOND_JUDGE] as const
		).map((seat) => ({
			seat,
			findings: [],
			judgments:
				seat === "code-review" || seat === SECOND_JUDGE
					? [
							{
								scenario: "T1",
								outcome: seat === SECOND_JUDGE ? second : first,
								reason: "Replacement judged against #789",
							},
						]
					: [],
		})),
	});

	assert.equal(scenarioJudgments(review("pass", "pass"))[0]?.route, "pass");
	assert.equal(blocksReview(review("pass", "pass").seats), false);
	assert.equal(scenarioJudgments(review("pass", "fail"))[0]?.route, "fail");
	assert.equal(blocksReview(review("pass", "fail").seats), true);
});

test("a named replacement cannot silently delete a test", async (t) => {
	const f = repo(t);
	f.git("rm", "test/src/example/value.test.ts");

	const replacements = [
		{ path: "test/src/example/value.test.ts", reason: "change behavior" },
	];

	const r = await checkCandidate({
		...gateInput(f, f.commit()),
		replacements,
		replacementsDigest: replacementDigest(replacements),
	});

	assert.equal(r.status, "failed");
	assert.equal(r.reason, "replacement_deleted");
});

for (const source of [
	'import {Readable as R} from "node:stream"; R.prototype.push = () => true;',
	'import {DefaultSerializer} from "node:v8"; Object.defineProperty(DefaultSerializer.prototype,"writeValue",{value:()=>true});',
	'import * as a from "node:assert"; Reflect.set(a,"equal",()=>{});',
	'import Module from "node:module"; Module._load = () => {};',
	'import {register} from "node:module"; register("x");',
	'require.extensions[".ts"] = () => {};',
	'process.on("uncaughtException",()=>{});',
	'process.once("beforeExit",()=>{});',
	"process.exitCode = 0;",
	'module.register("x");',
	"Object.assign(process,{exitCode:0});",
	'const {Readable}=await import("node:stream"); Readable.prototype.push=()=>true;',
])
	test(`runtime patching rejected: ${source}`, async (t) => {
		const f = repo(t);
		f.put("src/patch.ts", source);
		const r = await checkCandidate(gateInput(f, f.commit()));
		assert.equal(r.status, "failed");
		assert.equal(r.reason, "runtime_patching");
		assert.match(JSON.stringify(r), /src\/patch.ts/);
	});

test("maintained probes pass the tamper scan when a candidate adds them", async (t) => {
	const f = repo(t);

	const probes = [
		".pi/skills/verify-factory/probes/acceptance-isolation/probe.ts",
		".pi/skills/verify-factory/probes/build-isolation/probe.ts",
		".pi/skills/verify-factory/probes/heldout-ci/repair-probe.ts",
	];

	for (const path of probes) f.put(path, readFileSync(path, "utf8"));

	const r = await checkCandidate(gateInput(f, f.commit()));
	assert.deepEqual(r.tamperSignals, []);
	assert.equal(r.status, "passed");
});

test("runtime patching in a maintained skill is still rejected", async (t) => {
	const f = repo(t);
	const path = ".pi/skills/verify-factory/probes/p/probe.ts";
	f.put(path, "process.exitCode = 1;\n");
	const r = await checkCandidate(gateInput(f, f.commit()));
	assert.equal(r.status, "failed");
	assert.equal(r.reason, "runtime_patching");
	assert.deepEqual(r.tamperSignals, [
		{ path, line: 1, rule: "runtime_patching" },
	]);
});

for (const directive of [
	"@ts-nocheck",
	"@ts-ignore",
	"@ts-expect-error",
	"oxlint-disable",
	"eslint-disable-next-line",
	"biome-ignore format: reason",
])
	test(`added suppression rejected: ${directive}`, async (t) => {
		const f = repo(t);
		f.put("src/new.ts", `// ${directive}\nexport const n = 1;\n`);
		const r = await checkCandidate(gateInput(f, f.commit()));
		assert.equal(r.status, "failed");
		assert.equal(r.reason, "suppression_added");
	});

test("unchanged main suppressions are not new candidate directives", async (t) => {
	const f = repo(t);
	f.put(
		"src/value.ts",
		'// @ts-expect-error existing main directive\nexport const value = "main";\n',
	);
	const gateSha = f.commit();
	f.put(
		"src/value.ts",
		'// @ts-expect-error existing main directive\nexport const value = "main";\nexport const another = true;\n',
	);
	assert.equal(
		(await checkCandidate({ ...gateInput(f, f.commit()), gateSha })).status,
		"passed",
	);
});

for (const [addition, reason] of [
	["// @ts-nocheck\n", "suppression_added"],
	["// @TS-NOCHECK\n", "suppression_added"],
	["// @Ts-NoCheck\n", "suppression_added"],
	[
		'import {Readable} from "node:stream"; Readable.prototype.push = () => true;\n',
		"runtime_patching",
	],
] as const)
	test(`changed lines in an existing file are scanned: ${reason}`, async (t) => {
		const f = repo(t);
		f.put("src/value.ts", addition + 'export const value = "main";\n');
		const r = await checkCandidate(gateInput(f, f.commit()));
		assert.equal(r.status, "failed");
		assert.equal(r.reason, reason);
		assert.deepEqual(r.tamperSignals, [
			{ path: "src/value.ts", line: 1, rule: reason },
		]);
	});

for (const bytes of [
	Buffer.from("// \0\n"),
	Buffer.from([47, 47, 32, 255, 10]),
])
	test(`source encoding refuses ${bytes.includes(0) ? "NUL" : "non-UTF-8"} bytes`, async (t) => {
		const f = repo(t);
		writeFileSync(
			join(f.root, "src/value.ts"),
			Buffer.concat([
				Buffer.from("// @ts-nocheck\n"),
				bytes,
				Buffer.from('export const value = "main";\n'),
			]),
		);
		const r = await checkCandidate(gateInput(f, f.commit()));
		assert.equal(r.status, "failed");
		assert.equal(r.reason, "invalid_source_encoding");
	});

for (const separator of ["\u2028", "\u2029", "\r"])
	test(`source encoding refuses line separator ${JSON.stringify(separator)}`, async (t) => {
		const f = repo(t);
		f.put(
			"src/value.ts",
			`export const sep = "${separator.repeat(3)}";\nprocess.on("exit", () => {});\nexport const value = "main";\n`,
		);
		const r = await checkCandidate(gateInput(f, f.commit()));
		assert.equal(r.status, "failed");
		assert.equal(r.reason, "invalid_source_encoding");
	});

test("an encoding rejection names each rejected file so diagnosis can tell whose it is (L3)", async (t) => {
	const f = repo(t);
	const path = "test/acceptance/123/checks/scenario.test.mjs";

	const text =
		'import {test} from "node:test";\ntest("held",()=>{});\n// \u2028\n';

	for (const candidate of [false, true]) {
		f.put(path, text);

		if (candidate) f.put("src/value.ts", 'export const value = "\u2028";\n');
		const candidateSha = f.commit();

		const r = await checkCandidate({
			...gateInput(f, candidateSha),
			heldoutDir: "test/acceptance/123",
			heldoutDigest: heldoutDigest([{ path, bytes: Buffer.from(text) }]),
		});

		assert.equal(r.status, "failed");
		assert.equal(r.reason, "invalid_source_encoding");
		assert.deepEqual(
			r.tamperSignals.map((s) => s.path).toSorted(),
			candidate ? ["src/value.ts", path] : [path],
		);
		assert.ok(
			r.tamperSignals.every((s) => s.rule === "invalid_source_encoding"),
		);

		const classified = classifyFailure({
			receipt: parseJson(JSON.stringify(r)) ?? undefined,
			identity: {
				gateSha: gitSha(f.gateSha),
				candidateSha: gitSha(candidateSha),
				nonce: "unit",
				heldoutDigest: heldoutDigest([{ path, bytes: Buffer.from(text) }]),
				replacementsDigest: replacementDigest([]),
			},
			expected: [path],
			scenarios: [{ scenario: "S1", kind: "new_behavior", file: path }],
			base: null,
			ignoredChanges: null,
			replay: null,
			dependencies: null,
			candidatePaths: candidate ? ["src/value.ts"] : [],
			baseRefusal: null,
		});

		assert.deepEqual(classified, {
			kind: "missing_evidence",
			reason: "incomplete_ci",
		});
		f.git("reset", "-q", "--hard", f.gateSha);
	}
});

test("source encoding permits CRLF line endings", async (t) => {
	const f = repo(t);
	f.put("src/value.ts", 'export const value = "main";\r\n');
	assert.equal(
		(await checkCandidate(gateInput(f, f.commit()))).status,
		"passed",
	);
});

test("unchanged acceptance files on main need no dispatch but modifications do", async (t) => {
	const f = repo(t);
	const path = "test/acceptance/123/checks/scenario.test.ts";
	const text = 'import {test} from "node:test"; test("published",()=>{});\n';
	f.put(path, text);
	const gateSha = f.commit();
	f.put(
		"src/value.ts",
		'export const value = "main";\nexport const extra = 1;\n',
	);
	const input = { ...gateInput(f, f.commit()), gateSha };
	assert.equal((await checkCandidate(input)).status, "passed");
	f.put(path, text + "// candidate edit\n");
	const changed = await checkCandidate({ ...input, candidateSha: f.commit() });
	assert.equal(changed.status, "failed");
	assert.equal(changed.reason, "unauthorized_acceptance");
});

for (const path of [
	"test/acceptance/stash/lint.ts",
	"test/acceptance/123/manifest.json",
	"test/acceptance/other/checks/suite.test.ts",
])
	test(`candidate acceptance files require dispatch authorization: ${path}`, async (t) => {
		const f = repo(t);
		f.put(path, "export const value = true;\n");
		const r = await checkCandidate(gateInput(f, f.commit()));
		assert.equal(r.status, "failed");
		assert.equal(r.reason, "unauthorized_acceptance");
	});

test("an empty describe cannot replace a contract-named test even when other files run", async (t) => {
	const f = repo(t);
	f.put(
		"test/src/example/other.test.ts",
		'import {test} from "node:test"; test("other",()=>{});\n',
	);
	const gateSha = f.commit();
	f.put(
		"test/src/example/value.test.ts",
		'import {describe} from "node:test"; describe("empty",()=>{});\n',
	);

	const replacements = [
		{ path: "test/src/example/value.test.ts", reason: "change behavior" },
	];

	const r = await checkCandidate({
		...gateInput(f, f.commit()),
		gateSha,
		replacements,
		replacementsDigest: replacementDigest(replacements),
	});

	assert.equal(r.status, "failed");
	assert.equal(r.candidateCounts["test/src/example/value.test.ts"], undefined);
	assert.equal(r.candidateCounts["test/src/example/other.test.ts"], 1);
	assert.equal(r.checks.find((c) => c.name === "main_tests")?.exitCode, 1);
});

test("dispatched held-out suppressions are exempt but runtime patching is not", async (t) => {
	const f = repo(t);
	const path = "test/acceptance/123/checks/scenario.test.ts";

	for (const patch of [false, true]) {
		const text =
			'import {test} from "node:test";\n// @ts-expect-error controller-authored suite\ntest("held",()=>{});\n' +
			(patch ? 'process.on("exit",()=>{});\n' : "");

		f.put(path, text);

		const input = {
			...gateInput(f, f.commit()),
			heldoutDir: "test/acceptance/123",
			heldoutDigest: heldoutDigest([{ path, bytes: Buffer.from(text) }]),
		};

		const r = await checkCandidate(input);
		assert.equal(r.status, patch ? "failed" : "passed");
		assert.equal(r.reason, patch ? "runtime_patching" : null);
		assert.ok(r.tamperSignals.every((s) => s.rule !== "suppression_added"));

		if (!patch) {
			f.put("test/acceptance/123/helper.ts", "export const n = 1;\n");

			const extra = await checkCandidate({
				...input,
				candidateSha: f.commit(),
			});

			assert.equal(extra.status, "failed");
			assert.equal(extra.reason, "unauthorized_acceptance");
			f.git("rm", "test/acceptance/123/helper.ts");
		}
	}
});

test("lockfile aliases pin their real package, and swaps are refused", () => {
	const manifest = { dependencies: { alias: "npm:real@^1" } };

	const entry = {
		name: "real",
		version: "1.0.0",
		resolved: "https://registry.npmjs.org/real/-/real-1.0.0.tgz",
		integrity: `sha512-${Buffer.alloc(64).toString("base64")}`,
	};

	const lock = {
		lockfileVersion: 3,
		packages: { "": manifest, "node_modules/alias": entry },
	};

	assert.equal(
		validateDependencies(JSON.stringify(manifest), JSON.stringify(lock)).length,
		1,
	);
	assert.throws(
		() =>
			validateDependencies(
				JSON.stringify(manifest),
				JSON.stringify({
					...lock,
					packages: {
						"": manifest,
						"node_modules/alias": {
							...entry,
							resolved: "https://registry.npmjs.org/wrong/-/wrong-1.0.0.tgz",
						},
					},
				}),
			),
		/package_swap/,
	);
});

test("an alias binds its entry name and declaring parent's dependency spec", () => {
	const entry = (name: string) => ({
		version: "1.0.0",
		resolved: `https://registry.npmjs.org/${name}/-/${name}-1.0.0.tgz`,
		integrity: `sha512-${Buffer.alloc(64).toString("base64")}`,
	});

	const parent = { ...entry("parent"), dependencies: { alias: "npm:real@^1" } };
	const alias = { ...entry("real"), name: "real" };
	const manifest = { dependencies: { parent: "1.0.0" } };

	const lock = {
		lockfileVersion: 3,
		packages: {
			"": manifest,
			"node_modules/parent": parent,
			"node_modules/alias": alias,
		},
	};

	type Packages = Record<
		string,
		| (ReturnType<typeof entry> & { name?: string })
		| typeof parent
		| typeof manifest
	>;

	const validate = (packages: Packages, trusted?: string) =>
		validateDependencies(
			JSON.stringify(manifest),
			JSON.stringify({ ...lock, packages }),
			trusted,
		);

	assert.equal(validate(lock.packages).length, 2);
	assert.throws(
		() =>
			validate({
				...lock.packages,
				"node_modules/alias": { ...alias, name: undefined },
			}),
		/package_swap/,
	);
	assert.throws(
		() =>
			validate({ ...lock.packages, "node_modules/parent": entry("parent") }),
		/package_swap/,
	);
	assert.equal(
		validate({
			"": manifest,
			"node_modules/parent": parent,
			"node_modules/parent/node_modules/alias": alias,
		}).length,
		2,
	);

	const trusted = JSON.stringify({
		...lock,
		packages: {
			...lock.packages,
			"node_modules/parent": { ...parent, dependencies: { alias: "1.0.0" } },
			"node_modules/alias": entry("alias"),
		},
	});

	assert.throws(() => validate(lock.packages, trusted), /package_swap/);
});

test("candidate-added tests pass without a manifest edit and join the next main baseline", async (t) => {
	const f = repo(t);

	const manifest = f.git(
		"show",
		`${f.gateSha}:.github/factory/gates/gates.json`,
	);

	f.put(
		"test/src/example/nested/new-thing.test.ts",
		'import {test} from "node:test"; test("new",()=>{});',
	);

	const sha = f.commit();
	assert.equal(
		f.git("show", `${sha}:.github/factory/gates/gates.json`),
		manifest,
	);
	const invocations: (readonly string[])[] = [];

	const runner: GateRunner = {
		kind: miniRunner.kind,
		run: (input) => {
			invocations.push(input.argv);

			return miniRunner.run(input);
		},
	};

	const candidate = await checkCandidate({ ...gateInput(f, sha), runner });
	assert.equal(candidate.status, "passed");
	assert.ok(
		invocations.some((argv) =>
			argv.includes("test/src/example/nested/new-thing.test.ts"),
		),
	);
	assert.deepEqual(Object.keys(candidate.baselineCounts), [
		"test/src/example/value.test.ts",
	]);
	assert.equal(
		candidate.checks.find((c) => c.name === "candidate_tests")?.exitCode,
		0,
	);
	const main = await checkCandidate({ ...gateInput(f, sha), gateSha: sha });
	assert.equal(main.status, "passed");
	assert.equal(
		main.baselineCounts["test/src/example/nested/new-thing.test.ts"],
		1,
	);
	assert.equal(
		main.candidateCounts["test/src/example/nested/new-thing.test.ts"],
		1,
	);
});

test("a failing nested candidate test vetoes through candidate_tests without a manifest edit", async (t) => {
	const f = repo(t);
	const path = "test/src/candidate/nested/regression.test.ts";
	f.put(
		path,
		'import {test} from "node:test"; test("nested regression",()=>{throw new Error("NESTED_REGRESSION");});',
	);
	const invocations: (readonly string[])[] = [];

	const runner: GateRunner = {
		kind: miniRunner.kind,
		run: (input) => {
			invocations.push(input.argv);

			return miniRunner.run(input);
		},
	};

	const receipt = await checkCandidate({
		...gateInput(f, f.commit()),
		runner,
	});

	assert.equal(receipt.status, "failed");
	assert.equal(
		receipt.checks.find((check) => check.name === "candidate_tests")?.exitCode,
		1,
	);
	assert.equal(invocations.filter((argv) => argv.includes(path)).length, 1);
	assert.equal(receipt.baselineCounts[path], undefined);
});

test("main integration suites run on the baseline and candidate even when the candidate deletes them", async (t) => {
	const f = repo(t);
	const path = ".github/factory/gates/gates.json";
	const manifest = JSON.parse(readFileSync(join(f.root, path), "utf8"));
	f.put(
		path,
		JSON.stringify({
			...manifest,
			testGlobs: ["test/src/**/*.test.ts", "test/integration/*.test.ts"],
		}),
	);
	f.put(
		"test/integration/driver.test.ts",
		'import {test} from "node:test"; test("driver scenario",()=>{});',
	);
	const gateSha = f.commit();
	f.git("rm", "test/integration/driver.test.ts");
	f.put(
		path,
		JSON.stringify({ ...manifest, testGlobs: ["candidate-controlled"] }),
	);
	const candidateSha = f.commit();
	const r = await checkCandidate({ ...gateInput(f, candidateSha), gateSha });
	assert.deepEqual(r.testGlobs, [
		"test/src/**/*.test.ts",
		"test/integration/*.test.ts",
	]);
	assert.equal(r.gateSha, gateSha);
	assert.equal(r.status, "passed");
	assert.equal(r.baselineCounts["test/integration/driver.test.ts"], 1);
	assert.equal(r.candidateCounts["test/integration/driver.test.ts"], 1);
	assert.ok(r.ignoredChanges.includes(".github/factory/gates/gates.json"));
});

test("new main sandbox cases are discovered through the main aggregator", async (t) => {
	const f = repo(t);
	const path = ".github/factory/gates/gates.json";
	const manifest = JSON.parse(readFileSync(join(f.root, path), "utf8"));
	f.put(
		path,
		JSON.stringify({
			...manifest,
			testGlobs: ["test/src/**/*.test.ts", "test/host/**/*.test.ts"],
		}),
	);
	f.put(
		"test/host/sandbox/new.test.ts",
		'import {test} from "node:test"; test("new main case",()=>{});',
	);
	f.put("test/host/sandbox/helper.ts", "export const fixture = true;");
	const gateSha = f.commit();
	const r = await checkCandidate({ ...gateInput(f, gateSha), gateSha });
	assert.equal(r.status, "passed");
	assert.equal(r.baselineCounts["test/host/sandbox/new.test.ts"], 1);
});

for (const [cases, reason] of [
	[[[]], "invalid_gate_manifest"],
	[
		[
			["test/src/example/value.test.ts"],
			["test/*.test.ts"],
			["test/sandbox/*.cases.ts"],
		],
		"invalid_gate_manifest",
	],
	[[["../*.test.ts"]], "invalid_gate_manifest"],
	[
		[["test/src/**/*.test.ts", "test/src/**/*.test.ts"]],
		"invalid_gate_manifest",
	],
	[[["test/host/**/*.test.ts"]], "missing_tests"],
] as const) {
	test(`invalid or empty main test globs fail closed: ${JSON.stringify(cases[0])}`, async (t) => {
		for (const testGlobs of cases) {
			const f = repo(t);
			const path = ".github/factory/gates/gates.json";
			const manifest = JSON.parse(readFileSync(join(f.root, path), "utf8"));
			f.put(path, JSON.stringify({ ...manifest, testGlobs }));
			const gateSha = f.commit();
			const r = await checkCandidate({ ...gateInput(f, gateSha), gateSha });
			assert.equal(r.status, "incomplete", JSON.stringify(testGlobs));
			assert.equal(r.reason, reason, JSON.stringify(testGlobs));
		}
	});
}

for (const name of ["layout", "decisions"]) {
	for (const mutation of ["missing", "duplicate"]) {
		test(`trusted manifest refuses ${mutation} ${name}`, async (t) => {
			const f = repo(t);
			const path = ".github/factory/gates/gates.json";
			const manifest = JSON.parse(readFileSync(join(f.root, path), "utf8"));
			manifest.checks =
				mutation === "missing"
					? manifest.checks.filter(
							(check: { name: string }) => check.name !== name,
						)
					: [
							...manifest.checks,
							manifest.checks.find(
								(check: { name: string }) => check.name === name,
							),
						];
			f.put(path, JSON.stringify(manifest));
			const gateSha = f.commit();

			const receipt = await checkCandidate({
				...gateInput(f, gateSha),
				gateSha,
			});

			assert.equal(receipt.status, "incomplete");
			assert.equal(receipt.reason, "missing_checks");
		});
	}

	test(`receipt cannot omit or fail ${name}`, async (t) => {
		const f = repo(t);
		const receipt = await checkCandidate(gateInput(f, f.gateSha));
		assert.equal(receipt.status, "passed");
		assert.equal(
			receiptPasses({
				...receipt,
				requiredChecks: receipt.requiredChecks.filter(
					(check) => check !== name,
				),
				checks: receipt.checks.filter((check) => check.name !== name),
			}),
			false,
		);
		assert.equal(
			receiptPasses({
				...receipt,
				checks: receipt.checks.map((check) =>
					check.name === name ? { ...check, exitCode: 1 } : check,
				),
			}),
			false,
		);
	});
}

test("Docker and runner infrastructure exits never blame a candidate", async (t) => {
	const f = repo(t);

	for (const code of [125, 126, 127]) {
		let calls = 0;

		const runner: GateRunner = {
			kind: "docker",
			run: async (input) =>
				++calls === 1
					? miniRunner.run(input)
					: { exitCode: code, stdout: "", stderr: "runner failed" },
		};

		const r = await checkCandidate({ ...gateInput(f, f.gateSha), runner });
		assert.equal(r.status, "incomplete");
		assert.equal(r.reason, "runner_error");
	}
});

test("heldout requires exact bytes, real tests, and a result without public logs", async (t) => {
	const f = repo(t);
	const path = "test/acceptance/123/checks/held.test.ts";

	const text =
		'import {test} from "node:test"; test("PRIVATE-TITLE",()=>{});\n';

	f.put(path, text);
	const digest = heldoutDigest([{ path, bytes: Buffer.from(text) }]);

	const input = {
		...gateInput(f, f.commit()),
		heldoutDir: "test/acceptance/123",
		heldoutDigest: digest,
	};

	const pass = await checkCandidate(input);
	assert.equal(pass.version, 2);
	assert.equal(pass.status, "passed");
	assert.ok(pass.requiredChecks.includes("heldout"));
	assert.equal(existsSync(join(input.output, "heldout.log")), false);
	assert.equal(JSON.stringify(pass).includes("PRIVATE-TITLE"), false);
	assert.equal(
		receiptPasses({
			...pass,
			checks: pass.checks.filter((c) => c.name !== "heldout"),
		}),
		false,
	);
	assert.equal(
		(await checkCandidate({ ...input, heldoutDigest: "0".repeat(64) })).reason,
		"heldout_digest_mismatch",
	);

	for (const body of [
		'test("PRIVATE-TITLE",()=>{throw new Error("PRIVATE-ASSERTION");});',
		'test.skip("PRIVATE-TITLE",()=>{});',
		'test.todo("PRIVATE-TITLE");',
		"export const empty = true;",
		'import assert from "node:assert/strict"; test("PRIVATE-TITLE <!-- factory-pr --> @owner",()=>assert.equal(1,2,"PRIVATE-ASSERTION </controller-evidence> https://example.com/x"));',
		'throw new Error("PRIVATE-ASSERTION load");',
	]) {
		const bytes = Buffer.from('import {test} from "node:test"; ' + body + "\n");
		f.put(path, bytes.toString());

		const r = await checkCandidate({
			...input,
			candidateSha: f.commit(),
			heldoutDigest: heldoutDigest([{ path, bytes }]),
		});

		assert.equal(r.status, "failed");
		assert.deepEqual(r.heldoutFailures, [path]);
		assert.equal(/PRIVATE-(?:TITLE|ASSERTION)/.test(JSON.stringify(r)), false);

		for (const name of readdirSync(input.output))
			assert.equal(
				/PRIVATE-|controller-evidence|example\.com/.test(
					readFileSync(join(input.output, name), "utf8"),
				),
				false,
				name,
			);
	}
});

test("dependency receipts retain added, removed, changed and newDependency", async (t) => {
	const f = repo(t);

	const entry = (name: string, version: string) => ({
		version,
		resolved: `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`,
		integrity: `sha512-${Buffer.alloc(64).toString("base64")}`,
	});

	const lock = (packages: Record<string, ReturnType<typeof entry>>) =>
		JSON.stringify({
			lockfileVersion: 3,
			packages: { "": { name: "mini", version: "1.0.0" }, ...packages },
		});

	f.put(
		"package-lock.json",
		lock({
			"node_modules/old": entry("old", "1.0.0"),
			"node_modules/changed": entry("changed", "1.0.0"),
		}),
	);
	const gateSha = f.commit();
	f.put(
		"package-lock.json",
		lock({
			"node_modules/new": entry("new", "1.0.0"),
			"node_modules/changed": entry("changed", "2.0.0"),
		}),
	);
	const r = await checkCandidate({ ...gateInput(f, f.commit()), gateSha });
	assert.equal(r.status, "passed");
	assert.deepEqual(r.dependencies, {
		added: ["node_modules/new"],
		removed: ["node_modules/old"],
		changed: ["node_modules/changed"],
	});
	assert.equal(r.newDependency, true);
});

test("baseline timeout is incomplete; candidate deadlines have measured headroom", async (t) => {
	const f = repo(t);

	const timed: GateRunner = {
		kind: "timeout",
		run: async () => ({
			exitCode: 1,
			stdout: "",
			stderr: "",
			signal: "SIGKILL",
			timedOut: true,
		}),
	};

	const r = await checkCandidate({ ...gateInput(f, f.gateSha), runner: timed });
	assert.equal(r.status, "incomplete");
	assert.equal(r.reason, "baseline_failed");

	const runner: GateRunner = {
		kind: "timing",
		run: async (input) => {
			assert.ok((input.deadlineMs ?? 0) >= 90000);

			return input.tree.endsWith("/baseline")
				? miniRunner.run(input)
				: {
						exitCode: 1,
						stdout: "",
						stderr: "",
						signal: "SIGKILL",
						timedOut: true,
					};
		},
	};

	const failed = await checkCandidate({ ...gateInput(f, f.gateSha), runner });
	assert.equal(failed.status, "failed");
	assert.ok(failed.checks.some((c) => c.timedOut));
	assert.ok(failed.requiredChecks.includes("main_tests_deadline_control"));
	let calls = 0;

	const slowMain: GateRunner = {
		kind: "slow-main",
		run: (input) => (++calls === 1 ? miniRunner.run(input) : timed.run(input)),
	};

	const incomplete = await checkCandidate({
		...gateInput(f, f.gateSha),
		runner: slowMain,
	});

	assert.equal(incomplete.status, "incomplete");
	assert.equal(incomplete.reason, "baseline_deadline");
});

test("main's baseline test run gets 360 seconds and candidates three times its measured time", async (t) => {
	const f = repo(t);
	const deadlines: { tree: string; tests: boolean; deadlineMs?: number }[] = [];

	const runner: GateRunner = {
		kind: "recording",
		run: (input) => {
			deadlines.push({
				tree: input.tree.endsWith("/baseline") ? "baseline" : "tree",
				tests: input.argv.includes("--test"),
				deadlineMs: input.deadlineMs,
			});

			return miniRunner.run(input);
		},
	};

	const result = await checkCandidate({ ...gateInput(f, f.gateSha), runner });
	const baseline = deadlines.find((d) => d.tree === "baseline" && d.tests);
	assert.equal(baseline?.deadlineMs, 360000);

	const measured =
		result.checks.find((c) => c.name === "baseline_tests")?.durationMs ?? -1;

	assert.ok(measured >= 0);
	const later = deadlines.slice(deadlines.indexOf(baseline) + 1);
	assert.ok(later.length > 0);

	for (const run of later)
		assert.equal(
			run.deadlineMs,
			Math.max(90000, measured * 3 + 30000),
			JSON.stringify(run),
		);
});

test("trusted test concurrency is step-specific and preserves baseline/main counts at concurrency 3", async (t) => {
	const f = repo(t);
	f.put(
		"test/src/example/slow.test.ts",
		'import {test} from "node:test"; test("slow",async()=>{await new Promise(r=>setTimeout(r,25));});',
	);
	f.put(
		"test/src/example/fast.test.ts",
		'import {test} from "node:test"; test("fast",()=>{}); test("also fast",()=>{});',
	);
	const gateSha = f.commit();
	f.put(
		"test/new.test.ts",
		'import {test} from "node:test"; test("new",()=>{});',
	);
	const path = "test/acceptance/123/checks/held.test.ts";
	const text = 'import {test} from "node:test"; test("held",()=>{});';
	f.put(path, text);
	const argv: (readonly string[])[] = [];

	const runner: GateRunner = {
		kind: "recording",
		run(input) {
			argv.push(input.argv);

			return miniRunner.run(input);
		},
	};

	const result = await checkCandidate({
		...gateInput(f, f.commit()),
		gateSha,
		runner,
		heldoutDir: "test/acceptance/123",
		heldoutDigest: heldoutDigest([{ path, bytes: Buffer.from(text) }]),
	});

	assert.equal(result.status, "passed");
	assert.deepEqual(result.baselineCounts, {
		"test/src/example/fast.test.ts": 2,
		"test/src/example/slow.test.ts": 1,
		"test/src/example/value.test.ts": 1,
	});
	assert.deepEqual(result.candidateCounts, result.baselineCounts);
	assert.deepEqual(result.requiredChecks, [
		"baseline_tests",
		"typecheck",
		"lint",
		"format",
		"layout",
		"decisions",
		"main_tests",
		"candidate_tests",
		"heldout",
	]);
	assert.deepEqual(
		result.checks.map((c) => c.name),
		result.requiredChecks,
	);
	assert.deepEqual(
		argv.map(
			(args) =>
				args.find((arg) => arg.startsWith("--test-concurrency=")) ?? null,
		),
		[
			"--test-concurrency=3",
			null,
			null,
			null,
			null,
			null,
			"--test-concurrency=3",
			"--test-concurrency=1",
			"--test-concurrency=1",
		],
	);
	const measured = result.checks[0]?.durationMs ?? -1;
	assert.equal(result.checks[0]?.deadlineMs, 360000);

	for (const check of result.checks.slice(1))
		assert.equal(check.deadlineMs, Math.max(90000, 3 * measured + 30000));
});

for (const step of ["main_tests", "candidate_tests", "heldout"]) {
	test(`test deadline control for ${step} reruns main at concurrency 3 with the same deadline`, async (t) => {
		const f = repo(t);
		f.put(
			"test/new.test.ts",
			'import {test} from "node:test"; test("new",()=>{});',
		);
		const path = "test/acceptance/123/checks/held.test.ts";
		const text = 'import {test} from "node:test"; test("held",()=>{});';
		f.put(path, text);

		const steps = [
			"baseline_tests",
			"typecheck",
			"lint",
			"format",
			"layout",
			"decisions",
			"main_tests",
			"candidate_tests",
			"heldout",
			`${step}_deadline_control`,
		];

		const calls: { argv: readonly string[]; deadlineMs?: number }[] = [];

		const runner: GateRunner = {
			kind: "recording-timeout",
			run(input) {
				calls.push(input);

				return steps[calls.length - 1] === step
					? Promise.resolve({
							exitCode: 1,
							stdout: "",
							stderr: "",
							timedOut: true,
							signal: "SIGKILL",
						})
					: miniRunner.run(input);
			},
		};

		const result = await checkCandidate({
			...gateInput(f, f.commit()),
			runner,
			heldoutDir: "test/acceptance/123",
			heldoutDigest: heldoutDigest([{ path, bytes: Buffer.from(text) }]),
		});

		assert.equal(result.status, "failed");
		assert.equal(result.reason, null);
		assert.deepEqual(result.requiredChecks, steps);
		assert.deepEqual(
			result.checks.map((c) => c.name),
			steps,
		);
		const control = calls.at(-1);
		assert.ok(control);
		assert.ok(control.argv.includes("--test-concurrency=3"));
		assert.ok(control.argv.includes("test/src/example/value.test.ts"));
		assert.equal(control.argv.includes("test/new.test.ts"), false);
		assert.equal(control.argv.includes(path), false);
		assert.equal(control.deadlineMs, calls[steps.indexOf(step)]?.deadlineMs);
	});
}

test("draft and held-out base checks keep both repetitions serial", async (t) => {
	const f = repo(t);
	const tree = join(f.root, "base");
	await exportTree(f.root, f.gateSha, tree);
	const slug = "owner/repo";
	assert.ok(isRepoSlug(slug));

	const contract: Contract = {
		version: 2,
		runId: digestOf("serial base"),
		issue: 123,
		base: { repo: slug, sha: gitSha(f.gateSha) },
		snapshot: {
			digest: digestOf("snapshot"),
			source: "unedited",
			eventId: "1",
			eventAt: "2026-11-02T00:00:00Z",
		},
		link: null,
		summary: "Preserve behavior",
		behavior: ["Preserve behavior"],
		exclusions: [],
		acceptance: [{ id: "A1", kind: "preservation", text: "Preserve behavior" }],
		compatibility: [],
		limits: [],
		files: [],
		evidence: [],
	};

	const parsed = writeAcceptance(
		JSON.stringify({
			version: 2,
			scenarios: [
				{ id: "S1", criteria: ["A1"], checks: ["held.test.mjs"], judge: null },
			],
			files: [
				{
					path: "held.test.mjs",
					type: "node:test",
					content: 'import {test} from "node:test"; test("held",()=>{});',
				},
			],
		}),
		contract,
		new Set(),
	);

	assert.equal(parsed.kind, "suite");
	const calls: (readonly string[])[] = [];

	const runner: GateRunner = {
		kind: "recording-base",
		run(input) {
			calls.push(input.argv);

			const argv = input.argv.map((arg) =>
				arg
					.replaceAll("/g/", `${input.gates}/`)
					.replaceAll("/d/", `${input.detailReporter}/`),
			);

			const result = spawnSync(argv[0] ?? "node", argv.slice(1), {
				cwd: input.tree,
				encoding: "utf8",
				env: { PATH: process.env.PATH, HOME: "/tmp" },
				timeout: 10000,
			});

			assert.equal(result.status, 0, result.stderr);

			return Promise.resolve({
				exitCode: result.status ?? 1,
				stdout: result.stdout,
				stderr: result.stderr,
			});
		},
	};

	const startedAt = Date.now();

	const input = {
		tree,
		cacheDir: join(f.root, "cache"),
		binding: {
			runId: contract.runId,
			repo: contract.base.repo,
			issue: 123,
			contractDigest: contractDigestOf(contractBytes(contract)),
			acceptanceDigest: digestOf("suite"),
			baseSha: contract.base.sha,
			gateSha: contract.base.sha,
		},
		contract,
		suite: parsed.suite,
		canary: `factory-holdout-${"0".repeat(64)}`,
		startedAt,
		deadline: startedAt + 10000,
		runner,
	};

	const base = await runHeldoutBase({
		...input,
		workDir: join(f.root, "base-work"),
	});

	const draft = await runDraftBase({
		...input,
		workDir: join(f.root, "draft-work"),
	});

	assert.equal(assessBase(base).assessment.kind, "ready", JSON.stringify(base));
	assert.equal(
		assessBase(draft.evidence).assessment.kind,
		"ready",
		JSON.stringify(draft),
	);
	assert.equal(calls.length, 4);

	for (const argv of calls) assert.ok(argv.includes("--test-concurrency=1"));
});

test("bad manifests, stale bases, missing checks and tampered replacement digests fail incomplete", async (t) => {
	const f = repo(t);
	f.put("src/value.ts", "export const value=1;\n");
	const candidateSha = f.commit();

	const input = {
		repository: f.root,
		gateSha: f.gateSha,
		candidateSha,
		nonce: "unit",
		output: join(f.root, "result"),
		runner: miniRunner,
		install: false,
	};

	assert.equal(
		(
			await checkCandidate({
				...input,
				replacements: [
					{ path: "test/src/example/value.test.ts", reason: "change" },
				],
				replacementsDigest: "0".repeat(64),
			})
		).status,
		"incomplete",
	);
	assert.equal(
		(
			await checkCandidate({
				...input,
				gateSha: candidateSha,
				candidateSha: f.gateSha,
			})
		).reason,
		"stale_base",
	);

	const empty: GateRunner = {
		kind: "empty",
		run: async () => ({ exitCode: 0, stdout: "{}", stderr: "" }),
	};

	assert.equal(
		(await checkCandidate({ ...input, runner: empty })).status,
		"incomplete",
	);
	f.put(
		".github/factory/gates/gates.json",
		JSON.stringify({
			version: 1,
			checks: [],
			testGlobs: ["test/src/**/*.test.ts"],
		}),
	);
	const bad = f.commit();
	assert.equal(
		(await checkCandidate({ ...input, gateSha: bad, candidateSha: bad }))
			.reason,
		"missing_checks",
	);
});

test("visible tests run an unlisted changed test from its base bytes as the gate does, and a listed or added test from the candidate (#807 review)", (t) => {
	const root = mkdtempSync(join(tmpdir(), "visible-gate-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));

	const put = (dir: string, path: string, text: string) => {
		mkdirSync(dirname(join(dir, path)), { recursive: true });
		writeFileSync(join(dir, path), text);
	};

	const pinned = (expected: string) =>
		`import assert from "node:assert/strict";\nimport { test } from "node:test";\nimport { value } from "../src/value.js";\ntest("pinned value", () => assert.equal(value, "${expected}"));\n`;

	const run = (cwd: string) =>
		spawnSync(
			process.execPath,
			["--test", "--test-timeout=30000", "test/*.test.js"],
			{
				cwd,
				encoding: "utf8",
				timeout: 30_000,
				env: { PATH: process.env.PATH ?? "" },
			},
		).status;

	const base = join(root, "base");
	put(
		base,
		"package.json",
		JSON.stringify({
			type: "module",
			scripts: { test: "node --test test/*.test.js" },
		}),
	);
	put(base, "src/value.js", 'export const value = "old";\n');
	put(base, "test/value.test.js", pinned("old"));
	put(
		base,
		".github/factory/gates/gates.json",
		readFileSync(".github/factory/gates/gates.json", "utf8"),
	);

	const listed: readonly ReplacedTest[] = [
		{
			path: "test/value.test.js",
			test: "pinned value",
			reason: "The ticket changes the value",
		},
	];

	for (const [label, replacements, exit] of [
		["unlisted", [], 1],
		["listed", listed, 0],
	] as const) {
		const candidate = join(root, label, "candidate");
		const gate = join(root, label, "gate");
		const visible = join(root, label, "visible");
		cpSync(base, candidate, { recursive: true });
		put(candidate, "src/value.js", 'export const value = "new";\n');
		put(candidate, "test/value.test.js", pinned("new"));
		put(candidate, "test/added.test.js", pinned("new"));

		const overlay = materializeFromDirectories({
			gateTree: base,
			candidateTree: candidate,
			dest: gate,
			replacements,
		});

		cpSync(candidate, visible, { recursive: true });
		trustedVisiblePlan(base, visible, "npm test", replacements);

		assert.deepEqual(
			overlay.ignoredChanges,
			exit === 1 ? ["test/value.test.js"] : [],
			label,
		);

		for (const path of ["test/value.test.js", "test/added.test.js"])
			assert.equal(
				readFileSync(join(visible, path), "utf8"),
				readFileSync(join(gate, path), "utf8"),
				`${label} ${path}`,
			);

		assert.equal(run(gate), exit, `${label} gate`);
		assert.equal(run(visible), exit, `${label} visible`);
	}
});

const GATE_POLICY = ".github/factory/gates/gates.json";

const AGENTS_ROOTS = [
	"pi-extension",
	"maestro",
	"plugins",
	"scripts",
	"skills",
	"tools",
	".pi/skills",
];

const AGENTS_GLOBS = [
	"test/test.ts",
	"test/*.test.ts",
	"test/*.test.js",
	"test/maestro/*.test.ts",
];

const AGENTS_TESTS = [
	"test/host.test.ts",
	"test/maestro/worker.test.ts",
	"test/plugin.test.js",
	"test/test.ts",
];

const AGENTS_TYPECHECKED = ["pi-extension", "maestro", "plugins", "scripts"];

const AGENTS_LINTED = ["pi-extension", "test", "maestro", "plugins", "scripts"];

function agentsPolicy() {
	return {
		version: 2,
		sourceRoots: AGENTS_ROOTS,
		testGlobs: AGENTS_GLOBS,
		checks: [
			{
				name: "typecheck",
				argv: [
					"node",
					"/g/tooling/node_modules/typescript/bin/tsc",
					"--noEmit",
					"-p",
					"/w/tsconfig.json",
				],
			},
			{
				name: "lint",
				argv: [
					"/g/tooling/node_modules/.bin/oxlint",
					"--disable-nested-config",
					"--ignore-path",
					"/dev/null",
					"--ignore-pattern",
					"test/acceptance/**",
					"-c",
					"/g/tooling/oxlint.config.ts",
					...AGENTS_LINTED,
				],
			},
			{
				name: "format",
				argv: [
					"/g/tooling/node_modules/.bin/biome",
					"format",
					"--config-path",
					"/w/biome.json",
					...AGENTS_LINTED,
				],
			},
		],
	};
}

function agentsRepo(t: { after(fn: () => void): void }) {
	const f = repo(t);
	f.git("rm", "-rq", "src", "test/src", ".oxlintrc.json");

	for (const root of AGENTS_ROOTS) {
		f.put(`${root}/value.ts`, 'export const value = "main";\n');
		f.put(`${root}/gone.ts`, "export const gone = true;\n");
	}

	for (const path of AGENTS_TESTS)
		f.put(
			path,
			'import { test } from "node:test";\ntest("preserved", () => {});\n',
		);
	f.put("test/integration/live.test.ts", 'throw new Error("NOT_UNIT");\n');
	f.put("test/benchmark.ts", 'throw new Error("NOT_UNIT");\n');
	f.put("test/acceptance/old/checks/a.test.ts", 'throw new Error("HELD");\n');
	f.put(
		"tools/oxlint/anti-slop/index.ts",
		`import { eslintCompatPlugin } from ${JSON.stringify(import.meta.resolve("@oxlint/plugins"))};
export default eslintCompatPlugin({
	meta: { name: "fixture" },
	rules: {
		"no-debugger": {
			meta: { schema: [], messages: { forbidden: "Debugger forbidden" } },
			create(context) {
				return { DebuggerStatement(node) { context.report({ node, messageId: "forbidden" }); } };
			},
		},
	},
});\n`,
	);
	f.put(
		"oxlint.config.ts",
		'export default { jsPlugins: [{ name: "fixture", specifier: "./tools/oxlint/anti-slop/index.ts" }], rules: { "fixture/no-debugger": "error" } };\n',
	);
	f.put("biome.json", "{}\n");
	f.put(
		"tsconfig.json",
		JSON.stringify({
			compilerOptions: { target: "esnext", strict: true, types: [] },
			include: AGENTS_TYPECHECKED,
		}),
	);
	f.put(GATE_POLICY, JSON.stringify(agentsPolicy()));

	return { ...f, gateSha: f.commit() };
}

const TOOLS = resolve("node_modules");

const toolingRunner: GateRunner = {
	kind: "test-process",
	async run(input) {
		const args = input.argv.map((a) =>
			a.startsWith("/g/tooling/node_modules/")
				? `${TOOLS}/${a.slice("/g/tooling/node_modules/".length)}`
				: a.startsWith("/g/")
					? `${input.gates}/${a.slice(3)}`
					: a.startsWith("/w/")
						? `${input.tree}/${a.slice(3)}`
						: a,
		);

		const result = spawnSync(args[0] ?? "node", args.slice(1), {
			cwd: input.tree,
			encoding: "utf8",
			env: { PATH: process.env.PATH, HOME: "/tmp" },
			timeout: 60000,
		});

		return {
			exitCode: result.status ?? 1,
			stdout: result.stdout ?? "",
			stderr: result.stderr ?? "",
		};
	},
};

function weakerPolicy() {
	return {
		version: 2,
		sourceRoots: ["pi-extension"],
		testGlobs: ["test/test.ts"],
		checks: [
			{
				name: "typecheck",
				argv: ["/g/tooling/node_modules/.bin/biome", "format", "pi-extension"],
			},
			{
				name: "lint",
				argv: [
					"/g/tooling/node_modules/.bin/oxlint",
					"-c",
					"/g/tooling/oxlint.config.ts",
					"plugins",
				],
			},
			{
				name: "format",
				argv: ["/g/tooling/node_modules/.bin/biome", "format", "pi-extension"],
			},
		],
	};
}

test("a pi-herdr-agents gate policy overlays its source roots and deletions, keeping main's configs, tests and policy", async (t) => {
	const f = agentsRepo(t);

	for (const root of AGENTS_ROOTS) {
		f.put(`${root}/value.ts`, 'export const value = "candidate";\n');
		f.git("rm", "-q", `${root}/gone.ts`);
	}

	f.put("oxlint.config.ts", "export default {};\n");
	f.put("tsconfig.json", "{}\n");
	f.put("test/test.ts", 'throw new Error("CANDIDATE_TEST");\n');
	f.put(GATE_POLICY, JSON.stringify(weakerPolicy()));
	const candidateSha = f.commit();
	const gateTree = join(f.root, "gate-tree");
	const candidateTree = join(f.root, "candidate-tree");
	await exportTree(f.root, f.gateSha, gateTree);
	await exportTree(f.root, candidateSha, candidateTree);

	for (const [dest, material] of [
		[
			join(f.root, "from-git"),
			(dest: string) =>
				materializeCandidate({
					repository: f.root,
					gateSha: f.gateSha,
					candidateSha,
					dest,
					replacements: [],
				}),
		],
		[
			join(f.root, "from-directories"),
			async (dest: string) =>
				materializeFromDirectories({
					gateTree,
					candidateTree,
					dest,
					replacements: [],
				}),
		],
	] as const) {
		const r = await material(dest);

		for (const root of AGENTS_ROOTS) {
			assert.match(
				readFileSync(join(dest, root, "value.ts"), "utf8"),
				/candidate/,
				root,
			);
			assert.equal(existsSync(join(dest, root, "gone.ts")), false, root);
		}

		for (const path of ["oxlint.config.ts", "tsconfig.json", GATE_POLICY])
			assert.equal(
				readFileSync(join(dest, path), "utf8"),
				readFileSync(join(gateTree, path), "utf8"),
				path,
			);
		assert.match(readFileSync(join(dest, "test/test.ts"), "utf8"), /preserved/);
		assert.deepEqual(r.ignoredChanges, [
			GATE_POLICY,
			"oxlint.config.ts",
			"test/test.ts",
			"tsconfig.json",
		]);
		const manifest = manifestOf(dest);
		assert.deepEqual(manifest.sourceRoots, AGENTS_ROOTS);
		assert.deepEqual(manifest.testGlobs, AGENTS_GLOBS);
		assert.deepEqual(manifest.tests, AGENTS_TESTS);
	}
});

test("replay materialization refuses a missing or invalid gate policy exactly as the gate does", async (t) => {
	const f = agentsRepo(t);
	const gateTree = join(f.root, "gate-tree");
	const candidateTree = join(f.root, "candidate-tree");
	await exportTree(f.root, f.gateSha, gateTree);
	await exportTree(f.root, f.gateSha, candidateTree);
	const policy = join(gateTree, GATE_POLICY);

	for (const [label, text] of [
		["missing", null],
		["not JSON", "gate"],
		["unknown version", JSON.stringify({ ...agentsPolicy(), version: 3 })],
		["version 1 with roots", JSON.stringify({ ...agentsPolicy(), version: 1 })],
		[
			"unsafe roots",
			JSON.stringify({ ...agentsPolicy(), sourceRoots: ["../escape"] }),
		],
	] as const) {
		if (text === null) rmSync(policy);
		else writeFileSync(policy, text);

		let gateError = "";

		try {
			manifestOf(gateTree);
		} catch (error) {
			gateError = error instanceof Error ? error.message : String(error);
		}

		assert.notEqual(gateError, "", label);
		assert.throws(
			() =>
				materializeFromDirectories({
					gateTree,
					candidateTree,
					dest: join(f.root, `out-${label}`),
					replacements: [],
				}),
			(error) => error instanceof Error && error.message === gateError,
			label,
		);
		assert.equal(existsSync(join(f.root, `out-${label}`)), false, label);
	}
});

test("a pi-herdr-agents gate policy runs its real checks and test inventory with main's TypeScript lint config", async (t) => {
	const f = agentsRepo(t);
	f.put("maestro/value.ts", 'export const value = "candidate";\n');

	const receipt = await checkCandidate({
		...gateInput(f, f.commit()),
		runner: toolingRunner,
	});

	assert.equal(receipt.status, "passed", JSON.stringify(receipt));

	assert.deepEqual(receipt.requiredChecks, [
		"baseline_tests",
		"typecheck",
		"lint",
		"format",
		"main_tests",
		"candidate_tests",
	]);
	assert.deepEqual(
		receipt.checks.map((c) => c.name),
		receipt.requiredChecks,
	);
	assert.deepEqual(receipt.testGlobs, AGENTS_GLOBS);
	assert.deepEqual(Object.keys(receipt.baselineCounts).sort(), AGENTS_TESTS);
	assert.deepEqual(receipt.candidateCounts, receipt.baselineCounts);
	assert.equal(receiptPasses(receipt), false);
	assert.equal(receiptPasses(receipt, ["typecheck", "lint", "format"]), true);

	for (const [name, bad] of [
		["typecheck", 'export const value: number = "candidate";\n'],
		["lint", 'export const value = "candidate";\ndebugger;\n'],
		["format", 'export const value    =    "candidate"\n'],
	] as const) {
		f.put("maestro/value.ts", bad);

		const failed = await checkCandidate({
			...gateInput(f, f.commit()),
			runner: toolingRunner,
			output: join(f.root, `failed-${name}`),
		});

		assert.equal(failed.status, "failed", name);
		assert.deepEqual(
			failed.checks.filter((c) => c.exitCode !== 0).map((c) => c.name),
			[name],
		);
	}

	f.put("maestro/value.ts", 'export const value = "candidate";\n');

	for (const [name, bad] of [
		[
			"lint",
			'import { test } from "node:test";\ntest("added", () => {});\ndebugger;\n',
		],
		[
			"format",
			'import { test } from "node:test";\ntest("added",    () => {});\n',
		],
	] as const) {
		f.put("test/added.test.ts", bad);

		const failed = await checkCandidate({
			...gateInput(f, f.commit()),
			runner: toolingRunner,
			output: join(f.root, `failed-test-${name}`),
		});

		assert.equal(failed.status, "failed", `test ${name}`);
		assert.deepEqual(
			failed.checks.filter((c) => c.exitCode !== 0).map((c) => c.name),
			[name],
		);
	}
});

test("a candidate cannot weaken, skip or redirect a pi-herdr-agents gate policy or its lint config", async (t) => {
	const f = agentsRepo(t);
	f.put(GATE_POLICY, JSON.stringify(weakerPolicy()));
	assert.doesNotThrow(() => manifestOf(f.root));
	f.put("oxlint.config.ts", "export default {};\n");
	f.put("tools/oxlint/anti-slop/index.ts", "export default {};\n");
	f.put("maestro/value.ts", 'export const value = "candidate";\ndebugger;\n');

	const receipt = await checkCandidate({
		...gateInput(f, f.commit()),
		runner: toolingRunner,
	});

	assert.equal(receipt.status, "failed");
	assert.deepEqual(receipt.requiredChecks, [
		"baseline_tests",
		"typecheck",
		"lint",
		"format",
		"main_tests",
		"candidate_tests",
	]);
	assert.deepEqual(
		receipt.checks.filter((c) => c.exitCode !== 0).map((c) => c.name),
		["lint"],
	);
	assert.deepEqual(receipt.testGlobs, AGENTS_GLOBS);
	assert.deepEqual(Object.keys(receipt.baselineCounts).sort(), AGENTS_TESTS);
	assert.deepEqual(receipt.ignoredChanges, [GATE_POLICY, "oxlint.config.ts"]);
});

test("a candidate cannot weaken, skip or redirect Factorio's gate policy", async (t) => {
	const f = repo(t);
	const base = JSON.parse(readFileSync(join(f.root, GATE_POLICY), "utf8"));

	f.put(
		GATE_POLICY,
		JSON.stringify({
			...base,
			checks: base.checks.map((c: { name: string }) =>
				c.name === "layout"
					? { ...c, argv: ["node", "-e", "process.exit(3)"] }
					: c,
			),
		}),
	);
	const gateSha = f.commit();

	f.put(
		GATE_POLICY,
		JSON.stringify({
			version: 2,
			sourceRoots: ["src"],
			testGlobs: ["test/src/example/value.test.ts"],
			checks: ["typecheck", "lint", "format"].map((name) => ({
				name,
				argv: [
					"/g/tooling/node_modules/.bin/oxlint",
					"--disable-nested-config",
					"src",
				],
			})),
		}),
	);
	assert.doesNotThrow(() => manifestOf(f.root));
	f.put("src/value.ts", 'export const value = "main";\n// candidate\n');

	const receipt = await checkCandidate({
		...gateInput(f, f.commit()),
		gateSha,
		runner: toolingRunner,
	});

	assert.equal(receipt.status, "failed");
	assert.deepEqual(receipt.requiredChecks, [
		"baseline_tests",
		"typecheck",
		"lint",
		"format",
		"layout",
		"decisions",
		"main_tests",
		"candidate_tests",
	]);
	assert.equal(receipt.checks.find((c) => c.name === "layout")?.exitCode, 3);
	assert.deepEqual(receipt.testGlobs, ["test/src/**/*.test.ts"]);
	assert.deepEqual(receipt.ignoredChanges, [GATE_POLICY]);
});

const OXLINT = "/g/tooling/node_modules/.bin/oxlint";

const BIOME = "/g/tooling/node_modules/.bin/biome";

function permissiveAgentsRepo(
	t: { after(fn: () => void): void },
	change: { readonly [name: string]: readonly string[] },
) {
	const f = agentsRepo(t);
	const policy = agentsPolicy();

	f.put(
		GATE_POLICY,
		JSON.stringify({
			...policy,
			checks: policy.checks.map((c) => ({
				...c,
				argv: change[c.name] ?? c.argv,
			})),
		}),
	);

	return f;
}

async function nestedAttack(
	f: ReturnType<typeof agentsRepo>,
	gateSha: string,
	label: string,
) {
	const receipt = await checkCandidate({
		...gateInput(f, f.commit()),
		gateSha,
		runner: toolingRunner,
		output: join(f.root, `attack-${label}`),
	});

	return {
		status: receipt.status,
		failed: receipt.checks.filter((c) => c.exitCode !== 0).map((c) => c.name),
		ignoredChanges: receipt.ignoredChanges,
	};
}

test("a candidate's nested oxlint config cannot turn off main's lint rule under a version 2 policy", async (t) => {
	for (const [nested, text] of [
		["maestro/.oxlintrc.json", '{ "rules": { "no-debugger": "off" } }\n'],
		[
			"maestro/oxlint.config.ts",
			'export default { rules: { "no-debugger": "off" } };\n',
		],
	] as const) {
		const f = permissiveAgentsRepo(t, {
			lint: [OXLINT, "--ignore-path", "/dev/null", ...AGENTS_LINTED],
		});

		f.git("rm", "-q", "oxlint.config.ts");
		f.put(".oxlintrc.json", '{"rules":{"no-debugger":"error"}}\n');
		const gateSha = f.commit();
		f.put(nested, text);
		f.put("maestro/value.ts", 'export const value = "candidate";\ndebugger;\n');

		assert.deepEqual(await nestedAttack(f, gateSha, "oxlint"), {
			status: "failed",
			failed: ["lint"],
			ignoredChanges: [nested],
		});
	}
});

test("a candidate's nested Biome config cannot turn off main's formatter under a version 2 policy", async (t) => {
	for (const nested of ["maestro/biome.json", "maestro/biome.jsonc"]) {
		const f = permissiveAgentsRepo(t, {
			format: [BIOME, "format", ...AGENTS_LINTED],
		});

		const gateSha = f.commit();
		f.put(
			nested,
			'{"root":false,"extends":"//","formatter":{"enabled":false}}\n',
		);
		f.put("maestro/value.ts", 'export const value    =    "candidate"\n');

		assert.deepEqual(await nestedAttack(f, gateSha, "biome"), {
			status: "failed",
			failed: ["format"],
			ignoredChanges: [nested],
		});
	}
});

test("a candidate cannot weaken main's TypeScript config through a nested tsconfig or an extends target inside a source root", async (t) => {
	for (const base of ["maestro/base.json", "maestro/tsconfig.base.json"]) {
		const f = permissiveAgentsRepo(t, {});
		f.put(base, '{ "compilerOptions": { "strict": true } }\n');
		f.put(
			"tsconfig.json",
			JSON.stringify({
				extends: `./${base.replace(/\.json$/, "")}`,
				compilerOptions: { target: "esnext", types: [] },
				include: AGENTS_TYPECHECKED,
			}),
		);
		const gateSha = f.commit();
		f.put(base, '{ "compilerOptions": { "strict": false } }\n');
		f.put(
			"maestro/tsconfig.json",
			'{ "compilerOptions": { "strict": false } }\n',
		);
		f.put(
			"maestro/value.ts",
			'export const value = "candidate";\nexport function same(x) {\n\treturn x;\n}\n',
		);

		assert.deepEqual(await nestedAttack(f, gateSha, "tsc"), {
			status: "failed",
			failed: ["typecheck"],
			ignoredChanges: [base, "maestro/tsconfig.json"].sort(),
		});
	}
});

test("a version 2 overlay keeps main's nested Prettier, ESLint, oxlint, Biome, TypeScript, env and Node version files and package.json tool keys", async (t) => {
	const f = agentsRepo(t);
	f.put("pi-extension/.prettierrc", '{"semi":true}\n');
	f.put("maestro/.prettierrc", '{"semi":true}\n');
	f.put(
		"maestro/package.json",
		'{"name":"m","version":"1.0.0","prettier":{"semi":true}}\n',
	);
	const gateSha = f.commit();

	const added = [
		"maestro/.oxlintrc.json",
		"maestro/oxlint.config.mjs",
		"plugins/.eslintrc",
		"plugins/.eslintrc.json",
		"plugins/eslint.config.js",
		"scripts/.prettierrc.yaml",
		"scripts/prettier.config.mjs",
		"scripts/.prettierignore",
		"scripts/package.yaml",
		"skills/biome.jsonc",
		"skills/.biome.json",
		"skills/.ignore",
		"skills/nested/biome.json",
		"tools/tsconfig.json",
		"tools/tsconfig.build.json",
		"tools/jsconfig.json",
		".pi/skills/.env",
		".pi/skills/.env.local",
		"pi-extension/.node-version",
		"pi-extension/.nvmrc",
		"test/.oxlintrc.json",
		"test/maestro/.prettierrc",
	];

	for (const path of added) f.put(path, "{}\n");
	f.put("pi-extension/.prettierrc", '{"semi":false}\n');
	f.put("pi-extension/value.ts", 'export const value = "candidate";\n');
	f.git("rm", "-q", "maestro/.prettierrc");
	f.put(
		"maestro/package.json",
		'{"name":"m","version":"2.0.0","prettier":{"semi":false},"eslintConfig":{},"eslintIgnore":["*"],"oxlint":{}}\n',
	);
	f.put("plugins/package.json", '{"name":"p","eslintConfig":{"rules":{}}}\n');
	f.put("scripts/package.json", '{"name":"s","type":"module"}\n');
	const candidateSha = f.commit();
	const gateTree = join(f.root, "gate-tree");
	const candidateTree = join(f.root, "candidate-tree");
	await exportTree(f.root, gateSha, gateTree);
	await exportTree(f.root, candidateSha, candidateTree);

	for (const [dest, material] of [
		[
			join(f.root, "from-git"),
			(dest: string) =>
				materializeCandidate({
					repository: f.root,
					gateSha,
					candidateSha,
					dest,
					replacements: [],
				}),
		],
		[
			join(f.root, "from-directories"),
			async (dest: string) =>
				materializeFromDirectories({
					gateTree,
					candidateTree,
					dest,
					replacements: [],
				}),
		],
	] as const) {
		const r = await material(dest);

		for (const path of added)
			assert.equal(existsSync(join(dest, path)), false, path);

		for (const path of ["pi-extension/.prettierrc", "maestro/.prettierrc"])
			assert.equal(readFileSync(join(dest, path), "utf8"), '{"semi":true}\n');
		assert.deepEqual(
			JSON.parse(readFileSync(join(dest, "maestro/package.json"), "utf8")),
			{ name: "m", version: "2.0.0", prettier: { semi: true } },
		);
		assert.deepEqual(
			JSON.parse(readFileSync(join(dest, "plugins/package.json"), "utf8")),
			{ name: "p" },
		);
		assert.equal(
			readFileSync(join(dest, "scripts/package.json"), "utf8"),
			'{"name":"s","type":"module"}\n',
		);
		assert.match(
			readFileSync(join(dest, "pi-extension/value.ts"), "utf8"),
			/candidate/,
		);
		assert.deepEqual(
			r.ignoredChanges,
			[
				...added,
				"pi-extension/.prettierrc",
				"maestro/.prettierrc",
				"maestro/package.json",
				"plugins/package.json",
			].sort(),
		);
	}
});

test("Factorio's gate policy yields today's checks, source roots, test inventory and receipt", async (t) => {
	const root = existsSync("/g/tooling/.github/factory/gates/gates.json")
		? "/g/tooling"
		: ".";

	const policy = JSON.parse(readFileSync(join(root, GATE_POLICY), "utf8"));
	const manifest = manifestOf(root);

	const legacyGlobs = [
		"test/src/**/*.test.ts",
		"test/host/**/*.test.ts",
		"test/integration/*.test.ts",
	];

	assert.equal(policy.version, 1);
	assert.deepEqual(manifest.checks, policy.checks);
	assert.deepEqual(
		manifest.checks.map((c) => c.name),
		["typecheck", "lint", "format", "layout", "decisions"],
	);
	assert.deepEqual(manifest.sourceRoots, [
		"src",
		"extension",
		"host",
		"skills",
		"scripts",
		".pi/skills",
		"docs/models",
	]);
	assert.deepEqual(manifest.testGlobs, legacyGlobs);

	const legacyTests = legacyGlobs
		.flatMap((pattern) => globSync(pattern, { cwd: root }))
		.sort();

	assert.equal(manifest.tests.length, legacyTests.length);
	assert.equal(
		createHash("sha256").update(JSON.stringify(manifest.tests)).digest("hex"),
		createHash("sha256").update(JSON.stringify(legacyTests)).digest("hex"),
	);

	const f = repo(t);
	f.put(GATE_POLICY, JSON.stringify(policy));
	f.put(".oxlintrc.json", readFileSync(join(root, ".oxlintrc.json"), "utf8"));

	for (const path of [
		"test/host/example.test.ts",
		"test/integration/example.test.ts",
	])
		f.put(path, 'import { test } from "node:test";\ntest("kept", () => {});\n');
	const gateSha = f.commit();
	f.put("src/value.ts", 'export const value = "main";\n// candidate\n');
	const ran: { argv: readonly string[]; plugins: unknown }[] = [];

	const recording: GateRunner = {
		kind: "test-process",
		async run(input) {
			if (input.argv.includes("--test")) return miniRunner.run(input);

			const lint = JSON.parse(
				readFileSync(join(input.gates, "lint.json"), "utf8"),
			);

			ran.push({ argv: input.argv, plugins: lint.jsPlugins });

			return { exitCode: 0, stdout: "", stderr: "" };
		},
	};

	const receipt = await checkCandidate({
		...gateInput(f, f.commit()),
		gateSha,
		runner: recording,
	});

	assert.equal(receipt.status, "passed", JSON.stringify(receipt));
	assert.deepEqual(
		ran.map((r) => r.argv),
		policy.checks.map((c: { argv: string[] }) => c.argv),
	);

	for (const r of ran)
		assert.deepEqual(r.plugins, [
			{
				name: "anti-slop",
				specifier: "/g/tooling/tools/oxlint/anti-slop/index.ts",
			},
		]);

	const legacyRequired = [
		"baseline_tests",
		"typecheck",
		"lint",
		"format",
		"layout",
		"decisions",
		"main_tests",
		"candidate_tests",
	];

	assert.deepEqual(receipt.requiredChecks, legacyRequired);
	assert.deepEqual(
		receipt.checks.map((c) => c.name),
		legacyRequired,
	);
	assert.deepEqual(receipt.testGlobs, legacyGlobs);
	assert.deepEqual(Object.keys(receipt.baselineCounts).sort(), [
		"test/host/example.test.ts",
		"test/integration/example.test.ts",
		"test/src/example/value.test.ts",
	]);
	assert.equal(receiptPasses(receipt), true);
});

const CHECK_SCRIPT = "/g/tooling/scripts/check.mjs";

const NODE_CODE_ARGV = [
	["node", "--import=data:text/javascript,process.exit(0)", CHECK_SCRIPT],
	["node", "--require=/w/src/evil.js", CHECK_SCRIPT],
	["node", "--require=/g/tooling/../../w/src/evil.js", CHECK_SCRIPT],
	...[
		"--import",
		"--require",
		"-r",
		"--loader",
		"--experimental-loader",
		"-e",
		"--eval",
		"-p",
		"--print",
	].flatMap((flag) => [
		["node", `${flag}=/g/tooling/scripts/exit.mjs`, CHECK_SCRIPT],
		["node", flag, "/g/tooling/scripts/exit.mjs", CHECK_SCRIPT],
		[
			"node",
			"--no-warnings",
			flag,
			"/g/tooling/scripts/exit.mjs",
			CHECK_SCRIPT,
		],
	]),
	...[
		"--import",
		"--require",
		"--loader",
		"--experimental-loader",
		"--eval",
		"--print",
	].flatMap((flag) => [
		[CHECK_SCRIPT, `${flag}=/g/tooling/scripts/exit.mjs`],
		["node", CHECK_SCRIPT, flag, "/g/tooling/scripts/exit.mjs"],
	]),
];

type PolicyChange = {
	readonly version?: number;
	readonly sourceRoots?: readonly string[] | null;
	readonly testGlobs?: readonly string[];
	readonly checks?: readonly { name: string; argv: readonly string[] }[];
};

function refuse(change: PolicyChange, reason: string): [PolicyChange, string] {
	return [change, reason];
}

test("a repository gate policy refuses unsafe roots, test globs and checks, and never a no-op check", (t) => {
	const f = agentsRepo(t);
	const policy = agentsPolicy();
	const [typecheck, lint, format] = policy.checks;
	assert.ok(typecheck && lint && format);
	const tooling = "/g/tooling/node_modules/.bin/biome";
	f.put("pi-extension-two/value.ts", "export const two = 2;\n");

	const refused: [PolicyChange, string][] = [
		[{ version: 3 }, "invalid_gate_manifest"],
		[{ version: 1 }, "invalid_gate_manifest"],
		...[
			undefined,
			null,
			[],
			["../pi-extension"],
			["/etc"],
			["."],
			[".github"],
			[".pi"],
			["test"],
			["test/acceptance"],
			["node_modules"],
			["pi-extension/node_modules"],
			["pi-extension", "pi-extension"],
			["pi-extension", "pi-extension/nested"],
			["pi-extension\\nested"],
			Array.from({ length: 33 }, (_, i) => `root${i}`),
			["tsconfig.json"],
			["package.json"],
			["biome.json"],
			["pi-extension/value.ts"],
			["missing"],
			["pi-extension", "missing"],
		].map((sourceRoots) => refuse({ sourceRoots }, "invalid_gate_manifest")),
		...[
			[],
			["test/../value.test.ts"],
			["test/acceptance/*.test.ts"],
			["test/fixtures/*.test.ts"],
			["test/$(touch evil).test.ts"],
			["test/*.test.ts\n"],
			["test/test.ts", "test/test.ts"],
			Array.from({ length: 33 }, (_, i) => `test/t${i}.test.ts`),
		].map((testGlobs) => refuse({ testGlobs }, "invalid_gate_manifest")),
		[{ testGlobs: ["test/*.test.ts", "test/host.test.ts"] }, "duplicate_tests"],
		[{ testGlobs: ["test/missing/*.test.ts"] }, "missing_tests"],
		...["typecheck", "lint", "format"].map((name) =>
			refuse(
				{ checks: policy.checks.filter((c) => c.name !== name) },
				"missing_checks",
			),
		),
		[{ checks: [...policy.checks, typecheck] }, "missing_checks"],
		[
			{
				checks: [
					...policy.checks,
					...Array.from({ length: 10 }, (_, i) => ({
						name: `extra${i}`,
						argv: [tooling, "check", "pi-extension"],
					})),
				],
			},
			"missing_checks",
		],
		...[
			"install",
			"baseline_tests",
			"main_tests",
			"candidate_tests",
			"heldout",
			"lint_deadline_control",
			"Bad",
			"bad/path",
			"",
		].map((name) =>
			refuse(
				{
					checks: [
						...policy.checks,
						{ name, argv: [tooling, "check", "pi-extension"] },
					],
				},
				"invalid_gate_manifest",
			),
		),
		...[
			[],
			["true"],
			["/bin/true"],
			["sh", "-c", "/g/tooling/node_modules/.bin/oxlint"],
			["node", "-e", "0"],
			["node", "--eval=0", "/g/tooling/scripts/check.mjs"],
			["node", "--print", "/g/tooling/scripts/check.mjs"],
			["node", "-p", "/g/tooling/scripts/check.mjs"],
			["node", "/w/scripts/check.mjs"],
			["node", "scripts/check.mjs"],
			["/g/tooling/../../bin/true"],
			["/w/node_modules/.bin/oxlint"],
			[tooling, "nul\0"],
			...NODE_CODE_ARGV,
			[tooling, "check", ".."],
			[tooling, "check", "--config-path=/g/tooling/../../w/maestro"],
			[tooling, "check", "--config-path", "/g/tooling/../../etc"],
			...[
				"/w/pi-extension/biome.json",
				"/w//maestro/biome.json",
				"/w/./tools/biome.json",
				"/w/.pi/skills/biome.json",
				"/w/test/biome.json",
				"/w/plugins",
				"//w/pi-extension",
				"/./w/pi-extension",
				"/w/./pi-extension/biome.json",
				"file:///w/pi-extension/x.mjs",
				"file:/w/maestro/biome.json",
				"file://localhost/w/maestro",
				"file:///%77/maestro",
				"FILE:////w/test",
			].flatMap((path) => [
				[tooling, "check", "--config-path", path],
				[tooling, "check", `--config-path=${path}`],
			]),
			...[
				"--env-file=pi-extension/x.env",
				"--env-file-if-exists=pi-extension/x.env",
				"--experimental-config-file=pi-extension/node.config.json",
				"--test-reporter=./pi-extension/r.mjs",
				"--test-reporter-destination=stdout",
				"--test-global-setup=pi-extension/setup.mjs",
				"--conditions=development",
				"--stack-size=1",
				"--",
			].map((flag) => ["node", flag, CHECK_SCRIPT]),
			["node", "--env-file", "pi-extension/x.env", CHECK_SCRIPT],
			["node", "-C", "development", CHECK_SCRIPT],
			["node", "--no-warnings", "--conditions", "development", CHECK_SCRIPT],
		].map((argv) =>
			refuse(
				{ checks: [{ ...lint, argv }, typecheck, format] },
				"invalid_gate_manifest",
			),
		),
		...["typecheck", "lint", "format", "layout"].flatMap((name) =>
			["--version", "-v", "--help", "-h"].flatMap((flag) =>
				[
					[tooling, flag],
					[tooling, "format", "pi-extension", flag],
					["node", "/g/tooling/node_modules/typescript/bin/tsc", flag],
					["node", flag, "/g/tooling/node_modules/typescript/bin/tsc"],
				].map((argv) =>
					refuse(
						{
							checks: [
								...policy.checks.filter((c) => c.name !== name),
								{ name, argv },
							],
						},
						"invalid_gate_manifest",
					),
				),
			),
		),
	];

	for (const [change, reason] of refused) {
		f.put(GATE_POLICY, JSON.stringify({ ...policy, ...change }));
		assert.throws(
			() => manifestOf(f.root),
			new RegExp(`^Error: ${reason}$`),
			JSON.stringify(change),
		);
	}

	for (const change of [
		{
			checks: [
				...policy.checks,
				{
					name: "layout",
					argv: [
						"node",
						"--experimental-strip-types",
						"/g/tooling/scripts/check-layout.mjs",
						"--root",
						"/w",
					],
				},
			],
		},
		{
			checks: [
				typecheck,
				lint,
				format,
				{
					name: "layout",
					argv: [
						"node",
						"--no-warnings",
						"--experimental-strip-types",
						"/g/tooling/scripts/check-layout.mjs",
						"--root=/w",
						"pi-extension",
					],
				},
			],
		},
		{ testGlobs: ["test/**/*.test.ts"] },
		{ sourceRoots: ["pi-extension", "pi-extension-two", ".pi/skills"] },
		{
			checks: [
				typecheck,
				lint,
				{
					...format,
					argv: [tooling, "format", "--config-path=/w/biome.json", "test"],
				},
			],
		},
	]) {
		f.put(GATE_POLICY, JSON.stringify({ ...policy, ...change }));
		assert.doesNotThrow(() => manifestOf(f.root), JSON.stringify(change));
	}

	f.put(
		GATE_POLICY,
		JSON.stringify({ ...policy, testGlobs: ["test/**/*.test.ts"] }),
	);
	assert.deepEqual(manifestOf(f.root).tests, [
		"test/host.test.ts",
		"test/integration/live.test.ts",
		"test/maestro/worker.test.ts",
	]);
});
