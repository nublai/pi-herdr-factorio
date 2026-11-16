import type { BenchTrial } from "./trial.ts";
import type { BenchVariant } from "./variant.ts";
import type { CostCoverage } from "../core/tariff.ts";

function selector(change: BenchVariant["change"]): string {
	switch (change.kind) {
		case "model":
			return `model.${change.stage}`;
		case "skill":
			return `skill.${change.path}`;
		case "buildRevision":
			return "buildRevision";
	}
}

function treatment(change: BenchVariant["change"]): string {
	switch (change.kind) {
		case "model":
			return change.model;
		case "skill":
			return change.digest;
		case "buildRevision":
			return change.value;
	}
}

function dimensions(trial: BenchTrial) {
	return new Map(
		Object.entries({
			bundleDigest: trial.bundleDigest,
			issue: trial.issue,
			tokenCap: trial.tokenCap,
			...Object.fromEntries(
				Object.entries(trial.variant.pins).map(([key, value]) => [
					`pins.${key}`,
					value,
				]),
			),
			...Object.fromEntries(
				Object.entries(trial.runtime).map(([key, value]) => [
					`runtime.${key}`,
					value,
				]),
			),
		}),
	);
}

function differences(left: BenchTrial, right: BenchTrial): string[] {
	const a = dimensions(left);
	const b = dimensions(right);
	const leftSelector = selector(left.variant.change);
	const rightSelector = selector(right.variant.change);
	const sameVariant = left.variant.name === right.variant.name;
	const changed = [...a.keys()].filter((key) => a.get(key) !== b.get(key));

	const baseline = (change: BenchVariant["change"]) =>
		change.kind === "buildRevision" && change.value === "on";

	const sameSelector = leftSelector === rightSelector;

	const allowedSelector =
		sameSelector ||
		baseline(left.variant.change) ||
		baseline(right.variant.change);

	if (!allowedSelector || (sameVariant && !sameSelector))
		changed.push(leftSelector, rightSelector);
	else if (
		sameVariant &&
		treatment(left.variant.change) !== treatment(right.variant.change)
	)
		changed.push(leftSelector);

	if (
		!sameVariant &&
		allowedSelector &&
		(left.variant.change.kind === "skill" ||
			right.variant.change.kind === "skill") &&
		(!sameSelector ||
			treatment(left.variant.change) !== treatment(right.variant.change))
	) {
		return changed.filter((key) => key !== "runtime.assetsDigest");
	}

	return changed;
}

function distribution(values: readonly number[]) {
	const sorted = [...values].sort((a, b) => a - b);
	const n = sorted.length;
	const middle = Math.floor(n / 2);

	const median =
		n === 0
			? null
			: n % 2 === 1
				? (sorted[middle] ?? null)
				: ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;

	return { n, median, min: sorted[0] ?? null, max: sorted[n - 1] ?? null };
}

function summarize(trials: readonly BenchTrial[]) {
	const n = trials.length;

	const passed = trials.filter(
		(trial) => trial.outcome.kind === "passed",
	).length;

	const costs = trials.map((trial) => trial.accounting.cost);

	const known = costs.flatMap((cost) =>
		cost.estimate.usdMicros === null ? [] : [cost.estimate.usdMicros],
	);

	const coverageCounts = {
		exact: 0,
		lower_bound: 0,
		uncertain: 0,
		unavailable: 0,
	};

	for (const cost of costs) coverageCounts[cost.coverage.kind]++;

	const coverage: CostCoverage["kind"] =
		known.length === 0
			? "unavailable"
			: coverageCounts.uncertain > 0
				? "uncertain"
				: coverageCounts.exact !== n || known.length !== n
					? "lower_bound"
					: "exact";

	const estimates = distribution(known);

	return {
		n,
		passRate: { passed, n, rate: n === 0 ? null : passed / n },
		tokens: distribution(trials.map((trial) => trial.accounting.chargedTokens)),
		wallMs: distribution(trials.map((trial) => trial.wallMs)),
		estimate: {
			kind: "api_equivalent_estimate",
			usdMicros: estimates.median,
			min: estimates.min,
			max: estimates.max,
			n: known.length,
			total: n,
			coverage,
			coverageCounts,
			billedSpend: "unavailable",
		},
	};
}

