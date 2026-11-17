import { isGitSha, isModelId } from "../config/schema.ts";
import type { SeatReceipt } from "../candidate/review.ts";
import {
	journalCharge,
	requestSettlements,
	settlementReply,
} from "../core/journal.ts";
import {
	arrayOf,
	hasDuplicateKey,
	objectOf,
	parseJson,
	textOf,
	type JsonValue,
} from "../core/json.ts";
import { parseFamily } from "../core/models.ts";
import { digestOf, type Digest } from "../core/run.ts";
import { count, digest, literal, oneOf, record } from "../ledger/schema.ts";
import { estimateCost, PINNED_TARIFF } from "../core/tariff.ts";
import { parseBenchVariant, type BenchVariant } from "./variant.ts";

export type TrialOutcome =
	| { readonly kind: "passed" }
	| {
			readonly kind: "failed" | "budget_exhausted";
			readonly stage: string;
			readonly reason: string;
	  };

export type TrialStage = {
	readonly name: string;
	readonly wallMs: number;
	readonly outcome: string;
};

export type TrialJournal = {
	readonly id: string;
	readonly model: string;
	readonly fallback?: string | null;
	readonly text: string | null;
	readonly receiptTokens: number;
};

export function trialAccounting(journals: readonly TrialJournal[]) {
	const seen = new Set<string>();
	let chargedTokens = 0;
	let missing = 0;
	let invalid = 0;
	const requests = [];

	for (const journal of journals) {
		if (seen.has(journal.id)) throw new Error("duplicate_trial_charge");
		seen.add(journal.id);
	}

	const leaves = journals.filter(
		(journal) =>
			!journals.some((other) => other.id.startsWith(`${journal.id}/`)),
	);

	for (const journal of leaves) {
		const charge = journalCharge(journal.text ?? "");
		chargedTokens += Math.max(
			journal.receiptTokens,
			charge.tokens + charge.uncertainTokens,
		);

		if (journal.text === null) missing++;

		for (const line of (journal.text ?? "").split("\n"))
			if (line.trim() !== "" && objectOf(parseJson(line)) === null) invalid++;

		for (const settlement of requestSettlements(journal.text ?? "").requests) {
			const observed = textOf(settlementReply(settlement)?.observedModel);

			const provider =
				settlement.route === "model-openai"
					? "openai"
					: settlement.route === "model-anthropic"
						? "anthropic"
						: null;

			const candidates = [journal.model, journal.fallback].filter((model) =>
				model?.startsWith(`${provider}/`),
			);

			const model =
				provider === null
					? null
					: observed !== null
						? observed.includes("/")
							? observed
							: `${provider}/${observed}`
						: candidates.length === 1
							? (candidates[0] ?? null)
							: null;

			requests.push({ settlement, model });
		}
	}

	for (const parent of journals.filter(
		(journal) => !leaves.includes(journal),
	)) {
		const children = leaves.filter((leaf) =>
			leaf.id.startsWith(`${parent.id}/`),
		);

		const total = children.reduce((sum, child) => {
			const charge = journalCharge(child.text ?? "");

			return (
				sum +
				Math.max(child.receiptTokens, charge.tokens + charge.uncertainTokens)
			);
		}, 0);

		chargedTokens += Math.max(0, parent.receiptTokens - total);
	}

	const cost = estimateCost(requests, PINNED_TARIFF);
	cost.coverage.missingJournals = missing;
	cost.coverage.missing += invalid;

	if (missing + invalid > 0 || chargedTokens !== cost.tokens.total) {
		if (cost.coverage.kind === "exact") cost.coverage.kind = "lower_bound";

		if (cost.coverage.priced === 0) cost.estimate.usdMicros = null;
	}

	return {
		chargedTokens,
		cost,
		sources: leaves.map((journal) => journal.id).sort(),
	};
}

