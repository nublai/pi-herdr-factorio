import assert from "node:assert/strict";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	symlinkSync,
	renameSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	sandboxExecutor,
	type SandboxExecutorConfig,
} from "../../../host/sandbox/executor.ts";
import { manifestDigest } from "../../../host/bundle/manifest.ts";
import {
	BUILD_MAX_TOKENS,
	collectPatch,
	storePatch,
	readPatch,
	finishPatch,
} from "../../../src/candidate/build.ts";
import { fileLedgerOutbox } from "../../../host/controller/outbox.ts";
import { fileRunFiles } from "../../../host/controller/run-files.ts";
import { readRunCharges } from "../../../host/controller/terminal.ts";
import { parseMarker } from "../../../src/trust/markers.ts";
import { digestOf } from "../../../src/core/run.ts";
import { networkError, TRUSTED_RUN_CAP } from "../../fake-ticket-adapter.ts";
import { EXE_DEV_PLATFORM } from "../../../src/trust/platform.ts";
import {
	CONTRACT_TEXT,
	labeled,
	runOf,
	world,
	statuses,
	instrument,
	stateDir,
	once,
	keyed,
	settle,
	capAt,
	type FakeExecutor,
} from "./orchestrator-fixtures.ts";
import type { StageExecutor } from "../../../src/controller/launch.ts";

const NEW_TEST_MS = 30_000;

