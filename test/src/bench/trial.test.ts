import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { trialAccounting } from "../../../src/bench/trial.ts";

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

describe("BenchTrial accounting", () => {
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