export type BenchTrial = {
	readonly version: 1;
	readonly kind: "factory_benchmark_trial";
	readonly id: Digest;
	readonly bundleDigest: Digest;
	readonly originalRunId: Digest;
	readonly issue: number;
	readonly variant: BenchVariant;
	readonly variantDigest: Digest;
	readonly runtime: {
		readonly factoryRevision: string;
		readonly assetsDigest: string;
		readonly node: string;
		readonly platform: string;
		readonly gateRunner: string;
		readonly thinking: "runtime_default:not_historically_recorded";
	};
	readonly respec?: BenchRespec;
	readonly tokenCap: number;
	readonly startedAt: string;
	readonly endedAt: string;
	readonly wallMs: number;
	readonly outcome: TrialOutcome;
	readonly stages: readonly TrialStage[];
	readonly judges: readonly SeatReceipt[];
	readonly accounting: ReturnType<typeof trialAccounting>;
};

const text = (value: JsonValue | undefined): string => {
	const result = textOf(value);

	if (result === null || result.length === 0)
		throw new Error("invalid_trial_text");

	return result;
};

const nullableText = (value: JsonValue | undefined) =>
	value === null ? null : text(value);

const nullableCount = (value: JsonValue | undefined) =>
	value === null ? null : count(value);

const boolean = (value: JsonValue | undefined) => {
	if (value !== true && value !== false)
		throw new Error("invalid_trial_boolean");

	return value;
};

const list =
	<T>(codec: (value: JsonValue | undefined) => T) =>
	(value: JsonValue | undefined): T[] => {
		const values = arrayOf(value);

		if (values === null) throw new Error("invalid_trial_array");

		return values.map(codec);
	};

const uniqueTexts = (value: JsonValue | undefined) => {
	const values = list(text)(value);

	if (new Set(values).size !== values.length)
		throw new Error("duplicate_trial_source");

	return values;
};

const timestamp = (value: JsonValue | undefined) => {
	const result = text(value);
	const date = new Date(result);

	if (!Number.isFinite(date.getTime()) || date.toISOString() !== result)
		throw new Error("invalid_trial_timestamp");

	return result;
};

const estimateCodec = record({
	kind: literal("api_equivalent_estimate"),
	usdMicros: nullableCount,
});

const costCodec = record({
	estimate: estimateCodec,
	billedSpend: literal("unavailable"),
	cache: literal("not_reported"),
	tariffDigest: digest,
	tokens: record({ input: count, output: count, total: count }),
	coverage: record({
		kind: oneOf("exact", "lower_bound", "uncertain", "unavailable"),
		requests: count,
		priced: count,
		uncertain: count,
		missing: count,
		unpriced: count,
		missingJournals: count,
		missingReceipts: count,
	}),
	unpricedModels: uniqueTexts,
	byModel: list(
		record({
			model: text,
			requests: count,
			priced: count,
			inputTokens: count,
			outputTokens: count,
			estimate: estimateCodec,
		}),
	),
});

const outcomeCodec = (value: JsonValue | undefined): TrialOutcome => {
	if (objectOf(value)?.kind === "passed")
		return record({ kind: literal("passed") })(value);

	return record({
		kind: oneOf("failed", "budget_exhausted"),
		stage: text,
		reason: text,
	})(value);
};

const literalTrue = (value: JsonValue | undefined): true => {
	if (value !== true) throw new Error("invalid_trial_true");

	return true;
};

