import assert from "node:assert/strict";
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
import { gatePolicyOf, manifestOf } from "../../../host/gates/manifest.ts";
import { visibleTestCommand } from "../../../src/candidate/build.ts";
import { parseWorkflow } from "../../../src/config/parse.ts";
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
		assert.deepEqual(
			policy.checks.map((check) => check.name),
			["typecheck", "lint", "format"],
		);
		assert.deepEqual(manifestOf(tree).tests, tests);
	} finally {
		rmSync(tree, { recursive: true, force: true });
	}
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
