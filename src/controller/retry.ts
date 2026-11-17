import type { SessionOutcome } from "../core/execution.ts";

export function retryableStageOutcome(
	kind: SessionOutcome["kind"],
): kind is "failed" {
	return kind === "failed";
}

export function stageRetryDecision(input: {
	readonly usage: number;
	readonly charge: number;
	readonly attempt: number;
	readonly maxTokensPerRun: number;
	readonly maxAttempts: number;
}) {
	const usage = input.usage + input.charge;

	return {
		usage,
		kind:
			usage >= input.maxTokensPerRun
				? "budget_exhausted"
				: input.attempt >= input.maxAttempts
					? "attempts"
					: "retry",
	} as const;
}

export function acceptRetryUnavailable(input: {
	readonly attempt: number;
	readonly maxAttempts: number;
	readonly spent: number | null;
	readonly maxTokens: number;
	readonly remainingRunTokens: number;
	readonly baseWallMs: number | null;
	readonly remainingWallMs: number;
}) {
	return input.attempt >= input.maxAttempts
		? "attempts"
		: input.spent === null || input.spent >= input.maxTokens
			? "stage_tokens"
			: input.remainingRunTokens <= 0
				? "run_tokens"
				: input.baseWallMs === null
					? "base_receipt"
					: input.remainingWallMs <= 0
						? "wall"
						: null;
}