const seatCodec = (value: JsonValue | undefined) => {
	const input = objectOf(value);

	if (input === null) throw new Error("invalid_trial_judge");

	const { family, primary, refusal, unconfigured, budgetStopped, ...required } =
		input;

	const seat = record({
		seat: text,
		findings: list(
			record({
				id: text,
				severity: oneOf("blocking", "advisory"),
				category: oneOf("bug", "security", "contract", "simplify"),
				path: text,
				startLine: count,
				endLine: count,
				claim: text,
				evidence: text,
			}),
		),
		judgments: list(
			record({
				scenario: text,
				outcome: oneOf(
					"pass",
					"fail",
					"unverifiable",
					"inconclusive",
					"timeout",
				),
				reason: text,
			}),
		),
		requested: text,
		observed: nullableText,
		label: text,
		fallback: boolean,
		tokens: count,
	})(required);

	const parsedFamily = family === undefined ? undefined : parseFamily(family);

	if (
		parsedFamily === null ||
		(unconfigured !== undefined && unconfigured !== true) ||
		(budgetStopped !== undefined && budgetStopped !== true)
	)
		throw new Error("invalid_trial_judge");

	return {
		...seat,
		...(parsedFamily === undefined ? undefined : { family: parsedFamily }),
		...(primary === undefined ? undefined : { primary: text(primary) }),
		...(refusal === undefined ? undefined : { refusal: nullableText(refusal) }),
		...(unconfigured === true
			? { unconfigured: literalTrue(unconfigured) }
			: undefined),
		...(budgetStopped === true
			? { budgetStopped: literalTrue(budgetStopped) }
			: undefined),
	};
};

const respecCodec = record({
	baseSha: (value) => {
		const sha = text(value);

		if (!isGitSha(sha)) throw new Error("invalid_respec_base");

		return sha;
	},
	archiveDigest: digest,
	snapshotDigest: digest,
	contractDigest: (value) => (value === null ? null : digest(value)),
	acceptanceDigest: (value) => (value === null ? null : digest(value)),
	baseReceiptDigest: (value) => (value === null ? null : digest(value)),
	acceptEffort: oneOf("low", "medium", "high"),
	models: list(
		record({
			session: text,
			requested: (value) => {
				const model = text(value);

				if (!isModelId(model)) throw new Error("invalid_respec_model");

				return model;
			},
			observed: nullableText,
			fallback: nullableText,
		}),
	),
});

export type BenchRespec = ReturnType<typeof respecCodec>;

const trialCodec = record({
	version: literal(1),
	kind: literal("factory_benchmark_trial"),
	id: digest,
	bundleDigest: digest,
	originalRunId: digest,
	variant: (value) => parseBenchVariant(JSON.stringify(value)),
	variantDigest: digest,
	issue: (value) => {
		const result = count(value);

		if (result === 0) throw new Error("invalid_trial_issue");

		return result;
	},
	runtime: record({
		factoryRevision: text,
		assetsDigest: digest,
		node: text,
		platform: text,
		gateRunner: text,
		thinking: literal("runtime_default:not_historically_recorded"),
	}),
	tokenCap: (value) => {
		const result = count(value);

		if (result === 0) throw new Error("invalid_trial_cap");

		return result;
	},
	startedAt: timestamp,
	endedAt: timestamp,
	wallMs: count,
	outcome: outcomeCodec,
	stages: list(record({ name: text, wallMs: count, outcome: text })),
	judges: list(seatCodec),
	accounting: record({
		chargedTokens: count,
		cost: costCodec,
		sources: uniqueTexts,
	}),
});

