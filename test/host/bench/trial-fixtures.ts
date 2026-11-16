import { parseBenchVariant } from "../../../src/bench/variant.ts";
import { trialAccounting, type BenchTrial } from "../../../src/bench/trial.ts";
import { digestOf } from "../../../src/core/run.ts";
import { PINNED_TARIFF, tariffDigest } from "../../../src/core/tariff.ts";

export function syntheticTrial(
	input: {
		id?: string;
		task?: string;
		name?: string;
		value?: "on" | "off";
		tokens?: number;
		passed?: boolean;
		missing?: boolean;
	} = {},
): BenchTrial {
	const task = input.task ?? "430";
	const tokens = input.tokens ?? 100;

	const variant = parseBenchVariant(
		JSON.stringify({
			version: 1,
			kind: "factory_benchmark_variant",
			name: input.name ?? "baseline",
			pins: {
				bundleDigest: digestOf(`bundle/${task}`),
				factoryRevision: "a".repeat(40),
				assetsDigest: digestOf("assets"),
				workflowDigest: digestOf("workflow"),
				tariffDigest: tariffDigest(PINNED_TARIFF),
			},
			change: { kind: "buildRevision", value: input.value ?? "on" },
		}),
	);

	return {
		version: 1,
		kind: "factory_benchmark_trial",
		id: digestOf(input.id ?? "trial"),
		bundleDigest: variant.pins.bundleDigest,
		originalRunId: digestOf(task),
		issue: Number(task),
		variant,
		variantDigest: digestOf(JSON.stringify(variant)),
		runtime: {
			factoryRevision: variant.pins.factoryRevision,
			assetsDigest: variant.pins.assetsDigest,
			node: "v26.12.1",
			platform: "exe-dev",
			gateRunner: "docker",
			thinking: "runtime_default:not_historically_recorded",
		},
		tokenCap: 540000,
		startedAt: "2026-11-16T00:00:00.000Z",
		endedAt: "2026-11-16T00:00:01.000Z",
		wallMs: 1000,
		outcome:
			input.passed === false
				? { kind: "failed", stage: "build", reason: "synthetic_failure" }
				: { kind: "passed" },
		stages: [{ name: "build", wallMs: 1000, outcome: "passed" }],
		judges: [],
		accounting: trialAccounting([
			{
				id: "build",
				model: "openai/gpt-6.1-sol",
				receiptTokens: tokens,
				text: input.missing
					? null
					: [
							{
								kind: "dispatch",
								req: 1,
								route: "model-openai",
								inputTokenEstimate: tokens,
								maxOutputTokens: 10,
							},
							{
								kind: "result",
								req: 1,
								route: "model-openai",
								inputTokens: tokens,
								outputTokens: 0,
								status: 200,
								observedModel: "gpt-6.1-sol",
							},
						]
							.map((line) => JSON.stringify(line))
							.join("\n"),
			},
		]),
	};
}
