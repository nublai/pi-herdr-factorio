import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { requestSettlements } from "../../../src/core/journal.ts";
import { digestOf } from "../../../src/core/run.ts";
import { PINNED_TARIFF } from "../../../src/core/tariff.ts";
import {
	parseLedger,
	ledgerRowOf,
	type LedgerRow,
	type LedgerRowV5,
} from "../../../src/ledger/schema.ts";
import {
	scoreboard,
	type ScoreboardReceipts,
} from "../../../src/views/scoreboard.ts";
import { timelineRecord } from "../../../src/controller/timeline.ts";

const fixture = parseLedger(
	readFileSync(
		new URL("../../fixtures/metrics/runs-2026-11-08.jsonl", import.meta.url),
	),
);

const saved = fixture.find(
	(entry) =>
		entry.kind === "known" &&
		entry.row.v === 4 &&
		entry.row.outcome.kind === "landed",
);

assert.ok(saved?.kind === "known" && saved.row.outcome.kind === "landed");

const upgraded = ledgerRowOf({
	...saved.row,
	v: 5,
	outcome: { ...saved.row.outcome, assurance: { kind: "owner_override" } },
}).row;

assert.ok(upgraded.v === 5);

const base: LedgerRowV5 = upgraded;

function row(outcome: LedgerRowV5["outcome"] = base.outcome): LedgerRowV5 {
	assert.ok(base.stages.kind === "known");
	const build = base.stages.value.find((entry) => entry.stage === "build");
	assert.ok(build);

	return {
		...base,
		failure: null,
		runId: digestOf(outcome.kind),
		outcome,
		models: { kind: "unavailable", reason: "receipt_missing" },
		stages: {
			kind: "known",
			value: [
				{ ...build, tokens: { kind: "exact", unit: "tokens", total: 1200 } },
			],
		},
		usage: {
			...base.usage,
			tokens: { kind: "exact", unit: "tokens", total: 1200 },
		},
	};
}

function receipt(run: LedgerRow): ScoreboardReceipts {
	return {
		runId: run.runId,
		title: "Synthetic ticket",
		timeline: null,
		stages: [
			{
				stage: "build",
				requests: requestSettlements(
					`${JSON.stringify({ kind: "result", req: 1, route: "model-openai", inputTokens: 1000, outputTokens: 200 })}\n`,
				).requests.map((settlement) => ({
					settlement,
					model: "openai/gpt-6.1-sol",
				})),
				missingJournals: 0,
				missingReceipts: 0,
				invalidLines: 0,
			},
		],
	};
}

test("scoreboard groups v5 runs under unknown revision, ticket, stage, model and failure", () => {
	const landed = row();

	const failed = row({
		kind: "failed",
		stage: "build",
		cause: { kind: "unavailable", reason: "receipt_missing" },
	});

	const result = scoreboard(
		[landed, failed],
		[receipt(landed), receipt(failed)],
		PINNED_TARIFF,
	);

	assert.equal(result.summary.runs, 2);
	assert.equal(result.summary.landed.count, 1);
	assert.equal(result.summary.landed.rate, 0.5);
	assert.equal(result.groups.revision[0]?.key, "unknown");
	assert.equal(result.groups.revision[0]?.runs, 2);
	assert.equal(result.groups.ticket.length, 1);
	assert.ok(result.groups.stage.some((entry) => entry.key === "build"));
	assert.ok(
		result.groups.model.some((entry) => entry.key === "openai/gpt-6.1-sol"),
	);
	assert.ok(result.groups.failure.some((entry) => entry.key === "unknown"));
	assert.equal(result.summary.estimate.usdMicros, 8000);
	assert.equal(result.summary.estimate.perRunUsdMicros, 4000);
	assert.equal(result.summary.estimate.perLandedPrUsdMicros, 8000);
	assert.equal(result.summary.estimate.kind, "api_equivalent_estimate");
	assert.equal(result.summary.billedSpend, "unavailable");
	assert.equal(result.summary.readyPr.rate, null);
	assert.equal(result.summary.wallMs.total, null);
});

