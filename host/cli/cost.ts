import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
	fieldOf,
	objectOf,
	parseJson,
	textOf,
	type JsonObject,
} from "../../src/core/json.ts";
import { requestSettlements, settlementReply } from "../../src/core/journal.ts";
import { MODEL_STAGES } from "../../src/core/stages.ts";
import {
	estimateCost,
	PINNED_TARIFF,
	type CostRequest,
	type CostEstimate,
} from "../../src/core/tariff.ts";
import { frozenRowOf, type LedgerRow } from "../../src/ledger/schema.ts";
import { SPECIFY_SESSIONS } from "../sandbox/receipts.ts";
import { EXIT, type CliIo } from "./platform.ts";

type Evidence = {
	requests: CostRequest[];
	missingJournals: number;
	missingReceipts: number;
	invalidLines: number;
};

const emptyEvidence = (): Evidence => ({
	requests: [],
	missingJournals: 0,
	missingReceipts: 0,
	invalidLines: 0,
});

function addEvidence(target: Evidence, source: Evidence) {
	target.requests.push(...source.requests);
	target.missingJournals += source.missingJournals;
	target.missingReceipts += source.missingReceipts;
	target.invalidLines += source.invalidLines;
}

async function optionalRead(path: string): Promise<string | null> {
	try {
		return await readFile(path, "utf8");
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT")
			return null;
		throw error;
	}
}

async function directories(path: string): Promise<string[]> {
	try {
		return (await readdir(path, { withFileTypes: true }))
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name)
			.sort();
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT")
			return [];
		throw error;
	}
}

function routeModel(model: string | null, route: string | null): string | null {
	const provider =
		route === "model-openai"
			? "openai"
			: route === "model-anthropic"
				? "anthropic"
				: null;

	if (provider === null || model === null) return null;

	return model.includes("/")
		? model.startsWith(`${provider}/`)
			? model
			: null
		: `${provider}/${model}`;
}

function modelOf(
	request: CostRequest["settlement"],
	receipt: JsonObject | null,
): string | null {
	const observed = textOf(settlementReply(request)?.observedModel);

	if (observed !== null) return routeModel(observed, request.route);
	const models = objectOf(fieldOf(receipt, "models"));

	const primary = routeModel(
		textOf(fieldOf(models, "requested")),
		request.route,
	);

	const fallback = objectOf(fieldOf(receipt, "fallback"));

	const alternative = routeModel(
		textOf(fieldOf(fallback, "requested")),
		request.route,
	);

	// Same-route fallback journals do not say which request used which model.
	if (primary !== null && alternative !== null && primary !== alternative)
		return null;

	return alternative ?? primary;
}

async function executionEvidence(
	dir: string,
	runId: string,
	stage: string,
): Promise<Evidence> {
	const evidence = emptyEvidence();
	const rawReceipt = await optionalRead(join(dir, "receipt.json"));
	const receipt = rawReceipt === null ? null : objectOf(parseJson(rawReceipt));

	const validReceipt =
		fieldOf(receipt, "version") === 1 &&
		fieldOf(receipt, "runId") === runId &&
		fieldOf(receipt, "stage") === stage;

	if (!validReceipt) evidence.missingReceipts += 1;

	const leaves: readonly string[] = [
		...SPECIFY_SESSIONS,
		"code-review",
		"security-review",
		"simplify",
		"ultrareview",
		"second-judge",
	];

	const children = (await directories(dir)).filter((name) =>
		leaves.includes(name),
	);

	if (children.length > 0) {
		for (const child of children)
			addEvidence(
				evidence,
				await executionEvidence(join(dir, child), runId, stage),
			);

		return evidence;
	}

	const journal = await optionalRead(join(dir, "egress.requests.jsonl"));

	if (journal !== null) {
		for (const line of journal.split("\n")) {
			if (line.trim() !== "" && objectOf(parseJson(line)) === null)
				evidence.invalidLines += 1;
		}

		evidence.requests.push(
			...requestSettlements(journal).requests.map((settlement) => ({
				settlement,
				model: modelOf(settlement, validReceipt ? receipt : null),
			})),
		);
	} else evidence.missingJournals += 1;

	return evidence;
}

type LedgerTokens = LedgerRow["usage"]["tokens"];

