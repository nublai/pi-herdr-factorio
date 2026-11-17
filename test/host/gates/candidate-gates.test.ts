import assert from "node:assert/strict";
import childProcess, { execFileSync, spawnSync } from "node:child_process";
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
	symlinkSync,
	watch,
	writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { parse as parseYaml } from "yaml";
import type { DiagnosisFacts } from "../../../host/controller/checkers.ts";
import { fileRunFiles } from "../../../host/controller/run-files.ts";
import { checkCandidate, receiptPasses } from "../../../host/gates/gates.ts";
import {
	byteSafeAttributes,
	exportTree,
	heldoutDigest,
	materializeCandidate,
	materializeFromDirectories,
	replacementDigest,
	replacementsOf,
	MATERIALIZER_FILES,
	materializerIdentity,
	gateMaterializerIdentity,
	productMaterializerIdentity,
} from "../../../host/gates/materialize.ts";
import {
	baseTreeDigest,
	runDraftBase,
	runHeldoutBase,
} from "../../../host/gates/base.ts";
import {
	manifestOf,
	validateDependencies,
} from "../../../host/gates/manifest.ts";
import {
	type GateRunner,
	dockerRunner,
	localRunner,
} from "../../../host/gates/runner.ts";
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

test("Docker gate reaps orphaned children without relaxing container restrictions", async (t) => {
	const calls: { command: string; argv: readonly string[] }[] = [];

	const docker = t.mock.method(
		childProcess,
		"execFile",
		(command: string, argv: readonly string[]) => {
			calls.push({ command, argv });
			throw new Error("captured Docker invocation");
		},
	);

	syncBuiltinESMExports();

	try {
		await assert.rejects(
			dockerRunner.run({
				tree: "/tree",
				gates: "/gates",
				argv: ["node", "--test"],
			}),
			/captured Docker invocation/,
		);
	} finally {
		docker.mock.restore();
		syncBuiltinESMExports();
	}

	assert.equal(calls.length, 2);
	const run = calls[0];
	assert.ok(run);
	assert.equal(run.command, "docker");
	assert.deepEqual(run.argv.slice(0, 4), ["run", "--rm", "--init", "--name"]);
	const id = run.argv[4];
	assert.match(id ?? "", /^factory-gate-[a-f0-9]{16}$/);
	assert.deepEqual(run.argv.slice(5, 23), [
		"--network",
		"none",
		"--read-only",
		"--tmpfs",
		"/tmp:exec,size=1g",
		"--user",
		"1001",
		"--cap-drop",
		"ALL",
		"--security-opt",
		"no-new-privileges",
		"--pids-limit",
		"512",
		"--memory",
		"4g",
		"--mount",
		"type=bind,src=/tree,dst=/w,readonly",
		"--mount",
	]);
	assert.equal(run.argv[23], "type=bind,src=/gates,dst=/g,readonly");
	assert.deepEqual(calls[1], { command: "docker", argv: ["rm", "-f", id] });
});

function missingBubblewrap(): string | null {
	const argv = [
		"bwrap",
		"--unshare-all",
		"--die-with-parent",
		"--ro-bind",
		"/",
		"/",
		"true",
	];

	try {
		execFileSync(argv[0] ?? "bwrap", argv.slice(1), {
			stdio: ["ignore", "ignore", "pipe"],
			timeout: 10_000,
		});

		return null;
	} catch (error) {
		const stderr =
			error instanceof Error && "stderr" in error
				? String(error.stderr).trim()
				: "";

		return `${argv.join(" ")} failed in this environment${stderr ? `: ${stderr.slice(0, 300)}` : ""}`;
	}
}

const bwrap = missingBubblewrap();

