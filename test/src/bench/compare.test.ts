import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isGitSha } from "../../../src/config/schema.ts";
import type { BenchRespec } from "../../../src/bench/trial.ts";
import { compareTrials } from "../../../src/bench/compare.ts";
import { parseBenchVariant } from "../../../src/bench/variant.ts";
import { digestOf } from "../../../src/core/run.ts";
import { syntheticTrial } from "../../host/bench/trial-fixtures.ts";

describe("BenchComparison", () => {
	it("pairs baseline with respec and repetitions by frozen inputs, never generated output digests", () => {
		const baseline = syntheticTrial({ id: "baseline" });

		const variant = parseBenchVariant(
			JSON.stringify({
				...baseline.variant,
				name: "respec",
				change: { kind: "respec", value: "on" },
			}),
		);

		const baseSha = "b".repeat(40);
		const changedSha = "c".repeat(40);
		assert.ok(isGitSha(baseSha) && isGitSha(changedSha));

		const respec = {
			baseSha,
			archiveDigest: digestOf("archive"),
			snapshotDigest: digestOf("snapshot"),
			contractDigest: digestOf("contract-a"),
			acceptanceDigest: digestOf("suite-a"),
			baseReceiptDigest: digestOf("base-a"),
			acceptEffort: "medium",
			models: [],
		} satisfies BenchRespec;

		const a = {
			...baseline,
			id: digestOf("a"),
			variant,
			variantDigest: digestOf(JSON.stringify(variant)),
			respec,
		};

		const b = {
			...a,
			id: digestOf("b"),
			respec: {
				...respec,
				contractDigest: digestOf("contract-b"),
				acceptanceDigest: digestOf("suite-b"),
				baseReceiptDigest: digestOf("base-b"),
			},
		};

		const result = compareTrials([baseline, a, b]);
		assert.equal(result.tasks[0]?.differences[0]?.status, "paired");
		assert.equal(
			result.tasks[0]?.variants[1]?.trials.find((trial) => trial.id === b.id)
				?.respec?.acceptanceDigest,
			b.respec.acceptanceDigest,
		);

		for (const changed of [
			{ ...b, respec: { ...b.respec, snapshotDigest: digestOf("changed") } },
			{ ...b, respec: { ...b.respec, baseSha: changedSha } },
			{ ...b, runtime: { ...b.runtime, factoryRevision: "c".repeat(40) } },
		])
			assert.throws(() => compareTrials([a, changed]), /incomparable_trials/);

		for (const change of [
			{ kind: "buildRevision", value: "off" },
			{ kind: "model", stage: "build", model: "openai/gpt-6.1-terra" },
			{
				kind: "skill",
				path: "skills/build/SKILL.md",
				file: "replacement.md",
				digest: digestOf("skill"),
			},
		]) {
			const other = {
				...baseline,
				id: digestOf("other"),
				variant: parseBenchVariant(
					JSON.stringify({ ...baseline.variant, name: "other", change }),
				),
			};

			assert.throws(() => compareTrials([a, other]), /incomparable_trials/);
			assert.throws(
				() =>
					compareTrials([
						a,
						{ ...other, originalRunId: digestOf("another task") },
					]),
				/incomparable_trials/,
			);
		}
	});
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
			candidateFailures: 0,
			harnessFailures: 1,
			incomplete: 0,
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
		assert.equal(result.variants[0]?.summary.estimate.known, 0);
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
	it("H1 labels the known-only median uncertain when two of five estimates are unknown", () => {
		const trials = [100, 200, 300, 0, 0].map((tokens, i) =>
			syntheticTrial({ id: `probe-${i}`, tokens, missing: i >= 3 }),
		);

		const estimate = compareTrials(trials).variants[0]?.summary.estimate;
		assert.equal(estimate?.usdMicros, 400);
		assert.equal(estimate?.known, 3);
		assert.equal(estimate?.n, 5);
		assert.equal(estimate?.coverage, "uncertain");
		assert.ok((estimate?.usdMicros ?? 0) > 200);
	});
	it("H2 labels each estimate delta exact only when both sides are exact", () => {
		const left = syntheticTrial({ id: "left" });
		const right = syntheticTrial({ id: "right", name: "off", value: "off" });

		const partial = syntheticTrial({
			id: "partial",
			name: "off",
			value: "off",
			missing: true,
		});

		assert.equal(
			compareTrials([left, right]).tasks[0]?.differences[0]?.estimate.coverage,
			"exact",
		);
		assert.equal(
			compareTrials([left, right, partial]).tasks[0]?.differences[0]?.estimate
				.coverage,
			"uncertain",
		);

		const lowerBound = {
			...right,
			accounting: {
				...right.accounting,
				cost: {
					...right.accounting.cost,
					coverage: {
						...right.accounting.cost.coverage,
						kind: "lower_bound",
						missingReceipts: 1,
					},
				},
			},
		} as const;

		const comparison = compareTrials([left, lowerBound]);
		assert.equal(
			comparison.variants[1]?.summary.estimate.coverage,
			"lower_bound",
		);
		assert.equal(
			comparison.tasks[0]?.differences[0]?.estimate.coverage,
			"uncertain",
		);
		assert.equal(
			comparison.tasks[0]?.differences[0]?.tokensCoverage,
			"uncertain",
		);
	});
	it("H3 exposes pooled task sets, pairwise overlap and mixed pins", () => {
		const trials = ["398", "399", "400", "401", "430", "785", "789"].map(
			(task) => syntheticTrial({ id: task, task }),
		);

		const result = compareTrials([
			...trials,
			syntheticTrial({ id: "off", name: "off", value: "off" }),
		]);

		const baseline = result.variants[0];
		const off = result.variants[1];
		assert.equal(baseline?.tasks.length, 7);
		assert.equal(off?.tasks.length, 1);
		assert.equal(baseline?.commonTasks.off, 1);
		assert.equal(off?.commonTasks.baseline, 1);
		assert.equal(baseline?.mixedPins, true);
		assert.equal(off?.mixedPins, false);
		assert.ok(
			result.limitations.some((note) =>
				note.includes("off covers 1 task(s), fewer than baseline (7)"),
			),
		);
	});
	it("classifies specify questions as needs-info input, not a harness failure", () => {
		const trial = {
			...syntheticTrial(),
			outcome: {
				kind: "failed",
				stage: "specify",
				reason: "specify_questions",
			} as const,
		};

		const result = compareTrials([trial]);

		assert.equal(
			result.tasks[0]?.variants[0]?.trials[0]?.failureClass,
			"input",
		);
		assert.equal(result.variants[0]?.summary.failureClasses.input, 1);
		assert.equal(result.variants[0]?.summary.passRate.candidateFailures, 1);
		assert.equal(result.variants[0]?.summary.passRate.harnessFailures, 0);
	});

	for (const [stage, reason, expected] of [
		["accept-base", "preservation_failed", "base"],
		["accept-base", "base_load_error", "base"],
		["accept-base", "base_nondeterministic", "base"],
		["specify", "specify_failed", "attempts"],
		["specify", "specify_bad_field", "attempts"],
		["specify", "specify_unknown_path", "attempts"],
		["specify", "specify_too_large_to_post", "attempts"],
		["accept", "accept_schema", "attempts"],
		["accept", "accept_coverage", "attempts"],
		["accept", "accept_manifest", "attempts"],
		["accept", "accept_judge_requires_execution", "attempts"],
		["accept", "accept_heldout_reads_preserved_test", "attempts"],
		["accept", "accept_failed", "attempts"],
		["build", "model_failed", "attempts"],
		["accept", "accept_refused", "provider"],
		["specify", "specify_refused", "provider"],
		["accept-base", "base_runner_error", "infrastructure"],
		["accept-base", "base_timeout", "infrastructure"],
		["specify", "specify_skills_unavailable", "missing_evidence"],
		["prepare", "respec_artifact_publish_failed", "infrastructure"],
	] as const)
		it(`classifies ${reason} as ${expected}`, () => {
			const result = compareTrials([
				{
					...syntheticTrial(),
					outcome: { kind: "failed", stage, reason },
				},
			]);

			assert.equal(
				result.tasks[0]?.variants[0]?.trials[0]?.failureClass,
				expected,
			);
			assert.equal(
				result.variants[0]?.summary.passRate.harnessFailures,
				["base", "attempts"].includes(expected) ? 0 : 1,
			);
		});

	it("H4 keeps candidate, harness, budget and incomplete outcomes separate using factory classes", () => {
		const failures = [
			["visible_tests", "visible_tests_failed"],
			["validation", "trusted_gates_failed"],
			["validation", "protected_path_changed:AGENTS.md"],
			["validation", "invalid_dependency_protocol"],
			["review", "review_malformed"],
			["review", "review_blocking_or_unverifiable"],
			["visible_tests", "visible_tests_unavailable"],
			["validation", "install_failed"],
			["validation", "baseline_failed"],
			["build", "model_unavailable"],
			["build", "budget_exhausted"],
			["prepare", "trial_incomplete"],
		].map(([stage = "", reason = ""], i) => ({
			...syntheticTrial({ id: `failure-${i}` }),
			outcome: {
				kind: reason === "budget_exhausted" ? "budget_exhausted" : "failed",
				stage,
				reason,
			} as const,
		}));

		const summary = compareTrials([syntheticTrial(), ...failures]).variants[0]
			?.summary;

		assert.deepEqual(summary?.passRate, {
			passed: 1,
			candidateFailures: 5,
			harnessFailures: 6,
			incomplete: 1,
			n: 13,
			rate: 1 / 13,
		});
		assert.equal(summary?.failureClasses.candidate, 4);
		assert.equal(summary?.failureClasses.review, 1);
		assert.equal(summary?.failureClasses.budget, 1);
	});
	it("H5 puts each median delta beside both sides' token and estimate spread", () => {
		const trials = [100, 200, 600].flatMap((tokens, i) => [
			syntheticTrial({ id: `a-${i}`, tokens }),
			syntheticTrial({
				id: `b-${i}`,
				name: "off",
				value: "off",
				tokens: tokens + 50,
			}),
		]);

		const delta = compareTrials(trials).tasks[0]?.differences[0];
		assert.equal(delta?.tokens, 50);
		assert.deepEqual(delta?.tokensSpread.left, {
			n: 3,
			median: 200,
			min: 100,
			max: 600,
		});
		assert.deepEqual(delta?.tokensSpread.right, {
			n: 3,
			median: 250,
			min: 150,
			max: 650,
		});
		assert.equal(delta?.estimate.spread.left.min, 200);
		assert.equal(delta?.estimate.spread.left.max, 1200);
		assert.equal(delta?.estimate.spread.right.min, 300);
		assert.equal(delta?.estimate.spread.right.max, 1300);
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