export type BenchComparison = ReturnType<typeof compareTrials>;

export function compareTrials(trials: readonly BenchTrial[]) {
	if (trials.length === 0) throw new Error("no_trials");
	const ids = new Set<string>();
	const tasks = new Map<string, BenchTrial[]>();

	const variants = [
		...new Set(trials.map((trial) => trial.variant.name)),
	].sort();

	const incompatible = new Set<string>();
	const declarations = new Map<string, BenchVariant["change"]>();

	for (const trial of trials) {
		if (ids.has(trial.id)) throw new Error(`duplicate_trial:${trial.id}`);
		ids.add(trial.id);
		const change = trial.variant.change;
		const previous = declarations.get(trial.variant.name);

		if (
			previous !== undefined &&
			(selector(previous) !== selector(change) ||
				treatment(previous) !== treatment(change))
		) {
			incompatible.add(selector(previous));
			incompatible.add(selector(change));
		}

		declarations.set(trial.variant.name, change);
		const task = tasks.get(trial.originalRunId) ?? [];

		for (const earlier of task)
			for (const key of differences(earlier, trial)) incompatible.add(key);
		task.push(trial);
		tasks.set(trial.originalRunId, task);
	}

	if (incompatible.size > 0)
		throw new Error(
			`incomparable_trials:${[...incompatible].sort().join(",")}`,
		);

	return {
		version: 1,
		kind: "factory_benchmark_comparison",
		method:
			"paired_by_original_run; differences=right_minus_left; task_local_only",
		limitations: [
			"Three trials cannot establish a small improvement.",
			"Variant totals may cover different tasks. Compare effects only within each task.",
			"Dates and observed models do not pin a provider backend version.",
		],
		variants: variants.map((name) => {
			const rows = trials.filter((trial) => trial.variant.name === name);

			return {
				name,
				fewerThanThreeTrials: rows.length < 3,
				summary: summarize(rows),
			};
		}),
		tasks: [...tasks.entries()]
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([task, rows]) => {
				const sides = variants.map((name) => {
					const entries = rows
						.filter((trial) => trial.variant.name === name)
						.sort((a, b) => a.id.localeCompare(b.id));

					return {
						name,
						status: entries.length === 0 ? "missing" : "present",
						fewerThanThreeTrials: entries.length < 3,
						summary: summarize(entries),
						trials: entries.map((trial) => ({
							id: trial.id,
							variantDigest: trial.variantDigest,
							change: trial.variant.change,
							outcome: trial.outcome,
							startedAt: trial.startedAt,
							endedAt: trial.endedAt,
							tokens: trial.accounting.chargedTokens,
							cost: trial.accounting.cost,
							judges: trial.judges,
						})),
					};
				});

				return {
					task,
					issue: rows[0]?.issue,
					variants: sides,
					differences: sides.flatMap((left, i) =>
						sides.slice(i + 1).map((right) => {
							const missing =
								left.status === "missing" || right.status === "missing";

							const delta = (a: number | null, b: number | null) =>
								missing || a === null || b === null ? null : b - a;

							return {
								left: left.name,
								right: right.name,
								status: missing ? "missing" : "paired",
								passRate: delta(
									left.summary.passRate.rate,
									right.summary.passRate.rate,
								),
								tokens: delta(
									left.summary.tokens.median,
									right.summary.tokens.median,
								),
								estimate: {
									kind: "api_equivalent_estimate",
									usdMicros: delta(
										left.summary.estimate.usdMicros,
										right.summary.estimate.usdMicros,
									),
									leftCoverage: left.summary.estimate.coverage,
									rightCoverage: right.summary.estimate.coverage,
								},
							};
						}),
					),
				};
			}),
	};
}
