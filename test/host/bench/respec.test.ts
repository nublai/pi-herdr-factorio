import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, type TestContext } from "node:test";
import {
	offlineArchiveFetch,
	respecBench,
} from "../../../host/bench/respec.ts";
import { verifyBundle } from "../../../host/bench/export.ts";
import { checkoutWorkspace } from "../../../host/controller/checkout.ts";
import { parseWorkflow } from "../../../src/config/parse.ts";
import { isGitSha } from "../../../src/config/schema.ts";
import { digestOf } from "../../../src/core/run.ts";
import { EXE_DEV_PLATFORM, isRepoSlug } from "../../../src/trust/platform.ts";
import { benchFixture } from "./fixtures.ts";

async function fixture(t: TestContext) {
	const root = mkdtempSync(join(tmpdir(), "bench-respec-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const f = await benchFixture(root);
	const { task } = verifyBundle(f.bundle);

	return { ...f, root, task };
}

describe("offline respec authoring", () => {
	it("serves only the frozen repo and SHA from local gzip bytes with no network fallback", async (t) => {
		const f = await fixture(t);
		let networkCalls = 0;
		t.mock.method(globalThis, "fetch", async () => {
			networkCalls++;
			throw new Error("network forbidden");
		});

		const archive = execFileSync("git", [
			"-C",
			f.repository,
			"archive",
			"--format=tar.gz",
			"--prefix=source/",
			f.sha,
		]);

		const archived = offlineArchiveFetch(f.task, archive);
		const wrongSha = "f".repeat(40);
		const wrongRepo = "nublai/not-the-task";
		assert.ok(isGitSha(wrongSha) && isRepoSlug(wrongRepo));
		assert.ok((await archived(f.task.repo, f.sha)) === archive);
		assert.deepEqual(await archived(f.task.repo, wrongSha), {
			kind: "refused",
			reason: "offline_archive_binding_mismatch",
		});
		assert.deepEqual(await archived(wrongRepo, f.sha), {
			kind: "refused",
			reason: "offline_archive_binding_mismatch",
		});
		const workspace = join(f.root, "checkout");
		mkdirSync(workspace, { mode: 0o700 });

		const checked = await checkoutWorkspace({
			stateDir: f.root,
			runId: f.task.runId,
			workspace,
			repo: f.task.repo,
			sha: f.sha,
			fetch: archived,
		});

		assert.equal(checked.kind, "ready");
		assert.equal(
			digestOf(readFileSync(join(workspace, "src/value.ts"))),
			digestOf("export const value = 0;\n"),
		);
		assert.equal(existsSync(join(workspace, ".git")), false);
		assert.equal(networkCalls, 0);
	});

	it("refuses mismatched frozen snapshot or base bindings before model work", async (t) => {
		const f = await fixture(t);

		const workflow = parseWorkflow({
			text: readFileSync(join(f.bundle, "original/WORKFLOW.md"), "utf8"),
			repo: f.task.repo,
			platform: EXE_DEV_PLATFORM,
			env: (name) => (name === "HOME" ? f.root : undefined),
		});

		assert.equal(workflow.kind, "valid");

		if (workflow.kind !== "valid") return;
		const wrongSha = "f".repeat(40);
		assert.ok(isGitSha(wrongSha));

		for (const task of [
			{ ...f.task, snapshotDigest: digestOf("wrong") },
			{ ...f.task, base: { ...f.task.base, sha: wrongSha } },
		]) {
			await assert.rejects(
				respecBench({
					bundle: f.bundle,
					state: f.root,
					workspace: f.repository,
					files: [],
					task,
					id: digestOf("new trial"),
					assets: f.assets,
					archive: Buffer.alloc(0),
					config: workflow.config,
					guidance: workflow.guidance,
					metadata: {
						baseSha: f.sha,
						archiveDigest: f.task.base.digest,
						snapshotDigest: f.task.snapshotDigest,
						contractDigest: null,
						acceptanceDigest: null,
						baseReceiptDigest: null,
						acceptEffort: "medium",
						models: [],
					},
					remaining: () => 540000,
					host: () => {
						throw new Error("must not launch a model");
					},
					stage: async (_name, run) => run(),
				}),
				/respec_snapshot_binding_mismatch/,
			);
		}
	});
});
