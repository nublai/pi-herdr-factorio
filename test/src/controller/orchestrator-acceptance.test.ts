import { ACCEPTANCE_MAX_TOKENS } from "../../../src/contract/acceptance.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
	readFileSync,
	mkdtempSync,
	mkdirSync,
	writeFileSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { checkoutWorkspace } from "../../../host/controller/checkout.ts";
import type { StageExecutor } from "../../../src/controller/launch.ts";
import { controllerDraftChecker } from "../../../host/controller/checkers.ts";
import { describe, it, type TestContext } from "node:test";
import { parseMarker } from "../../../src/trust/markers.ts";
import {
	httpError,
	MAIN_SHA,
	networkError,
	TRUSTED_RUN_CAP,
} from "../../fake-ticket-adapter.ts";
import {
	repo,
	START,
	ACCEPTANCE_TEXT,
	QUESTIONS_TEXT,
	EVENT_ID,
	labeled,
	runOf,
	world,
	statuses,
	events,
	setWorkflow,
	settle,
	writesWire,
	once,
	keyed,
	advanceOnPost,
} from "./orchestrator-fixtures.ts";

function inventoryWorld(t: TestContext, version: 1 | 2) {
	const ctx = world();
	const root = mkdtempSync(join(tmpdir(), "837c-retry-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	ctx.executor.tree.set(
		".github/factory/gates/gates.json",
		JSON.stringify({ version, testGlobs: ["test/test.ts"] }),
	);
	ctx.executor.tree.set("test/test.ts", "export const harness = 1;");
	const source = join(root, "source/repo");

	for (const [path, text] of ctx.executor.tree) {
		mkdirSync(dirname(join(source, path)), { recursive: true });
		writeFileSync(join(source, path), text);
	}

	const archive = execFileSync("tar", [
		"-czf",
		"-",
		"-C",
		join(root, "source"),
		"repo",
	]);

	const transport = { offline: false, fetches: 0 };

	ctx.files.workspacePath = (id) => join(root, "workspaces", id);
	ctx.executor.checkout = async (
		input: Parameters<StageExecutor["checkout"]>[0],
	) => {
		mkdirSync(input.workspace, { recursive: true });

		return checkoutWorkspace({
			...input,
			stateDir: root,
			fetch: async (_repo, sha) => {
				assert.equal(sha, MAIN_SHA);
				transport.fetches++;

				return transport.offline ? null : archive;
			},
		});
	};

	ctx.github.add(labeled(14));
	ctx.executor.behaviors = [{ kind: "pass", usage: 10 }];
	ctx.executor.acceptBehavior = { kind: "pass", usage: 7 };

	return { ...ctx, transport };
}

describe("held-out acceptance stage", () => {
	for (const version of [1, 2] as const) {
		it(`837c retries a transient v${version} inventory download at accept launch`, async (t) => {
			const { executor, start, transport, logs } = inventoryWorld(t, version);
			const controller = start();
			await controller.tick();
			await settle();
			transport.offline = true;
			await once(controller);
			assert.deepEqual(
				executor.launches.map((launch) => launch.stage),
				["specify"],
			);
			assert.equal(controller.state.runs.get(14)?.phase.kind, "claimed");
			assert.ok(
				logs.some(
					(log) =>
						log.event === "stage_inputs_unavailable" &&
						log.fields.why === "test_inventory",
				),
			);
			transport.offline = false;
			await once(controller);
			assert.deepEqual(
				executor.launches.map((launch) => launch.stage),
				["specify", "accept"],
			);
		});

		for (const stage of ["specify", "accept"] as const)
			it(`837c recovery retains finished v${version} ${stage} output across a transient inventory download`, async (t) => {
				const { executor, files, start, clock, transport } = inventoryWorld(
					t,
					version,
				);

				const writeContract = files.writeContract;
				const store = files.artifacts.store;

				if (stage === "specify")
					files.writeContract = async () => {
						throw new Error("crash before store");
					};
				else
					files.artifacts.store = async () => {
						throw new Error("crash before store");
					};

				await assert.rejects(once(start()), /crash before store/);
				files.writeContract = writeContract;
				files.artifacts.store = store;
				const output = executor.kept.get(`${runOf(14)}/${stage}-1`);
				assert.ok(output);
				executor.spentBy.set(`${stage}-1`, stage === "specify" ? 10 : 7);
				clock.t += 60_000;
				transport.offline = true;
				const recovered = start();
				await recovered.tick();
				await recovered.tick();
				const run = recovered.state.runs.get(14);
				assert.equal(run?.phase.kind, "recovering");

				if (run?.phase.kind !== "recovering")
					assert.fail("finished output lost");
				assert.equal(run.phase.output, output);
				assert.equal(run.attempt, 1);
				const fetches = transport.fetches;
				assert.ok(fetches >= 3);
				transport.offline = false;
				await once(recovered);
				assert.equal(
					executor.launches.filter((launch) => launch.stage === stage).length,
					1,
				);
				assert.ok(transport.fetches > fetches);
				const bound = await files.readContract(runOf(14));
				assert.equal(bound.kind, "found");

				if (bound.kind !== "found") assert.fail("contract lost");

				if (stage === "accept")
					assert.equal(
						(
							await files.artifacts.read(
								runOf(14),
								bound.contract,
								bound.digest,
							)
						).kind,
						"found",
					);
			});
	}

	it("837c v1 launch keeps suffix preservation outside policy globs and supplies no accept inventory", async () => {
		const { github, executor, logs, start } = world();
		github.add(labeled(14));
		executor.tree.set(
			".github/factory/gates/gates.json",
			JSON.stringify({ version: 1, testGlobs: ["test/src/**/*.test.ts"] }),
		);
		executor.tree.set("test/src/a.test.ts", "export const test = 1;");
		executor.tree.set("test/helpers/b.cases.ts", "export const helper = 1;");
		executor.behaviors = [{ kind: "pass", usage: 10 }];
		executor.acceptBehavior = { kind: "pass", usage: 7 };
		const suite = JSON.parse(ACCEPTANCE_TEXT);
		suite.files[0].content =
			"import { readFileSync } from 'node:fs'; readFileSync('test/helpers/b.cases.ts');";
		executor.acceptText = JSON.stringify(suite);
		await once(start());
		assert.equal(
			executor.launches.find((launch) => launch.stage === "accept")?.acceptDraft
				?.preservedTests,
			undefined,
		);
		assert.ok(
			logs.some(
				(log) =>
					log.event === "acceptance_malformed" &&
					log.fields.reason === "heldout_reads_preserved_test",
			),
		);
	});

	for (const policy of [null, "{malformed"])
		it(`837c refuses ${policy === null ? "missing or oversized" : "malformed"} trusted inventory without retry`, async () => {
			const { github, executor, logs, start } = world();
			github.add(labeled(14));
			executor.tree.set(".github/factory/gates/gates.json", "{}");
			executor.behaviors = [{ kind: "pass", usage: 10 }];
			const checkout = executor.checkout.bind(executor);
			executor.checkout = async (input) => {
				const result = await checkout(input);

				if (result.kind === "ready")
					result.checkout.readBase = async () => policy;

				return result;
			};

			const controller = start();
			await once(controller);
			await once(controller);
			assert.equal(executor.launches.length, 0);
			assert.equal(controller.state.runs.size, 0);
			assert.ok(
				logs.some(
					(log) =>
						log.event === "stage_inputs_refused" &&
						log.fields.why ===
							(policy === null
								? "test_inventory_unavailable"
								: "test_inventory_invalid"),
				),
			);
		});

	it("837c refuses an unmatched v2 inventory glob before stage launch", async () => {
		const { github, executor, logs, start } = world();
		github.add(labeled(14));
		executor.tree.set(
			".github/factory/gates/gates.json",
			JSON.stringify({ version: 2, testGlobs: ["test/missing/**/*.test.ts"] }),
		);
		executor.behaviors = [{ kind: "pass", usage: 10 }];
		await once(start());
		assert.equal(executor.launches.length, 0);
		assert.ok(
			logs.some(
				(log) =>
					log.event === "stage_inputs_refused" &&
					log.fields.why === "test_inventory_invalid",
			),
		);
	});
	it("837c carries the trusted Agents inventory to both draft and final acceptance checks", async (t) => {
		const { github, executor, logs, start } = world();
		github.add(labeled(14));
		executor.tree.set(
			".github/factory/gates/gates.json",
			JSON.stringify({ version: 2, testGlobs: ["test/test.ts"] }),
		);
		executor.tree.set(
			"test/test.ts",
			'import { test } from "node:test"; test("preserved", () => {});',
		);
		executor.tree.set("test/helper.ts", "export const fixture = 1;");

		const draft = JSON.parse(executor.text ?? "{}");
		draft.files = ["test/test.ts"];
		draft.evidence = [];
		executor.text = JSON.stringify(draft);
		executor.behaviors = [{ kind: "pass", usage: 100 }];
		executor.acceptBehavior = { kind: "pass", usage: 20 };

		const suite = JSON.parse(ACCEPTANCE_TEXT);
		suite.files[0].content =
			"import { readFileSync } from 'node:fs'; readFileSync('test/test.ts');";
		executor.acceptText = JSON.stringify(suite);
		await once(start());
		assert.deepEqual(executor.launches[0]?.testFiles, ["test/test.ts"]);

		const accept = executor.launches.find(
			(launch) => launch.stage === "accept",
		);

		assert.ok(accept);
		assert.ok(accept.prompt.includes("test_harness"));
		assert.ok(accept.prompt.includes("preserved"));
		const input = accept.acceptDraft;

		assert.ok(input);
		assert.equal(input.preservedTests?.has("test/test.ts"), true);
		assert.equal(input.preservedTests?.has("test/helper.ts"), false);
		assert.ok(
			logs.some(
				(log) =>
					log.event === "acceptance_malformed" &&
					log.fields.reason === "heldout_reads_preserved_test",
			),
		);

		const dir = mkdtempSync(join(tmpdir(), "837c-draft-"));
		t.after(() => rmSync(dir, { recursive: true, force: true }));

		const check = controllerDraftChecker({
			stateDir: dir,
			stageDir: dir,
			attempt: 1,
			input,
			fetch: async () => {
				throw new Error("must refuse before execution");
			},
		});

		const feedback = await check(executor.acceptText, {
			run: 1,
			signal: new AbortController().signal,
			deadline: Date.now() + 1000,
		});

		assert.ok(
			feedback !== null &&
				"reason" in feedback &&
				feedback.reason === "heldout_reads_preserved_test",
		);
	});

	for (const effort of ["default", "low"] as const)
		it(`forwards ${effort} trusted reasoning effort only to accept`, async () => {
			const { github, executor, start } = world();

			if (effort !== "default")
				setWorkflow(
					github,
					"  accept:\n",
					`  accept:\n    reasoning_effort: ${effort}\n`,
				);
			github.add(labeled(14));
			executor.behaviors = [{ kind: "pass", usage: 100 }];
			executor.acceptBehavior = { kind: "pass", usage: 20 };
			await once(start());
			assert.equal(executor.launches[0]?.acceptEffort, undefined);
			assert.equal(executor.launches[1]?.stage, "accept");
			assert.equal(
				executor.launches[1]?.acceptEffort,
				effort === "default" ? "medium" : effort,
			);
		});
	it("runs specify then a fresh accept, stores the suite, and claims build after one redacted summary", async () => {
		const { github, executor, files, start } = world();
		github.add(labeled(14, { body: "PRIVATE-ISSUE-TRANSCRIPT server/cli.ts" }));
		executor.tree.set(
			"test/cli.test.ts",
			"import test from 'node:test';\nimport { VERSION } from '../server/cli.ts';\ntest('public harness', () => {});",
		);
		executor.tree.set(
			"test/acceptance/14/checks/secret.test.ts",
			"PRIVATE-ORACLE",
		);
		executor.behaviors = [{ kind: "pass", usage: 100 }];
		executor.acceptBehavior = { kind: "pass", usage: 20 };
		const report = await once(start());
		assert.deepEqual(statuses(github, 14), [
			"1:claimed",
			"2:running",
			"3:claimed",
			"4:running",
			"5:claimed",
		]);
		assert.deepEqual(
			executor.launches.map((l) => [l.stage, l.attempt]),
			[
				["specify", 1],
				["accept", 1],
			],
		);
		const accept = executor.launches[1];
		assert.ok(accept);
		assert.equal(accept.specify, undefined);
		assert.deepEqual(accept.tools, ["read", "grep", "ls"]);
		assert.deepEqual(accept.skills, ["acceptance"]);
		assert.equal(accept.settings.maxTokens, ACCEPTANCE_MAX_TOKENS);
		assert.equal(accept.remainingRunTokens, TRUSTED_RUN_CAP - 100);
		assert.ok(!accept.prompt.includes("PRIVATE-ISSUE-TRANSCRIPT"));
		assert.ok(!accept.prompt.includes("snapshot"));
		assert.ok(accept.prompt.includes(MAIN_SHA));
		assert.ok(accept.prompt.includes('"id":"A1"'));
		assert.ok(accept.prompt.includes("export const VERSION"));
		assert.match(accept.prompt, /test_harness/);
		assert.match(accept.prompt, /public harness/);
		assert.doesNotMatch(accept.prompt, /secret\.test|PRIVATE-ORACLE/);
		assert.match(accept.prompt, /lines \d+-\d+ of \d+; omitted=/);
		assert.match(accept.prompt, /checkout=/);
		assert.ok((accept.source?.bytes ?? Infinity) <= 6144);
		const bound = await files.readContract(runOf(14));
		assert.equal(bound.kind, "found");

		if (bound.kind !== "found") throw new Error("contract missing");

		const suite = await files.artifacts.read(
			runOf(14),
			bound.contract,
			bound.digest,
		);

		assert.equal(suite.kind, "found");

		if (suite.kind !== "found") throw new Error("suite missing");
		assert.equal(suite.receipt.contractDigest, bound.digest);
		assert.equal(suite.receipt.model, "openai/gpt-6.1-sol");
		const [summary] = keyed(github, 14, "acceptance");
		assert.ok(summary?.includes("S1: A1"));
		assert.ok(
			summary?.includes("context-isolated, same family, not cross-family"),
		);

		for (const value of [
			"canary",
			"version.test.ts",
			"import assert",
			"/acceptance/",
		])
			assert.ok(!summary?.includes(value));
		assert.equal(keyed(github, 14, "acceptance").length, 1);
		assert.equal(report.totals.usage, 120);
		assert.equal(report.active, 1);
		assert.equal(report.runs[0]?.stage, "build");
		assert.deepEqual(report.corrupt, []);
	});

	for (const comments of [50, 51])
		it(`launches accept once the issue carries ${comments} controller comments`, async () => {
			const { github, executor, logs, wire, start } = world();
			const issue = github.add(labeled(14));

			// Markers 1-3 also count before accept's ledger read.
			for (let i = 0; i < comments - 3; i++) github.comment(issue, `old ${i}`);

			const ids = (args: readonly string[]) =>
				args.filter((arg) => arg.startsWith("ids[]=")).length;

			let largest = 0;

			wire.intercept = async (command, args) => {
				largest = Math.max(largest, ids(args));
				advanceOnPost(github, args);

				return ids(args) > 50
					? httpError(
							403,
							"GitHub GraphQL request rejected: document references 51 node IDs, more than the 50 the proxy will resolve",
						)
					: github.exec(command, args);
			};

			executor.behaviors = [{ kind: "pass", usage: 100 }];
			executor.acceptBehavior = { kind: "pass", usage: 20 };

			// Ticks, as `serve` runs them: the next tick sees specify's markers.
			const controller = start();
			await controller.tick();
			await settle();
			await controller.tick();
			assert.deepEqual(
				executor.launches.map((l) => [l.stage, l.attempt]),
				[
					["specify", 1],
					["accept", 1],
				],
			);
			assert.equal(largest, 50);
			assert.ok(!logs.some((l) => l.event === "claim_unverified"));
		});

	it("logs a claim whose ledger read keeps failing once, and shows why in status", async () => {
		const { github, executor, logs, wire, start } = world();
		github.add(labeled(14));
		executor.behaviors = [{ kind: "pass", usage: 100 }];
		executor.acceptBehavior = { kind: "pass", usage: 20 };

		// Every comment-edit read fails once specify has handed the claim back.
		wire.intercept = async (command, args) => {
			advanceOnPost(github, args);

			return statuses(github, 14).includes("3:claimed") &&
				args.some((arg) => arg.includes("nodes(ids:"))
				? httpError(403, "rejected")
				: github.exec(command, args);
		};

		const controller = start();
		await controller.tick();
		await settle();
		await controller.tick();
		await controller.tick();
		const stalled = await controller.tick();
		assert.deepEqual(
			executor.launches.map((l) => l.stage),
			["specify"],
		);
		assert.equal(statuses(github, 14).at(-1), "3:claimed");
		assert.deepEqual(
			logs.filter((l) => l.event === "claim_unverified"),
			[
				{
					event: "claim_unverified",
					fields: {
						issue: 14,
						runId: runOf(14),
						why: "ledger",
						failure: "gh_failed",
					},
				},
			],
		);
		assert.deepEqual(stalled.runs[0]?.unverified, {
			why: "ledger",
			failure: "gh_failed",
			since: START,
		});

		wire.intercept = null;
		const healed = await controller.tick();
		assert.deepEqual(
			executor.launches.map((l) => l.stage),
			["specify", "accept"],
		);
		assert.equal(healed.runs[0]?.unverified, null);
		assert.equal(logs.filter((l) => l.event === "claim_unverified").length, 1);
	});

	for (const read of ["ledger", "timeline"] as const)
		for (const keepClaim of [true, false])
			it(`logs a discovery ${read} failure before adoption (${keepClaim ? "claim kept" : "claim lost"}), once until a clean tick`, async () => {
				const { github, executor, files, logs, wire, start, clock } = world();
				github.add(labeled(14));
				await start().tick();
				assert.equal(executor.launches.length, 1);

				if (!keepClaim) files.claims.clear();
				const controller = start();
				wire.intercept = async (command, args) =>
					args.some((arg) =>
						read === "ledger"
							? arg.includes("nodes(ids:")
							: arg.includes("/timeline"),
					)
						? httpError(403, "rejected")
						: github.exec(command, args);
				const discovered = await controller.tick();
				assert.deepEqual(discovered.unverifiedClaims, [
					{
						issue: 14,
						runId: runOf(14),
						eventId: String(EVENT_ID + 14),
						why: read,
						failure: "gh_failed",
						since: START,
					},
				]);
				assert.equal(
					logs.filter((log) => log.event === "claim_unverified").length,
					1,
				);

				if (read === "ledger") assert.equal(controller.state.runs.size, 0);
				clock.t += 3_600_000;
				await controller.tick();
				assert.deepEqual(
					logs.filter((log) => log.event === "claim_unverified"),
					[
						{
							event: "claim_unverified",
							fields: {
								issue: 14,
								runId: runOf(14),
								why: read,
								failure: "gh_failed",
							},
						},
					],
				);
				assert.equal(executor.launches.length, 1);
				assert.ok(!events(logs).includes("claim_released"));
				wire.intercept = null;
				executor.fallback = { kind: "hang" };
				const healed = await controller.tick();
				assert.equal(healed.runs[0]?.unverified, null);
				assert.equal(executor.launches.length, 2);
				assert.equal(healed.runs[0]?.status, "running");
			});

	it("keeps a discovered unadopted marker visible when a later comments read fails", async () => {
		const { github, executor, files, logs, wire, start, clock } = world();
		github.add(labeled(14));
		executor.fallback = { kind: "hang" };
		await start().tick();
		files.claims.clear();
		let read = "timeline";
		wire.intercept = async (command, args) =>
			args.some((arg) => arg.includes(`/issues/14/${read}`))
				? httpError(403)
				: github.exec(command, args);
		const controller = start();
		const first = await controller.tick();
		assert.deepEqual(first.runs, []);
		assert.equal(first.unverifiedClaims[0]?.why, "timeline");
		clock.t += 60_000;
		read = "comments";
		const held = await controller.tick();
		assert.deepEqual(held.runs, []);
		assert.deepEqual(held.unverifiedClaims, [
			{
				issue: 14,
				runId: runOf(14),
				eventId: String(EVENT_ID + 14),
				why: "ledger",
				failure: "gh_failed",
				since: START,
			},
		]);
		await controller.tick();
		assert.deepEqual(
			logs
				.filter((log) => log.event === "claim_unverified")
				.map((log) => log.fields.why),
			["timeline", "ledger"],
		);
		assert.equal(executor.launches.length, 1);
	});

	it("projects a failed final issue read from the same observation that prevents launch", async () => {
		const { github, executor, logs, wire, start, clock } = world();
		github.add(labeled(14));
		const controller = start();
		await controller.tick();
		executor.fallback = { kind: "hang" };
		wire.intercept = async (command, args) =>
			args.includes(`repos/${repo}/issues/14`)
				? httpError(403)
				: github.exec(command, args);
		const held = await controller.tick();
		assert.deepEqual(held.runs[0]?.unverified, {
			why: "issue",
			failure: "gh_failed",
			since: START,
		});
		clock.t += 60_000;
		assert.deepEqual(
			(await controller.tick()).runs[0]?.unverified,
			held.runs[0]?.unverified,
		);
		await controller.tick();
		assert.equal(executor.launches.length, 1);
		assert.equal(
			events(logs).filter((event) => event === "claim_unverified").length,
			1,
		);
		wire.intercept = null;
		const healed = await controller.tick();
		assert.equal(healed.runs[0]?.unverified, null);
		assert.equal(executor.launches.length, 2);
	});

	it("reacquires ownership after restart and never launches a marker whose local admission was lost", async () => {
		const { github, executor, store, logs, start } = world();
		github.add(labeled(14));
		await start().tick();
		store.records.clear();
		executor.fallback = { kind: "hang" };
		const controller = start();
		const report = await controller.tick();
		await controller.tick();
		assert.deepEqual(report.runs, []);
		assert.equal(executor.launches.length, 1);
		assert.equal(
			events(logs).filter((event) => event === "claim_foreign").length,
			1,
		);
		assert.ok(!events(logs).includes("claim_released"));
	});

	it("logs reason changes and clean-tick resets while preserving the unverified age", async () => {
		const { github, logs, wire, start, clock } = world();
		const issue = github.add(labeled(14));
		const controller = start();
		await controller.tick();
		let read = "ledger";
		wire.intercept = async (command, args) =>
			args.some((arg) =>
				read === "ledger"
					? arg.includes("nodes(ids:")
					: arg.includes("/timeline"),
			)
				? httpError(403, "rejected")
				: github.exec(command, args);
		issue.updatedAt = new Date(clock.t + 1000)
			.toISOString()
			.replace(".000Z", "Z");
		clock.t += 1000;
		const first = await controller.tick();
		const since = clock.t;
		assert.deepEqual(first.runs[0]?.unverified, {
			why: "ledger",
			failure: "gh_failed",
			since,
		});
		clock.t += 60_000;
		read = "timeline";
		const changed = await controller.tick();
		assert.deepEqual(changed.runs[0]?.unverified, {
			why: "timeline",
			failure: "gh_failed",
			since,
		});
		await controller.tick();
		wire.intercept = null;
		await controller.tick();
		issue.updatedAt = new Date(clock.t + 1000)
			.toISOString()
			.replace(".000Z", "Z");
		clock.t += 1000;
		wire.intercept = async (command, args) =>
			args.some((arg) => arg.includes("/timeline"))
				? httpError(403)
				: github.exec(command, args);
		const again = await controller.tick();
		assert.equal(again.runs[0]?.unverified?.since, clock.t);
		assert.deepEqual(
			logs
				.filter((log) => log.event === "claim_unverified")
				.map((log) => log.fields.why),
			["ledger", "timeline", "timeline"],
		);
	});

	it("counts an acceptance store failure once", async () => {
		const { github, executor, files, start } = world();
		github.add(labeled(14));
		executor.behaviors = [{ kind: "pass", usage: 10 }];
		executor.acceptBehavior = { kind: "pass", usage: 7 };
		files.artifacts.store = async () => ({
			kind: "blocked",
			reason: "acceptance_invalid",
		});
		const controller = start();
		const report = await once(controller);
		assert.equal(statuses(github, 14).at(-1), "5:failed");
		assert.equal(report.totals.failures, 1);
		assert.equal((await controller.tick()).totals.failures, 1);
	});

	for (const corrupt of [false, true]) {
		it(`counts unmarked accept spend on claimed-marker reuse${corrupt ? " with an integrity failure" : ""}`, async () => {
			const ctx = world();
			const { github, executor, files, wire, clock } = ctx;
			github.add(labeled(14));
			executor.behaviors = [{ kind: "pass", usage: 10 }];
			executor.acceptBehavior = { kind: "pass", usage: 7 };
			wire.intercept = async (command, args) => {
				const body = args.find((a) => a.startsWith("body="))?.slice(5) ?? "";
				const parsed = parseMarker(body);

				return (parsed.kind === "marker" &&
					parsed.marker.stage === "accept" &&
					parsed.marker.status === "running") ||
					body.includes("<!-- factory-acceptance ")
					? httpError(403)
					: github.exec(command, args);
			};

			const first = ctx.start();
			await once(first);
			await first.tick();
			assert.equal(statuses(github, 14).at(-1), "3:claimed");
			const bound = await files.readContract(runOf(14));

			if (bound.kind !== "found") throw new Error("no contract");
			assert.equal(
				(await files.artifacts.read(runOf(14), bound.contract, bound.digest))
					.kind,
				"found",
			);
			executor.spentBy.set("accept-1", 7);

			if (corrupt)
				files.artifacts.read = async () => ({
					kind: "blocked",
					reason: "acceptance_changed",
				});
			wire.intercept = null;
			clock.t += 60_000;
			const controller = ctx.start();
			const report = await once(controller);
			const terminal = parseMarker(github.markers(14).at(-1) ?? "");
			assert.equal(terminal.kind, "marker");

			if (terminal.kind !== "marker") throw new Error("no marker");
			assert.equal(terminal.marker.status, corrupt ? "failed" : "claimed");
			assert.equal(terminal.marker.usage, 17);
			assert.equal(report.totals.usage, 7);
			assert.equal(report.totals.failures, corrupt ? 1 : 0);
			assert.equal((await controller.tick()).totals.usage, 7);
			assert.equal(
				executor.launches.filter((l) => l.stage !== "build").length,
				2,
			);
		});
	}

	it("recovers model identity from passed output before storing the suite", async () => {
		const ctx = world();
		const { github, executor, files, clock } = ctx;
		github.add(labeled(14));
		executor.behaviors = [{ kind: "pass", usage: 10 }];
		executor.acceptBehavior = { kind: "pass", usage: 7 };
		const store = files.artifacts.store;
		files.artifacts.store = async () => {
			throw new Error("crash before store");
		};

		await assert.rejects(once(ctx.start()), /crash before store/);
		files.artifacts.store = store;
		assert.equal(statuses(github, 14).at(-1), "4:running");
		executor.spentBy.set("accept-1", 7);
		executor.output = async () => ({
			kind: "output",
			text: ACCEPTANCE_TEXT,
			model: "openai/recorded-model",
			observed: "recorded-observation",
		});
		clock.t += 60_000;
		const report = await ctx.start().tick();
		const bound = await files.readContract(runOf(14));

		if (bound.kind !== "found") throw new Error("no contract");

		const stored = await files.artifacts.read(
			runOf(14),
			bound.contract,
			bound.digest,
		);

		assert.equal(stored.kind, "found");

		if (stored.kind !== "found") throw new Error("no suite");
		assert.equal(stored.receipt.model, "openai/recorded-model");
		assert.equal(stored.receipt.observed, "recorded-observation");
		assert.equal(report.totals.usage, 7);
		assert.equal(
			executor.launches.filter((l) => l.stage !== "build").length,
			2,
		);
	});

	for (const output of [
		"",
		"{}",
		JSON.stringify({ version: 1, scenarios: [], files: [] }),
		ACCEPTANCE_TEXT.replace("version.test.ts", "../escape.test.ts"),
	]) {
		it(`fails invalid accept output without storing or advancing: ${output.slice(0, 40)}`, async () => {
			const { github, executor, files, start, clock } = world();
			github.add(labeled(14));
			executor.behaviors = [{ kind: "pass", usage: 10 }];
			executor.acceptBehavior = { kind: "pass", usage: 7 };
			executor.acceptText = output;
			const controller = start();
			await once(controller);
			assert.equal(controller.state.runs.get(14)?.stage, "accept");
			assert.equal(controller.state.runs.get(14)?.attempt, 2);
			clock.t += 10_000;
			await once(controller);
			clock.t += 20_000;
			const report = await once(controller);
			assert.equal(statuses(github, 14).at(-1), "9:failed");
			assert.equal(report.totals.usage, 31);
			assert.equal(keyed(github, 14, "acceptance").length, 0);
			const bound = await files.readContract(runOf(14));

			if (bound.kind !== "found") throw new Error("contract missing");
			assert.deepEqual(
				await files.artifacts.read(runOf(14), bound.contract, bound.digest),
				{
					kind: "absent",
				},
			);
		});
	}

	for (const [judge, reason] of [
		[
			"Require the trusted npm run check gate to pass...",
			"judge_restates_gate",
		],
		[
			"Independently introduce each regression and verify the dedicated test fails",
			"judge_requires_execution",
		],
	])
		it(`retries ${reason} within the accept attempt cap without storing or building`, {
			timeout: 5000,
		}, async () => {
			const { github, executor, files, logs, start, clock } = world();
			github.add(labeled(14));
			executor.behaviors = [{ kind: "pass", usage: 10 }];
			executor.acceptBehavior = { kind: "pass", usage: 7 };
			executor.acceptText = ACCEPTANCE_TEXT.replace(
				'"scenarios":[',
				`"scenarios":[${JSON.stringify({ id: "S2", criteria: ["A1"], checks: [], judge })},`,
			);
			const controller = start();
			await once(controller);
			assert.equal(controller.state.runs.get(14)?.stage, "accept");
			assert.equal(controller.state.runs.get(14)?.attempt, 2);
			clock.t += 10_000;
			await once(controller);
			clock.t += 20_000;
			const report = await once(controller);
			assert.equal(statuses(github, 14).at(-1), "9:failed");
			assert.equal(report.totals.usage, 31);
			assert.equal(executor.baseChecks.length, 0);
			assert.deepEqual(
				executor.launches.map((launch) => [launch.stage, launch.attempt]),
				[
					["specify", 1],
					["accept", 1],
					["accept", 2],
					["accept", 3],
				],
			);
			assert.deepEqual(
				logs
					.filter((log) => log.event === "acceptance_malformed")
					.map((log) => log.fields.reason),
				[reason, reason, reason],
			);
			assert.equal(keyed(github, 14, "acceptance").length, 0);
			const bound = await files.readContract(runOf(14));

			if (bound.kind !== "found") throw new Error("contract missing");
			assert.equal(
				(await files.artifacts.read(runOf(14), bound.contract, bound.digest))
					.kind,
				"absent",
			);
		});

	it("final acceptance refuses the #430 test dependency using the trusted base inventory", {
		timeout: 30000,
	}, async () => {
		const { github, executor, files, logs, start } = world();
		github.add(labeled(14));
		executor.tree.set("test/host/sandbox/launcher.test.ts", "base test");
		executor.behaviors = [{ kind: "pass", usage: 10 }];
		executor.acceptBehavior = { kind: "pass", usage: 7 };
		executor.acceptText = JSON.stringify({
			version: 2,
			scenarios: [
				{
					id: "S1",
					criteria: ["A1"],
					checks: ["regression.test.mjs"],
					judge: null,
				},
			],
			files: [
				{
					path: "regression.test.mjs",
					type: "node:test",
					content: readFileSync(
						"test/fixtures/acceptance/430-wrapper-regression.txt",
						"utf8",
					),
				},
			],
		});
		const controller = start();
		await once(controller);
		assert.equal(controller.state.runs.get(14)?.attempt, 2);
		assert.equal(executor.baseChecks.length, 0);
		assert.equal(
			executor.launches.some((launch) => launch.stage === "build"),
			false,
		);
		assert.ok(
			logs.some(
				(log) =>
					log.event === "acceptance_malformed" &&
					log.fields.reason === "heldout_reads_preserved_test",
			),
		);
		const bound = await files.readContract(runOf(14));
		assert.equal(bound.kind, "found");

		if (bound.kind !== "found") throw new Error("missing contract");
		assert.equal(
			(await files.artifacts.read(runOf(14), bound.contract, bound.digest))
				.kind,
			"absent",
		);
	});

	it("drops exhausted accept output while retaining its usage", async () => {
		const { github, executor, files, start } = world();
		github.add(labeled(14));
		executor.behaviors = [{ kind: "pass", usage: 10 }];
		executor.acceptBehavior = { kind: "budget", usage: 7 };
		const report = await once(start());
		assert.equal(statuses(github, 14).at(-1), "5:budget_exhausted");
		assert.equal(report.totals.usage, 17);
		assert.equal(keyed(github, 14, "acceptance").length, 0);
		const bound = await files.readContract(runOf(14));

		if (bound.kind !== "found") throw new Error("contract missing");
		assert.deepEqual(
			await files.artifacts.read(runOf(14), bound.contract, bound.digest),
			{
				kind: "absent",
			},
		);
	});

	for (const corrupt of [false, true]) {
		it(`recovers after suite storage without regenerating${corrupt ? ", blocking changed bytes" : ""}`, async () => {
			const ctx = world();
			const { github, executor, files, wire, clock } = ctx;
			github.add(labeled(14));
			executor.behaviors = [{ kind: "pass", usage: 10 }];
			executor.acceptBehavior = { kind: "pass", usage: 7 };
			wire.intercept = async (command, args) =>
				args.some(
					(a) =>
						a.startsWith("body=") && a.includes("<!-- factory-acceptance "),
				)
					? networkError()
					: github.exec(command, args);
			await once(ctx.start());
			assert.equal(statuses(github, 14).at(-1), "5:running");
			const bound = await files.readContract(runOf(14));

			if (bound.kind !== "found") throw new Error("contract missing");

			const kept = await files.artifacts.read(
				runOf(14),
				bound.contract,
				bound.digest,
			);

			assert.equal(kept.kind, "found");

			if (corrupt)
				files.artifacts.read = async () => ({
					kind: "blocked",
					reason: "acceptance_changed",
				});
			executor.kept.delete(`${runOf(14)}/accept-1`);
			executor.spentBy.set("accept-1", 7);
			wire.intercept = null;
			clock.t += 60_000;
			const report = await once(ctx.start());
			assert.equal(
				executor.launches.filter((l) => l.stage !== "build").length,
				2,
			);
			assert.equal(
				statuses(github, 14).at(-1),
				corrupt ? "6:failed" : "6:claimed",
			);
			assert.equal(keyed(github, 14, "acceptance").length, corrupt ? 0 : 1);
			assert.deepEqual(report.corrupt, []);

			assert.equal(report.totals.failures, corrupt ? 1 : 0);

			if (corrupt)
				assert.ok(ctx.logs.some((e) => e.fields.why === "acceptance_changed"));
			else
				assert.deepEqual(
					await files.artifacts.read(runOf(14), bound.contract, bound.digest),
					kept,
				);
		});
	}
});

describe("held-out acceptance stage: needs_info", () => {
	it("ends a questions result at specify and never launches accept", async () => {
		const { github, executor, files, clock, wire, start } = world();

		wire.intercept = writesWire(github, []);
		github.add(labeled(14));
		executor.outputs = [QUESTIONS_TEXT];
		executor.behaviors = [{ kind: "pass", usage: 3 }];
		executor.acceptBehavior = { kind: "pass", usage: 7 };

		const controller = start();

		for (let tick = 0; tick < 3; tick++) {
			await once(controller);
			clock.t += 60_000;
		}

		assert.equal(statuses(github, 14).at(-1), "3:needs_info");
		assert.deepEqual(
			executor.launches.map((l) => l.stage),
			["specify"],
		);
		assert.equal(keyed(github, 14, "acceptance").length, 0);
		assert.equal((await files.readContract(runOf(14))).kind, "blocked");
	});
});
