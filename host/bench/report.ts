import { existsSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { parseBenchTrial, type BenchTrial } from "../../src/bench/trial.ts";
import { regularText } from "../../src/contract/artifacts.ts";
import { journalCharge } from "../../src/core/journal.ts";
import {
	fieldOf,
	hasDuplicateKey,
	numberOf,
	objectOf,
	parseJson,
	textOf,
} from "../../src/core/json.ts";
import type { FailedExit } from "../../src/core/execution.ts";
import { digestOf } from "../../src/core/run.ts";
import { count, digest, literal, record } from "../../src/ledger/schema.ts";
import { boundedText, executionCharge } from "../sandbox/receipts.ts";
import { LineSplitter } from "../sandbox/lines.ts";
import { parsePiRecord } from "../sandbox/rpc.ts";
import type { StageHost } from "../sandbox/run-stage.ts";

export function benchDiagnosticHost(host: StageHost): StageHost {
	const failures = new Map<number, string>();

	return {
		...host,
		async launchPi(model, session) {
			const pi = await host.launchPi(model, session);

			if (pi === null) return null;
			const splitter = new LineSplitter(64 * 1024 * 1024);

			pi.stdout.on("data", (chunk: Buffer) => {
				for (const line of splitter.push(chunk) ?? []) {
					const record = parsePiRecord(line);

					if (
						record.type === "response" &&
						record.command === "prompt" &&
						/^factory-(?:prompt|draft-[12])$/.test(record.id ?? "") &&
						(!record.success || record.disposition === "handled")
					)
						failures.set(session, "prompt_response_failed");
				}
			});

			return pi;
		},
		writeReceipt(receipt) {
			const diagnostic =
				receipt.guardStop ?? failures.get(receipt.fallback === null ? 0 : 1);

			const recorded =
				diagnostic === undefined ? receipt : { ...receipt, diagnostic };

			return host.writeReceipt(recorded);
		},
	};
}

function failedExitOf(value: string | null | undefined): FailedExit | null {
	return value === "error" ||
		value === "malformed" ||
		value === "crashed" ||
		value === "aborted"
		? value
		: null;
}

function stageEvidence(dir: string) {
	const path = join(dir, "receipt.json");

	const receipt = existsSync(path)
		? objectOf(parseJson(regularText(path, 1024 * 1024)))
		: null;

	const outcome = objectOf(fieldOf(receipt, "outcome"));

	const exit =
		fieldOf(outcome, "kind") === "failed"
			? failedExitOf(textOf(fieldOf(outcome, "exit")))
			: null;

	const diagnostic =
		textOf(fieldOf(receipt, "diagnostic")) ??
		textOf(fieldOf(receipt, "guardStop"));

	return { exit, diagnostic };
}

export function stageFailureReason(
	prefix: string,
	dir: string,
	knownExit: FailedExit | null = null,
): string {
	let evidence = stageEvidence(dir);
	let evidenceDir = dir;

	if (prefix === "specify") {
		for (const name of ["draft", "review", "revision"]) {
			const leaf = stageEvidence(join(dir, name));

			if (leaf.exit !== null) {
				evidence = {
					exit: evidence.exit ?? leaf.exit,
					diagnostic: evidence.diagnostic ?? leaf.diagnostic,
				};
				evidenceDir = join(dir, name);
			}
		}
	}

	const exit = knownExit ?? evidence.exit;
	let diagnostic = evidence.diagnostic;
	const audit = join(evidenceDir, "egress.jsonl");

	if (exit === "error" && diagnostic === null && existsSync(audit)) {
		for (const line of regularText(audit, 32 * 1024 * 1024).split("\n")) {
			const entry = objectOf(parseJson(line));
			const reason = textOf(fieldOf(entry, "reason"));

			if (reason === "secret-in-request") {
				diagnostic = reason;
				break;
			}

			if (textOf(fieldOf(entry, "route"))?.startsWith("model-")) {
				const status = numberOf(fieldOf(entry, "status")) ?? 0;

				diagnostic =
					reason ??
					(status === 429 || status >= 500 ? "provider-http-error" : null);
			}
		}
	}

	const suffix =
		diagnostic !== null && /^[a-z][a-z0-9_-]{0,79}$/.test(diagnostic)
			? `:${diagnostic}`
			: "";

	return `${prefix}_failed${exit === null ? "" : `_${exit}`}${suffix}`;
}

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

function comparisonTrial(dir: string): BenchTrial {
	const trial = readBenchTrial(dir);

	if (trial.outcome.kind !== "failed") return trial;

	const failed =
		/^(specify|accept|model)_failed(?:_(malformed|error|crashed|aborted))?$/.exec(
			trial.outcome.reason,
		);

	if (failed === null) return trial;
	const prefix = failed[1] ?? "model";

	const attempts = trial.accounting.sources
		.map((source) => source.split("/")[0] ?? "")
		.filter((name) =>
			prefix === "accept"
				? /^accept(?:-retry|-\d+)?$/.test(name)
				: /^specify(?:-\d+)?$/.test(name),
		)
		.sort((left, right) => {
			const attempt = (name: string) =>
				name.endsWith("-retry") ? 2 : Number(name.split("-")[1] ?? 1);

			return attempt(left) - attempt(right);
		});

	const stage =
		prefix === "accept" || prefix === "specify"
			? (attempts.at(-1) ?? trial.outcome.stage)
			: trial.outcome.stage;

	return {
		...trial,
		outcome: {
			...trial.outcome,
			reason: stageFailureReason(
				prefix,
				join(dir, "runtime", stage),
				failedExitOf(failed[2]),
			),
		},
	};
}

export function readBenchTrials(paths: readonly string[]) {
	const trials: BenchTrial[] = [];
	const incompleteTrials: string[] = [];

	for (const dir of directories(paths)) {
		if (existsSync(join(dir, "trial.json"))) trials.push(comparisonTrial(dir));
		else {
			readBinding(dir);
			incompleteTrials.push(dir);
		}
	}

	return { trials, incompleteTrials };
}

const bindingCodec = record({
	kind: literal("factory_benchmark_state"),
	version: literal(1),
	bundleDigest: digest,
	variantDigest: digest,
	tokenCap: count,
});

function readBinding(dir: string) {
	const raw = regularText(join(dir, "claim/binding.json"), 4096);

	if (hasDuplicateKey(raw)) throw new Error("duplicate_bench_binding_key");

	return bindingCodec(parseJson(raw));
}

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
				coverage: trial.accounting.cost.coverage.kind,
				unavailableStages: [],
			});
			continue;
		}

		readBinding(dir);
		const runtime = join(dir, "runtime");

		const stages = existsSync(runtime)
			? readdirSync(runtime, { withFileTypes: true })
					.filter((entry) => entry.isDirectory())
					.map((entry) => entry.name)
			: [];

		const charges = await Promise.all(
			stages.map((stage) => executionCharge(join(runtime, stage))),
		);

		const journalStages = stages.flatMap((stage) =>
			stage !== "specify"
				? [stage]
				: readdirSync(join(runtime, stage), { withFileTypes: true })
						.filter(
							(entry) =>
								entry.isDirectory() &&
								["draft", "review", "revision"].includes(entry.name),
						)
						.map((entry) => `${stage}/${entry.name}`),
		);

		const journals = await Promise.all(
			journalStages.map(async (stage) => ({
				stage,
				text: await boundedText(
					join(runtime, stage, "egress.requests.jsonl"),
					16 * 1024 * 1024,
				),
			})),
		);

		const unavailableStages = [
			...new Set([
				...stages.filter((stage, i) => {
					const covered = journals.filter(
						(journal) =>
							journal.stage === stage || journal.stage.startsWith(`${stage}/`),
					);

					const tokens = covered.reduce((sum, journal) => {
						const charge = journalCharge(journal.text ?? "");

						return sum + charge.tokens + charge.uncertainTokens;
					}, 0);

					return (
						charges[i] === null ||
						covered.length === 0 ||
						(charges[i]?.total ?? 0) > tokens
					);
				}),
				...journals
					.filter((journal) => journal.text === null)
					.map((journal) => journal.stage),
			]),
		].sort();

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
			coverage:
				recorded.length === 0
					? "unavailable"
					: unavailableStages.length > 0
						? "lower_bound"
						: recorded.some((charge) => charge.uncertain > 0)
							? "uncertain"
							: "exact",
			unavailableStages,
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
