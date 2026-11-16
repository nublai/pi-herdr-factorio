import pinned from "./tariff.json" with { type: "json" };
import {
	arrayOf,
	countOf,
	fieldOf,
	numberOf,
	objectOf,
	parseJson,
	textOf,
	type JsonValue,
} from "./json.ts";
import { settlementReply, type RequestSettlement } from "./journal.ts";
import { digestOf } from "./run.ts";

type Rates = {
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
};

type Tier = Rates & { readonly inputTokensAbove: number };

export type Tariff = {
	readonly version: 1;
	readonly models: readonly {
		readonly model: string;
		readonly rates: Rates;
		readonly tiers: readonly Tier[];
		readonly source: {
			readonly package: string;
			readonly version: string;
			readonly file: string;
			readonly sha256: string;
			readonly asOf: string;
		};
	}[];
};

export function tariffDigest(tariff: Tariff): string {
	return digestOf(JSON.stringify(tariff));
}

function ratesOf(value: JsonValue | undefined): Rates {
	const record = objectOf(value);
	const input = numberOf(fieldOf(record, "input"));
	const output = numberOf(fieldOf(record, "output"));
	const cacheRead = numberOf(fieldOf(record, "cacheRead"));
	const cacheWrite = numberOf(fieldOf(record, "cacheWrite"));

	if (
		input === null ||
		output === null ||
		cacheRead === null ||
		cacheWrite === null ||
		Math.min(input, output, cacheRead, cacheWrite) < 0
	)
		throw new Error("tariff_rates_invalid");

	return { input, output, cacheRead, cacheWrite };
}

export function readTariff(text: string, expectedDigest: string): Tariff {
	const value = parseJson(text);

	if (value === undefined || digestOf(JSON.stringify(value)) !== expectedDigest)
		throw new Error("tariff_digest_mismatch");
	const record = objectOf(value);
	const models = arrayOf(fieldOf(record, "models"));

	if (fieldOf(record, "version") !== 1 || models === null)
		throw new Error("tariff_invalid");
	const ids = new Set<string>();

	return {
		version: 1,
		models: models.map((value) => {
			const entry = objectOf(value);
			const model = textOf(fieldOf(entry, "model"));
			const rawTiers = arrayOf(fieldOf(entry, "tiers"));
			const source = objectOf(fieldOf(entry, "source"));
			const name = textOf(fieldOf(source, "package"));
			const version = textOf(fieldOf(source, "version"));
			const file = textOf(fieldOf(source, "file"));
			const sha256 = textOf(fieldOf(source, "sha256"));
			const asOf = textOf(fieldOf(source, "asOf"));

			if (
				model === null ||
				ids.has(model) ||
				rawTiers === null ||
				name === null ||
				version === null ||
				file === null ||
				sha256 === null ||
				!/^[a-f0-9]{64}$/.test(sha256) ||
				asOf === null ||
				!/^\d{4}-\d{2}-\d{2}$/.test(asOf)
			)
				throw new Error("tariff_invalid");
			ids.add(model);

			return {
				model,
				rates: ratesOf(fieldOf(entry, "rates")),
				tiers: rawTiers.map((tier) => {
					const inputTokensAbove = countOf(
						fieldOf(objectOf(tier), "inputTokensAbove"),
					);

					if (inputTokensAbove === null) throw new Error("tariff_tier_invalid");

					return { inputTokensAbove, ...ratesOf(tier) };
				}),
				source: { package: name, version, file, sha256, asOf },
			};
		}),
	};
}

export const PINNED_TARIFF = readTariff(
	JSON.stringify(pinned),
	"af4fba544ee16de41b2517720dd52a2dad2874bcd50bbc5a8bbc79d6ee83afb7",
);

export type CostRequest = {
	readonly settlement: RequestSettlement;
	readonly model: string | null;
};

