import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	cpSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { it } from "node:test";
import { fileURLToPath } from "node:url";
import { isMap, isSeq, parseDocument } from "yaml";
import { gatePolicyOf, manifestOf } from "../../../host/gates/manifest.ts";
import { visibleTestCommand } from "../../../src/candidate/build.ts";
import { parseWorkflow } from "../../../src/config/parse.ts";
import { isGitSha } from "../../../src/config/schema.ts";
import {
	fieldOf,
	objectOf,
	parseJson,
	textOf,
} from "../../../src/core/json.ts";
import { EXE_DEV_PLATFORM, isRepoSlug } from "../../../src/trust/platform.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));

const example = join(
	root,
	"docs/operations/examples/onboarding/pi-herdr-agents",
);

it("accepts the Agents onboarding policy and expands all four inventory forms", () => {
	const tree = mkdtempSync(join(tmpdir(), "onboarding-"));

	try {
		cpSync(join(example, ".github"), join(tree, ".github"), {
			recursive: true,
		});

		for (const path of [
			"pi-extension",
			"maestro",
			"plugins",
			"scripts",
			"skills",
			"tools",
			".pi/skills",
		])
			mkdirSync(join(tree, path), { recursive: true });

		const tests = [
			"test/maestro/worker.test.ts",
			"test/package-manifest.test.js",
			"test/release-workflow.test.ts",
			"test/test.ts",
		];

		for (const path of [
			...tests,
			"test/helpers.ts",
			"test/integration/parent.test.ts",
			"test/acceptance/1/private.test.ts",
		]) {
			mkdirSync(dirname(join(tree, path)), { recursive: true });
			writeFileSync(join(tree, path), "");
		}

		const policy = gatePolicyOf(tree);
		assert.equal(policy.version, 2);
		assert.deepEqual(policy.sourceRoots, [
			"pi-extension",
			"maestro",
			"plugins",
			"scripts",
			"skills",
			"tools",
			".pi/skills",
		]);

		const raw = objectOf(
			parseJson(
				readFileSync(join(tree, ".github/factory/gates/gates.json"), "utf8"),
			),
		);

		assert.ok(isGitSha(textOf(fieldOf(raw, "toolingRevision")) ?? ""));
		assert.deepEqual(
			policy.checks.map((check) => check.name),
			["typecheck", "lint", "format"],
		);

		const expected = new Map([
			[
				"typecheck",
				[
					"node",
					"/g/tooling/node_modules/typescript/bin/tsc",
					"--noEmit",
					"-p",
					"/w/tsconfig.json",
				],
			],
			[
				"lint",
				[
					"/g/tooling/node_modules/.bin/oxlint",
					"--disable-nested-config",
					"--ignore-path",
					"/dev/null",
					"--ignore-pattern",
					"test/acceptance/**",
					"-c",
					"/g/tooling/oxlint.config.ts",
					"pi-extension",
					"test",
					"maestro",
					"plugins",
					"scripts",
				],
			],
			[
				"format",
				[
					"/g/tooling/node_modules/.bin/biome",
					"format",
					"--config-path",
					"/w/biome.json",
					"pi-extension",
					"test",
					"maestro",
					"plugins",
					"scripts",
				],
			],
		]);

		for (const check of policy.checks)
			assert.deepEqual(check.argv, expected.get(check.name), check.name);
		assert.deepEqual(manifestOf(tree).tests, tests);
	} finally {
		rmSync(tree, { recursive: true, force: true });
	}
});