function sandboxAvailable(t: import("node:test").TestContext): boolean {
	if (bwrap === null) return true;

	assert.notEqual(
		process.env.FACTORY_REQUIRE_SANDBOX_TESTS,
		"1",
		`FACTORY_REQUIRE_SANDBOX_TESTS=1 but ${bwrap}`,
	);
	t.diagnostic(`not run: ${bwrap}`);

	return false;
}

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
	git(
		"remote",
		"add",
		"origin",
		"https://github.com/nublai/pi-herdr-factorio.git",
	);

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

	for (const member of MATERIALIZER_FILES)
		put(member, readFileSync(member, "utf8"));
	git("add", ".");
	git("commit", "-qm", "main");
	const gateSha = git("rev-parse", "HEAD");

	return {
		root,
		targetRepository: "nublai/pi-herdr-factorio",
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

async function pinnedProduct(
	t: { after(fn: () => void): void },
	prepare?: (root: string) => void,
) {
	const root = mkdtempSync(join(tmpdir(), "factory-product-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));

	for (const path of [
		"host",
		"src",
		".github/factory/gates",
		"package.json",
		"package-lock.json",
	])
		cpSync(resolve(path), join(root, path), { recursive: true });

	prepare?.(root);

	const git = (...args: string[]) =>
		execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();

	git("init", "-q");
	writeFileSync(join(root, ".git/info/exclude"), "node_modules\n");
	git("add", ".");
	git(
		"-c",
		"user.name=Gate test",
		"-c",
		"user.email=gate@example.invalid",
		"commit",
		"-qm",
		"trusted product",
	);
	const revision = git("rev-parse", "HEAD");
	symlinkSync(resolve("node_modules"), join(root, "node_modules"), "dir");

	const gates: typeof import("../../../host/gates/gates.ts") = await import(
		pathToFileURL(join(root, "host/gates/gates.ts")).href
	);

	const checkers: typeof import("../../../host/controller/checkers.ts") =
		await import(pathToFileURL(join(root, "host/controller/checkers.ts")).href);

	const base: typeof import("../../../host/gates/base.ts") = await import(
		pathToFileURL(join(root, "host/gates/base.ts")).href
	);

	return { root, revision, git, ...gates, ...checkers, ...base };
}

function externalTarget(t: { after(fn: () => void): void }, revision: string) {
	const f = repo(t);
	f.git(
		"remote",
		"set-url",
		"origin",
		"https://github.com/giuseppecrj/pi-herdr-agents.git",
	);
	f.git("rm", "-rq", "host");

	const policy = JSON.parse(
		readFileSync(join(f.root, ".github/factory/gates/gates.json"), "utf8"),
	);

	f.put(
		".github/factory/gates/gates.json",
		JSON.stringify({ ...policy, toolingRevision: revision }),
	);
	const gateSha = gitSha(f.commit());
	const heldoutDir = "test/acceptance/123";
	const path = `${heldoutDir}/checks/value.test.ts`;

	const bytes = Buffer.from(
		'import {test} from "node:test"; import assert from "node:assert/strict"; import {value} from "../../../../src/value.ts"; test("held-out value", () => assert.equal(value, "main"));\n',
	);

	f.put(path, bytes.toString());
	const candidateSha = gitSha(f.commit());

	return {
		...f,
		targetRepository: "giuseppecrj/pi-herdr-agents",
		gateSha,
		candidateSha,
		heldoutDir,
		heldoutDigest: heldoutDigest([{ path, bytes }]),
	};
}

const mustNotRun: GateRunner = {
	kind: "must-not-run",
	run: async () => assert.fail("unverified tooling ran"),
};

async function diagnoseExternal(
	product: Awaited<ReturnType<typeof pinnedProduct>>,
	f: ReturnType<typeof externalTarget>,
	runner: GateRunner = localRunner,
	repo: string = "giuseppecrj/pi-herdr-agents",
) {
	let runnerCalls = 0;
	assert.ok(isRepoSlug(repo));
	const runId = digestOf("external-tooling-run");
	const dir = join(f.root, "private-diagnosis");

	const owner = product.controllerDiagnosis({
		stateDir: dir,
		fetch: async (requestedRepo, sha) => {
			assert.equal(requestedRepo, repo);

			return execFileSync("git", [
				"-C",
				f.root,
				"archive",
				"--format=tar.gz",
				"--prefix=target/",
				sha,
			]);
		},
		runner: {
			kind: runner.kind,
			run: async (input) => {
				runnerCalls++;

				return runner.run(input);
			},
		},
	});

	const facts = new Promise<DiagnosisFacts>((finish, reject) => {
		void owner
			.check({
				runId,
				dir,
				bindingDigest: digestOf("external-binding"),
				repo,
				gateSha: f.gateSha,
				candidateSha: f.candidateSha,
				round: 0,
				allowanceMs: 30_000,
				needs: { replay: true, dependencies: false },
				heldoutDir: f.heldoutDir,
				heldoutDigest: f.heldoutDigest,
				replacements: [],
				base: { kind: "stored", receipt: null },
				finish,
				interrupted: () => assert.fail("unexpected interruption"),
			})
			.catch(reject);
	});

	const result = await facts;
	await owner.stop(runId);

	if (runner === mustNotRun)
		assert.equal(runnerCalls, 0, "diagnosis ran unverified tooling");

	return result;
}

async function externalRefused(
	product: Awaited<ReturnType<typeof pinnedProduct>>,
	f: ReturnType<typeof externalTarget>,
) {
	const receipt = await product.checkCandidate({
		repository: f.root,
		gateSha: f.gateSha,
		candidateSha: f.candidateSha,
		nonce: "refused-pin",
		output: join(f.root, "refused-output"),
		heldoutDir: f.heldoutDir,
		heldoutDigest: f.heldoutDigest,
		runner: {
			kind: "must-not-run",
			run: async () => assert.fail("unverified tooling ran"),
		},
	});

	assert.equal(receipt.reason, "unsupported_materializer");
	assert.equal(receipt.checks.length, 0);
	const facts = await diagnoseExternal(product, f, mustNotRun);
	assert.ok(facts.replay?.kind === "unavailable");
	assert.equal(facts.replay.reason, "unsupported_materializer");
}

async function externalBase(
	t: { after(fn: () => void): void },
	product: Awaited<ReturnType<typeof pinnedProduct>>,
	changedReporter: boolean,
) {
	const f = externalTarget(t, product.revision);

	if (changedReporter)
		f.put(
			".github/factory/gates/reporter.mjs",
			readFileSync(join(f.root, ".github/factory/gates/reporter.mjs"), "utf8") +
				"\n",
		);
	const sha = gitSha(changedReporter ? f.commit() : f.candidateSha);
	const slug = "giuseppecrj/pi-herdr-agents";
	assert.ok(isRepoSlug(slug));

	const contract: Contract = {
		version: 2,
		runId: digestOf("pinned base qualification"),
		issue: 123,
		base: { repo: slug, sha },
		snapshot: {
			digest: digestOf("snapshot"),
			source: "unedited",
			eventId: "1",
			eventAt: "2026-11-17T00:00:00Z",
		},
		link: null,
		summary: "Preserve value",
		behavior: ["Preserve value"],
		exclusions: [],
		acceptance: [{ id: "A1", kind: "preservation", text: "Preserve value" }],
		compatibility: [],
		limits: [],
		files: [],
		evidence: [],
	};

	const text = JSON.stringify({
		version: 2,
		scenarios: [
			{ id: "S1", criteria: ["A1"], checks: ["value.test.mjs"], judge: null },
		],
		files: [
			{
				path: "value.test.mjs",
				type: "node:test",
				content: 'import {test} from "node:test"; test("value",()=>{});',
			},
		],
	});

	const parsed = writeAcceptance(text, contract, new Set());
	assert.equal(parsed.kind, "suite");
	const stateDir = join(f.root, "private-base");
	const files = fileRunFiles(stateDir);
	const bytes = contractBytes(contract);
	const contractDigest = contractDigestOf(bytes);
	assert.ok(
		await files.writeContract({ contract, bytes, digest: contractDigest }),
	);

	const stored = await files.artifacts.store({
		contract,
		contractDigest,
		suite: parsed.suite,
		model: "openai/gpt-6.1-sol",
		observed: null,
	});

	assert.equal(stored.kind, "found");

	const canary = readFileSync(
		join(stateDir, "acceptance", contract.runId, "canary.txt"),
		"utf8",
	).trimEnd();

	const binding = {
		runId: contract.runId,
		repo: slug,
		issue: 123,
		contractDigest,
		acceptanceDigest: stored.receipt.acceptanceDigest,
		baseSha: sha,
		gateSha: sha,
	};

	const fetch = async () =>
		execFileSync("git", [
			"-C",
			f.root,
			"archive",
			"--format=tar.gz",
			"--prefix=target/",
			sha,
		]);

	return {
		...f,
		contract,
		suite: parsed.suite,
		text,
		stateDir,
		binding,
		canary,
		fetch,
	};
}

test("byte-safe attributes parse only the documented allowlist", () => {
	for (const attribute of [
		"text",
		"-text",
		"text=auto",
		"binary",
		"eol=lf",
		"diff",
		"-diff",
		"merge",
		"-merge",
		"whitespace",
		"linguist-generated",
		"linguist-language=TypeScript",
		"-linguist-vendored",
		"!linguist-generated",
	])
		assert.equal(
			byteSafeAttributes(Buffer.from(`* ${attribute}\n`)),
			true,
			attribute,
		);

	for (const text of [
		"",
		" \t\r\n# * export-ignore\n",
		"\uFEFF* text=auto eol=lf\r\n*.png binary\r\n",
		'"path with spaces" text\n',
		'"path\\040with\\tspaces" -text\n',
		"*\ttext\reol=lf\n",
		"path-with-no-attributes\n",
	])
		assert.equal(
			byteSafeAttributes(Buffer.from(text)),
			true,
			JSON.stringify(text),
		);
});

test("byte-safe attributes refuse unknown states, macros, conversions, and malformed input", () => {
	for (const attribute of [
		"export-ignore",
		"-export-ignore",
		"!export-ignore",
		"export-ignore=false",
		"export-subst",
		"-export-subst",
		"!export-subst",
		"export-subst=false",
		"ident",
		"-ident",
		"!ident",
		"filter=custom",
		"filter",
		"-filter",
		"!filter",
		"working-tree-encoding=UTF-16",
		"eol=crlf",
		"eol=native",
		"!eol",
		"-eol",
		"text=other",
		"!text",
		"diff=custom",
		"merge=custom",
		"unknown",
	])
		assert.equal(
			byteSafeAttributes(Buffer.from(`* ${attribute}\n`)),
			false,
			attribute,
		);

	for (const text of [
		"[attr]custom text\n",
		"[attr]binary -text\n",
		'"[attr]custom" text\n',
		'"\\133attr\\135custom" text\n',
		"* binary\n[attr]binary export-ignore\n",
		'"unterminated text\n',
		'"bad\\q" text\n',
		"* text # comment\n",
		"* text\0\n* export-ignore\n",
		"* text\n\u00a0# export-ignore\n",
		"* text\vbinary\n",
	])
		assert.equal(
			byteSafeAttributes(Buffer.from(text)),
			false,
			JSON.stringify(text),
		);

	assert.equal(byteSafeAttributes(Buffer.from([0xff])), false);
});

test("byte-safe attributes share root and nested directory-tree refusal rules", async (t) => {
	const f = repo(t);
	const tree = join(f.root, "base-export");
	await exportTree(f.root, f.gateSha, tree);

	for (const path of [".gitattributes", "src/.gitattributes"]) {
		writeFileSync(join(tree, path), "* text=auto eol=lf\n*.png binary\n");
		assert.doesNotThrow(() => baseTreeDigest(tree));
		assert.doesNotThrow(() =>
			materializeFromDirectories({
				gateTree: tree,
				candidateTree: tree,
				dest: join(f.root, "safe"),
				replacements: [],
			}),
		);
		rmSync(join(f.root, "safe"), { recursive: true, force: true });
		writeFileSync(join(tree, path), "* export-ignore\n");
		assert.throws(() => baseTreeDigest(tree), /unsafe_tree/);
		assert.throws(
			() =>
				materializeFromDirectories({
					gateTree: tree,
					candidateTree: tree,
					dest: join(f.root, "refused"),
					replacements: [],
				}),
			/unsafe_tree/,
		);
		assert.equal(existsSync(join(f.root, "refused")), false);
		rmSync(join(tree, path));
	}

	mkdirSync(join(tree, ".git/info"), { recursive: true });
	writeFileSync(join(tree, ".git/info/attributes"), "* text\n");
	assert.throws(() => baseTreeDigest(tree), /unsafe_tree/);
	assert.throws(
		() =>
			materializeFromDirectories({
				gateTree: tree,
				candidateTree: tree,
				dest: join(f.root, "refused"),
				replacements: [],
			}),
		/unsafe_tree/,
	);
});

test("byte-safe attributes qualify through the pinned base caller and diagnosis replay", async (t) => {
	const product = await pinnedProduct(t);
	const f = await externalBase(t, product, false);
	const tree = join(f.root, "base-export");
	await exportTree(f.root, f.binding.baseSha, tree);

	for (const path of [".gitattributes", "src/.gitattributes"])
		writeFileSync(join(tree, path), "* text=auto eol=lf\n*.png binary\n");

	const evidence = await product.runHeldoutBase({
		tree,
		cacheDir: join(f.stateDir, "cache"),
		binding: f.binding,
		contract: f.contract,
		suite: f.suite,
		canary: f.canary,
		startedAt: Date.now(),
		deadline: Date.now() + 30_000,
		workDir: join(f.stateDir, "base"),
	});

	assert.equal(evidence.source.kind, "ready");
	assert.equal(assessBase(evidence).assessment.kind, "ready");

	for (const path of [".gitattributes", "src/.gitattributes"])
		f.put(path, "* text=auto eol=lf\n*.png binary\n");
	const sha = gitSha(f.commit());

	const receipt = await product.checkCandidate({
		...f,
		gateSha: sha,
		candidateSha: sha,
		repository: f.root,
		nonce: "safe-attributes",
		output: join(f.stateDir, "ci"),
		runner: miniRunner,
		install: false,
	});

	assert.equal(receipt.status, "passed", receipt.reason ?? "");

	const facts = await diagnoseExternal(product, {
		...f,
		gateSha: sha,
		candidateSha: sha,
	});

	assert.equal(facts.replay?.kind, "observed");
	assert.ok(facts.replay?.kind === "observed");
	assert.equal(facts.replay.gate.projection.passed, true);
	assert.equal(facts.replay.full.projection.passed, true);
});

for (const attribute of ["export-ignore", "export-subst", "filter=custom"]) {
	test(`unsafe attributes ${attribute} are source refusals before any runner call`, async (t) => {
		const product = await pinnedProduct(t);
		const f = await externalBase(t, product, false);
		const tree = join(f.root, "base-export");
		await exportTree(f.root, f.binding.baseSha, tree);
		writeFileSync(join(tree, ".gitattributes"), `src/value.ts ${attribute}\n`);
		let calls = 0;

		const runner: GateRunner = {
			kind: mustNotRun.kind,
			run(input) {
				calls++;

				return mustNotRun.run(input);
			},
		};

		for (const tooling of [undefined, "running-product"] as const) {
			const evidence = await product.runHeldoutBase({
				tooling,
				tree,
				cacheDir: join(f.stateDir, "cache"),
				binding: f.binding,
				contract: f.contract,
				suite: f.suite,
				canary: f.canary,
				startedAt: Date.now(),
				deadline: Date.now() + 30_000,
				workDir: join(f.stateDir, "base"),
				runner,
			});

			assert.equal(calls, 0);
			assert.deepEqual(evidence.source, {
				kind: "unavailable",
				reason: "tree_refused",
			});
			const assessed = assessBase(evidence);
			assert.equal(assessed.assessment.kind, "refused");
			assert.ok(assessed.assessment.kind === "refused");
			assert.equal(assessed.assessment.failure.reason, "base_tree_unsupported");
		}

		f.put(".gitattributes", `src/value.ts ${attribute}\n`);
		const sha = gitSha(f.commit());

		const receipt = await product.checkCandidate({
			...f,
			gateSha: sha,
			candidateSha: sha,
			repository: f.root,
			nonce: "unsafe-attributes",
			output: join(f.stateDir, "ci"),
			runner,
			install: false,
		});

		assert.equal(calls, 0);
		assert.equal(receipt.reason, "unsafe_tree");
		assert.equal(receipt.checks.length, 0);

		const stageDir = join(f.stateDir, "draft");
		mkdirSync(stageDir, { recursive: true, mode: 0o700 });

		const check = product.controllerDraftChecker({
			stateDir: f.stateDir,
			stageDir,
			attempt: 1,
			input: {
				contract: { ...f.contract, base: { ...f.contract.base, sha } },
				digest: f.binding.contractDigest,
				repo: f.binding.repo,
				issue: f.binding.issue,
				baseSha: sha,
				files: new Set(),
			},
			fetch: async () =>
				execFileSync("git", [
					"-C",
					f.root,
					"archive",
					"--format=tar.gz",
					"--prefix=target/",
					sha,
				]),
			runner,
		});

		const feedback = await check(f.text, {
			signal: new AbortController().signal,
			deadline: Date.now() + 30_000,
			run: 1,
		});

		assert.equal(calls, 0);
		assert.equal(feedback?.verdict, "would_refuse");
		assert.equal(feedback?.reason, "base_tree_unsupported");
		assert.match(feedback?.sentence ?? "", /tree was refused/);
	});
}

test("837b pinned qualification equals unchanged Factorio v1 base results", async (t) => {
	const product = await pinnedProduct(t);
	const f = await externalBase(t, product, false);
	const tree = join(f.root, "base-export");
	await exportTree(f.root, f.binding.baseSha, tree);

	const input = {
		tree,
		cacheDir: join(f.stateDir, "cache"),
		binding: f.binding,
		contract: f.contract,
		suite: f.suite,
		canary: f.canary,
		startedAt: Date.now(),
		deadline: Date.now() + 30_000,
	};

	const pinned = assessBase(
		await product.runHeldoutBase({
			...input,
			workDir: join(f.stateDir, "pinned"),
		}),
	);

	writeFileSync(join(tree, GATE_POLICY), readFileSync(GATE_POLICY));

	for (const path of MATERIALIZER_FILES) {
		mkdirSync(dirname(join(tree, path)), { recursive: true });
		cpSync(join(product.root, path), join(tree, path));
	}

	const repo = "nublai/pi-herdr-factorio";
	assert.ok(isRepoSlug(repo));

	const legacy = assessBase(
		await product.runHeldoutBase({
			...input,
			binding: { ...input.binding, repo },
			workDir: join(f.stateDir, "legacy"),
		}),
	);

	assert.equal(legacy.assessment.kind, "ready");
	assert.equal(pinned.assessment.kind, legacy.assessment.kind);
	assert.deepEqual(pinned.receipt.results, legacy.receipt.results);
	assert.equal(
		pinned.receipt.evidence.runtime.protocolDigest,
		legacy.receipt.evidence.runtime.protocolDigest,
	);

	for (const key of ["execution", "repeat"] as const) {
		const before = legacy.receipt.evidence[key];
		const after = pinned.receipt.evidence[key];
		assert.equal(before.kind, "observed");
		assert.equal(after.kind, "observed");
		assert.equal(after.exitCode, before.exitCode);
		assert.deepEqual(after.files, before.files);
	}
});

for (const [name, policy] of [
	["dropped toolingRevision", '{"version":1}'],
	["misspelled toolingRevision", '{"version":1,"toolingRevison":"missing"}'],
	["missing gates.json", null],
	["unparsable gates.json", "{"],
	["empty gates.json", ""],
	["array gates.json", "[]"],
	[
		"changed six-file identity",
		readFileSync(".github/factory/gates/gates.json", "utf8"),
	],
	[
		"unpinned external tree without the six files",
		readFileSync(".github/factory/gates/gates.json", "utf8"),
	],
] as const) {
	test(`837b draft check refuses ${name} before any runner call`, async (t) => {
		const product = await pinnedProduct(t);
		const f = await externalBase(t, product, false);

		if (policy === null) rmSync(join(f.root, GATE_POLICY));
		else f.put(GATE_POLICY, policy);

		if (name === "changed six-file identity") {
			for (const path of MATERIALIZER_FILES)
				f.put(path, readFileSync(join(product.root, path), "utf8"));
			rmSync(join(f.root, "host/gates/base.ts"));
		}

		f.git("add", "-A", "--", ".github");

		if (name === "changed six-file identity") f.git("add", "host");
		f.git("commit", "-qm", "unverified base");
		const sha = gitSha(f.git("rev-parse", "HEAD"));
		const stageDir = join(f.stateDir, "draft");
		mkdirSync(stageDir, { recursive: true, mode: 0o700 });
		let calls = 0;

		const check = product.controllerDraftChecker({
			stateDir: f.stateDir,
			stageDir,
			attempt: 1,
			input: {
				contract: { ...f.contract, base: { ...f.contract.base, sha } },
				digest: f.binding.contractDigest,
				repo: f.binding.repo,
				issue: f.binding.issue,
				baseSha: sha,
				files: new Set(),
			},
			fetch: async () =>
				execFileSync("git", [
					"-C",
					f.root,
					"archive",
					"--format=tar.gz",
					"--prefix=target/",
					sha,
				]),
			runner: {
				kind: localRunner.kind,
				run(input) {
					calls++;

					return localRunner.run(input);
				},
			},
		});

		const feedback = await check(f.text, {
			signal: new AbortController().signal,
			deadline: Date.now() + 30_000,
			run: 1,
		});

		const receipt = JSON.parse(
			readFileSync(join(stageDir, "draft-1.json"), "utf8"),
		).receipt;

		assert.equal(calls, 0);
		assert.equal(feedback?.verdict, "would_refuse");
		assert.equal(feedback?.reason, "base_tree_unsupported");
		assert.deepEqual(receipt.evidence.source, {
			kind: "unavailable",
			reason: "tree_refused",
		});
	});
}

for (const mode of [
	"installed-product lag",
	"accepted N1 gate assets",
] as const) {
	test(`837b self-hosted Factorio v1 draft qualifies with ${mode}`, async (t) => {
		const product = await pinnedProduct(t);
		const f = await externalBase(t, product, false);
		f.put(GATE_POLICY, readFileSync(GATE_POLICY, "utf8"));

		for (const path of MATERIALIZER_FILES)
			f.put(
				path,
				readFileSync(join(product.root, path), "utf8") +
					(mode === "installed-product lag" ? "\n" : ""),
			);

		assert.equal(
			materializerIdentity(f.root).equals(materializerIdentity(product.root)),
			mode !== "installed-product lag",
		);

		for (const name of ["freeze.mjs", "reporter.mjs", "scan-rules.json"]) {
			const path = `.github/factory/gates/${name}`;
			f.put(path, readFileSync(join(product.root, path), "utf8") + "\n");
			assert.ok(
				!readFileSync(join(f.root, path)).equals(
					readFileSync(join(product.root, path)),
				),
			);
		}

		f.git("add", "host", ".github");
		f.git("commit", "-qm", mode);
		const sha = gitSha(f.git("rev-parse", "HEAD"));
		const stageDir = join(f.stateDir, "draft");
		mkdirSync(stageDir, { recursive: true, mode: 0o700 });
		let calls = 0;
		const repo = "nublai/pi-herdr-factorio";
		assert.ok(isRepoSlug(repo));

		const check = product.controllerDraftChecker({
			stateDir: f.stateDir,
			stageDir,
			attempt: 1,
			input: {
				contract: { ...f.contract, base: { repo, sha } },
				digest: f.binding.contractDigest,
				repo,
				issue: f.binding.issue,
				baseSha: sha,
				files: new Set(),
			},
			fetch: async () =>
				execFileSync("git", [
					"-C",
					f.root,
					"archive",
					"--format=tar.gz",
					"--prefix=target/",
					sha,
				]),
			runner: {
				kind: localRunner.kind,
				run(input) {
					calls++;

					return localRunner.run(input);
				},
			},
		});

		const feedback = await check(f.text, {
			signal: new AbortController().signal,
			deadline: Date.now() + 30_000,
			run: 1,
		});

		assert.equal(feedback?.verdict, "would_qualify");
		assert.equal(calls, 2);

		const receipt = JSON.parse(
			readFileSync(join(stageDir, "draft-1.json"), "utf8"),
		).receipt;

		assert.equal(receipt.evidence.source.kind, "ready");
		assert.equal(receipt.evidence.execution.kind, "observed");
		assert.equal(receipt.evidence.repeat.kind, "observed");
	});
}

for (const [name, pin] of [
	["null pin", null],
	["bad pin", "bad"],
	["unparsable pin-looking policy", "{"],
] as const) {
	test(`837b base refuses ${name} even with six files`, async (t) => {
		const product = await pinnedProduct(t);
		const f = await externalBase(t, product, false);
		const tree = join(f.root, "base-export");
		await exportTree(f.root, f.binding.baseSha, tree);
		writeFileSync(
			join(tree, GATE_POLICY),
			pin === "{"
				? '{"version":1,"toolingRevision":'
				: JSON.stringify({
						...JSON.parse(readFileSync(GATE_POLICY, "utf8")),
						toolingRevision: pin,
					}),
		);

		for (const path of MATERIALIZER_FILES) {
			mkdirSync(dirname(join(tree, path)), { recursive: true });
			cpSync(join(product.root, path), join(tree, path));
		}

		let calls = 0;

		const evidence = await product.runHeldoutBase({
			tree,
			cacheDir: join(f.stateDir, "cache"),
			binding: f.binding,
			contract: f.contract,
			suite: f.suite,
			canary: f.canary,
			startedAt: Date.now(),
			deadline: Date.now() + 30_000,
			workDir: join(f.stateDir, "malformed"),
			runner: {
				kind: mustNotRun.kind,
				run(input) {
					calls++;

					return mustNotRun.run(input);
				},
			},
		});

		assert.equal(calls, 0);
		assert.deepEqual(evidence.source, {
			kind: "unavailable",
			reason: "tree_refused",
		});
	});
}

test("837b running-product base and draft qualification accept the bench's historical tooling", async (t) => {
	const product = await pinnedProduct(t);
	const f = await externalBase(t, product, true);
	const tree = join(f.root, "bench-base");
	await exportTree(f.root, f.binding.baseSha, tree);

	const input = {
		tooling: "running-product" as const,
		tree,
		cacheDir: join(f.stateDir, "cache"),
		binding: f.binding,
		contract: f.contract,
		suite: f.suite,
		canary: f.canary,
		startedAt: Date.now(),
		deadline: Date.now() + 30_000,
	};

	const base = await product.runHeldoutBase({
		...input,
		workDir: join(f.stateDir, "bench"),
	});

	assert.equal(assessBase(base).assessment.kind, "ready");
	const stageDir = join(f.stateDir, "draft");
	mkdirSync(stageDir, { recursive: true, mode: 0o700 });

	const check = product.controllerDraftChecker({
		tooling: "running-product",
		stateDir: f.stateDir,
		stageDir,
		attempt: 1,
		input: {
			contract: f.contract,
			digest: f.binding.contractDigest,
			repo: f.binding.repo,
			issue: f.binding.issue,
			baseSha: f.binding.baseSha,
			files: new Set(),
		},
		fetch: f.fetch,
	});

	const feedback = await check(f.text, {
		signal: new AbortController().signal,
		deadline: Date.now() + 30_000,
		run: 1,
	});

	assert.equal(feedback?.verdict, "would_qualify");
});

test("837b draft check refuses a pinned target with a changed reporter before execution", async (t) => {
	const product = await pinnedProduct(t);
	const f = await externalBase(t, product, true);
	let calls = 0;
	const stageDir = join(f.stateDir, "draft");
	mkdirSync(stageDir, { recursive: true, mode: 0o700 });

	const check = product.controllerDraftChecker({
		stateDir: f.stateDir,
		stageDir,
		attempt: 1,
		input: {
			contract: f.contract,
			digest: f.binding.contractDigest,
			repo: f.binding.repo,
			issue: f.binding.issue,
			baseSha: f.binding.baseSha,
			files: new Set(),
		},
		fetch: f.fetch,
		runner: {
			kind: localRunner.kind,
			run(input) {
				calls++;

				return localRunner.run(input);
			},
		},
	});

	const feedback = await check(f.text, {
		signal: new AbortController().signal,
		deadline: Date.now() + 30_000,
		run: 1,
	});

	assert.equal(feedback?.verdict, "would_refuse");
	assert.equal(feedback?.reason, "base_tree_unsupported");

	const receipt = JSON.parse(
		readFileSync(join(stageDir, "draft-1.json"), "utf8"),
	).receipt;

	assert.deepEqual(receipt.evidence.source, {
		kind: "unavailable",
		reason: "tree_refused",
	});
	assert.equal(calls, 0);
});

test("837b accept held-out base qualification refuses a pinned target with a changed reporter", {
	timeout: 30_000,
}, async (t) => {
	const product = await pinnedProduct(t);
	const f = await externalBase(t, product, true);

	const checker = product.controllerBaseChecker({
		stateDir: f.stateDir,
		fetch: f.fetch,
	});

	const input = {
		binding: f.binding,
		acceptAttempt: 1,
		remainingAcceptMs: 30_000,
		signal: new AbortController().signal,
	};

	assert.equal((await checker.check(input)).kind, "checking");
	await new Promise<void>((resolve, reject) => {
		const watcher = watch(
			join(
				f.stateDir,
				"base-check",
				f.contract.runId,
				digestOf(JSON.stringify(f.binding)),
				"a1",
			),
			(_event, name) => {
				if (name === "result.json") {
					watcher.close();
					resolve();
				}
			},
		);

		watcher.on("error", reject);
		t.after(() => watcher.close());
	});
	await checker.stop(f.contract.runId);
	const progress = await checker.check({ ...input, readOnly: true });
	assert.equal(progress.kind, "refused");

	if (progress.kind === "refused")
		assert.equal(progress.failure.reason, "base_tree_unsupported");

	const receipt = JSON.parse(
		readFileSync(
			join(
				f.stateDir,
				"base-check",
				f.contract.runId,
				digestOf(JSON.stringify(f.binding)),
				"a1/result.json",
			),
			"utf8",
		),
	);

	assert.deepEqual(receipt.evidence.source, {
		kind: "unavailable",
		reason: "tree_refused",
	});
	assert.equal(receipt.evidence.execution.kind, "unavailable");
});

test("837b diagnosis fresh base refuses a pinned target with a changed reporter before execution", async (t) => {
	const product = await pinnedProduct(t);
	const f = await externalBase(t, product, true);
	let calls = 0;

	const owner = product.controllerDiagnosis({
		stateDir: f.stateDir,
		fetch: f.fetch,
		runner: {
			kind: localRunner.kind,
			run(input) {
				calls++;

				return localRunner.run(input);
			},
		},
	});

	const facts = await new Promise<DiagnosisFacts>((finish, reject) => {
		void owner
			.check({
				runId: f.contract.runId,
				dir: f.stateDir,
				bindingDigest: digestOf("fresh-pinned-base"),
				repo: f.binding.repo,
				gateSha: f.binding.gateSha,
				candidateSha: f.binding.gateSha,
				round: 0,
				allowanceMs: 30_000,
				needs: { replay: true, dependencies: false },
				heldoutDir: f.heldoutDir,
				heldoutDigest: f.heldoutDigest,
				replacements: [],
				base: {
					kind: "fresh",
					binding: f.binding,
					contract: f.contract,
					suite: f.suite,
					canary: f.canary,
				},
				finish,
				interrupted: () => assert.fail("unexpected interruption"),
			})
			.catch(reject);
	});

	await owner.stop(f.contract.runId);
	assert.equal(facts.baseRefusal, "base_tree_unsupported");
	assert.deepEqual(facts.base?.evidence.source, {
		kind: "unavailable",
		reason: "tree_refused",
	});
	assert.equal(
		facts.replay?.kind === "unavailable" ? facts.replay.reason : null,
		"unsupported_materializer",
	);
	assert.equal(calls, 0);
});

for (const name of ["freeze.mjs", "reporter.mjs", "scan-rules.json"]) {
	test(`837d gates refuse a spoofed Factorio origin with changed ${name}`, async (t) => {
		const f = repo(t);
		f.git(
			"remote",
			"set-url",
			"origin",
			"https://github.com/giuseppecrj/pi-herdr-agents.git",
		);
		const path = `.github/factory/gates/${name}`;
		f.put(path, readFileSync(join(f.root, path), "utf8") + "\n");
		const gateSha = f.commit();
		f.git(
			"remote",
			"set-url",
			"origin",
			"https://github.com/nublai/pi-herdr-factorio.git",
		);
		let calls = 0;

		const receipt = await checkCandidate({
			...gateInput(f, gateSha),
			gateSha,
			runner: {
				kind: miniRunner.kind,
				run(input) {
					calls++;

					return miniRunner.run(input);
				},
			},
		});

		t.diagnostic(
			`origin-spoof ${name}: runner calls=${calls}, status=${receipt.status}, reason=${receipt.reason}`,
		);
		assert.equal(calls, 0, "spoofed origin must not reach the runner");
		assert.equal(receipt.reason, "unsupported_materializer");
		assert.equal(receipt.checks.length, 0);
	});

	test(`837d replay refuses self-hosted Factorio with changed ${name}`, async (t) => {
		const product = await pinnedProduct(t);
		const f = externalTarget(t, product.revision);
		f.put(GATE_POLICY, readFileSync(GATE_POLICY, "utf8"));

		for (const path of MATERIALIZER_FILES)
			f.put(path, readFileSync(join(product.root, path), "utf8"));
		const path = `.github/factory/gates/${name}`;
		f.put(path, readFileSync(join(product.root, path), "utf8") + "\n");
		const sha = gitSha(f.commit());
		let calls = 0;

		const facts = await diagnoseExternal(
			product,
			{ ...f, gateSha: sha, candidateSha: sha },
			{
				kind: mustNotRun.kind,
				run(input) {
					calls++;

					return mustNotRun.run(input);
				},
			},
			"nublai/pi-herdr-factorio",
		);

		assert.equal(calls, 0);
		assert.equal(
			facts.replay?.kind === "unavailable" ? facts.replay.reason : null,
			"unsupported_materializer",
		);
	});
}

test("837d gates use trusted identity and nine files, never origin, to self-host", async (t) => {
	const f = repo(t);

	for (const path of [
		...MATERIALIZER_FILES,
		...["freeze.mjs", "reporter.mjs", "scan-rules.json"].map(
			(name) => `.github/factory/gates/${name}`,
		),
	])
		assert.ok(readFileSync(join(f.root, path)).equals(readFileSync(path)));

	const results = [];

	for (const targetRepository of [
		"nublai/pi-herdr-factorio",
		"giuseppecrj/pi-herdr-agents",
		undefined,
	])
		for (const origin of [
			"https://github.com/nublai/pi-herdr-factorio.git",
			"https://github.com/giuseppecrj/pi-herdr-agents.git",
			null,
		]) {
			f.git("config", "remote.origin.url", origin ?? "unused");

			if (origin === null) f.git("config", "--unset-all", "remote.origin.url");
			let calls = 0;

			const receipt = await checkCandidate({
				...gateInput(f, f.gateSha),
				targetRepository,
				output: join(f.root, `identity-${results.length}`),
				runner: {
					kind: miniRunner.kind,
					run(input) {
						calls++;

						return miniRunner.run(input);
					},
				},
			});

			const result = {
				targetRepository,
				origin,
				calls,
				status: receipt.status,
				reason: receipt.reason,
			};

			t.diagnostic(JSON.stringify(result));
			results.push(result);
		}

	for (const result of results) {
		if (result.targetRepository === "nublai/pi-herdr-factorio") {
			assert.equal(result.status, "passed", JSON.stringify(result));
			assert.ok(result.calls > 0);
		} else {
			assert.equal(
				result.reason,
				"unsupported_materializer",
				JSON.stringify(result),
			);
			assert.equal(result.calls, 0);
		}
	}
});

test("837d Factorio hosted-CI invocation self-hosts with the workflow's repository identity", (t) => {
	if (!sandboxAvailable(t)) return;
	const f = repo(t);
	f.git("remote", "remove", "origin");
	const workflow = parseYaml(readFileSync(".github/workflows/ci.yml", "utf8"));

	const step = workflow.jobs.gates.steps.find(
		(s: { name?: string }) => s.name === "Run trusted gates",
	);

	assert.equal(step.env.TARGET_REPO, "${{ github.repository }}");
	assert.match(step.run, /--target-repo "\$TARGET_REPO"/);
	const output = join(f.root, "actions");

	const result = spawnSync(
		"bash",
		[
			"-euc",
			`${step.run.trimEnd().replace("host/cli/index.ts", JSON.stringify(resolve("host/cli/index.ts")))} --runner local`,
		],
		{
			cwd: f.root,
			encoding: "utf8",
			timeout: 30_000,
			env: {
				PATH: process.env.PATH,
				HOME: f.root,
				TMPDIR: tmpdir(),
				CANDIDATE_SHA: f.gateSha,
				GATE_SHA: f.gateSha,
				NONCE: "hosted-ci",
				TARGET_REPO: "nublai/pi-herdr-factorio",
				RUNNER_TEMP: output,
				REPLACEMENTS: "[]",
				REPLACEMENTS_DIGEST: replacementDigest([]),
				HELDOUT_DIR: "",
				HELDOUT_DIGEST: "",
			},
		},
	);

	assert.equal(result.status, 0, result.stderr || result.stdout);

	const receipt = JSON.parse(
		readFileSync(join(output, "gate-results/receipt.json"), "utf8"),
	);

	assert.equal(receipt.status, "passed");
	assert.equal(receipt.nonce, "hosted-ci");
	assert.equal(receipt.checks.length, 9);
	assert.equal(receiptPasses(receipt), true);
});

test("837d private gates derive repository identity from the verified contract and refuse conflicts", async (t) => {
	if (!sandboxAvailable(t)) return;
	const product = await pinnedProduct(t);
	const f = await externalBase(t, product, false);

	const policy = JSON.parse(readFileSync(join(f.root, GATE_POLICY), "utf8"));
	f.put(GATE_POLICY, JSON.stringify({ ...policy, toolingRevision: undefined }));

	for (const path of MATERIALIZER_FILES)
		f.put(path, readFileSync(join(product.root, path), "utf8"));
	const sha = gitSha(f.commit());
	const repo = "nublai/pi-herdr-factorio";
	assert.ok(isRepoSlug(repo));

	const contract: Contract = {
		...f.contract,
		runId: digestOf("trusted private gate repo"),
		base: { repo, sha },
	};

	const bytes = contractBytes(contract);
	const digest = contractDigestOf(bytes);
	assert.ok(
		await fileRunFiles(f.stateDir).writeContract({ contract, bytes, digest }),
	);
	f.git("remote", "set-url", "origin", "https://github.com/other/target.git");

	for (const [label, args, expected] of [
		["contract", [], 0],
		["matching", ["--target-repo", repo], 0],
		["conflict", ["--target-repo", "other/target"], 2],
		["invalid", ["--target-repo", "not-a-slug"], 2],
	] as const) {
		const output = join(f.root, `private-${label}`);

		const result = spawnSync(
			process.execPath,
			[
				join(product.root, "host/cli/index.ts"),
				"gates",
				"--repository",
				f.root,
				"--gate-sha",
				sha,
				"--candidate-sha",
				sha,
				"--nonce",
				"private-ci",
				"--output",
				output,
				"--runner",
				"local",
				"--state-dir",
				f.stateDir,
				"--run-id",
				contract.runId,
				"--contract-digest",
				digest,
				...args,
			],
			{ encoding: "utf8", timeout: 30_000 },
		);

		assert.equal(result.status, expected, result.stderr || result.stdout);

		if (expected === 0) {
			const receipt = JSON.parse(
				readFileSync(join(output, "receipt.json"), "utf8"),
			);

			assert.equal(receiptPasses(receipt), true);
		} else {
			assert.match(
				result.stderr,
				label === "conflict" ? /target_repo_mismatch/ : /invalid_target_repo/,
			);
			assert.equal(existsSync(join(output, "receipt.json")), false);
		}
	}
});

for (const policyCase of [
	"six empty files and changed reporter",
	"six copied files without a pin",
] as const) {
	for (const surface of ["base", "gates", "replay"] as const) {
		test(`837d non-Factorio ${surface} refuses ${policyCase} before any runner call`, async (t) => {
			const product = await pinnedProduct(t);
			const f = await externalBase(t, product, false);

			const policy = JSON.parse(
				readFileSync(join(f.root, GATE_POLICY), "utf8"),
			);

			f.put(
				GATE_POLICY,
				JSON.stringify({ ...policy, toolingRevision: undefined }),
			);

			for (const path of MATERIALIZER_FILES)
				f.put(
					path,
					policyCase === "six copied files without a pin"
						? readFileSync(join(product.root, path), "utf8")
						: "",
				);

			if (policyCase === "six empty files and changed reporter")
				f.put(
					".github/factory/gates/reporter.mjs",
					readFileSync(".github/factory/gates/reporter.mjs", "utf8") + "\n",
				);
			const sha = gitSha(f.commit());
			let calls = 0;

			const runner: GateRunner = {
				kind: localRunner.kind,
				run(input) {
					calls++;

					return localRunner.run(input);
				},
			};

			if (surface === "base") {
				const tree = join(f.root, "base-export");
				await exportTree(f.root, sha, tree);

				const evidence = await product.runHeldoutBase({
					tree,
					workDir: join(f.stateDir, "refused"),
					cacheDir: join(f.stateDir, "cache"),
					binding: { ...f.binding, baseSha: sha, gateSha: sha },
					contract: f.contract,
					suite: f.suite,
					canary: f.canary,
					startedAt: Date.now(),
					deadline: Date.now() + 30_000,
					runner,
				});

				assert.deepEqual(evidence.source, {
					kind: "unavailable",
					reason: "tree_refused",
				});
			} else if (surface === "gates") {
				const receipt = await product.checkCandidate({
					repository: f.root,
					targetRepository: f.binding.repo,
					gateSha: sha,
					candidateSha: sha,
					nonce: "unpinned-external",
					output: join(f.root, "out"),
					runner,
					install: false,
				});

				assert.equal(receipt.reason, "unsupported_materializer");
				assert.equal(receipt.checks.length, 0);
			} else {
				const facts = await diagnoseExternal(
					product,
					{ ...f, gateSha: sha, candidateSha: sha },
					runner,
				);

				assert.equal(
					facts.replay?.kind === "unavailable" ? facts.replay.reason : null,
					"unsupported_materializer",
				);
			}

			assert.equal(calls, 0);
		});
	}
}

for (const step of ["tamper scan", "dependency install"] as const) {
	test(`837d pin refusal precedes ${step}`, async (t) => {
		const product = await pinnedProduct(t);
		const f = await externalBase(t, product, true);
		const tree = join(f.root, "base-export");
		await exportTree(f.root, f.binding.baseSha, tree);
		let suite = f.suite;

		if (step === "tamper scan") {
			suite = {
				...suite,
				files: suite.files.map((file) => ({
					...file,
					content: file.content + "\nprocess.exitCode = 0;\n",
				})),
			};
		} else {
			writeFileSync(
				join(tree, "package.json"),
				JSON.stringify({
					name: "mini",
					version: "1.0.0",
					dependencies: { yaml: "2.9.0" },
				}),
			);
			writeFileSync(
				join(tree, "package-lock.json"),
				JSON.stringify({
					lockfileVersion: 3,
					packages: {
						"": {
							name: "mini",
							version: "1.0.0",
							dependencies: { yaml: "2.9.0" },
						},
						"node_modules/yaml": {
							version: "2.9.0",
							resolved: "https://registry.npmjs.org/yaml/-/yaml-2.9.0.tgz",
							integrity:
								"sha512-2AvhNX3mb8zd6Zy7INTtSpl1F15HW6Wnqj0srWlkKLcpYl/gMIMJiyuGq2KeI2YFxUPjdlB+3Lc10seMLtL4cA==",
						},
					},
				}),
			);
		}

		let calls = 0;

		const evidence = await product.runHeldoutBase({
			tree,
			workDir: join(f.stateDir, "ordered"),
			cacheDir: join(f.stateDir, "cache"),
			binding: f.binding,
			contract: f.contract,
			suite,
			canary: f.canary,
			startedAt: Date.now(),
			deadline: Date.now() + 30_000,
			runner: {
				kind: mustNotRun.kind,
				run(input) {
					calls++;

					return mustNotRun.run(input);
				},
			},
		});

		assert.equal(calls, 0);
		assert.equal("tamper" in evidence, false);
		assert.deepEqual(evidence.source, {
			kind: "unavailable",
			reason: "tree_refused",
		});
	});
}

test("837d diagnosis checks pinned main, not the candidate's unpinned six-file tree", async (t) => {
	const product = await pinnedProduct(t);
	const f = await externalBase(t, product, true);
	f.put(GATE_POLICY, readFileSync(GATE_POLICY, "utf8"));

	for (const path of MATERIALIZER_FILES)
		f.put(path, readFileSync(join(product.root, path), "utf8"));
	const candidateSha = gitSha(f.commit());
	const repo = "nublai/pi-herdr-factorio";
	assert.ok(isRepoSlug(repo));
	let calls = 0;

	const owner = product.controllerDiagnosis({
		stateDir: f.stateDir,
		fetch: async (_repo, sha) =>
			execFileSync("git", [
				"-C",
				f.root,
				"archive",
				"--format=tar.gz",
				"--prefix=target/",
				sha,
			]),
		runner: {
			kind: mustNotRun.kind,
			run(input) {
				calls++;

				return mustNotRun.run(input);
			},
		},
	});

	const facts = await new Promise<DiagnosisFacts>((finish, reject) => {
		void owner
			.check({
				runId: f.contract.runId,
				dir: f.stateDir,
				bindingDigest: digestOf("candidate-dropped-pin"),
				repo,
				gateSha: f.binding.gateSha,
				candidateSha,
				round: 0,
				allowanceMs: 30_000,
				needs: { replay: true, dependencies: false },
				heldoutDir: f.heldoutDir,
				heldoutDigest: f.heldoutDigest,
				replacements: [],
				base: {
					kind: "fresh",
					binding: { ...f.binding, repo },
					contract: { ...f.contract, base: { ...f.contract.base, repo } },
					suite: f.suite,
					canary: f.canary,
				},
				finish,
				interrupted: () => assert.fail("unexpected interruption"),
			})
			.catch(reject);
	});

	await owner.stop(f.contract.runId);
	assert.equal(facts.baseRefusal, "base_tree_unsupported");
	assert.deepEqual(facts.base?.evidence.source, {
		kind: "unavailable",
		reason: "tree_refused",
	});
	assert.equal(calls, 0);
});

for (const [member, text] of [
	[
		"reporter.mjs",
		'export default async function* () { yield \'{"counts":{},"bad":false}\\n\'; }\n',
	],
	["freeze.mjs", ""],
	[
		"scan-rules.json",
		'{"version":1,"suppression":"never-match","processMembers":[],"processEvents":[],"loaderCalls":[],"mutators":[]}',
	],
]) {
	test(`R3 B1 refuses changed target ${member} before gates and replay`, async (t) => {
		const product = await pinnedProduct(t);
		const f = externalTarget(t, product.revision);
		f.put(`.github/factory/gates/${member}`, text ?? "");
		const gateSha = gitSha(f.commit());
		await externalRefused(product, { ...f, gateSha, candidateSha: gateSha });
	});
}

test("R3 F2 refuses an older pin with identical materializer files when installed HEAD is newer", async (t) => {
	const product = await pinnedProduct(t);
	product.git(
		"-c",
		"user.name=Gate test",
		"-c",
		"user.email=gate@example.invalid",
		"commit",
		"--allow-empty",
		"-qm",
		"newer product",
	);
	assert.equal(
		product.git("diff", product.revision, "HEAD", "--", ...MATERIALIZER_FILES),
		"",
	);
	assert.equal(product.git("status", "--porcelain"), "");
	await externalRefused(product, externalTarget(t, product.revision));
});

for (const member of [
	"host/cli/index.ts",
	"package-lock.json",
	"src/candidate/review.ts",
	".github/factory/gates/scan.ts",
	"src/core/json.ts",
	"src/trust/protected-paths.ts",
]) {
	test(`R3 F3 verifies imported product member ${member} even when git status is clean`, async (t) => {
		const product = await pinnedProduct(t);
		product.git("update-index", "--skip-worktree", member);
		writeFileSync(
			join(product.root, member),
			readFileSync(join(product.root, member), "utf8") + "\n",
		);
		assert.equal(product.git("status", "--porcelain"), "");
		await externalRefused(product, externalTarget(t, product.revision));
	});
}

for (const key of [undefined, "toolingRevison"]) {
	test(`R3 unpinned external v1 target refuses before execution (${key ?? "missing pin"})`, async (t) => {
		const product = await pinnedProduct(t);
		const f = externalTarget(t, product.revision);

		const policy = JSON.parse(readFileSync(join(f.root, GATE_POLICY), "utf8"));

		delete policy.toolingRevision;

		if (key !== undefined) policy[key] = product.revision;
		f.put(GATE_POLICY, JSON.stringify(policy));
		f.put(".github/factory/gates/reporter.mjs", "throw new Error('DRIFT');\n");
		const gateSha = gitSha(f.commit());
		await externalRefused(product, { ...f, gateSha, candidateSha: gateSha });
	});
}

test("R3 CI gates CLI refuses an external target without a pin and exposes no running-product override", async (t) => {
	const product = await pinnedProduct(t);
	const f = externalTarget(t, product.revision);
	const policy = JSON.parse(readFileSync(join(f.root, GATE_POLICY), "utf8"));
	delete policy.toolingRevision;
	f.put(GATE_POLICY, JSON.stringify(policy));
	f.put(
		".github/factory/gates/reporter.mjs",
		"throw new Error('unverified reporter ran');\n",
	);
	const gateSha = gitSha(f.commit());
	const output = join(f.root, "unpinned-cli-output");

	const argv = [
		join(product.root, "host/cli/index.ts"),
		"gates",
		"--repository",
		f.root,
		"--gate-sha",
		gateSha,
		"--candidate-sha",
		gateSha,
		"--nonce",
		"unpinned-ci",
		"--output",
		output,
		"--runner",
		"local",
	];

	const result = spawnSync(process.execPath, argv, {
		encoding: "utf8",
		timeout: 30_000,
	});

	assert.equal(result.status, 1, result.stderr || result.stdout);

	const receipt = JSON.parse(
		readFileSync(join(output, "receipt.json"), "utf8"),
	);

	assert.equal(receipt.status, "incomplete");
	assert.equal(receipt.reason, "unsupported_materializer");
	assert.equal(receipt.checks.length, 0);

	for (const option of ["--tooling", "--tooling-source"]) {
		const bypassOutput = join(f.root, option.slice(2));

		const bypass = spawnSync(
			process.execPath,
			[...argv, "--output", bypassOutput, option, "running-product"],
			{ encoding: "utf8", timeout: 30_000 },
		);

		assert.equal(bypass.status, 2, bypass.stderr || bypass.stdout);
		assert.match(bypass.stderr, /Unknown option/);
		assert.equal(existsSync(join(bypassOutput, "receipt.json")), false);
	}
});

for (const pin of [undefined, "b".repeat(40)]) {
	test(`R3 PROBE2 gate and replay retain main's pin when the candidate ${pin === undefined ? "deletes" : "replaces"} it`, async (t) => {
		const product = await pinnedProduct(t);
		const f = externalTarget(t, product.revision);

		const policy = JSON.parse(readFileSync(join(f.root, GATE_POLICY), "utf8"));

		f.put(GATE_POLICY, JSON.stringify({ ...policy, toolingRevision: pin }));

		for (const member of MATERIALIZER_FILES)
			f.put(member, readFileSync(join(product.root, member), "utf8"));
		const candidateSha = gitSha(f.commit());
		const member = "package-lock.json";
		product.git("update-index", "--skip-worktree", member);
		writeFileSync(
			join(product.root, member),
			readFileSync(join(product.root, member), "utf8") + "\n",
		);
		assert.equal(product.git("status", "--porcelain"), "");
		await externalRefused(product, { ...f, candidateSha });
	});
}

test("R3 F3 includes a new transitive gate import in the pinned identity", async (t) => {
	const product = await pinnedProduct(t, (root) => {
		const path = join(root, "host/gates/manifest.ts");
		writeFileSync(
			path,
			'import "./pin-helper.ts";\n' + readFileSync(path, "utf8"),
		);
		writeFileSync(
			join(root, "host/gates/pin-helper.ts"),
			"export const trusted = true;\n",
		);
	});

	const f = externalTarget(t, product.revision);

	const materialize: typeof import("../../../host/gates/materialize.ts") =
		await import(
			pathToFileURL(join(product.root, "host/gates/materialize.ts")).href
		);

	const identity = materialize.gateMaterializerIdentity(
		f.root,
		"giuseppecrj/pi-herdr-agents",
	);

	assert.ok(identity.toString().includes('"host/gates/pin-helper.ts"'));
	assert.ok(
		identity.equals(materialize.productMaterializerIdentity(product.root)),
	);
	product.git("update-index", "--skip-worktree", "host/gates/pin-helper.ts");
	writeFileSync(
		join(product.root, "host/gates/pin-helper.ts"),
		"export const trusted = false;\n",
	);
	assert.equal(product.git("status", "--porcelain"), "");
	await externalRefused(product, f);
});

for (const member of ["package.json", "untracked.txt"]) {
	test(`R3 F3 refuses a dirty product worktree (${member})`, async (t) => {
		const product = await pinnedProduct(t);
		const path = join(product.root, member);
		writeFileSync(
			path,
			(existsSync(path) ? readFileSync(path, "utf8") : "") + "\n",
		);
		await externalRefused(product, externalTarget(t, product.revision));
	});
}

test("R3 F4 version 2 refuses unknown top-level keys including a misspelled pin; version 1 stays unchanged", async (t) => {
	const f = agentsRepo(t);

	for (const key of ["toolingRevison", "unknown"]) {
		f.put(
			GATE_POLICY,
			JSON.stringify({ ...agentsPolicy(), [key]: "a".repeat(40) }),
		);
		assert.throws(() => manifestOf(f.root), /invalid_gate_manifest/);
		const gateSha = f.commit();

		const receipt = await checkCandidate({
			repository: f.root,
			gateSha,
			candidateSha: gateSha,
			nonce: "typo-pin",
			output: join(f.root, "refused-output"),
			runner: {
				kind: "must-not-run",
				run: async () => assert.fail("invalid policy ran"),
			},
		});

		assert.equal(receipt.reason, "invalid_gate_manifest");
		assert.equal(receipt.checks.length, 0);
	}

	const legacy = repo(t);

	const policy = JSON.parse(
		readFileSync(join(legacy.root, GATE_POLICY), "utf8"),
	);

	legacy.put(GATE_POLICY, JSON.stringify({ ...policy, unknown: true }));
	assert.equal(manifestOf(legacy.root).version, 1);
});

test("R3 F6 pin checks ignore ambient global git configuration", async (t) => {
	const home = mkdtempSync(join(tmpdir(), "factory-git-home-"));
	t.after(() => rmSync(home, { recursive: true, force: true }));
	writeFileSync(join(home, ".gitconfig"), "[invalid config\n");

	const product = await pinnedProduct(t, (root) => {
		const path = join(root, "host/gates/runner.ts");
		writeFileSync(
			path,
			readFileSync(path, "utf8").replace(
				'HOME: "/tmp",',
				`HOME: ${JSON.stringify(home)},`,
			),
		);
	});

	const materialize: typeof import("../../../host/gates/materialize.ts") =
		await import(
			pathToFileURL(join(product.root, "host/gates/materialize.ts")).href
		);

	const f = externalTarget(t, product.revision);
	assert.ok(
		materialize
			.gateMaterializerIdentity(f.root, "giuseppecrj/pi-herdr-agents")
			.equals(materialize.productMaterializerIdentity(product.root)),
	);
});

test("R3 G1 missing gates.json is refused by gates and by external-target replay", async (t) => {
	const product = await pinnedProduct(t);
	const f = externalTarget(t, product.revision);

	for (const member of MATERIALIZER_FILES)
		f.put(member, readFileSync(join(product.root, member), "utf8"));
	rmSync(join(f.root, GATE_POLICY));
	const gateSha = gitSha(f.commit());
	const gateTree = join(f.root, "gate-export");
	await exportTree(f.root, gateSha, gateTree);

	const materialize: typeof import("../../../host/gates/materialize.ts") =
		await import(
			pathToFileURL(join(product.root, "host/gates/materialize.ts")).href
		);

	assert.ok(
		materialize
			.gateMaterializerIdentity(gateTree, "nublai/pi-herdr-factorio")
			.equals(materialize.materializerIdentity(product.root)),
	);
	assert.throws(
		() =>
			materialize.materializeFromDirectories({
				gateTree,
				candidateTree: gateTree,
				dest: join(f.root, "refused-tree"),
				replacements: [],
			}),
		/^Error: invalid_gate_manifest$/,
	);

	const receipt = await product.checkCandidate({
		repository: f.root,
		gateSha,
		candidateSha: gateSha,
		nonce: "missing-policy",
		output: join(f.root, "refused-output"),
		runner: {
			kind: "must-not-run",
			run: async () => assert.fail("missing policy ran"),
		},
	});

	assert.equal(receipt.reason, "invalid_gate_manifest");

	const facts = await diagnoseExternal(
		product,
		{
			...f,
			gateSha,
			candidateSha: gateSha,
		},
		mustNotRun,
	);

	assert.ok(facts.replay?.kind === "unavailable");
	assert.equal(facts.replay.reason, "unsupported_materializer");
});

test("R3 external target without Factorio source passes the gates CLI and both diagnostic replays", async (t) => {
	if (!sandboxAvailable(t)) return;
	const product = await pinnedProduct(t);
	const f = externalTarget(t, product.revision);
	assert.equal(existsSync(join(f.root, "host")), false);
	const output = join(f.root, "cli-output");

	const result = spawnSync(
		process.execPath,
		[
			join(product.root, "host/cli/index.ts"),
			"gates",
			"--repository",
			f.root,
			"--gate-sha",
			f.gateSha,
			"--candidate-sha",
			f.candidateSha,
			"--nonce",
			"1234567890abcdef-r0-d1",
			"--output",
			output,
			"--runner",
			"local",
			"--heldout-dir",
			f.heldoutDir,
			"--heldout-digest",
			f.heldoutDigest,
		],
		{ encoding: "utf8", timeout: 30_000 },
	);

	assert.equal(result.status, 0, result.stderr || result.stdout);

	const receipt = JSON.parse(
		readFileSync(join(output, "receipt.json"), "utf8"),
	);

	assert.equal(receipt.status, "passed");
	assert.equal(receipt.gateSha, f.gateSha);
	assert.equal(receipt.candidateSha, f.candidateSha);
	assert.equal(receipt.nonce, "1234567890abcdef-r0-d1");
	assert.equal(receipt.heldoutDigest, f.heldoutDigest);
	assert.ok(receipt.heldoutCounts[`${f.heldoutDir}/checks/value.test.ts`] > 0);
	const facts = await diagnoseExternal(product, f);
	assert.equal(facts.replay?.kind, "observed", JSON.stringify(facts.replay));
	assert.ok(facts.replay?.kind === "observed");
	assert.equal(
		facts.replay.gate.projection.passed,
		true,
		JSON.stringify(facts.replay),
	);
	assert.equal(
		facts.replay.full.projection.passed,
		true,
		JSON.stringify(facts.replay),
	);
});

test("R3 external tooling revision mismatch is rejected before gate execution and replay", async (t) => {
	const product = await pinnedProduct(t);
	const f = externalTarget(t, "a".repeat(40));

	const receipt = await product.checkCandidate({
		repository: f.root,
		gateSha: f.gateSha,
		candidateSha: f.candidateSha,
		nonce: "external-pin",
		output: join(f.root, "output"),
		heldoutDir: f.heldoutDir,
		heldoutDigest: f.heldoutDigest,
		runner: {
			kind: "must-not-run",
			run: async () => assert.fail("unverified tooling ran"),
		},
	});

	assert.equal(receipt.reason, "unsupported_materializer");
	assert.equal(receipt.checks.length, 0);
	const facts = await diagnoseExternal(product, f, mustNotRun);
	assert.equal(facts.replay?.kind, "unavailable");
	assert.ok(facts.replay?.kind === "unavailable");
	assert.equal(facts.replay.reason, "unsupported_materializer");
});

test("R3 every modified installed gate member is rejected despite the correct product revision", async (t) => {
	const product = await pinnedProduct(t);
	const f = externalTarget(t, product.revision);
	const gateTree = join(f.root, "exported-gate");
	const candidateTree = join(f.root, "exported-candidate");
	await exportTree(f.root, f.gateSha, gateTree);
	await exportTree(f.root, f.candidateSha, candidateTree);

	const materialize: typeof import("../../../host/gates/materialize.ts") =
		await import(
			pathToFileURL(join(product.root, "host/gates/materialize.ts")).href
		);

	for (const member of MATERIALIZER_FILES) {
		const path = join(product.root, member);
		const before = readFileSync(path);
		writeFileSync(path, Buffer.concat([before, Buffer.from("\n")]));

		const receipt = await product.checkCandidate({
			repository: f.root,
			gateSha: f.gateSha,
			candidateSha: f.candidateSha,
			nonce: "external-member",
			output: join(f.root, "out-member"),
			heldoutDir: f.heldoutDir,
			heldoutDigest: f.heldoutDigest,
			runner: {
				kind: "must-not-run",
				run: async () => assert.fail("changed tooling ran"),
			},
		});

		assert.equal(receipt.reason, "unsupported_materializer", member);
		assert.equal(receipt.checks.length, 0, member);
		const dest = join(f.root, "refused-materialization");
		assert.throws(
			() =>
				materialize.materializeFromDirectories({
					gateTree,
					candidateTree,
					dest,
					replacements: [],
					heldoutDir: f.heldoutDir,
					heldoutDigest: f.heldoutDigest,
				}),
			/unsupported_materializer/,
			member,
		);
		assert.equal(existsSync(dest), false, member);
		const facts = await diagnoseExternal(product, f, mustNotRun);
		assert.equal(facts.replay?.kind, "unavailable", member);
		assert.ok(facts.replay?.kind === "unavailable");
		assert.equal(facts.replay.reason, "unsupported_materializer", member);
		rmSync(join(f.root, "private-diagnosis"), { recursive: true, force: true });
		writeFileSync(path, before);
	}
});

test("R3 tooling pins are exact commit SHAs, and candidate edits cannot remove or replace them", async (t) => {
	if (!sandboxAvailable(t)) return;
	const product = await pinnedProduct(t);
	const f = externalTarget(t, product.revision);
	const policyPath = ".github/factory/gates/gates.json";
	const policy = JSON.parse(readFileSync(join(f.root, policyPath), "utf8"));
	const gateTree = join(f.root, "gate-export");
	await exportTree(f.root, f.gateSha, gateTree);

	const materialize: typeof import("../../../host/gates/materialize.ts") =
		await import(
			pathToFileURL(join(product.root, "host/gates/materialize.ts")).href
		);

	for (const pin of [
		null,
		"",
		"main",
		product.revision.slice(0, 7),
		product.revision.toUpperCase(),
		42,
		{},
	]) {
		writeFileSync(
			join(gateTree, policyPath),
			JSON.stringify({ ...policy, toolingRevision: pin }),
		);
		assert.throws(
			() =>
				materialize.gateMaterializerIdentity(
					gateTree,
					"giuseppecrj/pi-herdr-agents",
				),
			/unsupported_materializer/,
			JSON.stringify(pin),
		);
	}

	rmSync(gateTree, { recursive: true, force: true });
	const output = mkdtempSync(join(tmpdir(), "factory-pin-output-"));
	t.after(() => rmSync(output, { recursive: true, force: true }));

	for (const pin of [undefined, "b".repeat(40)]) {
		f.put(policyPath, JSON.stringify({ ...policy, toolingRevision: pin }));
		const candidateSha = gitSha(f.commit());

		const receipt = await product.checkCandidate({
			repository: f.root,
			gateSha: f.gateSha,
			candidateSha,
			nonce: "candidate-pin",
			output,
			runner: miniRunner,
			install: false,
			heldoutDir: f.heldoutDir,
			heldoutDigest: f.heldoutDigest,
		});

		assert.equal(receipt.status, "passed", JSON.stringify(receipt));
		assert.deepEqual(receipt.ignoredChanges, [policyPath]);
		const facts = await diagnoseExternal(product, { ...f, candidateSha });
		assert.ok(facts.replay?.kind === "observed");
		assert.equal(facts.replay.gate.projection.passed, true);
		assert.equal(facts.replay.full.projection.passed, true);
		rmSync(join(f.root, "private-diagnosis"), {
			recursive: true,
			force: true,
		});
	}
});

test("R3 a bad external candidate still fails gates and both diagnostic replays", async (t) => {
	const product = await pinnedProduct(t);
	const f = externalTarget(t, product.revision);
	f.put("src/value.ts", 'export const value = "wrong";\n');
	const candidateSha = gitSha(f.commit());

	const receipt = await product.checkCandidate({
		repository: f.root,
		gateSha: f.gateSha,
		candidateSha,
		nonce: "bad-candidate",
		output: join(f.root, "out-bad"),
		runner: miniRunner,
		install: false,
		heldoutDir: f.heldoutDir,
		heldoutDigest: f.heldoutDigest,
	});

	assert.equal(receipt.status, "failed");
	assert.equal(receipt.checks.find((c) => c.name === "heldout")?.exitCode, 1);
	const facts = await diagnoseExternal(product, { ...f, candidateSha });
	assert.ok(facts.replay?.kind === "observed", JSON.stringify(facts.replay));
	assert.equal(facts.replay.gate.projection.passed, false);
	assert.equal(facts.replay.full.projection.passed, false);
});

test("R3 a pinned Agents-shaped version 2 target passes real static tools, gates and native replay without Factorio source", async (t) => {
	if (!sandboxAvailable(t)) return;
	const product = await pinnedProduct(t);
	const f = agentsRepo(t);
	f.git(
		"remote",
		"set-url",
		"origin",
		"https://github.com/giuseppecrj/pi-herdr-agents.git",
	);
	f.git("rm", "-rq", "host");
	f.put(
		GATE_POLICY,
		JSON.stringify({ ...agentsPolicy(), toolingRevision: product.revision }),
	);
	const gateSha = gitSha(f.commit());
	const heldoutDir = "test/acceptance/123";
	const path = `${heldoutDir}/checks/value.test.ts`;

	const bytes = Buffer.from(
		'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { value } from "../../../../maestro/value.ts";\ntest("held-out value", () => assert.equal(value, "main"));\n',
	);

	f.put(path, bytes.toString());
	const candidateSha = gitSha(f.commit());
	const digest = heldoutDigest([{ path, bytes }]);
	assert.equal(existsSync(join(f.root, "host")), false);
	assert.equal(existsSync(join(f.root, "src")), false);

	const receipt = await product.checkCandidate({
		repository: f.root,
		gateSha,
		candidateSha,
		nonce: "agents-pin",
		output: join(f.root, "out-agents"),
		runner: toolingRunner,
		install: false,
		heldoutDir,
		heldoutDigest: digest,
	});

	assert.equal(receipt.status, "passed", JSON.stringify(receipt));
	assert.deepEqual(receipt.testGlobs, AGENTS_GLOBS);

	const facts = await diagnoseExternal(product, {
		...f,
		gateSha,
		candidateSha,
		heldoutDir,
		heldoutDigest: digest,
	});

	assert.ok(facts.replay?.kind === "observed", JSON.stringify(facts.replay));
	assert.equal(facts.replay.gate.projection.passed, true);
	assert.equal(facts.replay.full.projection.passed, true);
});

test("R3 unpinned Factorio self-hosting retains the exact six-file identity and gate policy", () => {
	assert.ok(
		gateMaterializerIdentity(".", "nublai/pi-herdr-factorio").equals(
			materializerIdentity("."),
		),
	);
	assert.equal(JSON.parse(materializerIdentity(".").toString()).length, 6);
	assert.ok(
		!productMaterializerIdentity(".").equals(materializerIdentity(".")),
	);
	const manifest = manifestOf(".");
	assert.deepEqual(
		manifest.checks.map((c) => c.name),
		["typecheck", "lint", "format", "layout", "decisions"],
	);
	assert.deepEqual(manifest.testGlobs, [
		"test/src/**/*.test.ts",
		"test/host/**/*.test.ts",
		"test/integration/*.test.ts",
	]);
});

test("R3 target CI template separates the pinned product from the target and preserves fail-closed reporting", (t) => {
	const workflow = parseYaml(
		readFileSync("docs/operations/examples/target-ci.yml", "utf8"),
	);

	assert.equal(
		workflow["run-name"],
		"gates ${{ inputs.candidate_sha }} ${{ inputs.nonce }}",
	);
	assert.deepEqual(workflow.permissions, { contents: "read" });
	assert.deepEqual(workflow.jobs.report.permissions, {
		actions: "read",
		checks: "write",
	});
	const steps = workflow.jobs.gates.steps;

	const checkouts = steps.filter((s: { uses?: string }) =>
		s.uses?.startsWith("actions/checkout@"),
	);

	assert.equal(checkouts.length, 2);
	assert.equal(checkouts[0].with.repository, "nublai/pi-herdr-factorio");
	assert.equal(checkouts[0].with.ref, "${{ env.FACTORY_PRODUCT_REVISION }}");
	assert.equal(checkouts[0].with.path, "product");
	assert.equal(checkouts[1].with.ref, "${{ github.sha }}");
	assert.equal(checkouts[1].with.path, "target");

	for (const checkout of checkouts)
		assert.equal(checkout.with["persist-credentials"], false);

	const run = steps.find(
		(s: { name?: string }) => s.name === "Run trusted gates",
	).run;

	assert.match(run, /product\/host\/cli\/index\.ts gates/);
	assert.ok(run.includes('--repository "$PWD/target" --gate-sha "$GATE_SHA"'));
	assert.ok(
		workflow.jobs.report.steps.every(
			(s: { uses?: string }) => !s.uses?.startsWith("actions/checkout@"),
		),
	);

	const shell = workflow.jobs.report.steps.find(
		(s: { name?: string }) => s.name === "Report exact candidate result",
	).run;

	const script = /<<'NODE'\n([\s\S]+)\nNODE\n?$/.exec(shell)?.[1];
	assert.ok(script);
	const root = mkdtempSync(join(tmpdir(), "factory-template-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));

	const names = [
		"install",
		"baseline_tests",
		"typecheck",
		"lint",
		"format",
		"main_tests",
		"candidate_tests",
		"heldout",
	];

	const base = {
		version: 2,
		status: "passed",
		modelCalls: 0,
		candidateSha: "a".repeat(40),
		gateSha: "b".repeat(40),
		nonce: "1234567890abcdef-r0-d1",
		heldoutDigest: "c".repeat(64),
		heldoutCounts: { held: 1 },
		requiredChecks: names,
		checks: names.map((name) => ({ name, exitCode: 0 })),
	};

	const input = join(root, "input.json");
	const posted = join(root, "posted.json");

	const env = {
		PATH: process.env.PATH,
		HOME: root,
		GH_TOKEN: "not-a-token",
		CANDIDATE_SHA: base.candidateSha,
		GATE_SHA: base.gateSha,
		NONCE: base.nonce,
		HELDOUT_DIR: "test/acceptance/123",
		HELDOUT_DIGEST: base.heldoutDigest,
		GATE_RESULT: "success",
		GITHUB_REF: "refs/heads/main",
		GITHUB_EVENT_NAME: "workflow_dispatch",
		GITHUB_ACTOR: "exe-dev-github-integration[bot]",
		TRIGGERING_ACTOR: "exe-dev-github-integration[bot]",
		GITHUB_REPOSITORY: "giuseppecrj/pi-herdr-agents",
		GITHUB_RUN_ID: "77",
		GITHUB_RUN_ATTEMPT: "1",
		REPORT_INPUT: input,
		POSTED: posted,
	};

	const fakeGithub = `globalThis.fetch = async (_url, request) => {
		const body = JSON.parse(request.body);
		(await import('node:fs')).writeFileSync(process.env.POSTED, JSON.stringify(body));
		return {ok: true, json: async () => ({id: 123, app: {id: Number(process.env.APP_ID ?? 15368)},
			head_sha: body.head_sha, external_id: body.external_id})};
	};\n`;

	for (const [label, receipt] of [
		["valid", base],
		["gate SHA", { ...base, gateSha: "d".repeat(40) }],
		["candidate SHA", { ...base, candidateSha: "d".repeat(40) }],
		["nonce", { ...base, nonce: "1234567890abcdef-r0-d2" }],
		["held-out", { ...base, heldoutDigest: "d".repeat(64) }],
		["missing check", { ...base, checks: base.checks.slice(1) }],
		[
			"timeout",
			{ ...base, checks: base.checks.map((c) => ({ ...c, timedOut: true })) },
		],
	] as const) {
		writeFileSync(input, JSON.stringify(receipt));
		const output = join(root, label);

		const result: import("node:child_process").SpawnSyncReturns<string> =
			spawnSync(
				process.execPath,
				["--input-type=module", "-e", fakeGithub + script],
				{
					env: { ...env, REPORT_OUTPUT: output },
					encoding: "utf8",
					timeout: 5_000,
				},
			);

		assert.equal(result.status, 0, result.stderr);

		const report = JSON.parse(
			readFileSync(join(output, "receipt.json"), "utf8"),
		);

		assert.equal(report.status, label === "valid" ? "passed" : "failed", label);
		assert.equal(report.gateSha, env.GATE_SHA);
		assert.equal(report.candidateSha, env.CANDIDATE_SHA);
		assert.equal(report.nonce, env.NONCE);
		assert.equal(report.heldoutDigest, env.HELDOUT_DIGEST);
		assert.equal(report.workflow, ".github/workflows/ci.yml");
		assert.equal(report.externalId, `factory-gates:77:${env.NONCE}`);
	}

	writeFileSync(input, JSON.stringify(base));

	for (const change of [
		{ APP_ID: "1" },
		{ GITHUB_REF: "refs/heads/candidate" },
		{ GITHUB_ACTOR: "other" },
	]) {
		const output = join(root, "invalid-identity");

		const result: import("node:child_process").SpawnSyncReturns<string> =
			spawnSync(
				process.execPath,
				["--input-type=module", "-e", fakeGithub + script],
				{
					env: { ...env, ...change, REPORT_OUTPUT: output },
					encoding: "utf8",
					timeout: 5_000,
				},
			);

		assert.equal(result.status, 1, JSON.stringify(change));
		assert.equal(existsSync(join(output, "receipt.json")), false);
	}
});

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
		targetRepository: f.targetRepository,
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
		targetRepository: f.targetRepository,
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
		targetRepository: f.targetRepository,
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
		targetRepository: f.targetRepository,
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
				targetRepository: f.targetRepository,
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
		targetRepository: f.targetRepository,
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
		targetRepository: f.targetRepository,
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
		targetRepository: f.targetRepository,
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
		targetRepository: f.targetRepository,
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
			targetRepository: f.targetRepository,
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
		targetRepository: f.targetRepository,
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
	const slug = "nublai/pi-herdr-factorio";
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
		targetRepository: f.targetRepository,
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
		JSON.stringify({
			version: 2,
			sourceRoots: ["src"],
			testGlobs: ["test/*.test.js"],
			checks: ["typecheck", "lint", "format"].map((name) => ({
				name,
				argv: ["/g/tooling/node_modules/.bin/biome", "format", "src"],
			})),
		}),
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
		`import { eslintCompatPlugin } from "@oxlint/plugins";
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

test("837c runs candidate-added Agents suffix-less glob tests using only main policy", async (t) => {
	const f = agentsRepo(t);
	f.put(
		GATE_POLICY,
		JSON.stringify({
			...agentsPolicy(),
			testGlobs: ["test/test.ts", "test/**/worker.ts"],
		}),
	);
	f.put(
		"test/maestro/worker.ts",
		'import { test } from "node:test";\ntest("base worker", () => {});\n',
	);
	const gateSha = f.commit();
	f.put(
		"test/maestro/new/worker.ts",
		'import { test } from "node:test";\ntest("new worker", () => {});\n',
	);
	f.put("test/helper.ts", 'throw new Error("NOT_A_TEST");\n');
	f.put(
		GATE_POLICY,
		JSON.stringify({
			...agentsPolicy(),
			testGlobs: ["test/test.ts", "test/helper.ts"],
		}),
	);
	const candidateSha = f.commit();
	const observed: string[][] = [];

	const runner: GateRunner = {
		kind: "test-process",
		async run(input) {
			observed.push([...input.argv]);

			return toolingRunner.run(input);
		},
	};

	const receipt = await checkCandidate({
		...gateInput(f, candidateSha),
		gateSha,
		runner,
	});

	assert.equal(receipt.status, "passed", JSON.stringify(receipt));
	assert.equal(
		observed.filter((argv) => argv.includes("test/maestro/new/worker.ts"))
			.length,
		1,
	);
	assert.ok(!observed.some((argv) => argv.includes("test/helper.ts")));
	f.put(
		"test/maestro/new/worker.ts",
		'import { test } from "node:test";\ntest("new worker", () => {\n\tthrow new Error("NEW_TEST_FAILURE");\n});\n',
	);

	const failed = await checkCandidate({
		...gateInput(f, f.commit()),
		gateSha,
		runner,
	});

	assert.equal(
		failed.checks.find((check) => check.name === "candidate_tests")?.exitCode,
		1,
	);
	assert.equal(failed.status, "failed");
});

test("R4 materializes an empty replacement list without expanding the test inventory", async (t) => {
	const f = repo(t);
	const path = "test/value.test.ts";
	f.git("mv", "test/src/example/value.test.ts", path);
	const gateSha = f.commit();
	f.put("src/value.ts", 'export const value = "candidate";\n');
	const candidateSha = f.commit();
	const dest = join(f.root, "materialized");

	const result = await materializeCandidate({
		repository: f.root,
		targetRepository: f.targetRepository,
		gateSha,
		candidateSha,
		dest,
		replacements: [],
	});

	assert.deepEqual(result, { ignoredChanges: [], newTests: [] });
	assert.equal(
		readFileSync(join(dest, "src/value.ts"), "utf8"),
		'export const value = "candidate";\n',
	);
	assert.equal(
		readFileSync(join(dest, path), "utf8"),
		readFileSync(join(f.root, path), "utf8"),
	);
	await assert.rejects(
		materializeCandidate({
			repository: f.root,
			gateSha,
			candidateSha,
			dest: join(f.root, "replacement-refused"),
			replacements: [{ path, test: "value", reason: "Not in the inventory" }],
		}),
		/missing_tests/,
	);
});

test("R4 accepts a named replacement in the configured test/test.ts and preserves its unnamed tests", async (t) => {
	const f = agentsRepo(t);
	const path = "test/test.ts";

	const source = (value: number) =>
		`import assert from "node:assert/strict";\nimport { test } from "node:test";\ntest("changed", () => assert.equal(${value}, ${value}));\ntest("unnamed", () => assert.equal(2, 2));\n`;

	f.put(path, source(1));
	const gateSha = f.commit();
	const replacements = [{ path, test: "changed", reason: "Ticket changes it" }];

	const specified = parseSpecifyOutput(
		JSON.stringify({
			kind: "contract",
			summary: "Change the named test",
			behavior: ["Use the new behavior"],
			acceptance: [{ kind: "new_behavior", text: "New behavior is checked" }],
			exclusions: [],
			compatibility: [],
			limits: [],
			files: [path],
			evidence: [],
			replacesTests: replacements,
		}),
		new Set([path]),
	);

	assert.ok(specified.kind === "contract");
	assert.deepEqual(specified.draft.replacesTests, replacements);
	assert.equal(replacementScenarios(specified.draft)[0]?.id, "T1");
	f.put(path, source(2));

	const candidateSha = f.commit();
	const dest = join(f.root, "materialized");
	await materializeCandidate({
		repository: f.root,
		targetRepository: f.targetRepository,
		gateSha,
		candidateSha,
		dest,
		replacements,
	});
	assert.equal(readFileSync(join(dest, path), "utf8"), source(2));
	assert.ok(declaresTest(readFileSync(join(dest, path), "utf8"), "unnamed"));

	const receipt = await checkCandidate({
		...gateInput(f, candidateSha),
		gateSha,
		replacements,
		replacementsDigest: replacementDigest(replacements),
		runner: toolingRunner,
	});

	assert.equal(receipt.status, "passed", JSON.stringify(receipt));
	assert.equal(receipt.candidateCounts[path], 2);
	assert.equal(receipt.replacedTests[0]?.test, "changed");
});

for (const widen of [false, true])
	test(`R4 refuses an out-of-inventory helper replacement, candidate widens policy=${widen}`, async (t) => {
		const f = agentsRepo(t);
		const path = "test/helper.test.ts";
		const policy = { ...agentsPolicy(), testGlobs: ["test/test.ts"] };
		f.put(GATE_POLICY, JSON.stringify(policy));
		f.put(
			path,
			'import { test } from "node:test";\ntest("helper", () => {});\n',
		);
		const gateSha = f.commit();

		if (widen)
			f.put(
				GATE_POLICY,
				JSON.stringify({ ...policy, testGlobs: ["test/test.ts", path] }),
			);
		f.put(
			path,
			'import { test } from "node:test";\ntest("helper", () => { throw new Error("candidate"); });\n',
		);
		assert.doesNotThrow(() => manifestOf(f.root));

		const candidateSha = f.commit();
		const replacements = [{ path, test: "helper", reason: "Not a unit test" }];

		await assert.rejects(
			materializeCandidate({
				repository: f.root,
				gateSha,
				candidateSha,
				dest: join(f.root, "refused"),
				replacements,
			}),
			/invalid_replacements/,
		);

		const gateTree = join(f.root, "base-tree");
		const candidateTree = join(f.root, "candidate-tree");
		await exportTree(f.root, gateSha, gateTree);
		await exportTree(f.root, candidateSha, candidateTree);
		assert.throws(
			() =>
				materializeFromDirectories({
					gateTree,
					candidateTree,
					dest: join(f.root, "refused-directories"),
					replacements,
				}),
			/invalid_replacements/,
		);
	});

const TOOLS = resolve("node_modules");

const toolingRunner: GateRunner = {
	kind: "test-process",
	async run(input) {
		const modules = join(input.gates, "tooling/node_modules");

		if (!existsSync(modules)) symlinkSync(TOOLS, modules, "dir");

		const args = input.argv.map((a) =>
			a.replace(/\/g\/tooling\/node_modules\/|\/g\/|\/w\//g, (mount) =>
				mount === "/g/tooling/node_modules/"
					? `${TOOLS}/`
					: mount === "/g/"
						? `${input.gates}/`
						: `${input.tree}/`,
			),
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
					targetRepository: f.targetRepository,
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

for (const attached of [false, true])
	for (const frozen of [false, true])
		test(`837a ignore-path control/attack with real oxlint (${attached ? "attached" : "separate"}, ${frozen ? "frozen" : "mutable"})`, async (t) => {
			const path = `${frozen ? "/g/tooling/" : ""}docs/lintignore.md`;

			const f = permissiveAgentsRepo(t, {
				lint: [
					OXLINT,
					"--disable-nested-config",
					...(attached ? [`--ignore-path=${path}`] : ["--ignore-path", path]),
					"-c",
					"/g/tooling/.oxlintrc.json",
					"maestro",
				],
			});

			f.git("rm", "-q", "oxlint.config.ts");
			f.put(".oxlintrc.json", '{"rules":{"no-debugger":"error"}}\n');
			f.put("docs/lintignore.md", "# main ignores nothing\n");
			const gateSha = f.commit();
			const results = [];

			for (const attack of [false, true]) {
				f.put(
					"maestro/value.ts",
					'export const value = "candidate";\ndebugger;\n',
				);

				if (attack) f.put("docs/lintignore.md", "maestro/value.ts\n");
				let calls = 0;

				const receipt = await checkCandidate({
					...gateInput(f, f.commit()),
					gateSha,
					output: join(f.root, `ignore-${attack}`),
					runner: {
						kind: toolingRunner.kind,
						async run(input) {
							calls++;
							const result = await toolingRunner.run(input);

							if (input.argv[0] === OXLINT && result.exitCode !== 0)
								assert.match(result.stdout + result.stderr, /no-debugger/);

							return result;
						},
					},
				});

				const result = {
					attack,
					calls,
					status: receipt.status,
					reason: receipt.reason,
					lint: receipt.checks.find((c) => c.name === "lint")?.exitCode,
				};

				t.diagnostic(JSON.stringify(result));
				results.push(result);
			}

			for (const result of results) {
				if (frozen) {
					assert.equal(result.lint, 1, JSON.stringify(result));
					assert.equal(result.status, "failed");
				} else {
					assert.equal(
						result.reason,
						"invalid_gate_manifest",
						JSON.stringify(result),
					);
					assert.equal(result.calls, 0);
				}
			}
		});

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
			status: "incomplete",
			failed: [],
			ignoredChanges: [],
		});
		assert.throws(() => manifestOf(f.root), /^Error: invalid_gate_manifest$/);
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
					targetRepository: f.targetRepository,
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

const CONFIG_REACH_CASES = [
	[
		"R1 jsonc / Grok 4",
		"tsconfig.json",
		'{"extends":"./maestro/base.jsonc"}',
		"maestro/base.jsonc",
		"{}",
	],
	[
		"R1 extensionless",
		"tsconfig.json",
		'{"extends":"./maestro/base"}',
		"maestro/base",
		"{}",
	],
	[
		"R1 absolute",
		"tsconfig.json",
		'{"extends":"/w/maestro/base.json"}',
		"maestro/base.json",
		"{}",
	],
	[
		"R1 escaped",
		"tsconfig.json",
		String.raw`{"extends":".\/maestro/base.json"}`,
		"maestro/base.json",
		"{}",
	],
	[
		"Grok 1 oxlint import",
		"oxlint.config.ts",
		'import rules from "./maestro/rules.ts"; export default rules;',
		"maestro/rules.ts",
		"export default {};",
	],
	[
		"Grok 2 oxlint extends",
		".oxlintrc.json",
		'{"extends":["./maestro/rules.json"]}',
		"maestro/rules.json",
		"{}",
	],
	[
		"Grok 3 biome extends",
		"biome.json",
		'{"extends":["./maestro/extra.json"]}',
		"maestro/extra.json",
		"{}",
	],
	[
		"Grok 5 references",
		"tsconfig.json",
		'{"references":[{"path":"maestro/settings.json"}]}',
		"maestro/settings.json",
		"{}",
	],
] as const;

for (const [label, config, text, target, content] of CONFIG_REACH_CASES)
	test(`837a refuses candidate config reach: ${label}`, async (t) => {
		const f = permissiveAgentsRepo(
			t,
			config.startsWith("oxlint") || config.startsWith(".oxlint")
				? {
						lint: [OXLINT, "-c", `/w/${config}`, ...AGENTS_LINTED],
					}
				: {},
		);

		f.put(config, text);
		f.put(target, content);
		const gateSha = f.commit();
		f.put(target, `${content}\n`);
		let calls = 0;

		const receipt = await checkCandidate({
			...gateInput(f, f.commit()),
			gateSha,
			runner: {
				kind: "test-process",
				async run() {
					calls++;

					return { exitCode: 0, stdout: "", stderr: "" };
				},
			},
		});

		assert.equal(receipt.status, "incomplete");
		assert.equal(receipt.reason, "invalid_gate_manifest");
		assert.equal(calls, 0);
	});

for (const [label, argv] of [
	["R2 relative lint config", [OXLINT, "-c", "maestro/lint.json", "maestro"]],
	[
		"Grok 6 relative project",
		[
			"node",
			"/g/tooling/node_modules/typescript/bin/tsc",
			"-p",
			"maestro/tsconfig.jsonc",
		],
	],
	[
		"R3 relay require",
		[
			"/g/tooling/node_modules/.bin/tsx",
			"-r",
			"./maestro/x.cjs",
			"/g/tooling/node_modules/typescript/bin/tsc",
		],
	],
] as const)
	test(`837a refuses candidate config reach: ${label}`, (t) => {
		const f = permissiveAgentsRepo(t, { lint: argv });
		assert.throws(() => manifestOf(f.root), /^Error: invalid_gate_manifest$/);
	});

for (const name of ["freeze.mjs", "reporter.mjs", "scan-rules.json"])
	test(`837a N1 / 837d refuses unpinned non-Factorio ${name}`, async (t) => {
		const f = repo(t);
		f.git(
			"remote",
			"set-url",
			"origin",
			"https://github.com/giuseppecrj/pi-herdr-agents.git",
		);
		f.put(`.github/factory/gates/${name}`, "changed\n");
		const gateSha = f.commit();
		assert.throws(
			() => gateMaterializerIdentity(f.root, "giuseppecrj/pi-herdr-agents"),
			/unsupported_materializer/,
		);
		await assert.rejects(
			materializeCandidate({
				repository: f.root,
				gateSha,
				candidateSha: gateSha,
				dest: join(f.root, "out"),
				replacements: [],
			}),
			/unsupported_materializer/,
		);
	});

test("837a accepts the published Agents onboarding policy and keeps Factorio v1 equal", (t) => {
	const f = agentsRepo(t);

	const example =
		"docs/operations/examples/onboarding/pi-herdr-agents/.github/factory/gates/gates.json";

	f.put(GATE_POLICY, readFileSync(example, "utf8"));
	assert.doesNotThrow(() => manifestOf(f.root));
	const legacy = repo(t);
	const before = manifestOf(legacy.root);

	legacy.put("tsconfig.json", '{"extends":"/w/src/base.jsonc"}');
	legacy.put("src/base.jsonc", "{}");

	assert.ok(JSON.stringify(manifestOf(legacy.root)) === JSON.stringify(before));
});

test("837a refuses relay preload, environment and inspector flags at every argv position", (t) => {
	const f = agentsRepo(t);
	const policy = agentsPolicy();

	for (const flag of [
		"-r",
		"-r./maestro/x.cjs",
		"-e",
		"-eprocess.exit(0)",
		"--require",
		"--import",
		"--loader",
		"--experimental-loader",
		"--env-file",
		"--env-file-if-exists",
		"--inspect",
		"--inspect-brk",
		"--inspect-port",
		"--experimental-config-file",
		"--experimental-default-config-file",
		"--config-file",
		"--test-reporter",
		"--test-reporter-destination",
		"--test-global-setup",
		"--test-rerun-failures",
		"--bench-reporter",
		"--conditions",
		"-C",
		"--snapshot-blob",
		"--openssl-config",
		"--experimental-package-map",
		"--vfs-load",
		"--build-snapshot",
		"--build-snapshot-config",
		"--experimental-sea-config",
		"--build-sea",
		"--experimental-policy",
		"--policy-integrity",
		"--icu-data-dir",
		"--localstorage-file",
		"--run",
		"--entry-url",
		"--prof-process",
		"--experimental_config_file",
	])
		for (const relay of [
			["/g/tooling/node_modules/.bin/tsx"],
			["node", "/g/tooling/node_modules/tsx/dist/cli.mjs"],
		])
			for (const args of [
				[flag, "/g/tooling/scripts/exit.mjs"],
				[`${flag}=/g/tooling/scripts/exit.mjs`],
				[
					"/g/tooling/node_modules/typescript/bin/tsc",
					flag,
					"/g/tooling/scripts/exit.mjs",
				],
				[
					"/g/tooling/node_modules/typescript/bin/tsc",
					`${flag}=/g/tooling/scripts/exit.mjs`,
				],
			]) {
				const argv = [...relay, ...args];

				f.put(
					GATE_POLICY,
					JSON.stringify({
						...policy,
						checks: policy.checks.map((c) =>
							c.name === "lint"
								? {
										...c,
										argv: [
											...relay,
											"/g/tooling/node_modules/typescript/bin/tsc",
										],
									}
								: c,
						),
					}),
				);
				assert.doesNotThrow(() => manifestOf(f.root));
				f.put(
					GATE_POLICY,
					JSON.stringify({
						...policy,
						checks: policy.checks.map((c) =>
							c.name === "lint" ? { ...c, argv } : c,
						),
					}),
				);
				assert.throws(
					() => manifestOf(f.root),
					/^Error: invalid_gate_manifest$/,
					JSON.stringify(argv),
				);
			}
});

test("837a classifies tool file options independently of their suffix or argument shape", (t) => {
	for (const [tool, flags] of [
		["oxlint", ["-c", "--config", "--tsconfig"]],
		["eslint", ["-c", "--config"]],
		["prettier", ["--config"]],
		["biome", ["--config-path"]],
		["tsc", ["-p", "--project", "--PROJECT"]],
	] as const)
		for (const flag of flags) {
			const f = permissiveAgentsRepo(t, {});
			f.put("docs/settings.md", "{}");

			for (const path of [
				"docs/settings.md",
				"/w/docs/settings.md",
				"maestro/settings",
				"test/settings",
			]) {
				f.put(path.replace(/^\/w\//, ""), "{}");

				for (const args of [[flag, path], [`${flag}=${path}`]]) {
					const argv = [`/g/tooling/node_modules/.bin/${tool}`, ...args];
					const policy = agentsPolicy();
					f.put(
						GATE_POLICY,
						JSON.stringify({
							...policy,
							checks: policy.checks.map((c) =>
								c.name === "lint" ? { ...c, argv } : c,
							),
						}),
					);
					assert.throws(
						() => manifestOf(f.root),
						/^Error: invalid_gate_manifest$/,
						JSON.stringify(argv),
					);
				}
			}
		}

	for (const [tool, flags] of [
		["oxlint", ["--ignore-path"]],
		["eslint", ["--ignore-path", "--suppressions-location"]],
		["prettier", ["--ignore-path"]],
	] as const)
		for (const flag of flags) {
			const f = permissiveAgentsRepo(t, {});
			const policy = agentsPolicy();
			f.git("rm", "-q", "oxlint.config.ts");
			f.put("settings/ignore.json", "# opaque ignore data, not JSON\n");
			f.put("docs/ignore.md", "# mutable\n");

			for (const path of [
				"/dev/null",
				"settings/ignore.json",
				"/g/tooling/docs/ignore.md",
				"docs/ignore.md",
			])
				for (const args of [[flag, path], [`${flag}=${path}`]]) {
					const argv = [`/g/tooling/node_modules/.bin/${tool}`, ...args];
					f.put(
						GATE_POLICY,
						JSON.stringify({
							...policy,
							checks: policy.checks.map((c) =>
								c.name === "lint" ? { ...c, argv } : c,
							),
						}),
					);

					if (path === "docs/ignore.md")
						assert.throws(
							() => manifestOf(f.root),
							/^Error: invalid_gate_manifest$/,
							JSON.stringify(argv),
						);
					else
						assert.doesNotThrow(() => manifestOf(f.root), JSON.stringify(argv));
				}
		}
});

test("837a refuses unsupported file loaders and response-file indirection", (t) => {
	for (const [tool, flags] of [
		[
			"eslint",
			[
				"--parser",
				"--parser-options",
				"--plugin",
				"--rulesdir",
				"--resolve-plugins-relative-to",
				"-f",
				"--format",
				"--stdin-filename",
				"--cache",
				"--cache-file",
				"--cache-location",
			],
		],
		[
			"prettier",
			[
				"--plugin",
				"--plugin-search-dir",
				"--find-config-path",
				"--stdin-filepath",
				"--cache",
				"--cache-location",
			],
		],
		["biome", ["--vcs-root", "--stdin-file-path", "--use-server"]],
		[
			"tsc",
			[
				"-b",
				"--build",
				"-i",
				"--incremental",
				"--composite",
				"--tsBuildInfoFile",
			],
		],
	] as const)
		for (const flag of flags) {
			const f = permissiveAgentsRepo(t, {
				lint: [`/g/tooling/node_modules/.bin/${tool}`],
			});

			assert.doesNotThrow(() => manifestOf(f.root));

			const policy = JSON.parse(
				readFileSync(join(f.root, GATE_POLICY), "utf8"),
			);

			for (const args of [
				[flag, "/g/tooling/settings"],
				[`${flag}=/g/tooling/settings`],
			]) {
				const argv = [`/g/tooling/node_modules/.bin/${tool}`, ...args];
				f.put(
					GATE_POLICY,
					JSON.stringify({
						...policy,
						checks: policy.checks.map((c: { name: string; argv: string[] }) =>
							c.name === "lint" ? { ...c, argv } : c,
						),
					}),
				);
				assert.throws(
					() => manifestOf(f.root),
					/^Error: invalid_gate_manifest$/,
					JSON.stringify(argv),
				);
			}
		}

	for (const argv of [
		[
			OXLINT,
			"--ignore-path",
			"docs/missing.md",
			"/g/tooling/node_modules/.bin/tsc",
		],
		["/g/tooling/node_modules/.bin/tsc", "@docs/options.md"],
		["/g/tooling/node_modules/.bin/tsc", "-p"],
		[OXLINT, "--ignore-path"],
	]) {
		const f = permissiveAgentsRepo(t, { lint: argv });
		assert.throws(
			() => manifestOf(f.root),
			/^Error: invalid_gate_manifest$/,
			JSON.stringify(argv),
		);
	}
});

test("837a follows config references transitively and refuses unresolved or dynamic references", (t) => {
	for (const [config, text] of [
		["tsconfig.json", '{"extends":"./settings/strict.jsonc"}'],
		["biome.json", '{"extends":["./settings/format.json"]}'],
	] as const) {
		const f = agentsRepo(t);

		f.put(config, text);
		f.put(
			"settings/strict.jsonc",
			'{/* JSONC */ "compilerOptions":{"strict":true},}',
		);
		f.put("settings/format.json", "{}");
		assert.doesNotThrow(() => manifestOf(f.root));
		f.put("settings/strict.jsonc", '{"extends":"../maestro/base.jsonc"}');
		f.put("settings/format.json", '{"extends":["../maestro/extra.json"]}');
		f.put("maestro/base.jsonc", "{}");
		f.put("maestro/extra.json", "{}");
		assert.throws(() => manifestOf(f.root), /^Error: invalid_gate_manifest$/);
	}

	for (const text of [
		"export default await import(process.env.CONFIG);",
		"export default {jsPlugins:[{specifier:process.env.PLUGIN}]};",
		'import rules from "/w/maestro/rules.ts"; export default rules;',
		'import rules from "./missing.ts"; export default rules;',
		'import {readFileSync} from "node:fs"; export default JSON.parse(readFileSync("./maestro/rules.json", "utf8"));',
		'import rules from "file:///w/maestro/rules.ts"; export default rules;',
	]) {
		const f = agentsRepo(t);

		f.put("oxlint.config.ts", text);
		assert.throws(() => manifestOf(f.root), /^Error: invalid_gate_manifest$/);
	}
});

test("837a permits declarative frozen config imports while refusing a transitive workspace reference", (t) => {
	const f = agentsRepo(t);

	f.put(
		"oxlint.config.ts",
		'import rules from "./settings/rules.ts"; export default {rules};',
	);
	f.put("settings/rules.ts", 'export default {"no-debugger":"error"};');
	assert.doesNotThrow(() => manifestOf(f.root));
	f.put("settings/rules.ts", 'export default {extends:["./base.json"]};');
	f.put("settings/base.json", '{"extends":["/w/maestro/rules.json"]}');
	f.put("maestro/rules.json", "{}");
	assert.throws(() => manifestOf(f.root), /^Error: invalid_gate_manifest$/);
});

test("837a refuses attached config paths, mutable documentation configs and unsupported tools", (t) => {
	for (const argv of [
		[OXLINT, "-cmaestro/lint.json", "maestro"],
		["node", "/g/tooling/scripts/check-layout.mjs", "--root", "/w"],
		["/g/tooling/scripts/arbitrary-wrapper.mjs"],
		[
			"node",
			"/g/tooling/node_modules/typescript/bin/tsc",
			"-pmaestro/settings.jsonc",
		],
		...["vitest", "jest", "mocha", "babel", "stylelint", "dprint"].map(
			(tool) => [`/g/tooling/node_modules/.bin/${tool}`],
		),
	]) {
		const f = permissiveAgentsRepo(t, { lint: argv });

		assert.throws(() => manifestOf(f.root), /^Error: invalid_gate_manifest$/);
	}

	const f = agentsRepo(t);

	f.put("tsconfig.json", '{"extends":"./docs/settings.md"}');
	f.put("docs/settings.md", "{}");
	assert.throws(() => manifestOf(f.root), /^Error: invalid_gate_manifest$/);
});

for (const [label, config, text] of [
	["TypeScript extends", "tsconfig.json", '{"extends":"@vendor/tsconfig"}'],
	[
		"config import",
		"oxlint.config.ts",
		'import rules from "@vendor/config"; export default {rules};',
	],
] as const)
	test(`837a refuses unresolved frozen package config: ${label}`, (t) => {
		const f = permissiveAgentsRepo(t, {
			typecheck: [
				"node",
				"/g/tooling/node_modules/typescript/bin/tsc",
				"--noEmit",
				"-p",
				"/g/tooling/tsconfig.json",
			],
		});

		f.put(config, text);
		assert.throws(() => manifestOf(f.root), /^Error: invalid_gate_manifest$/);
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
						"/g/tooling/node_modules/typescript/bin/tsc",
						"--project",
						"/w/tsconfig.json",
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
						"/g/tooling/node_modules/typescript/bin/tsc",
						"--project=/w/tsconfig.json",
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
