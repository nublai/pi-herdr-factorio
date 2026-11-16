import { readdir, lstat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { parseTimeline } from "../../src/controller/timeline.ts";
import { fieldOf, objectOf, parseJson, textOf } from "../../src/core/json.ts";
import { requestSettlements, settlementReply } from "../../src/core/journal.ts";
import { MODEL_STAGES, type ModelStage } from "../../src/core/stages.ts";
import { PINNED_TARIFF, type CostRequest } from "../../src/core/tariff.ts";
import { frozenRowOf, type LedgerRow } from "../../src/ledger/schema.ts";
import {
	scoreboard,
	type ScoreboardReceipts,
} from "../../src/views/scoreboard.ts";
import { SPECIFY_SESSIONS } from "../sandbox/receipts.ts";
import { Evidence } from "../viewer/evidence.ts";
import { EXIT, type CliIo } from "./platform.ts";

async function directories(io: Evidence, path: string): Promise<string[]> {
	try {
		if (!(await io.safe(path))) throw new Error("unsafe directory");
		const entries = await readdir(path, { withFileTypes: true });
		io.entries += entries.length;

		if (io.entries > 10000) throw new Error("scoreboard_entry_limit");

		return entries
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

async function execution(
	io: Evidence,
	dir: string,
	row: LedgerRow,
	stage: ModelStage,
): Promise<ScoreboardReceipts["stages"][number]> {
	const receipt = await io.json(join(dir, "receipt.json"));

	const valid =
		fieldOf(receipt, "version") === 1 &&
		fieldOf(receipt, "runId") === row.runId &&
		fieldOf(receipt, "stage") === stage;

	const result: ScoreboardReceipts["stages"][number] = {
		stage,
		requests: [],
		missingJournals: 0,
		missingReceipts: valid ? 0 : 1,
		invalidLines: 0,
	};

	const leaves: readonly string[] = [
		...SPECIFY_SESSIONS,
		"code-review",
		"security-review",
		"simplify",
		"ultrareview",
		"second-judge",
	];

	const children = (await directories(io, dir)).filter((name) =>
		leaves.includes(name),
	);

	if (children.length > 0) {
		const requests: CostRequest[] = [];

		for (const child of children) {
			const evidence = await execution(io, join(dir, child), row, stage);
			requests.push(...evidence.requests);
			result.missingReceipts += evidence.missingReceipts;
			result.missingJournals += evidence.missingJournals;
			result.invalidLines += evidence.invalidLines;
		}

		return { ...result, requests };
	}

	const journal = await io.text(join(dir, "egress.requests.jsonl"));

	if (journal === null) return { ...result, missingJournals: 1 };
	const models = valid ? objectOf(fieldOf(receipt, "models")) : null;
	const fallback = valid ? objectOf(fieldOf(receipt, "fallback")) : null;

	const requests = requestSettlements(journal).requests.map((settlement) => {
		const observed = textOf(settlementReply(settlement)?.observedModel);

		const primary = routeModel(
			textOf(fieldOf(models, "requested")),
			settlement.route,
		);

		const alternative = routeModel(
			textOf(fieldOf(fallback, "requested")),
			settlement.route,
		);

		const model =
			observed !== null
				? routeModel(observed, settlement.route)
				: primary !== null && alternative !== null && primary !== alternative
					? null
					: (alternative ?? primary);

		return { settlement, model };
	});

	return {
		...result,
		requests,
		invalidLines: journal
			.split("\n")
			.filter(
				(line) => line.trim() !== "" && objectOf(parseJson(line)) === null,
			).length,
	};
}

export async function readScoreboard(stateDir: string, since?: string) {
	const root = resolve(stateDir);
	const info = await lstat(root);

	if (!info.isDirectory() || info.isSymbolicLink())
		throw new Error("state_unavailable");
	const io = new Evidence(root);
	const rows: LedgerRow[] = [];
	let excludedUnknownStart = 0;

	for (const id of await directories(io, join(root, "ledger"))) {
		if (!/^[a-f0-9]{64}$/.test(id)) continue;
		const path = join(root, "ledger", id, "row.json");

		const exists = await lstat(path).catch((error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT") return null;
			throw error;
		});

		if (exists === null) continue;
		const bytes = await io.text(path);
		const saved = bytes === null ? null : frozenRowOf(Buffer.from(bytes));

		if (saved === null || saved.row.runId !== id)
			throw new Error("terminal_row_invalid");

		if (since !== undefined) {
			if (saved.row.startedAt.kind !== "known") {
				excludedUnknownStart += 1;
				continue;
			}

			if (Date.parse(saved.row.startedAt.value) < Date.parse(since)) continue;
		}

		rows.push(saved.row);
	}

	const receipts: ScoreboardReceipts[] = [];

	for (const row of rows) {
		const stages: ScoreboardReceipts["stages"][number][] = [];
		const stageRoot = join(root, "stages", row.runId);
		const names = await directories(io, stageRoot);

		for (const stage of MODEL_STAGES) {
			for (const name of names.filter((name) =>
				new RegExp(`^${stage}-(?:r[0-9]+-)?[0-9]+(?:\\.[0-9]+)?$`).test(name),
			))
				stages.push(await execution(io, join(stageRoot, name), row, stage));
		}

		const admission = await io.json(
			join(
				root,
				"admissions",
				"github",
				row.repo,
				String(row.issue),
				`${row.eventId}.json`,
			),
		);

		const timeline =
			row.v === 6
				? await io.text(join(root, "timeline", `${row.runId}.jsonl`))
				: null;

		receipts.push({
			runId: row.runId,
			title: textOf(fieldOf(objectOf(fieldOf(admission, "snapshot")), "title")),
			stages,
			timeline: timeline === null ? null : parseTimeline(timeline, row.runId),
		});
	}

	return {
		...scoreboard(rows, receipts, PINNED_TARIFF),
		filter: { since: since ?? null, excludedUnknownStart },
	};
}

type ScoreboardOptions = {
	stateDir: string;
	since?: string;
	by?: "revision" | "stage" | "failure" | "model";
};

export async function runScoreboardCli(
	argv: readonly string[],
	io: CliIo,
): Promise<number> {
	let options: ScoreboardOptions;

	try {
		const { values, positionals } = parseArgs({
			args: [...argv],
			strict: true,
			allowPositionals: true,
			options: {
				json: { type: "boolean" },
				"state-dir": { type: "string" },
				since: { type: "string" },
				by: { type: "string" },
			},
		});

		if (
			values.json !== true ||
			!values["state-dir"] ||
			positionals.length > 0 ||
			(values.since !== undefined &&
				(!/^\d{4}-\d{2}-\d{2}$/.test(values.since) ||
					!Number.isFinite(Date.parse(values.since)) ||
					new Date(values.since).toISOString().slice(0, 10) !==
						values.since)) ||
			(values.by !== undefined &&
				values.by !== "revision" &&
				values.by !== "stage" &&
				values.by !== "failure" &&
				values.by !== "model")
		)
			throw new Error("usage");
		options = { stateDir: values["state-dir"] };

		if (values.since !== undefined) options.since = values.since;

		if (values.by !== undefined) options.by = values.by;
	} catch {
		io.stderr(
			"scoreboard requires --json --state-dir <dir> [--since <YYYY-MM-DD>] [--by revision|stage|failure|model]\n",
		);

		return EXIT.usage;
	}

	try {
		const report = await readScoreboard(options.stateDir, options.since);
		io.stdout(
			`${JSON.stringify({ ...report, by: options.by ?? "revision", selectedGroups: report.groups[options.by ?? "revision"] }, null, 2)}\n`,
		);

		return EXIT.ok;
	} catch (error) {
		io.stdout(
			`${JSON.stringify({ error: error instanceof Error ? error.message : "scoreboard_unavailable" })}\n`,
		);

		return EXIT.invalid;
	}
}
