import { timelineFacts, type TimelineRecord } from "../controller/timeline.ts";
import {
	STAGE_ORDER,
	isModelStage,
	type Stage,
	type ModelStage,
} from "../core/stages.ts";
import {
	estimateCost,
	type CostCoverage,
	type CostRequest,
	type Tariff,
} from "../core/tariff.ts";
import type { LedgerRow } from "../ledger/schema.ts";

export type ScoreboardReceipts = {
	runId: string;
	title: string | null;
	timeline: readonly TimelineRecord[] | null;
	stages: readonly {
		stage: ModelStage;
		requests: readonly CostRequest[];
		missingJournals: number;
		missingReceipts: number;
		invalidLines: number;
	}[];
};

export type ScoreboardBy =
	| "revision"
	| "ticket"
	| "stage"
	| "model"
	| "failure";

type Amount = {
	total: number | null;
	known: number;
	missing: number;
	kind: CostCoverage["kind"];
};

function amount(values: readonly (number | null)[]): Amount {
	const known = values.filter((value) => value !== null);

	return {
		total: known.length === 0 ? null : known.reduce((a, b) => a + b, 0),
		known: known.length,
		missing: values.length - known.length,
		kind:
			known.length === values.length
				? "exact"
				: known.length === 0
					? "unavailable"
					: "lower_bound",
	};
}

function priced(
	row: LedgerRow,
	evidence: ScoreboardReceipts["stages"][number][],
	tariff: Tariff,
	stage?: Stage,
	model?: string,
) {
	const requests = evidence
		.flatMap((entry) => entry.requests)
		.filter(
			(request) =>
				model === undefined || (request.model ?? "unknown") === model,
		);

	const cost = estimateCost(requests, tariff);
	cost.coverage.missingJournals = evidence.reduce(
		(sum, entry) => sum + entry.missingJournals,
		0,
	);
	cost.coverage.missingReceipts = evidence.reduce(
		(sum, entry) => sum + entry.missingReceipts,
		0,
	);
	cost.coverage.missing += evidence.reduce(
		(sum, entry) => sum + entry.invalidLines,
		0,
	);

	const ledger =
		stage === undefined
			? row.usage.tokens
			: row.stages.kind === "known"
				? row.stages.value.find((entry) => entry.stage === stage)?.tokens
				: null;

	const gap =
		cost.coverage.missingJournals +
		cost.coverage.missingReceipts +
		cost.coverage.missing +
		cost.coverage.unpriced;

	const difference =
		model === undefined && ledger != null
			? ledger.total - cost.tokens.total
			: null;

	if (
		evidence.length === 0 ||
		(model !== undefined && requests.length === 0) ||
		gap > 0 ||
		(model === undefined &&
			(ledger == null || ledger.kind !== "exact" || difference !== 0))
	) {
		cost.coverage.kind =
			cost.coverage.uncertain > 0 || ledger?.kind === "uncertain"
				? "uncertain"
				: cost.coverage.priced > 0
					? "lower_bound"
					: "unavailable";

		if (cost.coverage.priced === 0) cost.estimate.usdMicros = null;
	}

	return {
		...cost,
		tokens:
			cost.coverage.requests === 0 && cost.coverage.kind !== "exact"
				? { input: null, output: null, total: null }
				: cost.tokens,
		ledgerTokenDifference: difference,
	};
}

function ready(
	row: LedgerRow,
	timeline: readonly TimelineRecord[] | null,
): boolean | null {
	if (timeline?.some((entry) => entry.name === "ready_for_review")) return true;

	if (
		row.outcome.kind === "landed" &&
		row.outcome.assurance.kind === "factory_verified"
	)
		return true;

	if (timeline !== null && timelineFacts(timeline) !== null) return false;

	return null;
}

function rate(values: readonly (boolean | null)[]) {
	const count = values.filter((value) => value === true).length;
	const unknown = values.filter((value) => value === null).length;

	return {
		count,
		total: values.length,
		unknown,
		rate: values.length === 0 || unknown > 0 ? null : count / values.length,
	};
}

