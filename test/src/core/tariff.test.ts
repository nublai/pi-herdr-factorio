import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { requestSettlements } from "../../../src/core/journal.ts";
import { ANTHROPIC_MODEL_IDS } from "../../../src/core/models.ts";
import {
	estimateCost,
	PINNED_TARIFF,
	readTariff,
	tariffDigest,
} from "../../../src/core/tariff.ts";

function requests(
	inputTokens: number,
	outputTokens: number,
	model = "openai/gpt-6.1-sol",
) {
	return requestSettlements(
		JSON.stringify({
			kind: "result",
			req: 1,
			route: "model-openai",
			inputTokens,
			outputTokens,
		}),
	).requests.map((settlement) => ({ settlement, model }));
}

describe("API-equivalent tariff estimate", () => {
	it("prices a metered request without claiming billed spend or cache reporting", () => {
		const result = estimateCost(requests(1_000, 200), PINNED_TARIFF);
		assert.equal(result.estimate.kind, "api_equivalent_estimate");
		assert.equal(result.estimate.usdMicros, 4_000);
		assert.equal(result.cache, "not_reported");
		assert.equal(result.billedSpend, "unavailable");
		assert.equal(result.coverage.priced, 1);
		assert.equal(result.tokens.total, 1_200);
	});

	it("uses the higher tier only above 272,000 input tokens", () => {
		assert.equal(
			estimateCost(requests(272_000, 100), PINNED_TARIFF).estimate.usdMicros,
			545_000,
		);
		assert.equal(
			estimateCost(requests(272_001, 100), PINNED_TARIFF).estimate.usdMicros,
			1_089_504,
		);
	});

	it("names an unknown model as unpriced rather than estimating zero", () => {
		const result = estimateCost(
			requests(100, 20, "openai/unknown"),
			PINNED_TARIFF,
		);

		assert.equal(result.estimate.usdMicros, null);
		assert.equal(result.coverage.unpriced, 1);
		assert.deepEqual(result.unpricedModels, ["openai/unknown"]);
		assert.equal(result.tokens.total, 120);
	});

	it("keeps an uncertain charge out of the estimate and counts missing usage separately", () => {
		const journal = [
			{
				kind: "dispatch",
				req: 1,
				route: "model-openai",
				inputTokenEstimate: 1_000,
				maxOutputTokens: 128_000,
			},
			{
				kind: "result",
				req: 2,
				route: "model-openai",
				inputTokens: 200,
				outputTokens: null,
			},
		]
			.map((line) => JSON.stringify(line))
			.join("\n");

		const result = estimateCost(
			requestSettlements(journal).requests.map((settlement) => ({
				settlement,
				model: "openai/gpt-6.1-sol",
			})),
			PINNED_TARIFF,
		);

		assert.equal(result.estimate.usdMicros, null);
		assert.equal(result.coverage.uncertain, 1);
		assert.equal(result.coverage.missing, 1);
		assert.equal(result.tokens.input, 200);
	});

	it("refuses a tariff whose digest does not match", () => {
		assert.throws(
			() =>
				readTariff(
					JSON.stringify({ version: 1, models: [] }),
					tariffDigest(PINNED_TARIFF),
				),
			/tariff_digest_mismatch/,
		);
	});

	it("pins source metadata and rates for every model in the limits table", () => {
		assert.equal(
			tariffDigest(
				readTariff(JSON.stringify(PINNED_TARIFF), tariffDigest(PINNED_TARIFF)),
			),
			tariffDigest(PINNED_TARIFF),
		);

		for (const model of ANTHROPIC_MODEL_IDS) {
			const entry = PINNED_TARIFF.models.find(
				(entry) => entry.model === `anthropic/${model}`,
			);

			assert.ok(entry);
			assert.equal(entry.source.package, "@earendil-works/pi-ai");
			assert.equal(entry.source.version, "1.4.0");
			assert.match(entry.source.sha256, /^[a-f0-9]{64}$/);
		}
	});

	it("prices each request once even if a result is duplicated", () => {
		const line = JSON.stringify({
			kind: "result",
			req: 1,
			route: "model-openai",
			inputTokens: 100,
			outputTokens: 20,
		});

		const settled = requestSettlements(`${line}\n${line}\n`).requests;
		assert.equal(settled.length, 1);

		const result = estimateCost(
			settled.map((settlement) => ({
				settlement,
				model: "openai/gpt-6.1-sol",
			})),
			PINNED_TARIFF,
		);

		assert.equal(result.estimate.usdMicros, 400);
	});
});
