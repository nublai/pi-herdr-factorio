import { estimateCost, type CostRequest, type Tariff } from "./tariff.ts";
import type { LedgerRow } from "../ledger/schema.ts";

export type CostEvidence = {
	requests: readonly CostRequest[];
	missingJournals: number;
	missingReceipts: number;
	invalidLines: number;
};

export const emptyEvidence = (): CostEvidence => ({
	requests: [],
	missingJournals: 0,
	missingReceipts: 0,
	invalidLines: 0,
});

export function addEvidence(target: CostEvidence, source: CostEvidence) {
	target.requests = [...target.requests, ...source.requests];
	target.missingJournals += source.missingJournals;
	target.missingReceipts += source.missingReceipts;
	target.invalidLines += source.invalidLines;
}

export function costOf(
	evidence: CostEvidence,
	ledgerTokens: LedgerRow["usage"]["tokens"] | null,
	tariff: Tariff,
) {
	const cost = estimateCost(evidence.requests, tariff);
	const coverage = cost.coverage;
	coverage.missing += evidence.invalidLines;
	coverage.missingJournals = evidence.missingJournals;
	coverage.missingReceipts = evidence.missingReceipts;

	const tokenDifference =
		ledgerTokens !== null ? ledgerTokens.total - cost.tokens.total : null;

	const gaps: string[] = [];

	if (evidence.missingJournals > 0) gaps.push("journal_missing");

	if (evidence.missingReceipts > 0) gaps.push("receipt_missing");

	if (coverage.missing > 0) gaps.push("request_usage_missing");

	if (coverage.unpriced > 0) gaps.push("model_unpriced");

	if (coverage.uncertain > 0) gaps.push("request_uncertain");

	if (ledgerTokens === null) gaps.push("ledger_tokens_unavailable");
	else if (ledgerTokens.kind !== "exact")
		gaps.push(`ledger_${ledgerTokens.kind}`);

	if (tokenDifference !== null && tokenDifference !== 0)
		gaps.push("ledger_token_difference");

	if (gaps.length > 0) {
		coverage.kind =
			coverage.uncertain > 0 || ledgerTokens?.kind === "uncertain"
				? "uncertain"
				: coverage.priced === 0
					? "unavailable"
					: "lower_bound";

		if (coverage.priced === 0) cost.estimate.usdMicros = null;
	}

	return { ...cost, ledgerTokens, tokenDifference, gaps };
}
