import {
	closeSync,
	existsSync,
	fsyncSync,
	openSync,
	readFileSync,
	writeSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { privateDir } from "../../src/contract/artifacts.ts";
import { isGitSha } from "../../src/config/schema.ts";
import { type Digest } from "../../src/core/run.ts";
import {
	parseTimeline,
	timelineRecord,
	type RunTimeline,
	type TimelineInput,
	type TimelineRecord,
} from "../../src/controller/timeline.ts";

export function readRunTimeline(
	stateDir: string,
	runId: Digest,
): TimelineRecord[] | null {
	try {
		return parseTimeline(
			readFileSync(
				join(resolve(stateDir), "timeline", `${runId}.jsonl`),
				"utf8",
			),
			runId,
		);
	} catch {
		return null;
	}
}

export function fileRunTimeline(stateDir: string): RunTimeline {
	const root = resolve(stateDir);
	const dir = join(root, "timeline");

	function write(
		runId: Digest,
		{ repo: controllerRepo, ...input }: Parameters<RunTimeline["point"]>[1],
		point: boolean,
	): boolean {
		try {
			privateDir(dir);
			const path = join(dir, `${runId}.jsonl`);
			const records = existsSync(path) ? readRunTimeline(root, runId) : [];

			if (records === null) return false;

			if (records.some((r) => r.name === "terminal")) return true;

			if (
				point &&
				records.some((r) => r.kind === "point" && r.key === input.key)
			)
				return true;
			const active = records.findLast((r) => r.kind !== "point");

			if (!point && active?.kind === "start" && active.key === input.key)
				return true;
			let revision = records[0]?.controllerRevision ?? null;

			if (records.length === 0) {
				const installed = existsSync(join(root, "install-exe-dev.commit"))
					? readFileSync(join(root, "install-exe-dev.commit"), "utf8").trim()
					: "";

				const [sha = "", repo] = installed.split(/\s+/);

				if (isGitSha(sha) && (repo === undefined || repo === controllerRepo))
					revision = sha;
			}

			const at = Math.max(input.at, records.at(-1)?.at ?? 0);
			const additions: TimelineRecord[] = [];

			const add = (fields: TimelineInput) =>
				additions.push(
					timelineRecord({
						...fields,
						v: 1,
						runId,
						seq: records.length + additions.length,
						controllerRevision: revision,
					}),
				);

			if ((!point || input.name === "terminal") && active?.kind === "start")
				add({ ...active, kind: "end", at });
			add({ ...input, at, kind: point ? "point" : "start" });
			const fd = openSync(path, "a", 0o600);

			try {
				writeSync(fd, additions.map((r) => `${JSON.stringify(r)}\n`).join(""));
				fsyncSync(fd);
			} finally {
				closeSync(fd);
			}

			return true;
		} catch {
			return false;
		}
	}

	return {
		async transition(runId, input) {
			return write(runId, input, false);
		},
		async point(runId, input) {
			return write(runId, input, true);
		},
	};
}
