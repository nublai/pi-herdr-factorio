import { existsSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { parseBenchTrial, type BenchTrial } from "../../src/bench/trial.ts";
import { regularText } from "../../src/contract/artifacts.ts";
import { hasDuplicateKey, parseJson } from "../../src/core/json.ts";
import { digestOf } from "../../src/core/run.ts";
import { count, digest, literal, record } from "../../src/ledger/schema.ts";
import { executionCharge } from "../sandbox/receipts.ts";

function directories(paths: readonly string[]) {
	const dirs = paths.map((path) => realpathSync(path));

	if (new Set(dirs).size !== dirs.length)
		throw new Error("duplicate_trial_directory");

	return dirs;
}

export function readBenchTrial(dir: string): BenchTrial {
	if (!existsSync(join(dir, "trial.json")))
		throw new Error(`trial_incomplete:${dir}`);
	const raw = regularText(join(dir, "trial.json"), 8 * 1024 * 1024);

	if (regularText(join(dir, "trial.sha256"), 100) !== `${digestOf(raw)}\n`)
		throw new Error("trial_record_digest_mismatch");

	return parseBenchTrial(raw);
}

export function readBenchTrials(paths: readonly string[]): BenchTrial[] {
	return directories(paths).map(readBenchTrial);
}

const bindingCodec = record({
	kind: literal("factory_benchmark_state"),
	version: literal(1),
	bundleDigest: digest,
	variantDigest: digest,
	tokenCap: count,
});

export async function benchSpend(paths: readonly string[]) {
	const ids = new Set<string>();
	const trials = [];

	for (const dir of directories(paths)) {
		if (existsSync(join(dir, "trial.json"))) {
			const trial = readBenchTrial(dir);

			if (ids.has(trial.id)) throw new Error(`duplicate_trial:${trial.id}`);
			ids.add(trial.id);
			trials.push({
				directory: dir,
				id: trial.id,
				status: "completed",
				chargedTokens: trial.accounting.chargedTokens,
				uncertain: trial.accounting.cost.coverage.uncertain > 0,
			});
			continue;
		}

		const raw = regularText(join(dir, "claim/binding.json"), 4096);

		if (hasDuplicateKey(raw)) throw new Error("duplicate_bench_binding_key");
		bindingCodec(parseJson(raw));
		const runtime = join(dir, "runtime");

		const stages = existsSync(runtime)
			? readdirSync(runtime, { withFileTypes: true })
					.filter((entry) => entry.isDirectory())
					.map((entry) => entry.name)
			: [];

		const charges = await Promise.all(
			stages.map((stage) => executionCharge(join(runtime, stage))),
		);

		const recorded = charges.filter((charge) => charge !== null);
		trials.push({
			directory: dir,
			id: null,
			status: "incomplete",
			chargedTokens:
				recorded.length === 0
					? null
					: recorded.reduce((sum, charge) => sum + charge.total, 0),
			uncertain: recorded.some((charge) => charge.uncertain > 0),
		});
	}

	return {
		version: 1,
		kind: "factory_benchmark_spend",
		coverage: "recorded_charges_only",
		chargedTokens: trials.reduce(
			(sum, trial) => sum + (trial.chargedTokens ?? 0),
			0,
		),
		completedTrials: trials.filter((trial) => trial.status === "completed")
			.length,
		incompleteTrials: trials.filter((trial) => trial.status === "incomplete")
			.length,
		unavailableTrials: trials.filter((trial) => trial.chargedTokens === null)
			.length,
		uncertainTrials: trials.filter((trial) => trial.uncertain).length,
		billedSpend: "unavailable",
		trials,
	};
}