describe("private build stage", () => {
	for (const reuse of [false, true])
		it(`controller restart ${reuse ? "reuses bound tests" : "waits for preflight then recomputes missing tests"} without another builder`, async () => {
			const { github, executor, start, wire, clock } = world();
			github.add(labeled(14));
			executor.behaviors = [{ kind: "pass", usage: 10 }];
			executor.acceptBehavior = { kind: "pass", usage: 7 };
			executor.buildBehavior = { kind: "pass", usage: 12 };
			wire.intercept = async (command, args) =>
				args.some((a) => a.includes("<!-- factory-build "))
					? networkError()
					: github.exec(command, args);
			const first = start();
			await once(first);
			await once(first);
			assert.equal(statuses(github, 14).at(-1), "6:running");
			const original = executor.builds.get(`${runOf(14)}/build-1`);
			assert.equal(original?.result.kind, "found");

			if (original?.result.kind !== "found") return;

			const state = stateDir(),
				base = join(state, "pristine", runOf(14)),
				candidate = join(state, "candidate");

			mkdirSync(base, { recursive: true, mode: 0o700 });
			mkdirSync(candidate);
			writeFileSync(join(base, "value"), "base\n");
			writeFileSync(join(candidate, "value"), "patched\n");
			const patch = await collectPatch({ base, workspace: candidate });
			assert.equal(patch.kind, "collected");

			if (patch.kind !== "collected") return;

			const { runId, baseSha, contractDigest, acceptanceDigest } =
				original.result.receipt;

			const binding = { runId, baseSha, contractDigest, acceptanceDigest };
			mkdirSync(join(state, "build-base", "checkouts"), { recursive: true });
			writeFileSync(
				join(state, "build-base", "checkouts", `${runId}.json`),
				JSON.stringify({ sha: baseSha, files: ["value"] }),
			);
			assert.equal(
				storePatch(state, binding, patch, {
					model: "openai/gpt-6.1-sol",
					observed: null,
					commands: [],
				}).kind,
				"found",
			);

			if (reuse)
				finishPatch(state, binding, {
					command: "base test",
					exitCode: 0,
					tail: "private",
					wallMs: 1,
				});

			const root = join(state, "sandbox-root"),
				staging = join(root, "staging");

			mkdirSync(staging, { recursive: true });
			writeFileSync(join(staging, "marker"), "bundle");
			const hash = await manifestDigest(staging);
			assert.ok(hash);
			renameSync(staging, join(root, `assets-${hash}`));
			symlinkSync(`assets-${hash}`, join(root, "current"));

			let calls = 0,
				ready = reuse;

			const diskExecutor = sandboxExecutor({
				platform: EXE_DEV_PLATFORM,
				stateDir: state,
				root,
				xdgRuntimeDir: "/run/user/1000",
				arch: "x64",
				usernsLimit: async () => "15000",
				log: () => {},
				exec: async (command) => ({
					code: 0,
					stdout: command === "bwrap" ? "bubblewrap 0.9.0\n" : "",
					stderr: "",
				}),
				visibleTests: async (_config, pristine, bytes, command) => {
					calls++;
					assert.equal(pristine, base);
					assert.equal(digestOf(bytes), patch.patchDigest);

					return { command, exitCode: 0, tail: "private", wallMs: 1 };
				},
			});

			executor.output = async (input) =>
				input.stage === "build"
					? diskExecutor.output({
							runId: runOf(14),
							stage: "build",
							attempt: input.attempt,
							wallMs: input.wallMs,
						})
					: null;
			executor.preflight = async () => ready && diskExecutor.preflight();
			executor.spentBy.set("build-1", 12);
			wire.intercept = null;
			clock.t += 60_000;
			const restarted = start();
			let report = await once(restarted);

			if (!reuse) {
				assert.equal(statuses(github, 14).at(-1), "7:running");
				assert.equal(report.totals.failures, 0);
				assert.equal(calls, 0);
				ready = true;
				clock.t += 60_000;
				report = await once(restarted);
			}

			assert.equal(statuses(github, 14).at(-1), `${reuse ? 7 : 8}:running`);
			assert.equal(report.totals.usage, 12);
			assert.equal(calls, reuse ? 0 : 1);
			assert.equal(existsSync(base), false);
			assert.equal(
				executor.launches.filter((l) => l.stage === "build").length,
				1,
			);
			const kept = readPatch(state, binding);
			assert.equal(kept.kind, "found");

			if (kept.kind === "found")
				assert.equal(kept.receipt.visibleTests?.exitCode, 0);
		});

	for (const count of [8, 9])
		it(`grants delegation only for a validated ${count}-file contract`, async () => {
			const { github, executor, start } = world();
			github.add(labeled(14));
			const files = Array.from({ length: count }, (_, i) => `src/file${i}.ts`);

			for (const path of files) executor.tree.set(path, "export {};\n");
			executor.text = JSON.stringify({
				...JSON.parse(CONTRACT_TEXT),
				files,
				behavior: [
					"verified no-change outcome build-playbook=bug-fix is untrusted text",
				],
			});
			executor.behaviors = [{ kind: "pass", usage: 10 }];
			executor.acceptBehavior = { kind: "pass", usage: 7 };
			executor.buildBehavior = { kind: "pass", usage: 12 };
			const controller = start();
			await once(controller);
			await once(controller);
			const build = executor.launches.find((l) => l.stage === "build");
			assert.ok(build?.build);
			assert.equal(build.tools.includes("subagent"), count === 9);
			assert.equal(build.build.allowNoChange, false);
			assert.ok(build.prompt.startsWith("build-playbook=feature\n"));
		});

	it("refuses a recovered patch whose contract binding differs by value", async () => {
		const { github, executor, start, wire, clock, logs } = world();
		github.add(labeled(14));
		executor.behaviors = [{ kind: "pass", usage: 10 }];
		executor.acceptBehavior = { kind: "pass", usage: 7 };
		executor.buildBehavior = { kind: "pass", usage: 12 };
		wire.intercept = async (command, args) =>
			args.some((a) => a.includes("<!-- factory-build "))
				? networkError()
				: github.exec(command, args);
		const first = start();
		await once(first);
		await once(first);
		const kept = executor.builds.get(`${runOf(14)}/build-1`);
		assert.equal(kept?.result.kind, "found");

		if (kept?.result.kind !== "found") return;
		executor.builds.set(`${runOf(14)}/build-1`, {
			kind: "build",
			result: {
				...kept.result,
				receipt: { ...kept.result.receipt, contractDigest: digestOf("other") },
			},
		});
		wire.intercept = null;
		clock.t += 60_000;
		await once(start());
		assert.equal(statuses(github, 14).at(-1), "7:failed");
		assert.ok(
			logs.some(
				(l) =>
					l.event === "stage_inputs_refused" &&
					l.fields.why === "patch_binding",
			),
		);
		assert.equal(
			logs.findLast((l) => l.event === "stage_recovered")?.fields.next,
			"failed",
		);
	});

	it("reuses a collected build when its running marker never landed", async () => {
		const { github, executor, start, wire, clock, files } = world();
		const issue = github.add(labeled(14));
		executor.behaviors = [{ kind: "pass", usage: 10 }];
		executor.acceptBehavior = { kind: "pass", usage: 7 };
		executor.buildBehavior = { kind: "pass", usage: 12 };
		wire.intercept = async (command, args) =>
			args.some((a) => a.includes("<!-- factory-build "))
				? networkError()
				: github.exec(command, args);
		const first = start();
		await once(first);
		await once(first);
		issue.comments = issue.comments.filter((c) => {
			const parsed = parseMarker(c.body);

			return parsed.kind !== "marker" || parsed.marker.seq !== 6;
		});
		const claim = files.claims.get(runOf(14));
		assert.ok(claim);
		files.claims.set(runOf(14), {
			...claim,
			seq: 5,
			status: "claimed",
			usage: 17,
		});
		executor.spentBy.set("build-1", 12);
		wire.intercept = null;
		clock.t += 60_000;
		const restored = start();
		const report = await once(restored);
		await restored.tick();
		assert.equal(
			executor.launches.filter((l) => l.stage === "build").length,
			1,
		);
		assert.equal(report.totals.usage, 12);
		assert.equal(statuses(github, 14).at(-1), "6:running");
	});

	it("advances the same run to build, grants coding tools without the suite, and documents its marker log", async () => {
		const { github, executor, start, logs } = world();
		github.add(labeled(14, { body: "PRIVATE-ISSUE server/cli.ts" }));
		executor.behaviors = [{ kind: "pass", usage: 10 }];
		executor.acceptBehavior = { kind: "pass", usage: 7 };
		executor.buildBehavior = { kind: "pass", usage: 12 };
		const controller = start();
		await once(controller);
		const beforeBuild = logs.length;
		const report = await once(controller);
		assert.deepEqual(
			executor.launches.map((l) => [l.stage, l.attempt]),
			[
				["specify", 1],
				["accept", 1],
				["build", 1],
			],
		);
		const build = executor.launches[2];
		assert.ok(build?.build);
		assert.deepEqual(build.tools, [
			"read",
			"grep",
			"ls",
			"bash",
			"edit",
			"write",
		]);
		assert.equal(build.settings.maxTokens, BUILD_MAX_TOKENS);
		assert.equal(build.remainingRunTokens, TRUSTED_RUN_CAP - 17);
		assert.ok(build.workspace.endsWith("-build-r0-1"));
		assert.match(build.prompt, /only the focused test file/);
		assert.match(build.prompt, /tail -n 40/);
		assert.match(build.prompt, /Never run the full suite/);
		assert.ok(!build.prompt.includes("Visible test command:"));
		assert.ok(!build.prompt.includes("`npm run check` runs typecheck"));

		for (const secret of [
			"PRIVATE-ISSUE",
			"version.test.ts",
			"import assert",
			"canary",
			"S1",
		])
			assert.ok(!build.prompt.includes(secret));
		await controller.tick();
		assert.equal(statuses(github, 14).at(-1), "7:running");
		assert.ok(
			logs.some(
				({ event, fields }) =>
					event === "marker_posted" &&
					fields.status === "running" &&
					fields.stage === "validate",
			),
		);
		assert.ok(
			!logs
				.slice(beforeBuild)
				.some(
					({ event, fields }) =>
						event === "stage_ended" && fields.next === "stage_passed",
				),
		);

		const stageDoc =
			readFileSync(
				new URL(
					"../../../.pi/skills/verify-factory/features/sandbox-stage.md",
					import.meta.url,
				),
				"utf8",
			)
				.split("\n")
				.find((line) => line.startsWith("- `stage-passed`:")) ?? "";

		assert.match(stageDoc, /marker_posted .*status=running stage=validate/);
		assert.doesNotMatch(
			stageDoc,
			/stage_ended \.\.\. cause=passed next=stage_passed/,
		);
		assert.equal(report.totals.usage, 29);
		assert.equal(report.active, 0);
		const summary = keyed(github, 14, "build");
		assert.equal(summary.length, 1);
		assert.match(summary[0] ?? "", /Visible tests: passed/);
		assert.ok(!JSON.stringify(report).includes("private output"));
		assert.ok(!summary[0]?.includes("private output"));
	});

	for (const forbidden of [false, true])
		it(`keeps ${forbidden ? "forbidden work" : "failed visible tests"} private and never passes`, async () => {
			const { github, executor, start } = world();
			github.add(labeled(14));
			executor.behaviors = [{ kind: "pass", usage: 10 }];
			executor.acceptBehavior = { kind: "pass", usage: 7 };
			executor.buildBehavior = { kind: "pass", usage: 12 };

			if (forbidden) executor.buildPolicy = "forbidden";
			else executor.buildExitCode = 1;
			const controller = start();
			await once(controller);
			const report = await once(controller);
			assert.equal(statuses(github, 14).at(-1), "7:failed");
			assert.equal(report.totals.failures, 1);
			assert.match(
				keyed(github, 14, "build")[0] ?? "",
				forbidden ? /no publication/ : /Visible tests: failed/,
			);
			assert.equal((await controller.tick()).totals.failures, 1);
		});

	for (const [baseExitCode, runtime] of [
		[0, "matching"],
		[1, "matching"],
		[null, "matching"],
		[undefined, "matching"],
		[0, "legacy"],
		[0, "different"],
	] as const)
		it(`attributes visible failure only with a passing base control (${baseExitCode}, ${runtime}) across restart and status`, async () => {
			const dir = stateDir();
			const outbox = fileLedgerOutbox(dir);

			const { github, executor, files, start, wire, clock } = world(
				null,
				outbox,
			);

			files.accounting = fileRunFiles(dir).accounting;
			await instrument(files);
			github.add(labeled(14));
			executor.behaviors = [{ kind: "pass", usage: 10 }];
			executor.acceptBehavior = { kind: "pass", usage: 7 };
			executor.buildBehavior = { kind: "pass", usage: 12 };
			executor.buildExitCode = 1;
			executor.buildBaseExitCode = baseExitCode;
			executor.buildRuntime = runtime;
			wire.intercept = async (command, args) =>
				args.some((a) => a.includes("<!-- factory-build "))
					? networkError()
					: github.exec(command, args);
			const first = start();
			await once(first);
			await once(first);
			assert.equal(statuses(github, 14).at(-1), "6:running");
			executor.spentBy.set("build-1", 12);
			wire.intercept = null;
			clock.t += 60_000;
			const restarted = start();
			await once(restarted);
			await restarted.tick();
			const row = (await outbox.scan())?.[0]?.row?.row;
			assert.ok(row?.v === 6);
			assert.equal(row.outcome.kind, "failed");

			const failure = {
				kind: "known",
				value: {
					stage: "build",
					class:
						baseExitCode === 0 && runtime === "matching"
							? "candidate"
							: "missing_evidence",
					reason:
						baseExitCode === 0 && runtime === "matching"
							? "visible_tests_failed"
							: baseExitCode === 1
								? "visible_base_failed"
								: "visible_base_unavailable",
					failedVisibleChecks: [],
					retainedPatch: null,
				},
			};

			assert.deepEqual(row.failure, failure);
			assert.deepEqual((await readRunCharges(dir, runOf(14), 0)).terminal, {
				outcome: row.outcome,
				failure,
			});
			assert.equal(files.claims.get(runOf(14))?.round ?? 0, 0);
			assert.equal(
				executor.launches.filter((l) => (l.round ?? 0) > 0).length,
				0,
			);
			assert.equal(
				executor.launches.filter((l) => l.stage === "build").length,
				1,
			);
			assert.doesNotMatch(JSON.stringify(row), /PRIVATE BASE|private output/);
		});

	for (const missing of [false, true])
		it(`retries ${missing ? "missing" : "infrastructure-failed"} visible tests under the attempt cap without saying tests failed`, async () => {
			const { github, executor, start, clock } = world();
			github.add(labeled(14));
			executor.behaviors = [{ kind: "pass", usage: 10 }];
			executor.acceptBehavior = { kind: "pass", usage: 7 };
			executor.buildBehavior = { kind: "pass", usage: 12 };
			executor.buildExitCode = null;
			executor.missingBuildTests = missing;
			const controller = start();
			await once(controller);
			let report = await once(controller);
			assert.equal(report.totals.retries, 1);
			assert.equal(report.totals.failures, 0);
			assert.equal(keyed(github, 14, "build").length, 0);
			clock.t += 60_000;
			report = await once(controller);
			clock.t += 60_000;
			report = await once(controller);
			assert.equal(report.totals.failures, 1);
			assert.equal(keyed(github, 14, "build").length, 0);
		});

	for (const corrupt of [false, true])
		it(`recovers a collected patch without a second builder${corrupt ? " and types changed bytes" : ""}`, async () => {
			const { github, executor, start, wire, clock } = world();
			github.add(labeled(14));
			executor.behaviors = [{ kind: "pass", usage: 10 }];
			executor.acceptBehavior = { kind: "pass", usage: 7 };
			executor.buildBehavior = { kind: "pass", usage: 12 };
			wire.intercept = async (command, args) =>
				args.some((a) => a.includes("<!-- factory-build "))
					? networkError()
					: github.exec(command, args);
			const first = start();
			await once(first);
			await once(first);
			assert.equal(statuses(github, 14).at(-1), "6:running");
			executor.spentBy.set("build-1", 12);

			if (corrupt)
				executor.builds.set(`${runOf(14)}/build-1`, {
					kind: "build",
					result: { kind: "blocked", reason: "patch_changed" },
				});
			wire.intercept = null;
			clock.t += 60_000;
			const report = await once(start());
			assert.equal(
				executor.launches.filter((l) => l.stage === "build").length,
				1,
			);
			assert.equal(
				statuses(github, 14).at(-1),
				corrupt ? "7:failed" : "7:running",
			);
			assert.equal(report.totals.usage, 12);
		});

	it("returns from a build retry tick while the kept patch's visible tests run, and drains their result", {
		timeout: NEW_TEST_MS,
	}, async () => {
		const { github, executor, start, clock, logs } = world();
		github.add(labeled(14));
		executor.behaviors = [{ kind: "pass", usage: 10 }];
		executor.acceptBehavior = { kind: "pass", usage: 7 };
		executor.buildBehavior = { kind: "pass", usage: 12 };
		executor.buildExitCode = null;
		const controller = start();
		await once(controller);
		assert.equal((await once(controller)).totals.retries, 1);
		const visible = gatedVisibleTests(await keptUntestedPatch(executor));
		route(executor, visible.executor);
		clock.t += 60_000;
		assert.equal(await within(controller.tick()), "completed");
		assert.equal(await within(controller.tick()), "completed");
		assert.equal(visible.runs(), 1);
		assert.equal(statuses(github, 14).at(-1), "8:running");

		const drained = controller.drain(async () => settle());
		visible.release();
		const report = await drained;
		assert.equal(report?.totals.retries, 2);
		assert.equal(visible.runs(), 1);
		assert.equal(
			logs.findLast((l) => l.event === "stage_inputs_unavailable")?.fields.why,
			"visible_tests_unavailable",
		);
	});

	it("restarts during a kept patch's visible tests under the local hold without blocking a tick or rerunning them", {
		timeout: NEW_TEST_MS,
	}, async () => {
		const { github, executor, start, clock, logs, store, files } = world();
		github.add(labeled(14));
		executor.behaviors = [{ kind: "pass", usage: 10 }];
		executor.acceptBehavior = { kind: "pass", usage: 7 };
		executor.buildBehavior = { kind: "pass", usage: 12 };
		executor.buildExitCode = null;
		const controller = start();
		await once(controller);
		await once(controller);
		const disk = await keptUntestedPatch(executor);
		const before = gatedVisibleTests(disk);
		route(executor, before.executor);
		clock.t += 60_000;
		assert.equal(await within(controller.tick()), "completed");
		assert.equal(before.runs(), 1);
		const windows = join(disk.state, "visible-tests", runOf(14));
		assert.deepEqual(readdirSync(windows).filter(isDeadline), [
			"build-2.deadline",
		]);
		const deadline = readFileSync(join(windows, "build-2.deadline"), "utf8");

		store.local = "disabled";
		const after = gatedVisibleTests(disk);
		route(executor, after.executor);
		const restarted = start();

		for (let tick = 0; tick < 3; tick++) {
			assert.equal(await within(restarted.tick()), "completed");
			clock.t += 30_000;
		}

		assert.equal(after.runs(), 1);
		assert.ok(logs.some((l) => l.event === "stage_recovery_wait"));
		assert.deepEqual(readdirSync(windows).filter(isDeadline), [
			"build-2.deadline",
		]);
		assert.equal(
			readFileSync(join(windows, "build-2.deadline"), "utf8"),
			deadline,
		);
		after.release();
		await settle();
		await restarted.tick();
		assert.equal(files.claims.get(runOf(14))?.status, "retrying");
		assert.equal(
			logs.findLast((l) => l.event === "stage_inputs_unavailable")?.fields.why,
			"visible_tests_unavailable",
		);
		clock.t += 600_000;
		assert.equal(await within(restarted.tick()), "completed");
		assert.equal(after.runs(), 1);
		before.release();
	});

	it("keeps a build alive while its visible tests report progress, and aborts them on a stall", {
		timeout: NEW_TEST_MS,
	}, async () => {
		const { github, executor, start, clock, logs } = world();
		github.add(labeled(14));
		executor.behaviors = [{ kind: "pass", usage: 10 }];
		executor.acceptBehavior = { kind: "pass", usage: 7 };
		executor.buildBehavior = { kind: "pass", usage: 12 };
		const output = executor.output.bind(executor);
		let release: () => void = () => undefined;

		const gate = new Promise<void>((done) => {
			release = done;
		});

		const requests: OutputRequest[] = [];

		executor.output = async (input) => {
			if (input.stage !== "build" || input.background === true)
				return output(input);
			requests.push(input);
			await gate;

			return output(input);
		};

		const controller = start();
		await once(controller);
		await controller.tick();
		await settle();
		const requested = requests.at(-1);
		assert.ok(requested !== undefined);
		assert.equal(requested.background, undefined);
		assert.ok(
			requested.wallMs !== undefined &&
				requested.wallMs > 0 &&
				requested.wallMs <= 1_800_000,
		);
		clock.t += 299_000;
		requested.progress?.();
		clock.t += 299_000;
		await controller.tick();
		assert.equal(logs.filter((l) => l.event === "stage_stalled").length, 0);
		assert.equal(requested.signal?.aborted, false);
		clock.t += 301_000;
		await controller.tick();
		assert.equal(logs.filter((l) => l.event === "stage_stalled").length, 1);
		assert.equal(requested.signal?.aborted, true);
		release();
	});

	for (const retry of [false, true])
		it(`ends a build whose visible tests ran out of build wall as budget-exhausted${retry ? " on a kept-patch retry" : ""}`, {
			timeout: NEW_TEST_MS,
		}, async () => {
			const { github, executor, start, clock } = world();
			github.add(labeled(14));
			executor.behaviors = [{ kind: "pass", usage: 10 }];
			executor.acceptBehavior = { kind: "pass", usage: 7 };
			executor.buildBehavior = { kind: "pass", usage: 12 };
			executor.buildExitCode = retry ? null : 0;
			const output = executor.output.bind(executor);

			executor.output = async (input) =>
				input.stage === "build" && input.attempt === (retry ? 2 : 1)
					? { kind: "build", result: { kind: "unavailable", reason: "wall" } }
					: output(input);

			const controller = start();
			await once(controller);
			await once(controller);

			if (retry) {
				clock.t += 60_000;
				await once(controller);
			}

			assert.match(statuses(github, 14).at(-1) ?? "", /:budget_exhausted$/);
		});

	it("bounds a restarted build's visible tests by its builder's persisted wall, not a fresh one", {
		timeout: NEW_TEST_MS,
	}, async () => {
		const { github, executor, start, wire, clock } = world();
		github.add(labeled(14));
		executor.behaviors = [{ kind: "pass", usage: 10 }];
		executor.acceptBehavior = { kind: "pass", usage: 7 };
		executor.buildBehavior = { kind: "pass", usage: 12 };
		wire.intercept = async (command, args) =>
			args.some((a) => a.includes("<!-- factory-build "))
				? networkError()
				: github.exec(command, args);
		const first = start();
		await once(first);
		await once(first);
		assert.equal(statuses(github, 14).at(-1), "6:running");
		const disk = await keptUntestedPatch(executor);
		const wallEnd = Date.now() + 100_000;
		builderWindow(disk, 1, wallEnd);
		const deadlines: (number | undefined)[] = [];

		const real = diskExecutor(
			disk,
			async (_config, _pristine, _bytes, command, _replaces, options) => {
				deadlines.push(options?.deadline);

				return {
					command,
					exitCode: null,
					reason: "visible_tests_unavailable",
					detail: "timeout",
					tail: "",
					wallMs: 1,
				};
			},
		);

		route(executor, real);
		executor.spentBy.set("build-1", 12);
		wire.intercept = null;
		clock.t += 60_000;
		const restarted = start();
		await restarted.tick();
		await restarted.tick();
		await settle();

		const kept = readFileSync(
			join(disk.state, "visible-tests", runOf(14), "build-1.deadline"),
			"utf8",
		);

		assert.equal(Number(kept), wallEnd);
		assert.deepEqual(deadlines, [wallEnd]);
	});

	it("aborts a recovering build's visible tests when its issue closes, holding the slot until their scope stops", {
		timeout: NEW_TEST_MS,
	}, async () => {
		const { github, executor, start, clock, logs } = world();
		capAt(github, 1);
		github.add(labeled(14));
		executor.behaviors = [{ kind: "pass", usage: 10 }];
		executor.acceptBehavior = { kind: "pass", usage: 7 };
		executor.buildBehavior = { kind: "pass", usage: 12 };
		executor.buildExitCode = null;
		const controller = start();
		await once(controller);
		await once(controller);
		const disk = await keptUntestedPatch(executor);
		let signal: AbortSignal | undefined;
		let cleaned: () => void = () => undefined;

		const cleanup = new Promise<void>((done) => {
			cleaned = done;
		});

		let ended = false;

		const real = diskExecutor(
			disk,
			async (_config, _pristine, _bytes, command, _replaces, options) => {
				signal = options?.signal;
				await new Promise((done) =>
					signal?.addEventListener("abort", done, { once: true }),
				);
				await cleanup;
				ended = true;

				return {
					command,
					exitCode: null,
					reason: "visible_tests_unavailable",
					detail: "sandbox_unavailable",
					tail: "",
					wallMs: 1,
				};
			},
		);

		route(executor, real);
		clock.t += 60_000;
		await controller.tick();
		assert.equal(controller.state.runs.get(14)?.phase.kind, "recovering");
		github.add(labeled(15));
		clock.t += 30_000;
		await controller.tick();
		assert.equal(controller.state.runs.has(15), false);
		const issue = github.issues.get(14);
		assert.ok(issue !== undefined);
		issue.state = "closed";
		clock.t += 30_000;
		await controller.tick();
		assert.ok(logs.some((l) => l.event === "claim_released"));
		assert.equal(signal?.aborted, true);
		assert.equal(ended, false);
		clock.t += 30_000;
		await controller.tick();
		assert.equal(controller.state.runs.has(15), false);

		let waits = 0;

		await controller.drain(async () => {
			if (++waits === 2) cleaned();
			await settle();
		});

		assert.equal(ended, true);
		assert.ok(waits >= 2);
		clock.t += 30_000;
		await controller.tick();
		assert.equal(controller.state.runs.has(15), true);
	});

	it("keeps a held kept-patch retry idle, then tests the kept patch on attempts 2 and 3 without another builder", {
		timeout: NEW_TEST_MS,
	}, async () => {
		const { github, executor, start, clock, store } = world();
		github.add(labeled(14));
		executor.behaviors = [{ kind: "pass", usage: 10 }];
		executor.acceptBehavior = { kind: "pass", usage: 7 };
		executor.buildBehavior = { kind: "pass", usage: 12 };
		executor.buildExitCode = null;
		const controller = start();
		await once(controller);
		await once(controller);
		const disk = await keptUntestedPatch(executor);
		let runs = 0;

		const real = diskExecutor(disk, async (_c, _p, _b, command) => {
			runs++;

			return {
				command,
				exitCode: null,
				reason: "visible_tests_unavailable",
				detail: "timeout",
				tail: "",
				wallMs: 1,
			};
		});

		route(executor, real);
		const output = executor.output;

		executor.output = async (input) => {
			if (input.stage === "build" && input.attempt === 3) restoreBase(disk);

			return output(input);
		};

		store.local = "disabled";
		const restarted = start();

		for (let tick = 0; tick < 3; tick++) {
			clock.t += 60_000;
			await restarted.tick();
		}

		assert.equal(runs, 0);
		assert.equal(restarted.state.runs.get(14)?.attempt, 2);
		assert.equal(restarted.state.runs.get(14)?.phase.kind, "retry_queued");
		store.local = "enabled";

		for (let tick = 0; tick < 12; tick++) {
			clock.t += 60_000;
			await restarted.tick();
			await settle();
		}

		assert.equal(runs, 2);
		assert.match(statuses(github, 14).at(-1) ?? "", /:failed$/);
		assert.equal(
			executor.launches.filter((l) => l.stage === "build").length,
			1,
		);
	});
});