function stageTime(
	row: LedgerRow,
	timeline: readonly TimelineRecord[] | null,
	stage: Stage,
) {
	if (
		row.v === 6 &&
		row.timeline.kind === "known" &&
		timeline !== null &&
		timelineFacts(timeline) !== null
	) {
		let total = 0;
		let active: TimelineRecord | undefined;

		for (const entry of timeline) {
			if (entry.kind === "start") active = entry;

			if (entry.kind === "end" && active?.key === entry.key) {
				if (active.stage === stage) total += entry.at - active.at;
				active = undefined;
			}
		}

		return { total, source: "v6_timeline" as const };
	}

	const summary =
		row.stages.kind === "known"
			? row.stages.value.find((entry) => entry.stage === stage)
			: undefined;

	return {
		total: summary?.wallMs.kind === "exact" ? summary.wallMs.total : null,
		source: "receipt_wall" as const,
	};
}

export function scoreboard(
	rows: readonly LedgerRow[],
	receipts: readonly ScoreboardReceipts[],
	tariff: Tariff,
) {
	const runs = rows.map((row) => {
		const receipt = receipts.find((entry) => entry.runId === row.runId);
		const timeline = receipt?.timeline ?? null;

		const stages = STAGE_ORDER.flatMap((stage) => {
			const evidence =
				receipt?.stages.filter((entry) => entry.stage === stage) ?? [];

			const summary =
				row.stages.kind === "known"
					? row.stages.value.find((entry) => entry.stage === stage)
					: undefined;

			if (
				evidence.length === 0 &&
				summary === undefined &&
				!timeline?.some((entry) => entry.stage === stage)
			)
				return [];

			const retained =
				evidence.length > 0
					? evidence
					: isModelStage(stage)
						? [
								{
									stage,
									requests: [],
									missingJournals: 1,
									missingReceipts: 1,
									invalidLines: 0,
								},
							]
						: [];

			return [
				{
					stage,
					cost: priced(row, retained, tariff, stage),
					wallMs: stageTime(row, timeline, stage),
					evidence: retained,
				},
			];
		});

		const evidence = stages.flatMap((entry) => entry.evidence);
		const cost = priced(row, evidence, tariff);

		const models = [
			...new Set([
				...cost.byModel.map((entry) => entry.model),
				...(row.models.kind === "known"
					? row.models.value.map((entry) =>
							entry.observed.kind === "known"
								? entry.observed.value
								: entry.requested,
						)
					: []),
			]),
		].sort();

		if (models.length === 0) models.push("unknown");

		return {
			runId: row.runId,
			repo: row.repo,
			issue: row.issue,
			title: receipt?.title ?? null,
			startedAt: row.startedAt.kind === "known" ? row.startedAt.value : null,
			revision:
				row.v === 6 && row.controllerRevision.kind === "known"
					? row.controllerRevision.value
					: "unknown",
			failure:
				row.outcome.kind !== "failed" && row.outcome.kind !== "budget_exhausted"
					? "none"
					: row.v !== 1 && row.failure?.kind === "known"
						? row.failure.value.class
						: "unknown",
			outcome: row.outcome.kind,
			ready: ready(row, timeline),
			cost,
			chargedTokens: row.usage.tokens,
			timeline:
				row.v === 6 && row.timeline.kind === "known"
					? row.timeline.value
					: null,
			stages: stages.map(({ evidence: _evidence, ...entry }) => entry),
			models: models.map((model) => ({
				model,
				cost: priced(row, evidence, tariff, undefined, model),
			})),
		};
	});

	type Run = (typeof runs)[number];

	const summarize = (
		selected: readonly Run[],
		stage?: string,
		model?: string,
	) => {
		const costs = selected.map((run) =>
			stage === undefined
				? model === undefined
					? run.cost
					: run.models.find((entry) => entry.model === model)?.cost
				: run.stages.find((entry) => entry.stage === stage)?.cost,
		);

		const usd = amount(costs.map((cost) => cost?.estimate.usdMicros ?? null));
		const landed = rate(selected.map((run) => run.outcome === "landed"));

		const coverageKind: CostCoverage["kind"] = costs.some(
			(cost) => cost?.coverage.kind === "uncertain",
		)
			? "uncertain"
			: costs.every((cost) => cost?.coverage.kind === "exact")
				? "exact"
				: costs.some((cost) => cost?.estimate.usdMicros != null)
					? "lower_bound"
					: "unavailable";

		const coverage = {
			kind: coverageKind,
			runs: Object.fromEntries(
				["exact", "lower_bound", "uncertain", "unavailable"].map((kind) => [
					kind,
					costs.filter(
						(cost) => (cost?.coverage.kind ?? "unavailable") === kind,
					).length,
				]),
			),
			requests: costs.reduce(
				(sum, cost) => sum + (cost?.coverage.requests ?? 0),
				0,
			),
			priced: costs.reduce(
				(sum, cost) => sum + (cost?.coverage.priced ?? 0),
				0,
			),
			missingJournals: costs.reduce(
				(sum, cost) => sum + (cost?.coverage.missingJournals ?? 0),
				0,
			),
			missingReceipts: costs.reduce(
				(sum, cost) => sum + (cost?.coverage.missingReceipts ?? 0),
				0,
			),
		};

		return {
			runs: selected.length,
			outcomes: Object.fromEntries(
				[...new Set(selected.map((run) => run.outcome))]
					.sort()
					.map((outcome) => [
						outcome,
						selected.filter((run) => run.outcome === outcome).length,
					]),
			),
			readyPr: rate(selected.map((run) => run.ready)),
			landed,
			estimate: {
				kind: "api_equivalent_estimate" as const,
				usdMicros: usd.total,
				perRunUsdMicros:
					usd.total === null || selected.length === 0
						? null
						: usd.total / selected.length,
				perLandedPrUsdMicros:
					usd.total === null || landed.count === 0
						? null
						: usd.total / landed.count,
			},
			billedSpend: "unavailable" as const,
			coverage,
			tokens: {
				...amount(
					costs.map((cost) =>
						cost === undefined || cost.coverage.kind === "unavailable"
							? null
							: cost.tokens.total,
					),
				),
				kind: coverageKind,
			},
			wallMs: amount(
				selected.map((run) =>
					model !== undefined
						? null
						: stage === undefined
							? (run.timeline?.elapsedMs ?? null)
							: (run.stages.find((entry) => entry.stage === stage)?.wallMs
									.total ?? null),
				),
			),
			timeline: Object.fromEntries(
				(
					[
						"modelMs",
						"checkMs",
						"ciWaitMs",
						"ownerWaitMs",
						"controllerMs",
					] as const
				).map((key) => [
					key,
					amount(
						selected.map((run) =>
							stage !== undefined || model !== undefined
								? null
								: (run.timeline?.[key] ?? null),
						),
					),
				]),
			),
		};
	};

	const groups = (by: ScoreboardBy) => {
		const keys = (run: Run) =>
			by === "stage"
				? run.stages.map((entry) => entry.stage)
				: by === "model"
					? run.models.map((entry) => entry.model)
					: [
							by === "revision"
								? run.revision
								: by === "ticket"
									? `${run.repo}#${run.issue}`
									: run.failure,
						];

		return [...new Set(runs.flatMap(keys))].sort().map((key) => ({
			key,
			...summarize(
				runs.filter((run) => keys(run).includes(key)),
				by === "stage" ? key : undefined,
				by === "model" ? key : undefined,
			),
		}));
	};

	return {
		version: 1,
		tariffDigest: estimateCost([], tariff).tariffDigest,
		cache: "not_reported",
		summary: summarize(runs),
		groups: {
			revision: groups("revision"),
			ticket: groups("ticket"),
			stage: groups("stage"),
			model: groups("model"),
			failure: groups("failure"),
		},
		runs,
	};
}

export type ScoreboardReport = ReturnType<typeof scoreboard>;
