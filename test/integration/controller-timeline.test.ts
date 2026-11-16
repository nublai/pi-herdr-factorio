import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { fileRunFiles } from "../../host/controller/run-files.ts";
import { readRunTimeline } from "../../host/controller/timeline.ts";
import { timelineFacts } from "../../src/controller/timeline.ts";
import { AUTONOMY_DIGEST } from "../../src/ledger/schema.ts";
import { digestOf } from "../../src/core/run.ts";
import type { JsonValue } from "../../src/core/json.ts";
import {
	classifiedCase,
	failingVerdict,
	storedAssessment,
} from "../helpers.ts";
import {
	labeled,
	once,
	runOf,
	settle,
	sha,
	world,
} from "../src/controller/orchestrator-fixtures.ts";

function recordingWorld(dir: string) {
	const f = world();
	const native = fileRunFiles(dir);
	const accounting = native.accounting;

	assert.ok(accounting && native.ledger);
	Object.assign(f.files, {
		ledger: native.ledger,
		accounting,
		timeline: native.timeline,
		terminalEvidence: native.terminalEvidence,
		prepareRun: async (
			input: Parameters<NonNullable<typeof native.prepareRun>>[0],
		) =>
			accounting.begin({
				v: 2,
				runId: input.runId,
				startedAt: input.startedAt,
				context: {
					kind: "production",
					trustedCap: 800_000,
					policy: {
						workflowSha: input.workflowSha,
						workflowDigest: input.workflowDigest,
						gates: {
							kind: "known",
							value: {
								sourceSha: input.workflowSha,
								digest: digestOf("synthetic-gates"),
							},
						},
						autonomy: {
							approveMerge: "always",
							land: "propose",
							digest: AUTONOMY_DIGEST,
						},
					},
				},
			}),
	});

	return { f, native };
}

it("keeps the terminal outcome and non-timeline ledger fields when every timeline write throws", {
	timeout: 30_000,
}, async (t) => {
	const run = async (throws: boolean) => {
		const dir = mkdtempSync(join(tmpdir(), "factory-timeline-failure-"));
		t.after(() => rmSync(dir, { recursive: true, force: true }));
		const { f, native } = recordingWorld(dir);

		assert.ok(native.ledger);

		if (throws) {
			const fail = async () => {
				throw new Error("timeline unavailable");
			};

			Object.assign(f.files, { timeline: { point: fail, transition: fail } });
		}

		f.github.add(labeled(14));
		f.executor.fallback = { kind: "fail", usage: 10 };
		const controller = f.start();

		for (let tick = 0; tick < 6; tick++) {
			await once(controller);
			f.clock.t += 30_000;
		}

		const row = (await native.ledger.scan())?.[0]?.row?.row;

		assert.ok(row?.v === 6);
		assert.equal(row.outcome.kind, "failed");
		assert.equal(row.timeline.kind, throws ? "unavailable" : "known");
		assert.equal(
			f.logs.some((l) => l.event === "timeline_unwritable"),
			throws,
		);
		assert.equal(row.buildDrafts.kind, throws ? "unavailable" : "known");
		assert.equal(row.repairRounds.kind, throws ? "unavailable" : "known");

		const {
			controllerRevision: _revision,
			timeline: _timeline,
			repairRounds: _rounds,
			buildDrafts: _drafts,
			...unchanged
		} = row;

		return unchanged;
	};

	const working = await run(false);
	const failed = new Map(Object.entries(await run(true)));

	const hash = (value: JsonValue | undefined) =>
		createHash("sha256")
			.update(JSON.stringify(value) ?? "undefined")
			.digest("hex");

	assert.equal(failed.size, Object.keys(working).length);

	for (const [key, value] of Object.entries(working))
		assert.equal(hash(failed.get(key)), hash(value), key);
});

it("bounds timeline records across repeated unavailable launches", {
	timeout: 30_000,
}, async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "factory-timeline-unavailable-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const { f } = recordingWorld(dir);

	f.github.add(labeled(14));
	f.executor.fallback = { kind: "unavailable" };
	f.executor.ready = true;
	const controller = f.start();

	for (let tick = 0; tick < 100; tick++) {
		await once(controller);
		f.clock.t += 1000;
	}

	const records = readRunTimeline(dir, runOf(14));

	assert.ok(records);
	assert.equal(f.executor.launches.length, 100);
	assert.ok(
		records.length <= 3,
		`expected at most 3 timeline lines, got ${records.length}`,
	);
	assert.equal(
		records.some((r) => r.category === "model"),
		false,
	);
});