it("preserves Agents CI commands and bridges Checks to the factory check context", () => {
	const workflow = parseDocument(
		readFileSync(join(example, ".github/workflows/check.yml"), "utf8"),
	);

	assert.equal(workflow.errors.length, 0);
	const jobs = workflow.get("jobs");
	assert.ok(isMap(jobs));
	const checks = jobs.get("checks");
	assert.ok(isMap(checks));
	assert.equal(checks.get("name"), "Checks");
	const steps = checks.get("steps");
	assert.ok(isSeq(steps));
	assert.deepEqual(
		steps.items
			.filter(isMap)
			.map((step) => step.get("run"))
			.filter((run) => run !== undefined),
		[
			"npm ci --ignore-scripts",
			"npm run format:check",
			"npm run docs:tools:check",
			"npm run lint",
			"npm run typecheck",
			"npm test",
			"npm pack --dry-run",
			"git diff --check",
		],
	);
	const check = jobs.get("check");
	assert.ok(isMap(check));
	assert.equal(check.get("name"), "check");
	assert.equal(check.get("needs"), "checks");
	assert.equal(check.get("if"), "always()");
	const checkSteps = check.get("steps");
	assert.ok(isSeq(checkSteps));
	assert.equal(checkSteps.items.length, 1);
	const checkStep = checkSteps.items[0];
	assert.ok(isMap(checkStep));
	const command = 'test "$CHECKS_RESULT" = success';

	assert.equal(checkStep.get("run"), command);
	const checkEnv = checkStep.get("env");
	assert.ok(isMap(checkEnv));
	assert.equal(checkEnv.get("CHECKS_RESULT"), "${{ needs.checks.result }}");

	for (const result of ["success", "failure", "cancelled", "skipped"])
		assert.equal(
			spawnSync("sh", ["-c", command], {
				env: { ...process.env, CHECKS_RESULT: result },
			}).status,
			result === "success" ? 0 : 1,
			result,
		);
	const compatibility = jobs.get("compatibility");
	assert.ok(isMap(compatibility));
	assert.equal(compatibility.get("needs"), "check");
	assert.equal(compatibility.has("if"), false);
	assert.equal(
		compatibility.get("name"),
		"${{ (startsWith(github.head_ref, 'factory/pr/') || startsWith(github.head_ref, 'factory/run/') || github.event.pull_request.user.login == 'exe-dev-github-integration[bot]') && 'factory-compatibility' || 'factory-gates' }}",
	);
});

it("parses the Agents workflow with explicit budgets and npm test", () => {
	const repo = "giuseppecrj/pi-herdr-agents";

	if (!isRepoSlug(repo)) throw new Error("invalid test repository");

	const parsed = parseWorkflow({
		text: readFileSync(join(example, ".github/factory/WORKFLOW.md"), "utf8"),
		repo,
		env: (name) => (name === "HOME" ? "/home/exedev" : undefined),
		platform: EXE_DEV_PLATFORM,
	});

	assert.equal(parsed.kind, "valid");

	if (parsed.kind !== "valid") return;
	assert.equal(parsed.config.usage.maxTokensPerRun, 800_000);
	assert.equal(visibleTestCommand(parsed.guidance), "npm test");
	assert.equal(parsed.config.checkpoints.approveMerge.mode, "always");
	assert.deepEqual(parsed.config.handoff?.reviewers, ["giuseppecrj"]);
});

it("keeps Factorio's v1 policy roots, checks and inventory unchanged", () => {
	const policy = gatePolicyOf(root);
	assert.equal(policy.version, 1);
	assert.deepEqual(policy.sourceRoots, [
		"src",
		"extension",
		"host",
		"skills",
		"scripts",
		".pi/skills",
		"docs/models",
	]);
	assert.deepEqual(
		policy.checks.map((check) => check.name),
		["typecheck", "lint", "format", "layout", "decisions"],
	);
	assert.deepEqual(policy.testGlobs, [
		"test/src/**/*.test.ts",
		"test/host/**/*.test.ts",
		"test/integration/*.test.ts",
	]);
});

it("keeps the copied gate assets and trusted CI template byte-identical", () => {
	for (const path of [
		".github/factory/gates/freeze.mjs",
		".github/factory/gates/reporter.mjs",
		".github/factory/gates/scan-rules.json",
	])
		assert.ok(
			readFileSync(join(example, path)).equals(readFileSync(join(root, path))),
			path,
		);
	assert.ok(
		readFileSync(join(example, ".github/workflows/ci.yml")).equals(
			readFileSync(join(root, "docs/operations/examples/target-ci.yml")),
		),
	);
});
