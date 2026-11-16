import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";
import { BUILDER_INPUT, bundleJson } from "../../../src/bench/bundle.ts";
import { isGitSha } from "../../../src/config/schema.ts";
import { fileArtifacts } from "../../../src/contract/artifacts.ts";
import {
	type Contract,
	contractBytes,
	contractDigestOf,
} from "../../../src/contract/contract.ts";
import { digestOf, runIdOf } from "../../../src/core/run.ts";
import { ledgerRow } from "../../../src/ledger/schema.ts";
import {
	fileAdmissionStore,
	snapshotDigest,
} from "../../../src/trust/admission.ts";
import { isRepoSlug } from "../../../src/trust/platform.ts";

const cli = fileURLToPath(
	new URL("../../../host/cli/index.ts", import.meta.url),
);

const roots: string[] = [];

after(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function put(root: string, path: string, bytes: string | Buffer) {
	mkdirSync(dirname(join(root, path)), { recursive: true, mode: 0o700 });
	writeFileSync(join(root, path), bytes, { mode: 0o600 });
}

async function fixture() {
	const root = mkdtempSync(join(tmpdir(), "factory-bench-export-"));
	roots.push(root);
	const repository = join(root, "repo");
	const state = join(root, "state");
	mkdirSync(repository, { mode: 0o700 });
	mkdirSync(state, { mode: 0o700 });
	const repo = "nublai/pi-herdr-factorio";
	assert.ok(isRepoSlug(repo));
	const workflow = `---\nrepository: ${repo}\nstages:\n  accept:\n    reasoning_effort: low\n---\n## build\nBuild the task.\n`;
	put(repository, ".github/factory/WORKFLOW.md", workflow);
	put(repository, ".github/factory/gates/gates.json", '{"version":1}\n');
	put(repository, "src/value.ts", "export const value = 0;\n");

	const git = (...args: string[]) =>
		execFileSync("git", ["-C", repository, ...args], { encoding: "utf8" });

	git("init", "-q");
	git("add", ".");
	git(
		"-c",
		"user.name=Fixture",
		"-c",
		"user.email=fixture@example.invalid",
		"commit",
		"-qm",
		"synthetic base",
	);
	const sha = git("rev-parse", "HEAD").trim();
	assert.ok(isGitSha(sha));
	const issue = { title: "Export value", body: "Make the value one." };
	const runId = runIdOf({ repo, issue: 1, eventId: "1" });
	const snapshot = snapshotDigest(issue);

	const contract: Contract = {
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
		summary: "Export value",
		behavior: ["Export one"],
		exclusions: [],
		acceptance: [{ id: "A1", kind: "new_behavior", text: "Value is one" }],
		compatibility: [],
		limits: [],
		files: ["src/value.ts"],
		evidence: [],
	};

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
			],
			files: [
				{
					path: "value.test.ts",
					type: "node:test",
					content:
						"import assert from 'node:assert/strict';\nimport { test } from 'node:test';\ntest('value', () => assert.ok(true));\n",
				},
			],
		},
	});

	assert.ok(accepted.kind === "found");

	const receipt = {
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
		await fileAdmissionStore(state).record(receipt, issue),
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
		evidence: { issueUrl: receipt.issueUrl, ciUrls: [] },
	});

	put(state, `ledger/${runId}/row.json`, row.bytes);
	git(
		"-c",
		"user.name=Fixture",
		"-c",
		"user.email=fixture@example.invalid",
		"commit",
		"--allow-empty",
		"-qm",
		"later head",
	);
	const out = join(root, "bundle");

	const run = (...args: string[]) => {
		const result = spawnSync(process.execPath, [cli, "bench", ...args], {
			cwd: repository,
			encoding: "utf8",
			timeout: 30_000,
			env: { ...process.env, FACTORY_PLATFORM: "exe-dev" },
		});

		assert.equal(result.error, undefined);

		return {
			code: result.status,
			stdout: result.stdout,
			stderr: result.stderr,
		};
	};

	const exportRun = () =>
		run("export", "--state-dir", state, "--run", runId, "--out", out);

	return {
		root,
		repository,
		state,
		out,
		runId,
		sha,
		contractDigest,
		run,
		exportRun,
	};
}

function modes(root: string) {
	assert.equal(lstatSync(root).mode & 0o777, 0o700);

	for (const entry of readdirSync(root, { withFileTypes: true })) {
		const path = join(root, entry.name);

		if (entry.isDirectory()) modes(path);
		else assert.equal(lstatSync(path).mode & 0o777, 0o600);
	}
}

