import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { compareTrials } from "../../../src/bench/compare.ts";
import { parseBenchVariant } from "../../../src/bench/variant.ts";
import { digestOf } from "../../../src/core/run.ts";
import { syntheticTrial } from "../../host/bench/trial-fixtures.ts";

describe("BenchComparison", () => {
	it("pairs by task and reports pass counts, medians, spread and right-minus-left differences", () => {
		const trials = [100, 200, 600].flatMap((tokens, i) => [
			syntheticTrial({ id: `on-${i}`, tokens, passed: i !== 2 }),
			syntheticTrial({
				id: `off-${i}`,
				name: "off",
				value: "off",
				tokens: tokens + 50,
			}),
		]);

		const result = compareTrials(trials);
		assert.equal(result.variants.length, 2);
		assert.deepEqual(result.variants[0]?.summary.passRate, {
			passed: 2,
			n: 3,
			rate: 2 / 3,
		});
		assert.deepEqual(result.variants[0]?.summary.tokens, {
			n: 3,
			median: 200,
			min: 100,
			max: 600,
		});
		assert.equal(result.tasks[0]?.differences[0]?.tokens, 50);
		assert.equal(result.tasks[0]?.differences[0]?.estimate.usdMicros, 100);
		assert.equal(result.tasks[0]?.variants[0]?.trials.length, 3);
		assert.equal(result.variants[0]?.fewerThanThreeTrials, false);
		assert.ok(!JSON.stringify(result).includes("ratio"));
	});
	it("refuses every differing undeclared dimension, including within a named variant", () => {
		const left = syntheticTrial({ id: "a" });
		const right = syntheticTrial({ id: "b", name: "off", value: "off" });

		const changed = {
			...right,
			tokenCap: 123,
			runtime: { ...right.runtime, node: "v27.0.0", gateRunner: "other" },
		};

		assert.throws(
			() => compareTrials([left, changed]),
			/runtime.gateRunner.*runtime.node.*tokenCap/,
		);
		assert.throws(
			() => compareTrials([left, { ...changed, variant: left.variant }]),
			/tokenCap/,
		);
	});
	it("names both declared selectors when a pair changes two dimensions", () => {
		const left = syntheticTrial({ id: "a", value: "off" });
		const right = syntheticTrial({ id: "b", name: "model" });

		const changed = {
			...right,
			variant: parseBenchVariant(
				JSON.stringify({
					...right.variant,
					change: {
						kind: "model",
						stage: "build",
						model: "openai/gpt-6.1-terra",
					},
				}),
			),
		};

		assert.throws(
			() => compareTrials([left, changed]),
			/buildRevision.*model.build/,
		);
	});
	it("retains a task missing on one side without cross-task deltas", () => {
		const result = compareTrials([
			syntheticTrial({ id: "a", task: "430" }),
			syntheticTrial({ id: "b", task: "399", name: "off", value: "off" }),
		]);

		assert.equal(result.tasks.length, 2);

		for (const task of result.tasks) {
			assert.equal(
				task.variants.filter((v) => v.status === "missing").length,
				1,
			);
			assert.equal(task.differences[0]?.status, "missing");
			assert.equal(task.differences[0]?.tokens, null);
		}
	});
	it("flags small samples per variant and per task, keeping unknown estimates unknown", () => {
		const result = compareTrials([syntheticTrial({ missing: true })]);
		assert.equal(result.variants[0]?.fewerThanThreeTrials, true);
		assert.equal(result.tasks[0]?.variants[0]?.fewerThanThreeTrials, true);
		assert.equal(result.variants[0]?.summary.estimate.usdMicros, null);
		assert.equal(result.variants[0]?.summary.estimate.coverage, "unavailable");
		assert.equal(result.variants[0]?.summary.estimate.n, 0);
	});
	it("allows the on baseline against one model or skill treatment, but keeps asset pins fixed", () => {
		const baseline = syntheticTrial({ id: "a" });
		const model = syntheticTrial({ id: "b", name: "model" });

		const modelTrial = {
			...model,
			variant: parseBenchVariant(
				JSON.stringify({
					...model.variant,
					change: {
						kind: "model",
						stage: "build",
						model: "openai/gpt-6.1-terra",
					},
				}),
			),
		};

		assert.equal(
			compareTrials([baseline, modelTrial]).tasks[0]?.differences[0]?.status,
			"paired",
		);

		const skill = {
			...model,
			runtime: { ...model.runtime, assetsDigest: "b".repeat(64) },
			variant: parseBenchVariant(
				JSON.stringify({
					...model.variant,
					name: "skill",
					change: {
						kind: "skill",
						path: "skills/build/SKILL.md",
						file: "./skill.md",
						digest: "c".repeat(64),
					},
				}),
			),
		};

		assert.equal(
			compareTrials([baseline, skill]).tasks[0]?.differences[0]?.status,
			"paired",
		);

		const bad = {
			...skill,
			variant: {
				...skill.variant,
				pins: {
					...skill.variant.pins,
					assetsDigest: digestOf("different-assets"),
				},
			},
		};

		assert.throws(() => compareTrials([baseline, bad]), /pins.assetsDigest/);
	});
	it("retains known-estimate n and labels partial-price medians instead of substituting zero", () => {
		const result = compareTrials([
			syntheticTrial({ id: "a" }),
			syntheticTrial({ id: "b", missing: true }),
		]);

		assert.equal(result.variants[0]?.summary.estimate.n, 1);
		assert.equal(result.variants[0]?.summary.estimate.total, 2);
		assert.equal(result.variants[0]?.summary.estimate.usdMicros, 200);
		assert.equal(result.variants[0]?.summary.estimate.coverage, "lower_bound");
	});
	it("names every changed pin and runtime setting rather than selecting only the first mismatch", () => {
		const baseline = syntheticTrial({ id: "a" });
		const other = syntheticTrial({ id: "b", name: "off", value: "off" });

		const changed = {
			...other,
			issue: 1,
			tokenCap: 1000,
			bundleDigest: digestOf("other-bundle"),
			variant: parseBenchVariant(
				JSON.stringify({
					...other.variant,
					pins: {
						bundleDigest: digestOf("other-bundle"),
						factoryRevision: "b".repeat(40),
						assetsDigest: digestOf("other-assets"),
						workflowDigest: digestOf("other-workflow"),
						tariffDigest: digestOf("other-tariff"),
					},
				}),
			),
			runtime: {
				...other.runtime,
				factoryRevision: "b".repeat(40),
				assetsDigest: digestOf("other-assets"),
				node: "v27.0.0",
				platform: "other",
				gateRunner: "other",
			},
		};

		assert.throws(
			() => compareTrials([baseline, changed]),
			(error) => {
				assert.ok(error instanceof Error);

				for (const dimension of [
					"bundleDigest",
					"issue",
					"tokenCap",
					"pins.bundleDigest",
					"pins.factoryRevision",
					"pins.assetsDigest",
					"pins.workflowDigest",
					"pins.tariffDigest",
					"runtime.factoryRevision",
					"runtime.assetsDigest",
					"runtime.node",
					"runtime.platform",
					"runtime.gateRunner",
				])
					assert.ok(error.message.includes(dimension), dimension);

				return true;
			},
		);
	});
	it("flags under-repeated tasks even when the variant has three trials in total", () => {
		const result = compareTrials(
			["399", "400", "430"].map((task) => syntheticTrial({ id: task, task })),
		);

		assert.equal(result.variants[0]?.fewerThanThreeTrials, false);
		assert.ok(
			result.tasks.every((task) => task.variants[0]?.fewerThanThreeTrials),
		);
	});
	it("rejects duplicate trial identities and empty input", () => {
		const trial = syntheticTrial();
		assert.throws(() => compareTrials([trial, trial]), /duplicate_trial/);
		assert.throws(() => compareTrials([]), /no_trials/);
	});
});