type OutputRequest = Parameters<StageExecutor["output"]>[0];

function isDeadline(name: string): boolean {
	return name.endsWith(".deadline");
}

const TICK_BOUND_MS = 2_000;

async function within(
	tick: Promise<unknown>,
): Promise<"completed" | "blocked"> {
	let timer: ReturnType<typeof setTimeout> | undefined;

	const bound = new Promise<"blocked">((done) => {
		timer = setTimeout(() => done("blocked"), TICK_BOUND_MS);
	});

	try {
		return await Promise.race([tick.then(() => "completed" as const), bound]);
	} finally {
		clearTimeout(timer);
	}
}

type KeptPatch = { readonly state: string; readonly root: string };

/** The disk a real executor holds after attempt 1: a stored round-0 patch without tests, its pristine base and record. */
async function keptUntestedPatch(executor: FakeExecutor): Promise<KeptPatch> {
	const original = executor.builds.get(`${runOf(14)}/build-1`);
	assert.ok(original?.result.kind === "found");
	const state = stateDir();
	const base = join(state, "pristine", runOf(14));
	const candidate = join(state, "candidate");
	mkdirSync(base, { recursive: true, mode: 0o700 });
	mkdirSync(candidate);
	writeFileSync(join(base, "value"), "base\n");
	writeFileSync(join(candidate, "value"), "patched\n");
	const patch = await collectPatch({ base, workspace: candidate });
	assert.ok(patch.kind === "collected");

	const { runId, baseSha, contractDigest, acceptanceDigest } =
		original.result.receipt;

	mkdirSync(join(state, "build-base", "checkouts"), { recursive: true });
	writeFileSync(
		join(state, "build-base", "checkouts", `${runId}.json`),
		JSON.stringify({ sha: baseSha, files: ["value"] }),
	);
	assert.equal(
		storePatch(
			state,
			{ runId, baseSha, contractDigest, acceptanceDigest },
			patch,
			{ model: "openai/gpt-6.1-sol", observed: null, commands: [] },
		).kind,
		"found",
	);
	const root = join(state, "sandbox-root");
	const staging = join(root, "staging");
	mkdirSync(staging, { recursive: true });
	writeFileSync(join(staging, "marker"), "bundle");
	const hash = await manifestDigest(staging);
	assert.ok(hash);
	renameSync(staging, join(root, `assets-${hash}`));
	symlinkSync(`assets-${hash}`, join(root, "current"));

	return { state, root };
}