describe("bench export and verify CLI", () => {
	it("exports the recorded local Git base with private modes and isolated oracle, then verifies in a fresh process", async () => {
		const f = await fixture();
		const exported = f.exportRun();
		assert.equal(exported.code, 0, exported.stderr);
		assert.match(exported.stdout, /^ok [a-f0-9]{64}\n$/);
		modes(f.out);
		assert.equal(f.run("verify", f.out).stdout, exported.stdout);
		const base = readFileSync(join(f.out, "builder/base.tar"));

		const expected = execFileSync("git", [
			"-C",
			f.repository,
			"archive",
			"--format=tar",
			f.sha,
		]);

		assert.ok(base.equals(expected));
		assert.equal(
			readFileSync(join(f.out, "builder/input.json"), "utf8"),
			bundleJson(BUILDER_INPUT),
		);
		assert.equal(existsSync(join(f.out, "builder/oracle")), false);
		const metadata = readFileSync(join(f.out, "original/models.json"), "utf8");
		assert.match(metadata, /"accept": "low"/);
		assert.match(
			readFileSync(join(f.out, "original/row.json"), "utf8"),
			/"kind":"released"/,
		);
		assert.match(
			readFileSync(join(f.out, "task.json"), "utf8"),
			new RegExp(f.contractDigest),
		);
	});
	it("refuses an existing output without replacing any bytes", async () => {
		const f = await fixture();
		assert.equal(f.exportRun().code, 0);
		const before = digestOf(readFileSync(join(f.out, "manifest.json")));
		assert.equal(f.exportRun().code, 1);
		assert.equal(digestOf(readFileSync(join(f.out, "manifest.json"))), before);
		assert.equal(f.run("verify", f.out).code, 0);
	});
	it("rejects oracle tampering, missing files and symlinks", async () => {
		const f = await fixture();
		assert.equal(f.exportRun().code, 0);
		const path = join(f.out, "oracle/checks/value.test.ts");
		const original = readFileSync(path);
		writeFileSync(path, "tampered");
		assert.match(
			f.run("verify", f.out).stderr,
			/oracle\/checks\/value.test.ts/,
		);
		unlinkSync(path);
		assert.equal(f.run("verify", f.out).code, 1);
		symlinkSync(join(f.out, "builder/issue.json"), path);
		assert.match(f.run("verify", f.out).stderr, /unsafe_bundle_file/);
		unlinkSync(path);
		writeFileSync(path, original, { mode: 0o600 });
		assert.equal(f.run("verify", f.out).code, 0);
		chmodSync(path, 0o644);
		assert.match(f.run("verify", f.out).stderr, /unsafe_bundle_file/);
	});
	it("refuses corrupt inputs and missing local base objects without creating output", async () => {
		const f = await fixture();
		const contract = join(f.state, "contracts", f.runId, "contract.json");
		const original = readFileSync(contract);
		writeFileSync(contract, "{}");
		assert.equal(f.exportRun().code, 1);
		assert.equal(existsSync(f.out), false);
		writeFileSync(contract, original);
		rmSync(join(f.repository, ".git"), { recursive: true });
		assert.equal(f.exportRun().code, 1);
		assert.equal(existsSync(f.out), false);
	});
	it("exports read-only state deterministically and refuses output inside state", async () => {
		const f = await fixture();

		const protect = (root: string, readonly: boolean): void => {
			for (const entry of readdirSync(root, { withFileTypes: true })) {
				const path = join(root, entry.name);

				if (entry.isDirectory()) protect(path, readonly);
				else chmodSync(path, readonly ? 0o400 : 0o600);
			}

			chmodSync(root, readonly ? 0o500 : 0o700);
		};

		protect(f.state, true);

		try {
			const first = f.exportRun();
			assert.equal(first.code, 0, first.stderr);

			const second = f.run(
				"export",
				"--state-dir",
				f.state,
				"--run",
				f.runId,
				"--out",
				join(f.root, "second"),
			);

			assert.equal(second.code, 0, second.stderr);
			assert.equal(second.stdout, first.stdout);
			const inside = join(f.state, "..bundle");

			const refused = f.run(
				"export",
				"--state-dir",
				f.state,
				"--run",
				f.runId,
				"--out",
				inside,
			);

			assert.match(refused.stderr, /output_inside_state_directory/);
			assert.equal(existsSync(inside), false);
		} finally {
			protect(f.state, false);
		}
	});
	it("rejects incomplete arguments without creating an output", async () => {
		const f = await fixture();

		for (const args of [
			[],
			["export"],
			["verify"],
			["verify", f.out, "extra"],
			["export", "--run", "../bad"],
		])
			assert.equal(f.run(...args).code, 2);
		assert.equal(existsSync(f.out), false);
	});
});
