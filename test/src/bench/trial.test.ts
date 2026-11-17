import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseBenchTrial, trialAccounting } from "../../../src/bench/trial.ts";
import { digestOf } from "../../../src/core/run.ts";
import { parseBenchVariant } from "../../../src/bench/variant.ts";
import { syntheticTrial } from "../../host/bench/trial-fixtures.ts";

const journal = [
	{
		kind: "dispatch",
		req: 1,
		route: "model-openai",
		inputTokenEstimate: 100,
		maxOutputTokens: 50,
	},
	{
		kind: "result",
		req: 1,
		route: "model-openai",
		inputTokens: 10,
		outputTokens: 5,
		observedModel: "gpt-6.1-sol",
		status: 200,
	},
]
	.map((line) => JSON.stringify(line))
	.join("\n");

describe("BenchTrial parser", () => {
	it("requires conditional respec provenance, complete successful proofs, and strict nested digests", () => {
		const old = syntheticTrial();
		assert.equal(parseBenchTrial(JSON.stringify(old)).respec, undefined);

		const variant = parseBenchVariant(
			JSON.stringify({
				...old.variant,
				name: "respec",
				change: { kind: "respec", value: "on" },
			}),
		);

		const trial = {
			...old,
			variant,
			variantDigest: digestOf(JSON.stringify(variant)),
			outcome: { kind: "failed", stage: "specify", reason: "specify_failed" },
		};

		const respec = {
			baseSha: "b".repeat(40),
			archiveDigest: digestOf("archive"),
			snapshotDigest: digestOf("snapshot"),
			contractDigest: null,
			acceptanceDigest: null,
			baseReceiptDigest: null,
			acceptEffort: "medium",
			models: [],
		};

		assert.equal(
			parseBenchTrial(JSON.stringify({ ...trial, respec })).respec
				?.contractDigest,
			null,
		);

		assert.equal(
			parseBenchTrial(JSON.stringify({ ...trial, respec })).respec
				?.baseRetryReason,
			null,
		);
		assert.equal(
			parseBenchTrial(
				JSON.stringify({
					...trial,
					respec: { ...respec, baseRetryReason: "preservation_failed" },
				}),
			).respec?.baseRetryReason,
			"preservation_failed",
		);

		for (const value of [
			trial,
			{ ...old, respec },
			{ ...trial, respec: { ...respec, extra: true } },
			{ ...trial, respec: { ...respec, contractDigest: "wrong" } },
			{ ...trial, respec: { ...respec, baseReceiptDigest: "wrong" } },
			{ ...trial, respec: { ...respec, baseRetryReason: "wrong" } },
			{ ...trial, respec: { ...respec, baseRetryReason: "base_runner_error" } },
			{ ...trial, respec: { ...respec, baseRetryReason: 1 } },
			{ ...trial, respec, outcome: { kind: "passed" } },
		])
			assert.throws(() => parseBenchTrial(JSON.stringify(value)));
	});
	it("rejects coverage kinds that contradict counts or claim unavailable with a numeric estimate", () => {
		const trial = syntheticTrial();
		const missing = syntheticTrial({ missing: true });
		const cost = trial.accounting.cost;

		for (const value of [
			{ ...cost, coverage: { ...cost.coverage, kind: "uncertain" } },
			{ ...cost, coverage: { ...cost.coverage, kind: "lower_bound" } },
			{ ...cost, coverage: { ...cost.coverage, kind: "unavailable" } },
			{
				...missing.accounting.cost,
				coverage: { ...missing.accounting.cost.coverage, kind: "exact" },
			},
			{
				...cost,
				coverage: { ...cost.coverage, kind: "lower_bound", priced: 2 },
			},
		])
			assert.throws(
				() =>
					parseBenchTrial(
						JSON.stringify({
							...trial,
							accounting: { ...trial.accounting, cost: value },
						}),
					),
				/trial_cost_mismatch/,
			);
		assert.equal(
			parseBenchTrial(JSON.stringify(missing)).accounting.cost.estimate
				.usdMicros,
			null,
		);
	});
	it("rejects fallbackRecord because the bench writer never emits it", () => {
		const trial = syntheticTrial();

		const seat = {
			seat: "code-review",
			findings: [],
			judgments: [],
			requested: "openai/gpt-6.1-sol",
			observed: null,
			label: "same family",
			fallback: false,
			tokens: 0,
		};

		assert.equal(
			parseBenchTrial(JSON.stringify({ ...trial, judges: [seat] })).judges
				.length,
			1,
		);

		for (const fallbackRecord of [null, 17, {}, { requested: "bogus" }])
			assert.throws(
				() =>
					parseBenchTrial(
						JSON.stringify({ ...trial, judges: [{ ...seat, fallbackRecord }] }),
					),
				/unexpected_keys/,
			);
	});
	it("rejects malformed nested records, duplicate keys and broken semantic bindings", () => {
		const trial = syntheticTrial();
		const cost = trial.accounting.cost;

		const invalid = [
			{ ...trial, runtime: { ...trial.runtime, extra: true } },
			{ ...trial, tokenCap: -1 },
			{ ...trial, tokenCap: 1.5 },
			{ ...trial, issue: 0 },
			{ ...trial, accounting: { ...trial.accounting, chargedTokens: 0 } },
			{
				...trial,
				accounting: { ...trial.accounting, sources: ["build", "build"] },
			},
			{
				...trial,
				accounting: {
					...trial.accounting,
					cost: { ...cost, tokens: { ...cost.tokens, total: 0 } },
				},
			},
			{ ...trial, variantDigest: "0".repeat(64) },
			{ ...trial, bundleDigest: "0".repeat(64) },
			{ ...trial, wallMs: 0 },
			{ ...trial, outcome: { kind: "passed", reason: "not allowed" } },
			{ ...trial, stages: [{ name: "build", wallMs: -1, outcome: "passed" }] },
			{ ...trial, judges: [{ seat: "code-review" }] },
			{
				...trial,
				accounting: {
					...trial.accounting,
					cost: { ...cost, estimate: { ...cost.estimate, usdMicros: null } },
				},
			},
			{
				...trial,
				accounting: {
					...trial.accounting,
					cost: { ...cost, coverage: { ...cost.coverage, requests: 0 } },
				},
			},
		];

		for (const value of invalid)
			assert.throws(() => parseBenchTrial(JSON.stringify(value)));
		assert.throws(
			() =>
				parseBenchTrial(
					JSON.stringify(trial).replace(
						'"version":1',
						'"version":1,"version":1',
					),
				),
			/duplicate_trial_key/,
		);
		assert.throws(() => parseBenchTrial("null"));
		assert.throws(() => parseBenchTrial("{"));
	});
});

