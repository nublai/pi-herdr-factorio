import { STAGE_ORDER } from "../core/stages.ts";
import type { RepoSlug } from "../trust/platform.ts";
import { textOf, type JsonValue } from "../core/json.ts";
import {
	count,
	digest,
	literal,
	nullable,
	oneOf,
	record,
	sha,
	LedgerRowError,
	type Out,
} from "../ledger/schema.ts";

export const timelineRecord = record({
	v: literal(1),
	runId: digest,
	seq: count,
	at: count,
	kind: oneOf("start", "end", "point"),
	name: oneOf(
		"claim",
		"stage",
		"visible_tests",
		"validation",
		"ci_wait",
		"handoff",
		"ready_for_review",
		"owner_wait",
		"controller",
		"repair_authorized",
		"repair_started",
		"repair_completed",
		"terminal",
	),
	key: (value: JsonValue | undefined) => {
		const key = textOf(value);

		if (key === null || !/^[a-zA-Z0-9_:.-]{1,200}$/.test(key))
			throw new LedgerRowError("invalid_timeline_key");

		return key;
	},
	stage: nullable(oneOf(...STAGE_ORDER)),
	round: count,
	attempt: count,
	category: oneOf("model", "check", "ci_wait", "owner_wait", "controller"),
	controllerRevision: nullable(sha),
});

export type TimelineRecord = Out<typeof timelineRecord>;

export type TimelineInput = Omit<
	TimelineRecord,
	"v" | "runId" | "seq" | "controllerRevision"
>;

type TimelineWriteInput = Omit<TimelineInput, "kind"> & {
	readonly repo: RepoSlug;
};

export interface RunTimeline {
	transition(
		runId: TimelineRecord["runId"],
		input: TimelineWriteInput,
	): Promise<boolean>;
	point(
		runId: TimelineRecord["runId"],
		input: TimelineWriteInput,
	): Promise<boolean>;
}

export function parseTimeline(
	text: string,
	runId: TimelineRecord["runId"],
): TimelineRecord[] | null {
	if (!text.endsWith("\n")) return null;
	const records: TimelineRecord[] = [];

	try {
		for (const line of text.slice(0, -1).split("\n")) {
			const row = timelineRecord(JSON.parse(line));

			if (
				row.runId !== runId ||
				row.seq !== records.length ||
				row.at < (records.at(-1)?.at ?? 0)
			)
				return null;
			records.push(row);
		}

		return records;
	} catch {
		return null;
	}
}

export function timelineFacts(records: readonly TimelineRecord[]) {
	const claim = records.find((r) => r.name === "claim" && r.kind === "point");

	const terminal = records.find(
		(r) => r.name === "terminal" && r.kind === "point",
	);

	if (claim === undefined || terminal === undefined) return null;

	const summary = {
		elapsedMs: terminal.at - claim.at,
		modelMs: 0,
		checkMs: 0,
		ciWaitMs: 0,
		ownerWaitMs: 0,
		controllerMs: 0,
	};

	let active: TimelineRecord | undefined;
	let covered = 0;

	for (const row of records) {
		if (row.kind === "start") active = row;

		if (row.kind !== "end" || active === undefined || active.key !== row.key)
			continue;

		const duration = Math.max(
			0,
			Math.min(terminal.at, row.at) - Math.max(claim.at, active.at),
		);

		switch (active.category) {
			case "model":
				summary.modelMs += duration;
				break;
			case "check":
				summary.checkMs += duration;
				break;
			case "ci_wait":
				summary.ciWaitMs += duration;
				break;
			case "owner_wait":
				summary.ownerWaitMs += duration;
				break;
			case "controller":
				summary.controllerMs += duration;
				break;
			default: {
				const exhaustive: never = active.category;

				return exhaustive;
			}
		}

		covered += duration;
		active = undefined;
	}

	summary.controllerMs += Math.max(0, summary.elapsedMs - covered);

	const rounds = (name: TimelineRecord["name"]) =>
		new Set(
			records.flatMap((r) =>
				r.name === name && r.kind === "point" ? [r.round] : [],
			),
		).size;

	return {
		summary,
		controllerRevision: claim.controllerRevision,
		repairRounds: {
			authorized: rounds("repair_authorized"),
			started: rounds("repair_started"),
			completed: rounds("repair_completed"),
		},
	};
}