for (const restart of ["ci_wait", "repair_tests"] as const)
	it(`records a controller repair round and a v6 timeline through ${restart} restart and terminal freeze`, {
		timeout: 30_000,
	}, async (t) => {
		const dir = mkdtempSync(join(tmpdir(), "factory-measure-controller-"));
		t.after(() => rmSync(dir, { recursive: true, force: true }));
		const revision = "e".repeat(40);

		writeFileSync(
			join(dir, "install-exe-dev.commit"),
			`${revision} nublai/pi-herdr-factorio\n`,
		);
		const { f, native } = recordingWorld(dir);

		assert.ok(native.ledger);
		f.github.add(labeled(14));
		f.executor.behaviors = [{ kind: "pass", usage: 10 }];
		f.executor.acceptBehavior = { kind: "pass", usage: 7 };
		f.executor.buildBehavior = { kind: "pass", usage: 12 };

		let waited = false;

		f.executor.validate = async (input) => {
			const round = input.round ?? 0;

			const state = input.state ?? {
				version: 1,
				startedAt: input.now,
				deadline: input.now + input.wallMs,
				round,
				originalBase: input.baseSha,
				baseSha: input.baseSha,
				baseResolved: true,
				publication: {
					branch: `factory/run/14-${input.runId.slice(0, 12)}-r${round}`,
					patchSha: sha("b".repeat(40)),
					candidateSha: sha("c".repeat(40)),
				},
				dispatchTry: 1,
				dispatchedAt: input.now,
				ciRunId: 123 + round,
				counters: {},
			};

			await input.save(state);

			if (!waited) {
				waited = true;

				return { kind: "waiting", state };
			}

			const verdict = failingVerdict(
				digestOf(round === 0 ? "patch" : "patch-r1"),
			);

			const { text, read } = storedAssessment({
				runId: input.runId,
				round,
				generation: input.generation?.generation ?? 0,
				verdict,
				assessment: {
					kind: "failed",
					failure: classifiedCase(
						round === 0 ? "candidate_load_error" : "tree_disagreement",
					),
				},
			});

			f.executor.assessments.set(
				`${input.runId}/${round}/${input.generation?.generation ?? 0}`,
				text,
			);

			return { kind: "finished", state, verdict, assessment: read };
		};

		let controller = f.start();

		await once(controller);
		f.clock.t += 1000;
		await once(controller);
		f.clock.t += 1000;
		await once(controller);
		assert.equal(waited, true);

		if (restart === "repair_tests") {
			f.executor.buildBehavior = {
				kind: "later",
				result: new Promise(() => {}),
			};

			for (let tick = 0; tick < 6; tick++) {
				f.clock.t += 1000;
				await controller.tick();
				await settle();

				if (
					f.executor.launches.some((l) => l.stage === "build" && l.round === 1)
				)
					break;
			}

			const repair = f.executor.launches.find(
				(l) => l.stage === "build" && l.round === 1,
			)?.execution;

			assert.ok(repair);
			f.executor.candidateSpent.set(repair.id, 12);
		}

		const prefix = readFileSync(join(dir, "timeline", `${runOf(14)}.jsonl`));

		Object.assign(f.files, { timeline: fileRunFiles(dir).timeline });
		controller = f.start();

		if (restart === "repair_tests") {
			const output = f.executor.output.bind(f.executor);

			f.executor.output = async (input) =>
				input.stage === "build" && input.round === 1
					? { kind: "pending", testing: true }
					: output(input);

			for (let tick = 0; tick < 2; tick++) {
				f.clock.t += 1000;
				await controller.tick();
				await settle();
			}

			const testing = readRunTimeline(dir, runOf(14))?.filter(
				(r) =>
					r.name === "visible_tests" && r.round === 1 && r.kind === "start",
			);

			assert.equal(testing?.length, 1);
			f.executor.output = output;
		}

		for (let tick = 0; tick < 12; tick++) {
			f.clock.t += 1000;
			await controller.tick();
			await settle();
		}

		const row = (await native.ledger.scan())?.[0]?.row?.row;

		assert.ok(row?.v === 6);
		assert.deepEqual(row.controllerRevision, {
			kind: "known",
			value: revision,
		});
		assert.deepEqual(row.repairRounds, {
			kind: "known",
			value: { authorized: 1, started: 1, completed: 1 },
		});
		const records = readRunTimeline(dir, runOf(14));

		assert.ok(records);
		assert.ok(
			readFileSync(join(dir, "timeline", `${runOf(14)}.jsonl`))
				.subarray(0, prefix.length)
				.equals(prefix),
		);
		assert.deepEqual(row.timeline, {
			kind: "known",
			value: timelineFacts(records)?.summary,
		});
		assert.ok(records.some((r) => r.name === "visible_tests"));

		if (restart === "repair_tests") {
			const repairTests = records.filter(
				(r) => r.name === "visible_tests" && r.round === 1,
			);

			assert.deepEqual(
				repairTests.map((r) => r.kind),
				["start", "end"],
			);
			assert.ok((repairTests[1]?.at ?? 0) > (repairTests[0]?.at ?? 0));
		}

		assert.ok(records.some((r) => r.name === "validation"));
		assert.ok(records.some((r) => r.name === "ci_wait"));
		assert.ok(row.timeline.kind === "known");
		assert.equal(
			row.timeline.value.elapsedMs,
			Date.parse(row.terminalObservedAt) -
				Date.parse(row.startedAt.kind === "known" ? row.startedAt.value : ""),
		);
		const ends = records.filter((r) => r.kind === "end" && r.name === "stage");

		assert.equal(new Set(ends.map((r) => r.key)).size, ends.length);
		assert.equal(
			f.executor.launches.filter((l) => l.stage === "build" && l.round === 1)
				.length,
			1,
		);
	});