export function parseBenchTrial(raw: string): BenchTrial {
	if (hasDuplicateKey(raw)) throw new Error("duplicate_trial_key");
	const value = objectOf(parseJson(raw));

	if (value === null) throw new Error("invalid_trial");
	const { respec: rawRespec, ...body } = value;
	const parsed = trialCodec(body);
	const respec = rawRespec === undefined ? undefined : respecCodec(rawRespec);

	const trial: BenchTrial =
		respec === undefined ? parsed : { ...parsed, respec };

	if ((trial.variant.change.kind === "respec") !== (respec !== undefined))
		throw new Error("trial_respec_binding_mismatch");

	if (
		respec !== undefined &&
		((respec.acceptanceDigest !== null && respec.contractDigest === null) ||
			(respec.baseReceiptDigest !== null && respec.acceptanceDigest === null) ||
			new Set(respec.models.map((model) => model.session)).size !==
				respec.models.length ||
			respec.models.some(
				(model) =>
					![
						"specify/draft",
						"specify/review",
						"specify/revision",
						"accept",
					].includes(model.session) ||
					(model.fallback !== null && !isModelId(model.fallback)),
			))
	)
		throw new Error("trial_respec_binding_mismatch");

	if (
		respec !== undefined &&
		trial.outcome.kind === "passed" &&
		(respec.contractDigest === null ||
			respec.acceptanceDigest === null ||
			respec.baseReceiptDigest === null ||
			!["specify", "accept", "accept-base"].every((name) =>
				trial.stages.some(
					(stage) => stage.name === name && stage.outcome === "passed",
				),
			) ||
			!["specify/draft", "specify/review", "accept"].every((name) =>
				respec.models.some((model) => model.session === name),
			))
	)
		throw new Error("trial_respec_proof_missing");
	const { cost, chargedTokens } = trial.accounting;

	if (trial.variantDigest !== digestOf(JSON.stringify(trial.variant)))
		throw new Error("trial_variant_digest_mismatch");

	if (
		trial.bundleDigest !== trial.variant.pins.bundleDigest ||
		trial.runtime.factoryRevision !== trial.variant.pins.factoryRevision ||
		cost.tariffDigest !== trial.variant.pins.tariffDigest ||
		(trial.variant.change.kind !== "skill" &&
			trial.runtime.assetsDigest !== trial.variant.pins.assetsDigest)
	)
		throw new Error("trial_pin_mismatch");

	if (Date.parse(trial.endedAt) - Date.parse(trial.startedAt) !== trial.wallMs)
		throw new Error("trial_time_mismatch");

	if (
		cost.tokens.total !== cost.tokens.input + cost.tokens.output ||
		chargedTokens < cost.tokens.total
	)
		throw new Error("trial_tokens_mismatch");

	const sum = (values: readonly number[]) =>
		values.reduce((total, value) => total + value, 0);

	const coverage = cost.coverage;

	const expectedCoverage =
		coverage.uncertain > 0
			? "uncertain"
			: coverage.priced === 0 && coverage.requests > 0
				? "unavailable"
				: coverage.missing +
							coverage.unpriced +
							coverage.missingJournals +
							coverage.missingReceipts >
							0 || chargedTokens !== cost.tokens.total
					? "lower_bound"
					: "exact";

	if (
		coverage.kind !== expectedCoverage ||
		(coverage.kind === "unavailable" && cost.estimate.usdMicros !== null) ||
		coverage.priced + coverage.uncertain + coverage.unpriced >
			coverage.requests ||
		coverage.priced +
			coverage.uncertain +
			coverage.unpriced +
			coverage.missing <
			coverage.requests ||
		(coverage.priced > 0 && cost.estimate.usdMicros === null) ||
		new Set(cost.byModel.map((model) => model.model)).size !==
			cost.byModel.length ||
		sum(cost.byModel.map((model) => model.inputTokens)) !== cost.tokens.input ||
		sum(cost.byModel.map((model) => model.outputTokens)) !==
			cost.tokens.output ||
		sum(cost.byModel.map((model) => model.requests)) !== coverage.requests ||
		sum(cost.byModel.map((model) => model.priced)) !== coverage.priced ||
		(cost.estimate.usdMicros !== null &&
			sum(cost.byModel.map((model) => model.estimate.usdMicros ?? 0)) !==
				cost.estimate.usdMicros) ||
		(coverage.kind === "exact" &&
			(cost.estimate.usdMicros === null ||
				coverage.priced !== coverage.requests ||
				coverage.uncertain +
					coverage.missing +
					coverage.unpriced +
					coverage.missingJournals +
					coverage.missingReceipts >
					0 ||
				chargedTokens !== cost.tokens.total))
	)
		throw new Error("trial_cost_mismatch");

	return trial;
}