export type CostCoverage = {
	kind: "exact" | "lower_bound" | "uncertain" | "unavailable";
	requests: number;
	priced: number;
	uncertain: number;
	missing: number;
	unpriced: number;
	missingJournals: number;
	missingReceipts: number;
};

export type CostEstimate = {
	estimate: { kind: "api_equivalent_estimate"; usdMicros: number | null };
	billedSpend: "unavailable";
	cache: "not_reported";
	tariffDigest: string;
	tokens: { input: number; output: number; total: number };
	coverage: CostCoverage;
	unpricedModels: string[];
	byModel: {
		model: string;
		requests: number;
		priced: number;
		inputTokens: number;
		outputTokens: number;
		estimate: { kind: "api_equivalent_estimate"; usdMicros: number | null };
	}[];
};

export function estimateCost(
	requests: readonly CostRequest[],
	tariff: Tariff,
): CostEstimate {
	const coverage: CostCoverage = {
		kind: "exact",
		requests: requests.length,
		priced: 0,
		uncertain: 0,
		missing: 0,
		unpriced: 0,
		missingJournals: 0,
		missingReceipts: 0,
	};

	const byModel = new Map<string, CostEstimate["byModel"][number]>();
	const unpricedModels = new Set<string>();
	let input = 0;
	let output = 0;
	let micros = 0;

	for (const { settlement, model } of requests) {
		const reply = settlementReply(settlement);
		const usage = reply?.usage;
		const inputTokens = usage?.inputTokens ?? 0;
		const outputTokens = usage?.outputTokens ?? 0;
		input += inputTokens;
		output += outputTokens;
		const key = model ?? "unknown";

		const group = byModel.get(key) ?? {
			model: key,
			requests: 0,
			priced: 0,
			inputTokens: 0,
			outputTokens: 0,
			estimate: { kind: "api_equivalent_estimate", usdMicros: null },
		};

		group.requests += 1;
		group.inputTokens += inputTokens;
		group.outputTokens += outputTokens;
		byModel.set(key, group);

		if (
			settlement.kind === "Uncertain" ||
			settlement.kind === "Dispatched" ||
			reply?.kind === "Unreachable"
		) {
			coverage.uncertain += 1;
			continue;
		}

		if (usage?.kind !== "metered" || settlement.req === null) {
			coverage.missing += 1;
			continue;
		}

		const entry = tariff.models.find((entry) => entry.model === model);

		if (entry === undefined) {
			coverage.unpriced += 1;
			unpricedModels.add(key);
			continue;
		}

		let rates = entry.rates;
		let threshold = -1;

		for (const tier of entry.tiers) {
			if (
				inputTokens > tier.inputTokensAbove &&
				tier.inputTokensAbove > threshold
			) {
				rates = tier;
				threshold = tier.inputTokensAbove;
			}
		}

		// USD per million tokens is numerically USD micros per token.
		const cost = Math.round(
			inputTokens * rates.input + outputTokens * rates.output,
		);

		micros += cost;
		coverage.priced += 1;
		group.priced += 1;
		group.estimate.usdMicros = (group.estimate.usdMicros ?? 0) + cost;
	}

	coverage.kind =
		coverage.uncertain > 0
			? "uncertain"
			: coverage.missing + coverage.unpriced > 0
				? "lower_bound"
				: "exact";

	if (coverage.priced === 0 && requests.length > 0 && coverage.uncertain === 0)
		coverage.kind = "unavailable";

	return {
		estimate: {
			kind: "api_equivalent_estimate",
			usdMicros: coverage.priced === 0 && requests.length > 0 ? null : micros,
		},
		billedSpend: "unavailable",
		cache: "not_reported",
		tariffDigest: tariffDigest(tariff),
		tokens: { input, output, total: input + output },
		coverage,
		unpricedModels: [...unpricedModels].sort(),
		byModel: [...byModel.values()].sort((a, b) =>
			a.model.localeCompare(b.model),
		),
	};
}