function costOf(evidence: Evidence, ledgerTokens: LedgerTokens | null) {
	const cost = estimateCost(evidence.requests, PINNED_TARIFF);
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

function totalOf(costs: readonly CostEstimate[]): CostEstimate {
	const total = estimateCost([], PINNED_TARIFF);
	const groups = new Map<string, CostEstimate["byModel"][number]>();

	for (const cost of costs) {
		total.estimate.usdMicros =
			(total.estimate.usdMicros ?? 0) + (cost.estimate.usdMicros ?? 0);
		total.tokens.input += cost.tokens.input;
		total.tokens.output += cost.tokens.output;
		total.tokens.total += cost.tokens.total;

		for (const key of [
			"requests",
			"priced",
			"uncertain",
			"missing",
			"unpriced",
			"missingJournals",
			"missingReceipts",
		] as const)
			total.coverage[key] += cost.coverage[key];

		for (const model of cost.byModel) {
			const group = groups.get(model.model);

			if (group === undefined)
				groups.set(model.model, { ...model, estimate: { ...model.estimate } });
			else {
				group.requests += model.requests;
				group.priced += model.priced;
				group.inputTokens += model.inputTokens;
				group.outputTokens += model.outputTokens;

				if (model.estimate.usdMicros !== null)
					group.estimate.usdMicros =
						(group.estimate.usdMicros ?? 0) + model.estimate.usdMicros;
			}
		}
	}

	total.coverage.kind = costs.some((cost) => cost.coverage.kind === "uncertain")
		? "uncertain"
		: costs.some((cost) => cost.coverage.kind !== "exact")
			? total.coverage.priced > 0
				? "lower_bound"
				: "unavailable"
			: "exact";

	if (
		costs.length > 0 &&
		costs.every((cost) => cost.estimate.usdMicros === null)
	)
		total.estimate.usdMicros = null;
	total.unpricedModels = [
		...new Set(costs.flatMap((cost) => cost.unpricedModels)),
	].sort();
	total.byModel = [...groups.values()].sort((a, b) =>
		a.model.localeCompare(b.model),
	);

	return total;
}

async function runCost(stateDir: string, row: LedgerRow) {
	const root = join(stateDir, "stages", row.runId);
	const attempts = await directories(root);
	const stages = [];
	const all = emptyEvidence();

	for (const stage of MODEL_STAGES) {
		const names = attempts.filter((name) =>
			new RegExp(`^${stage}-(?:r[0-9]+-)?[0-9]+(?:\\.[0-9]+)?$`).test(name),
		);

		const summary =
			row.stages.kind === "known"
				? row.stages.value.find((summary) => summary.stage === stage)
				: undefined;

		if (names.length === 0 && summary === undefined) continue;
		const evidence = emptyEvidence();

		if (names.length === 0) evidence.missingJournals += 1;

		for (const name of names)
			addEvidence(
				evidence,
				await executionEvidence(join(root, name), row.runId, stage),
			);
		addEvidence(all, evidence);
		stages.push({ stage, ...costOf(evidence, summary?.tokens ?? null) });
	}

	return {
		runId: row.runId,
		repo: row.repo,
		issue: row.issue,
		outcome: row.outcome.kind,
		...costOf(all, row.usage.tokens),
		stages,
	};
}

function parseCostArgs(argv: readonly string[]) {
	return parseArgs({
		args: [...argv],
		allowPositionals: true,
		strict: true,
		options: {
			json: { type: "boolean" },
			"state-dir": { type: "string" },
			run: { type: "string" },
		},
	});
}

export async function runCostCli(
	argv: readonly string[],
	io: CliIo,
): Promise<number> {
	let parsed: ReturnType<typeof parseCostArgs>;

	try {
		parsed = parseCostArgs(argv);
	} catch {
		io.stderr("cost requires --json --state-dir <dir> [--run <id>]\n");

		return EXIT.usage;
	}

	const { values, positionals } = parsed;

	if (
		positionals.length > 0 ||
		values.json !== true ||
		!values["state-dir"] ||
		(values.run !== undefined && !/^[a-f0-9]{4,64}$/.test(values.run))
	) {
		io.stderr("cost requires --json --state-dir <dir> [--run <id>]\n");

		return EXIT.usage;
	}

	try {
		const stateDir = resolve(values["state-dir"]);

		if (!(await stat(stateDir).catch(() => null))?.isDirectory())
			throw new Error("state_unavailable");
		const rows: LedgerRow[] = [];

		for (const runId of await directories(join(stateDir, "ledger"))) {
			if (!/^[a-f0-9]{64}$/.test(runId)) continue;

			const bytes = await optionalRead(
				join(stateDir, "ledger", runId, "row.json"),
			);

			if (bytes === null) continue;
			const saved = frozenRowOf(Buffer.from(bytes));

			if (saved === null || saved.row.runId !== runId)
				throw new Error("terminal_row_invalid");
			rows.push(saved.row);
		}

		const selected = rows.filter(
			(row) => values.run === undefined || row.runId.startsWith(values.run),
		);

		if (values.run !== undefined && selected.length !== 1)
			throw new Error(
				selected.length === 0 ? "run_not_found" : "run_ambiguous",
			);
		const runs = [];

		for (const row of selected) runs.push(await runCost(stateDir, row));
		io.stdout(
			`${JSON.stringify({ version: 1, ...totalOf(runs), runs }, null, 2)}\n`,
		);

		return EXIT.ok;
	} catch (error) {
		io.stdout(
			`${JSON.stringify({ error: error instanceof Error ? error.message : "cost_unavailable" })}\n`,
		);

		return EXIT.invalid;
	}
}
