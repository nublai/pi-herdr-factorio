import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fileRunFiles } from "../../../host/controller/run-files.ts";
import type { ClaimRecord } from "../../../src/controller/claims.ts";
import { digestOf } from "../../../src/core/run.ts";
import {
	START,
	labeled,
	runOf,
	stateDir,
	schedulingTrace,
	stableTraces,
	type FreshPhase,
	type FreshOutput,
	freshProcess,
} from "./orchestrator-fixtures.ts";

describe("L10 scheduling characterization", () => {
	it("pins ordered events, requests, claim records, slots and accounting over tick, completion and restart", async () => {
		const trace = await schedulingTrace();
		const [text, again] = stableTraces(trace, await schedulingTrace());

		assert.equal(again, text);

		for (const { report } of trace)
			if (report !== null) assert.ok(report.active <= report.maxConcurrent);

		assert.equal(
			digestOf(text),
			"0a592bf3e2de31e489fb5c35b07ff4bf1f8626096d46eeb224eb9f5a2f5a0fbe",
		);
	});
});

describe("L10 fresh-process recovery characterization", () => {
	it("pins claims, captured identity and usage floors across fresh processes at claim, launch and completion", async () => {
		const state = stateDir();
		const files = fileRunFiles(state);
		let issues = [14, 15, 16].map((issue) => labeled(issue));

		const phases: {
			name: string;
			output: FreshOutput;
			claims: ClaimRecord[];
		}[] = [];

		const run = async (name: string, phase: FreshPhase) => {
			const output = freshProcess(state, issues, phase);

			issues = output.issues;
			phases.push({
				name,
				output,
				claims: (await files.listClaims()).sort((a, b) => a.issue - b.issue),
			});

			return output;
		};

		const claimed = await run("claim", {
			preflight: false,
			launch: "unavailable",
			usage: 0,
			spent: {},
			ticks: 1,
			now: START,
		});

		const launched = await run("launch", {
			preflight: true,
			launch: "hang",
			usage: 120,
			spent: {},
			ticks: 1,
			now: START + 60_000,
		});

		const completed = await run("completion", {
			preflight: true,
			launch: "pass",
			usage: 30,
			spent: { "specify-1": 120 },
			ticks: 3,
			now: START + 120_000,
		});

		const reloaded = await run("reload", {
			preflight: false,
			launch: "unavailable",
			usage: 0,
			spent: { "specify-1": 120 },
			ticks: 1,
			now: START + 300_000,
		});

		assert.deepEqual(
			claimed.reports[0]?.runs.map((run) => [run.issue, run.status]),
			[
				[14, "blocked"],
				[15, "blocked"],
			],
		);
		assert.deepEqual(claimed.reports[0]?.queued, [16]);
		assert.deepEqual(
			launched.reports[0]?.runs.map((run) => [run.issue, run.status]),
			[
				[14, "running"],
				[15, "running"],
			],
		);

		for (const issue of [14, 15]) {
			const ids = phases.map(
				({ claims }) => claims.find((claim) => claim.issue === issue)?.runId,
			);

			assert.deepEqual(ids, Array(phases.length).fill(runOf(issue)));
		}

		const usage = (output: FreshOutput) =>
			output.reports.at(-1)?.runs.map((run) => [run.issue, run.usage]);

		assert.deepEqual(usage(reloaded), usage(completed));
		assert.ok(
			(reloaded.reports[0]?.runs ?? []).every((run) => run.usage >= 120),
		);

		const text = JSON.stringify(phases).replaceAll(state, "<state>");

		assert.equal(
			digestOf(text),
			"ce89118292e1831d65be6e9d9d3d488f638a8fa4c026d43af02a49b750af723a",
		);
	});
});