/** The execution window a real builder persists in its stage directory before any model call. */
function builderWindow(disk: KeptPatch, attempt: number, deadline: number) {
	const dir = join(disk.state, "stages", runOf(14), `build-${attempt}`);
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "usage.json"),
		JSON.stringify({
			version: 1,
			runId: runOf(14),
			stage: "build",
			attempt,
			startedAt: deadline - 1_800_000,
			deadline,
			turns: 1,
			usage: {
				total: 12,
				parent: 12,
				children: 0,
				gateway: null,
				unreadChildren: 0,
				byModel: {},
			},
		}),
		{ mode: 0o600 },
	);
}

/** A successful pinned-base recheckout, which this fixture has no tarball transport for. */
function restoreBase(disk: KeptPatch): void {
	const base = join(disk.state, "pristine", runOf(14));
	mkdirSync(base, { recursive: true });
	writeFileSync(join(base, "value"), "base\n");
	mkdirSync(join(disk.state, "build-base", "checkouts"), { recursive: true });
	writeFileSync(
		join(disk.state, "build-base", "checkouts", `${runOf(14)}.json`),
		"{}",
	);
}

function diskExecutor(
	disk: KeptPatch,
	visibleTests: NonNullable<SandboxExecutorConfig["visibleTests"]>,
): StageExecutor {
	return sandboxExecutor({
		platform: EXE_DEV_PLATFORM,
		stateDir: disk.state,
		root: disk.root,
		xdgRuntimeDir: "/run/user/1000",
		arch: "x64",
		usernsLimit: async () => "15000",
		log: () => {},
		exec: async (command) => ({
			code: 0,
			stdout: command === "bwrap" ? "bubblewrap 0.9.0\n" : "",
			stderr: "",
		}),
		visibleTests,
	});
}

/** A real disk executor whose visible-test sandbox stays open until released, then reports a timeout. */
function gatedVisibleTests(disk: KeptPatch) {
	let release: () => void = () => undefined;

	const gate = new Promise<void>((done) => {
		release = done;
	});

	let runs = 0;

	const executor = diskExecutor(
		disk,
		async (_config, _pristine, _bytes, command) => {
			runs++;
			await gate;

			return {
				command,
				exitCode: null,
				reason: "visible_tests_unavailable",
				detail: "timeout",
				tail: "Visible tests could not run",
				wallMs: 600_000,
			};
		},
	);

	return { executor, release, runs: () => runs };
}

function route(executor: FakeExecutor, disk: StageExecutor): void {
	executor.preflight = async () => disk.preflight();
	executor.stopTests = disk.stopTests;
	executor.output = async (input) =>
		input.stage === "build" ? disk.output(input) : null;
}