test("scoreboard keeps missing cost, no landing and released readiness unknown", () => {
	const released = row({ kind: "released", stage: "land" });
	const result = scoreboard([released], [], PINNED_TARIFF);
	assert.equal(result.summary.outcomes.released, 1);
	assert.equal(result.summary.estimate.usdMicros, null);
	assert.equal(result.summary.estimate.perLandedPrUsdMicros, null);
	assert.equal(result.summary.coverage.kind, "unavailable");
	assert.equal(result.summary.readyPr.unknown, 1);
	assert.equal(result.summary.tokens.total, null);
	assert.equal(result.groups.model[0]?.key, "unknown");
	assert.equal(result.groups.model[0]?.estimate.usdMicros, null);
});

test("scoreboard uses v6 timeline stage intervals and category totals without guessing v5 history", () => {
	const previous = row();

	const run: LedgerRow = {
		...previous,
		v: 6,
		controllerRevision: { kind: "known", value: base.originalBase },
		timeline: {
			kind: "known",
			value: {
				elapsedMs: 200,
				modelMs: 100,
				checkMs: 0,
				ciWaitMs: 0,
				ownerWaitMs: 0,
				controllerMs: 100,
			},
		},
		buildDrafts: { kind: "unavailable", reason: "receipt_missing" },
	};

	const retained = receipt(run);

	const point = {
		v: 1,
		runId: run.runId,
		seq: 0,
		at: 0,
		kind: "point",
		name: "claim",
		key: "claim",
		stage: null,
		round: 0,
		attempt: 0,
		category: "controller",
		controllerRevision: "a".repeat(40),
	};

	retained.timeline = [
		timelineRecord(point),
		timelineRecord({
			...point,
			seq: 1,
			kind: "start",
			name: "stage",
			key: "build",
			stage: "build",
			category: "model",
			at: 10,
		}),
		timelineRecord({
			...point,
			seq: 2,
			kind: "end",
			name: "stage",
			key: "build",
			stage: "build",
			category: "model",
			at: 110,
		}),
		timelineRecord({ ...point, seq: 3, name: "ready_for_review", at: 150 }),
		timelineRecord({ ...point, seq: 4, name: "terminal", at: 200 }),
	];
	const result = scoreboard([run], [retained], PINNED_TARIFF);
	assert.equal(result.groups.revision[0]?.key, base.originalBase);
	assert.equal(result.summary.wallMs.total, 200);
	assert.equal(result.summary.timeline.modelMs?.total, 100);
	assert.equal(
		result.runs[0]?.stages.find((entry) => entry.stage === "build")?.wallMs
			.total,
		100,
	);
	assert.equal(result.summary.readyPr.rate, 1);
});

test("scoreboard groups recorded causal failures without treating a PR as readiness", () => {
	const failed: LedgerRowV5 = {
		...row({
			kind: "failed",
			stage: "land",
			cause: { kind: "known", value: "candidate_failed" },
		}),
		failure: {
			kind: "known",
			value: {
				stage: "build",
				class: "candidate",
				reason: "visible_tests_failed",
				failedVisibleChecks: [],
				retainedPatch: null,
			},
		},
	};

	const report = scoreboard([failed], [receipt(failed)], PINNED_TARIFF);
	assert.equal(report.groups.failure[0]?.key, "candidate");
	assert.equal(report.summary.readyPr.unknown, 1);
	assert.equal(report.summary.estimate.perLandedPrUsdMicros, null);
	assert.equal(report.summary.landed.rate, 0);
});

test("scoreboard preserves partial estimates and uncertain request coverage", () => {
	const run = row();
	const retained = receipt(run);
	const stage = retained.stages[0];
	assert.ok(stage);

	const report = scoreboard(
		[run],
		[{ ...retained, stages: [{ ...stage, missingJournals: 1 }] }],
		PINNED_TARIFF,
	);

	assert.equal(report.summary.estimate.usdMicros, 4000);
	assert.equal(report.summary.coverage.kind, "lower_bound");
	assert.equal(report.summary.coverage.missingJournals, 1);

	const uncertain = scoreboard(
		[
			{
				...run,
				usage: {
					...run.usage,
					tokens: {
						kind: "uncertain",
						unit: "tokens",
						total: 2000,
						reason: "request_unsettled",
					},
				},
			},
		],
		[retained],
		PINNED_TARIFF,
	);

	assert.equal(uncertain.summary.coverage.kind, "uncertain");
	assert.equal(uncertain.runs[0]?.cost.ledgerTokenDifference, 800);
});
