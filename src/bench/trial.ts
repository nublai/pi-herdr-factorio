import type { SeatReceipt } from "../candidate/review.ts";
import {
	journalCharge,
	requestSettlements,
	settlementReply,
} from "../core/journal.ts";
import { objectOf, parseJson, textOf } from "../core/json.ts";
import type { Digest } from "../core/run.ts";
import { estimateCost, PINNED_TARIFF } from "../core/tariff.ts";
import type { BenchVariant } from "./variant.ts";

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

	const cost = estimateCost(requests, PINNED_TARIFF);
	cost.coverage.missingJournals = missing;
	cost.coverage.missing += invalid;

	if (missing + invalid > 0 || chargedTokens !== cost.tokens.total) {
		if (cost.coverage.kind === "exact") cost.coverage.kind = "lower_bound";

		if (cost.coverage.priced === 0) cost.estimate.usdMicros = null;
	}

	return { chargedTokens, cost, sources: [...seen].sort() };
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
	readonly tokenCap: number;
	readonly startedAt: string;
	readonly endedAt: string;
	readonly wallMs: number;
	readonly outcome: TrialOutcome;
	readonly stages: readonly TrialStage[];
	readonly judges: readonly SeatReceipt[];
	readonly accounting: ReturnType<typeof trialAccounting>;
};
