import { readdir, lstat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { parseTimeline } from "../../src/controller/timeline.ts";
import { fieldOf, objectOf, textOf } from "../../src/core/json.ts";
import { PINNED_TARIFF } from "../../src/core/tariff.ts";
import { frozenRowOf, type LedgerRow } from "../../src/ledger/schema.ts";
import {
	scoreboard,
	type ScoreboardReceipts,
} from "../../src/views/scoreboard.ts";
import { Evidence } from "../viewer/evidence.ts";
import { readRunCostEvidence } from "./cost-evidence.ts";
import { EXIT, type CliIo } from "./platform.ts";

async function directories(
	io: Evidence,
	path: string,
	bounded = true,
): Promise<string[]> {
	try {
		if (!(await io.safe(path))) throw new Error("unsafe directory");
		const entries = await readdir(path, { withFileTypes: true });

		if (bounded) {
			io.entries += entries.length;

			if (io.entries > 10000) {
				io.gap(path, "per-run entry limit; directory skipped");

				return [];
			}
		}

		return entries
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name)
			.sort();
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT")
			return [];

		if (!bounded) throw error;
		io.gap(path, "unsafe or unreadable directory");

		return [];
	}
}

export async function readScoreboard(
	stateDir: string,
	since?: string,
	by: "revision" | "stage" | "failure" | "model" = "revision",
) {
	const root = resolve(stateDir);
	const info = await lstat(root);

	if (!info.isDirectory() || info.isSymbolicLink())
		throw new Error("state_unavailable");
	const rows: LedgerRow[] = [];
	let excludedUnknownStart = 0;

	for (const id of await directories(
		new Evidence(root),
		join(root, "ledger"),
		false,
	)) {
		if (!/^[a-f0-9]{64}$/.test(id)) continue;
		const path = join(root, "ledger", id, "row.json");

		const exists = await lstat(path).catch((error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT") return null;
			throw error;
		});

		if (exists === null) continue;
		const bytes = await new Evidence(root).text(path);
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
		const io = new Evidence(root);

		const evidence = await readRunCostEvidence(
			{
				text: async (path) => {
					if (io.entries > 10000) {
						io.gap(path, "per-run entry limit; file skipped");

						return null;
					}

					return io.text(path);
				},
				directories: (path) => directories(io, path),
			},
			root,
			row,
		);

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
			stages: evidence.stages,
			timeline: timeline === null ? null : parseTimeline(timeline, row.runId),
			evidenceGaps: io.gaps,
		});
	}

	const report = {
		...scoreboard(rows, receipts, PINNED_TARIFF),
		filter: { since: since ?? null, excludedUnknownStart },
	};

	return { ...report, by, selectedGroups: report.groups[by] };
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
		const report = await readScoreboard(
			options.stateDir,
			options.since,
			options.by,
		);

		io.stdout(`${JSON.stringify(report, null, 2)}\n`);

		return EXIT.ok;
	} catch (error) {
		io.stdout(
			`${JSON.stringify({ error: error instanceof Error ? error.message : "scoreboard_unavailable" })}\n`,
		);

		return EXIT.invalid;
	}
}
