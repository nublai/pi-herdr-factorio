import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseBenchVariant } from "../../../src/bench/variant.ts";
import { digestOf } from "../../../src/core/run.ts";

const variant = {
	version: 1,
	kind: "factory_benchmark_variant",
	name: "baseline",
	pins: {
		bundleDigest: digestOf("task"),
		factoryRevision: "a".repeat(40),
		assetsDigest: digestOf("assets"),
		workflowDigest: digestOf("workflow"),
		tariffDigest: digestOf("tariff"),
	},
	change: { kind: "buildRevision", value: "on" },
};

describe("BenchVariant v1", () => {
	it("accepts exactly one declared build revision, model or skill dimension", () => {
		for (const change of [
			variant.change,
			{ kind: "model", stage: "build", model: "openai/gpt-6.1-sol" },
			{
				kind: "skill",
				path: "skills/build/SKILL.md",
				file: "./replacement.md",
				digest: digestOf("skill"),
			},
		])
			assert.equal(
				parseBenchVariant(JSON.stringify({ ...variant, change })).change.kind,
				change.kind,
			);
	});
	it("refuses two dimensions, no dimension and legacy thinking or factory revision variants", () => {
		const { change: _change, ...without } = variant;

		for (const value of [
			without,
			{ ...variant, change: {} },
			{ ...variant, change: [variant.change, { kind: "model" }] },
			{
				...variant,
				change: { ...variant.change, model: "openai/gpt-6.1-sol" },
			},
			{ ...variant, change: { kind: "thinking", value: "high" } },
			{
				...variant,
				change: { kind: "factoryRevision", value: "b".repeat(40) },
			},
		])
			assert.throws(() => parseBenchVariant(JSON.stringify(value)));
	});
	it("refuses duplicate keys, unsafe skill paths and unpinned variants", () => {
		assert.throws(() =>
			parseBenchVariant(
				JSON.stringify(variant).replace(
					'"version":1',
					'"version":1,"version":1',
				),
			),
		);
		assert.throws(() =>
			parseBenchVariant(JSON.stringify({ ...variant, pins: {} })),
		);

		for (const path of [
			"../oracle/check.test.ts",
			"skills/../secret",
			"skills/build/..",
			"skills/build/SKILL.md/extra",
		])
			assert.throws(() =>
				parseBenchVariant(
					JSON.stringify({
						...variant,
						change: {
							kind: "skill",
							path,
							file: "replacement",
							digest: digestOf("x"),
						},
					}),
				),
			);
	});
});
