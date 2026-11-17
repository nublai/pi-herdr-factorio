import type { BenchTrial } from "./trial.ts";
import type { BenchVariant } from "./variant.ts";
import type { CostCoverage } from "../core/tariff.ts";
import type { MalformedReason } from "../contract/contract.ts";
import type { AcceptanceOutput } from "../contract/acceptance.ts";
import {
	parseBaseReason,
	retryableBaseReason,
} from "../candidate/diagnosis.ts";
import { FAILURE_CLASSES, type FailureClassName } from "../ledger/schema.ts";

function selector(change: BenchVariant["change"]): string {
	switch (change.kind) {
		case "model":
			return `model.${change.stage}`;
		case "skill":
			return `skill.${change.path}`;
		case "buildRevision":
			return "buildRevision";
		case "respec":
			return "respec";
	}
}

function treatment(change: BenchVariant["change"]): string {
	switch (change.kind) {
		case "model":
			return change.model;
		case "skill":
			return change.digest;
		case "buildRevision":
		case "respec":
			return change.value;
	}
}

function dimensions(trial: BenchTrial) {
	return new Map(
		Object.entries({
			bundleDigest: trial.bundleDigest,
			issue: trial.issue,
			tokenCap: trial.tokenCap,
			...(trial.respec === undefined
				? undefined
				: {
						"respec.baseSha": trial.respec.baseSha,
						"respec.archiveDigest": trial.respec.archiveDigest,
						"respec.snapshotDigest": trial.respec.snapshotDigest,
						"respec.acceptEffort": trial.respec.acceptEffort,
					}),
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

	const changed = [...new Set([...a.keys(), ...b.keys()])].filter((key) =>
		!key.startsWith("respec.") ||
		(left.respec !== undefined && right.respec !== undefined)
			? a.get(key) !== b.get(key)
			: false,
	);

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

const AUTHOR_OUTPUT_REASONS = {
	empty: true,
	too_large: true,
	not_json: true,
	duplicate_key: true,
	bad_kind: true,
	unknown_key: true,
	bad_field: true,
	unknown_path: true,
	unknown_test: true,
	ambiguous_test: true,
	too_large_to_post: true,
	schema: true,
	coverage: true,
	manifest: true,
	judge_restates_gate: true,
	judge_requires_execution: true,
	heldout_reads_preserved_test: true,
} satisfies Readonly<
	Record<
		| MalformedReason
		| Extract<AcceptanceOutput, { kind: "malformed" }>["reason"],
		true
	>
>;

const STAGE_INFRASTRUCTURE_DIAGNOSTICS = new Set([
	"prompt_response_failed",
	"secret-in-request",
	"upstream-error",
	"upstream-timeout",
	"audit-unavailable",
	"response-blocked",
	"redirect-refused",
	"upstream-address-refused",
]);

function failureClass(trial: BenchTrial): FailureClassName | null {
	const outcome = trial.outcome;

	if (outcome.kind === "passed" || outcome.reason === "trial_incomplete")
		return null;

	if (
		outcome.kind === "budget_exhausted" ||
		outcome.reason === "budget_exhausted"
	)
		return "budget";

	const stageFailure =
		/^(?:model|specify|accept)_failed(?:_(malformed|error|crashed|aborted))?(?::([a-z][a-z0-9_-]*))?$/.exec(
			outcome.reason,
		);

	if (stageFailure !== null) {
		const [, exit, diagnostic = ""] = stageFailure;

		return exit === "crashed" ||
			exit === "aborted" ||
			(exit === "error" && STAGE_INFRASTRUCTURE_DIAGNOSTICS.has(diagnostic))
			? "infrastructure"
			: "attempts";
	}

	if (
		outcome.reason.includes("unavailable") ||
		outcome.reason.includes("unconfigured")
	)
		return "missing_evidence";

	if (outcome.reason === "specify_questions") return "input";

	if (/^(?:model|specify|accept)_refused$/.test(outcome.reason))
		return "provider";

	const baseReason = parseBaseReason(outcome.reason);

	if (baseReason !== null && retryableBaseReason(baseReason)) return "base";

	if (
		Object.keys(AUTHOR_OUTPUT_REASONS).some(
			(reason) =>
				outcome.reason === `specify_${reason}` ||
				outcome.reason === `accept_${reason}`,
		)
	)
		return "attempts";

	if (outcome.reason === "review_malformed") return "missing_evidence";

	if (outcome.reason === "review_blocking_or_unverifiable") return "review";

	if (
		[
			"visible_tests_failed",
			"trusted_gates_failed",
			"forbidden_paths",
		].includes(outcome.reason) ||
		/^(?:protected_path_changed|npmrc_changed|runtime_patching|suppression_added|invalid_source_encoding|unauthorized_acceptance|package_swap|replacement_deleted|invalid_dependency_|dependency_integrity|unsafe_tree)/.test(
			outcome.reason,
		)
	)
		return "candidate";

	return "infrastructure";
}

function summarize(trials: readonly BenchTrial[]) {
	const n = trials.length;

	const passed = trials.filter(
		(trial) => trial.outcome.kind === "passed",
	).length;

	const failureClasses = Object.fromEntries(
		FAILURE_CLASSES.map((name) => [name, 0]),
	);

	let candidateFailures = 0;
	let harnessFailures = 0;
	let incomplete = 0;

	for (const trial of trials) {
		const classified = failureClass(trial);

		if (classified !== null) {
			failureClasses[classified] = (failureClasses[classified] ?? 0) + 1;

			if (
				classified === "candidate" ||
				classified === "review" ||
				classified === "input" ||
				classified === "base" ||
				classified === "attempts"
			)
				candidateFailures++;
			else harnessFailures++;
		} else if (trial.outcome.kind !== "passed") incomplete++;
	}

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
			: coverageCounts.uncertain > 0 || known.length !== n
				? "uncertain"
				: coverageCounts.exact !== n
					? "lower_bound"
					: "exact";

	const estimates = distribution(known);

	return {
		n,
		passRate: {
			passed,
			candidateFailures,
			harnessFailures,
			incomplete,
			n,
			rate: n === 0 ? null : passed / n,
		},
		failureClasses,
		tokens: distribution(trials.map((trial) => trial.accounting.chargedTokens)),
		wallMs: distribution(trials.map((trial) => trial.wallMs)),
		estimate: {
			kind: "api_equivalent_estimate",
			usdMicros: estimates.median,
			min: estimates.min,
			max: estimates.max,
			known: known.length,
			n,
			coverage,
			coverageCounts,
			billedSpend: "unavailable",
		},
	};
}

export type BenchComparison = ReturnType<typeof compareTrials>;

export function compareTrials(
	trials: readonly BenchTrial[],
	incompleteTrials: readonly string[] = [],
) {
	if (trials.length === 0 && incompleteTrials.length === 0)
		throw new Error("no_trials");
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

	if ([...declarations.values()].some((change) => change.kind === "respec")) {
		for (const change of declarations.values()) {
			if (
				change.kind === "respec" ||
				(change.kind === "buildRevision" && change.value === "on")
			)
				continue;
			incompatible.add("respec");
			incompatible.add(selector(change));
		}
	}

	if (incompatible.size > 0)
		throw new Error(
			`incomparable_trials:${[...incompatible].sort().join(",")}`,
		);

	const taskSets = new Map(
		variants.map((name) => [
			name,
			new Set(
				trials.flatMap((trial) =>
					trial.variant.name === name ? [trial.originalRunId] : [],
				),
			),
		]),
	);

	const taskNotes = variants.flatMap((name) =>
		variants.flatMap((other) => {
			const n = taskSets.get(name)?.size ?? 0;
			const otherN = taskSets.get(other)?.size ?? 0;

			return n < otherN
				? [`${name} covers ${n} task(s), fewer than ${other} (${otherN}).`]
				: [];
		}),
	);

	return {
		version: 1,
		kind: "factory_benchmark_comparison",
		excludedIncomplete: {
			n: incompleteTrials.length,
			directories: [...incompleteTrials],
		},
		method:
			"paired_by_original_run; differences=right_minus_left; task_local_only",
		limitations: [
			"Three trials cannot establish a small improvement.",
			"Variant totals may cover different tasks. Compare effects only within each task.",
			"Dates and observed models do not pin a provider backend version.",
			...taskNotes,
		],
		variants: variants.map((name) => {
			const rows = trials.filter((trial) => trial.variant.name === name);

			return {
				name,
				tasks: [...(taskSets.get(name) ?? [])].sort(),
				commonTasks: Object.fromEntries(
					variants.flatMap((other) =>
						other === name
							? []
							: [
									[
										other,
										[...(taskSets.get(name) ?? [])].filter((task) =>
											taskSets.get(other)?.has(task),
										).length,
									],
								],
					),
				),
				mixedPins:
					new Set(rows.map((trial) => JSON.stringify(trial.variant.pins)))
						.size > 1,
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
							...(trial.respec === undefined
								? undefined
								: { respec: trial.respec }),
							change: trial.variant.change,
							outcome: trial.outcome,
							failureClass: failureClass(trial),
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
								passRateCoverage: missing ? "uncertain" : "exact",
								passRate: delta(
									left.summary.passRate.rate,
									right.summary.passRate.rate,
								),
								tokens: delta(
									left.summary.tokens.median,
									right.summary.tokens.median,
								),
								tokensCoverage:
									!missing &&
									left.summary.estimate.coverage === "exact" &&
									right.summary.estimate.coverage === "exact"
										? "exact"
										: "uncertain",
								tokensSpread: {
									left: left.summary.tokens,
									right: right.summary.tokens,
								},
								estimate: {
									kind: "api_equivalent_estimate",
									coverage:
										!missing &&
										left.summary.estimate.coverage === "exact" &&
										right.summary.estimate.coverage === "exact"
											? "exact"
											: "uncertain",
									spread: {
										left: left.summary.estimate,
										right: right.summary.estimate,
									},
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
