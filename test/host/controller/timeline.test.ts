import assert from "node:assert/strict";
import {
	mkdtempSync,
	mkdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import {
	fileRunTimeline,
	readRunTimeline,
} from "../../../host/controller/timeline.ts";
import {
	timelineFacts,
	type TimelineInput,
} from "../../../src/controller/timeline.ts";
import { digestOf } from "../../../src/core/run.ts";
import { readTerminalEvidence } from "../../../host/controller/terminal.ts";

it("appends private timeline intervals, pins the installed revision and resumes without duplicate ends", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "factory-timeline-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const run = digestOf("synthetic-run");
	const revision = "a".repeat(40);

	writeFileSync(join(dir, "install-exe-dev.commit"), `${revision}\n`);
	let port = fileRunTimeline(dir);

	const input = (
		name: TimelineInput["name"],
		at: number,
		category: TimelineInput["category"] = "controller",
	) => ({
		name,
		at,
		category,
		key: name,
		stage: "build" as const,
		round: 1,
		attempt: 1,
	});

	assert.equal(await port.point(run, input("claim", 1000)), true);
	assert.equal(await port.transition(run, input("stage", 1100, "model")), true);
	const path = join(dir, "timeline", `${run}.jsonl`);
	const prefix = readFileSync(path);

	port = fileRunTimeline(dir);
	writeFileSync(join(dir, "install-exe-dev.commit"), `${"b".repeat(40)}\n`);
	assert.equal(await port.transition(run, input("stage", 1300, "model")), true);
	assert.ok(readFileSync(path).equals(prefix));

	for (const name of [
		"repair_authorized",
		"repair_started",
		"repair_completed",
	] as const) {
		assert.equal(await port.point(run, input(name, 1400)), true);
		assert.equal(await port.point(run, input(name, 1400)), true);
	}

	assert.equal(
		await port.transition(run, input("visible_tests", 1500, "check")),
		true,
	);
	assert.equal(
		await port.transition(run, input("ci_wait", 2000, "ci_wait")),
		true,
	);
	assert.equal(
		await port.transition(run, input("owner_wait", 2500, "owner_wait")),
		true,
	);
	assert.equal(await port.point(run, input("terminal", 3000)), true);
	const bytes = readFileSync(path);

	assert.equal(
		await fileRunTimeline(dir).point(run, input("terminal", 4000)),
		true,
	);
	assert.ok(readFileSync(path).equals(bytes));
	assert.ok(bytes.subarray(0, prefix.length).equals(prefix));
	const records = readRunTimeline(dir, run);

	assert.ok(records);
	assert.equal(
		records.filter((r) => r.name === "stage" && r.kind === "end").length,
		1,
	);
	assert.deepEqual(timelineFacts(records), {
		controllerRevision: revision,
		repairRounds: { authorized: 1, started: 1, completed: 1 },
		summary: {
			elapsedMs: 2000,
			modelMs: 400,
			checkMs: 500,
			ciWaitMs: 500,
			ownerWaitMs: 500,
			controllerMs: 100,
		},
	});
	assert.equal(statSync(join(dir, "timeline")).mode & 0o777, 0o700);
	assert.equal(statSync(path).mode & 0o777, 0o600);
});

it("summarizes each build receipt once and never turns absent legacy draft counters into zero", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "factory-build-summary-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const run = digestOf("synthetic-build-summary");
	const port = fileRunTimeline(dir);

	const point = {
		at: 1,
		category: "controller" as const,
		stage: null,
		round: 0,
		attempt: 0,
	};

	await port.point(run, { ...point, name: "claim", key: "claim" });
	await port.point(run, {
		...point,
		at: 1000,
		name: "terminal",
		key: "terminal",
	});

	const receipt = {
		version: 1,
		runId: run,
		stage: "build",
		attempt: 1,
		turns: 1,
		wallMs: 10,
		outcome: { kind: "passed" },
		usage: {
			total: 100,
			parent: 100,
			children: 0,
			byModel: {},
			gateway: 100,
			unreadChildren: 0,
		},
	};

	for (const [name, runs, tokens, skips] of [
		["build-1", 1, 200, []],
		["build-1.1", 1, 50, ["wall"]],
		["build-r1-1", 0, 0, ["tokens"]],
	] as const) {
		const stage = join(dir, "stages", run, name);

		mkdirSync(stage, { recursive: true });
		writeFileSync(
			join(stage, "receipt.json"),
			JSON.stringify({
				...receipt,
				draftRuns: runs,
				draftRevisionTokens: tokens,
				draftSkips: skips,
			}),
		);
	}

	assert.deepEqual(
		(await readTerminalEvidence(dir, run, 300, null)).buildDrafts,
		{
			kind: "known",
			value: {
				draftRuns: 2,
				draftRevisionTokens: 250,
				draftSkips: { tokens: 1, wall: 1 },
			},
		},
	);
	writeFileSync(
		join(dir, "stages", run, "build-1", "receipt.json"),
		JSON.stringify(receipt),
	);
	assert.equal(
		(await readTerminalEvidence(dir, run, 300, null)).buildDrafts?.kind,
		"unavailable",
	);
});

it("leaves absent, unfinished and corrupt historical timelines unavailable", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "factory-timeline-gap-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const run = digestOf("historical-run");

	assert.equal(readRunTimeline(dir, run), null);
	assert.equal(timelineFacts([]), null);

	const port = fileRunTimeline(dir);

	const input = {
		name: "claim" as const,
		at: 1000,
		category: "controller" as const,
		key: "claim",
		stage: null,
		round: 0,
		attempt: 0,
	};

	assert.equal(await port.point(run, input), true);
	assert.equal(timelineFacts(readRunTimeline(dir, run) ?? []), null);
	const path = join(dir, "timeline", `${run}.jsonl`);

	writeFileSync(path, "broken\n");
	assert.equal(readRunTimeline(dir, run), null);
	assert.equal(
		await port.point(run, { ...input, name: "terminal", key: "terminal" }),
		false,
	);
	assert.equal(readFileSync(path, "utf8"), "broken\n");
});
