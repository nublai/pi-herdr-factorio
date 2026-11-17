import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { costOf } from "../../src/core/cost-evidence.ts";
import {
	estimateCost,
	PINNED_TARIFF,
	type CostEstimate,
} from "../../src/core/tariff.ts";
import { frozenRowOf, type LedgerRow } from "../../src/ledger/schema.ts";
import { readRunCostEvidence } from "./cost-evidence.ts";
import { EXIT, type CliIo } from "./platform.ts";

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
	const evidence = await readRunCostEvidence(
		{ text: optionalRead, directories },
		stateDir,
		row,
	);

	const stages = evidence.stages.map(({ stage, ...retained }) => {
		const summary =
			row.stages.kind === "known"
				? row.stages.value.find((entry) => entry.stage === stage)
				: undefined;

		return {
			stage,
			...costOf(retained, summary?.tokens ?? null, PINNED_TARIFF),
		};
	});

	return {
		runId: row.runId,
		repo: row.repo,
		issue: row.issue,
		outcome: row.outcome.kind,
		...costOf(evidence.all, row.usage.tokens, PINNED_TARIFF),
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
