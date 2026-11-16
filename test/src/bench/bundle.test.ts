import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	BUILDER_INPUT,
	type TaskBundle,
	bundleJson,
	createManifest,
	verifyTaskBundle,
} from "../../../src/bench/bundle.ts";
import { isGitSha } from "../../../src/config/schema.ts";
import { digestOf } from "../../../src/core/run.ts";
import { isRepoSlug } from "../../../src/trust/platform.ts";

function fixture() {
	const sha = "a".repeat(40);
	const repo = "nublai/pi-herdr-factorio";
	assert.ok(isGitSha(sha) && isRepoSlug(repo));
	const base = Buffer.from("synthetic base archive");

	const task: TaskBundle = {
		version: 1,
		kind: "factory_benchmark_task",
		runId: digestOf("run"),
		repo,
		issue: 1,
		snapshotDigest: digestOf("issue"),
		contractDigest: digestOf("contract"),
		acceptanceDigest: digestOf("oracle"),
		base: { sha, archive: "builder/base.tar", digest: digestOf(base) },
		builderInput: "builder/input.json",
		oracle: "oracle/",
		original: "original/row.json",
	};

	const files = new Map<string, Buffer>();

	for (const path of [
		BUILDER_INPUT.issue,
		BUILDER_INPUT.contract,
		BUILDER_INPUT.workflow,
		"original/row.json",
		"original/contract-receipt.json",
		"original/admission.json",
		"original/models.json",
		"policy/gates.json",
		"oracle/suite.json",
		"oracle/receipt.json",
		"oracle/canary.txt",
		"oracle/manifest.json",
		"oracle/checks/check.test.ts",
	])
		files.set(path, Buffer.from("synthetic"));
	files.set("task.json", Buffer.from(bundleJson(task)));
	files.set("builder/input.json", Buffer.from(bundleJson(BUILDER_INPUT)));
	files.set("builder/base.tar", base);

	return seal(files);
}

function seal(files: Map<string, Buffer>) {
	files.delete("manifest.json");
	files.delete("manifest.sha256");
	const manifest = bundleJson(createManifest(files));
	files.set("manifest.json", Buffer.from(manifest));
	files.set("manifest.sha256", Buffer.from(`${digestOf(manifest)}\n`));

	return files;
}

describe("private task bundle manifest", () => {
	it("pins every file and prints a stable manifest digest", () => {
		const files = fixture();
		assert.equal(
			verifyTaskBundle(files).manifestDigest,
			digestOf(files.get("manifest.json") ?? ""),
		);
		const reverse = new Map([...files].reverse());
		assert.equal(
			verifyTaskBundle(seal(reverse)).manifestDigest,
			verifyTaskBundle(files).manifestDigest,
		);
	});
	it("rejects a tampered file by name", () => {
		const files = fixture();
		files.set("oracle/checks/check.test.ts", Buffer.from("tampered"));
		assert.throws(
			() => verifyTaskBundle(files),
			/file_digest_mismatch: oracle\/checks\/check.test.ts/,
		);
	});
	it("rejects a missing oracle file", () => {
		const files = fixture();
		files.delete("oracle/checks/check.test.ts");
		assert.throws(
			() => verifyTaskBundle(files),
			/file_missing: oracle\/checks\/check.test.ts/,
		);
	});
	it("rejects a base tree that does not match its task digest even with a rebuilt manifest", () => {
		const files = fixture();
		files.set("builder/base.tar", Buffer.from("different base"));
		assert.throws(
			() => verifyTaskBundle(seal(files)),
			/base_tree_digest_mismatch/,
		);
	});
	it("rejects a changed manifest digest, unlisted files and unsafe paths", () => {
		const files = fixture();
		files.set("manifest.sha256", Buffer.from(`${digestOf("wrong")}\n`));
		assert.throws(() => verifyTaskBundle(files), /manifest_digest_mismatch/);
		seal(files);
		files.set("unexpected", Buffer.from("extra"));
		assert.throws(() => verifyTaskBundle(files), /unlisted_bundle_file/);
		assert.throws(
			() => createManifest(new Map([["../escape", Buffer.from("bad")]])),
			/invalid_manifest_path/,
		);
	});
	it("never permits an oracle path in builder inputs", () => {
		const files = fixture();
		files.set(
			"builder/input.json",
			Buffer.from(
				bundleJson({ ...BUILDER_INPUT, checks: "oracle/suite.json" }),
			),
		);
		assert.throws(() => verifyTaskBundle(seal(files)), /invalid_builder_input/);
	});
});
