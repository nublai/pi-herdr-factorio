import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { exportBundle } from "../../../host/bench/export.ts";
import { manifestDigest } from "../../../host/bundle/manifest.ts";
import { bundleJson } from "../../../src/bench/bundle.ts";
import { isGitSha } from "../../../src/config/schema.ts";
import { fileArtifacts } from "../../../src/contract/artifacts.ts";
import {
	contractBytes,
	contractDigestOf,
	type Contract,
} from "../../../src/contract/contract.ts";
import { digestOf, runIdOf } from "../../../src/core/run.ts";
import { PINNED_TARIFF, tariffDigest } from "../../../src/core/tariff.ts";
import { ledgerRow } from "../../../src/ledger/schema.ts";
import {
	fileAdmissionStore,
	snapshotDigest,
} from "../../../src/trust/admission.ts";
import { EXE_DEV_PLATFORM, isRepoSlug } from "../../../src/trust/platform.ts";

export function put(
	root: string,
	path: string,
	text: string | Uint8Array,
): void {
	mkdirSync(dirname(join(root, path)), { recursive: true, mode: 0o700 });
	writeFileSync(join(root, path), text, { mode: 0o600 });
}

export async function benchFixture(
	root: string,
	options: {
		replacements?: boolean;
		ignored?: boolean;
		large?: boolean;
		ambiguous?: boolean;
	} = {},
) {
	const repository = join(root, "source");
	mkdirSync(repository, { mode: 0o700 });
	const repo = "nublai/pi-herdr-factorio";
	assert.ok(isRepoSlug(repo));
	const workflow = `---\nrepository: ${repo}\nstages:\n  review:\n    seats:\n      second-judge:\n        model: anthropic/claude-sonnet-5-5\n---\n## build\nBuild the task.\nVisible test command: \`node --test test/src/value.test.ts\`\n`;
	put(repository, ".github/factory/WORKFLOW.md", workflow);
	put(
		repository,
		".github/factory/gates/gates.json",
		JSON.stringify({
			version: 1,
			testGlobs: ["test/src/**/*.test.ts"],
			checks: ["typecheck", "lint", "format", "layout", "decisions"].map(
				(name) => ({ name, argv: ["node", "-e", "0"] }),
			),
		}),
	);
	const checkout = fileURLToPath(new URL("../../..", import.meta.url));

	for (const file of ["freeze.mjs", "reporter.mjs", "scan-rules.json"])
		put(
			repository,
			`.github/factory/gates/${file}`,
			readFileSync(join(checkout, ".github/factory/gates", file)),
		);
	put(repository, ".oxlintrc.json", "{}");
	put(
		repository,
		"package.json",
		'{"name":"bench-fixture","version":"1.0.0","type":"module"}',
	);
	put(
		repository,
		"package-lock.json",
		'{"name":"bench-fixture","version":"1.0.0","lockfileVersion":3,"packages":{"":{"name":"bench-fixture","version":"1.0.0"}}}',
	);
	put(repository, "src/value.ts", "export const value = 0;\n");

	if (options.ignored) {
		put(
			repository,
			".gitignore",
			"src/ignored-base.ts\ntest/src/added.test.ts\n",
		);
		put(repository, "src/ignored-base.ts", "export const ignored = true;\n");
	}

	put(
		repository,
		"test/src/value.test.ts",
		"import {test} from 'node:test'; test('base', () => {});\n" +
			(options.ambiguous ? "test('base', () => {});\n" : ""),
	);
	put(
		repository,
		"test/acceptance/published/secret.test.ts",
		"published-private-canary\n",
	);

	const git = (...args: string[]) =>
		execFileSync(
			"git",
			[
				"-c",
				"user.name=Fixture",
				"-c",
				"user.email=fixture@example.invalid",
				"-c",
				"core.hooksPath=/dev/null",
				"-C",
				repository,
				...args,
			],
			{ encoding: "utf8" },
		).trim();

	git("init", "-q");
	git("add", "-f", ".");
	git("commit", "-qm", "synthetic task");
	const sha = git("rev-parse", "HEAD");
	assert.ok(isGitSha(sha));
	const runId = runIdOf({ repo, issue: 1, eventId: "1" });
	const issue = { title: "Export one", body: "Make value one." };
	const snapshot = snapshotDigest(issue);

	const baseContract: Contract = {
		version: 2,
		runId,
		issue: 1,
		base: { repo, sha },
		snapshot: {
			digest: snapshot,
			source: "unedited",
			eventId: "1",
			eventAt: "2026-11-15T00:00:00Z",
		},
		link: null,
		summary: "Export one",
		behavior: ["Value is one"],
		exclusions: [],
		acceptance: [{ id: "A1", kind: "new_behavior", text: "Value is one" }],
		compatibility: [],
		limits: [],
		files: options.large
			? [
					"src/value.ts",
					...Array.from({ length: 8 }, (_, i) => `src/new-${i}.ts`),
				]
			: ["src/value.ts"],
		evidence: [],
	};

	const contract: Contract = options.replacements
		? {
				...baseContract,
				replacesTests: [
					{
						path: "test/src/value.test.ts",
						test: "base",
						reason: "Value changes to one.",
					},
				],
			}
		: baseContract;

	const state = join(root, "production-fixture");
	const bytes = contractBytes(contract);
	const contractDigest = contractDigestOf(bytes);
	put(state, `contracts/${runId}/contract.json`, bytes);
	put(
		state,
		`contracts/${runId}/receipt.json`,
		bundleJson({
			version: 1,
			runId,
			contractDigest,
			bytes: Buffer.byteLength(bytes),
			baseSha: sha,
			snapshotDigest: snapshot,
			answersDigest: null,
		}),
	);

	const accepted = await fileArtifacts(state).store({
		contract,
		contractDigest,
		model: "openai/gpt-6.1-sol",
		observed: "gpt-6.1-sol",
		suite: {
			version: 2,
			scenarios: [
				{
					id: "S1",
					kind: "new_behavior",
					criteria: ["A1"],
					checks: ["value.test.ts"],
					judge: null,
				},
				{
					id: "S2",
					kind: "new_behavior",
					criteria: ["A1"],
					checks: [],
					judge: "Judge the value behavior.",
				},
			],
			files: [
				{
					path: "value.test.ts",
					type: "node:test",
					content:
						"import assert from 'node:assert/strict'; import { test } from 'node:test'; import { value } from '../../../../src/value.ts'; test('private value', () => assert.equal(value, 1));\n",
				},
			],
		},
	});

	assert.ok(accepted.kind === "found");

	const admission = {
		decision: "admitted",
		reasons: [],
		repo,
		issue: 1,
		issueUrl: `https://github.com/${repo}/issues/1`,
		eventId: "1",
		eventAt: contract.snapshot.eventAt,
		actor: "owner",
		actorPermission: "admin",
		snapshotDigest: snapshot,
		snapshotSource: "unedited",
		baseSha: sha,
		workflowDigest: digestOf(workflow),
	} as const;

	assert.equal(
		await fileAdmissionStore(state).record(admission, issue),
		"recorded",
	);

	const row = ledgerRow({
		v: 1,
		runId,
		repo,
		issue: 1,
		eventId: "1",
		eventAt: contract.snapshot.eventAt,
		previousRunId: { kind: "known", value: null },
		snapshotDigest: snapshot,
		originalBase: sha,
		startedAt: { kind: "known", value: contract.snapshot.eventAt },
		terminalObservedAt: "2026-11-15T00:01:00Z",
		provenance: {
			kind: "production",
			policy: {
				workflowSha: sha,
				workflowDigest: digestOf(workflow),
				gates: {
					kind: "known",
					value: { sourceSha: sha, digest: digestOf("gates") },
				},
				autonomy: {
					approveMerge: "always",
					land: "propose",
					digest: digestOf('{"approveMerge":"always","land":"propose"}'),
				},
			},
		},
		terminalMarker: { seq: 1, digest: digestOf("marker") },
		outcome: { kind: "released", stage: "build" },
		pr: null,
		artifacts: {
			kind: "acceptance",
			contractDigest,
			acceptanceDigest: accepted.receipt.acceptanceDigest,
		},
		repairRounds: { kind: "unavailable", reason: "not_instrumented" },
		stages: { kind: "known", value: [] },
		models: { kind: "known", value: [] },
		usage: {
			tokens: { kind: "exact", unit: "tokens", total: 0 },
			parentTokens: { kind: "known", value: 0 },
			childTokens: { kind: "known", value: 0 },
			unattributedTokens: { kind: "known", value: 0 },
			money: { kind: "unavailable", reason: "provider_not_reported" },
		},
		interruptedAttempts: { kind: "known", value: 0 },
		contextPressure: { kind: "unavailable", reason: "not_instrumented" },
		redactedReceiptDigests: [],
		evidence: { issueUrl: admission.issueUrl, ciUrls: [] },
	});

	put(state, `ledger/${runId}/row.json`, row.bytes);
	const bundle = join(root, "bundle");

	const exported = await exportBundle({
		stateDir: state,
		runId,
		out: bundle,
		repository,
		platform: EXE_DEV_PLATFORM,
		env: (name) => (name === "HOME" ? root : undefined),
	});

	const assets = join(root, "assets");

	for (const seat of [
		"build",
		"audit-ticket",
		"grill-me",
		"deep-research",
		"acceptance",
		"code-review",
		"security-review",
		"simplify",
		"ultrareview",
	])
		put(assets, `skills/${seat}/SKILL.md`, `Synthetic ${seat} instructions.\n`);
	put(
		assets,
		"pkg/node_modules/pi-herdr-pstack/skills/poteto-mode/playbooks/feature.md",
		"5. Write a test.\n",
	);
	const assetsDigest = await manifestDigest(assets);
	assert.ok(assetsDigest !== null);
	const variantFile = join(root, "variant.json");

	const variant = {
		version: 1,
		kind: "factory_benchmark_variant",
		name: "baseline",
		pins: {
			bundleDigest: exported.manifestDigest,
			factoryRevision: sha,
			assetsDigest,
			workflowDigest: digestOf(workflow),
			tariffDigest: tariffDigest(PINNED_TARIFF),
		},
		change: { kind: "buildRevision", value: "on" },
	};

	put(root, "variant.json", JSON.stringify(variant));

	return {
		repository,
		state,
		bundle,
		assets,
		variant,
		variantFile,
		sha,
		git,
		contract,
		suite: accepted.suite,
	};
}