describe("BenchTrial accounting", () => {
	it("prices nested specify leaves once and reconciles an aggregate charge floor without repricing it", () => {
		const leaf = {
			id: "specify/draft",
			model: "openai/gpt-6.1-sol",
			text: journal,
			receiptTokens: 15,
		};

		const parent = { ...leaf, id: "specify", text: null, receiptTokens: 30 };

		const result = trialAccounting([
			parent,
			leaf,
			{ ...leaf, id: "specify/review" },
		]);

		assert.equal(result.chargedTokens, 30);
		assert.equal(result.cost.tokens.total, 30);
		assert.equal(result.cost.coverage.kind, "exact");
		assert.equal(result.cost.coverage.missingJournals, 0);
		assert.deepEqual(result.sources, ["specify/draft", "specify/review"]);

		const incomplete = trialAccounting([
			{ ...parent, receiptTokens: 50 },
			leaf,
		]);

		assert.equal(incomplete.chargedTokens, 50);
		assert.equal(incomplete.cost.tokens.total, 15);
		assert.equal(incomplete.cost.coverage.kind, "lower_bound");
	});
	it("prices journal requests once, not receipt plus journal or duplicate result lines", () => {
		const text = `${journal}\n${journal}\n`;

		const source = {
			id: "build",
			model: "openai/gpt-6.1-sol",
			text,
			receiptTokens: 15,
		};

		const accounting = trialAccounting([source]);
		assert.equal(accounting.chargedTokens, 15);
		assert.equal(accounting.cost.tokens.total, 15);
		assert.equal(accounting.cost.estimate.kind, "api_equivalent_estimate");
		assert.equal(accounting.cost.estimate.usdMicros, 70);
		assert.equal(accounting.cost.billedSpend, "unavailable");
		assert.equal(accounting.cost.coverage.kind, "exact");
		assert.throws(
			() => trialAccounting([source, source]),
			/duplicate_trial_charge/,
		);
	});
	it("keeps uncertain dispatch bounds and missing journal charges out of a zero estimate", () => {
		const accounting = trialAccounting([
			{
				id: "build",
				model: "openai/gpt-6.1-sol",
				text: journal.split("\n")[0] ?? "",
				receiptTokens: 0,
			},
		]);

		assert.equal(accounting.chargedTokens, 150);
		assert.equal(accounting.cost.coverage.kind, "uncertain");
		assert.equal(accounting.cost.estimate.usdMicros, null);

		const missing = trialAccounting([
			{
				id: "review",
				model: "openai/gpt-6.1-sol",
				text: null,
				receiptTokens: 40,
			},
		]);

		assert.equal(missing.chargedTokens, 40);
		assert.equal(missing.cost.coverage.missingJournals, 1);
		assert.equal(missing.cost.estimate.usdMicros, null);
	});
});
