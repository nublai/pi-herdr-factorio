import { join } from "node:path";
import {
	addEvidence,
	emptyEvidence,
	type CostEvidence,
} from "../../src/core/cost-evidence.ts";
import {
	fieldOf,
	objectOf,
	parseJson,
	textOf,
	type JsonObject,
} from "../../src/core/json.ts";
import { requestSettlements, settlementReply } from "../../src/core/journal.ts";
import { MODEL_STAGES, type ModelStage } from "../../src/core/stages.ts";
import type { CostRequest } from "../../src/core/tariff.ts";
import type { LedgerRow } from "../../src/ledger/schema.ts";
import { SPECIFY_SESSIONS } from "../sandbox/receipts.ts";

export type CostEvidenceReader = {
	text(path: string): Promise<string | null>;
	directories(path: string): Promise<string[]>;
};

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
	io: CostEvidenceReader,
	dir: string,
	runId: string,
	stage: ModelStage,
): Promise<CostEvidence> {
	const evidence = emptyEvidence();
	const rawReceipt = await io.text(join(dir, "receipt.json"));
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

	const children = (await io.directories(dir)).filter((name) =>
		leaves.includes(name),
	);

	if (children.length > 0) {
		for (const child of children)
			addEvidence(
				evidence,
				await executionEvidence(io, join(dir, child), runId, stage),
			);

		return evidence;
	}

	const journal = await io.text(join(dir, "egress.requests.jsonl"));

	if (journal !== null) {
		for (const line of journal.split("\n")) {
			if (line.trim() !== "" && objectOf(parseJson(line)) === null)
				evidence.invalidLines += 1;
		}

		evidence.requests = requestSettlements(journal).requests.map(
			(settlement) => ({
				settlement,
				model: modelOf(settlement, validReceipt ? receipt : null),
			}),
		);
	} else evidence.missingJournals += 1;

	return evidence;
}

export async function readRunCostEvidence(
	io: CostEvidenceReader,
	stateDir: string,
	row: LedgerRow,
) {
	const root = join(stateDir, "stages", row.runId);
	const attempts = await io.directories(root);
	const stages: (CostEvidence & { stage: ModelStage })[] = [];
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
				await executionEvidence(io, join(root, name), row.runId, stage),
			);
		addEvidence(all, evidence);
		stages.push({ stage, ...evidence });
	}

	return { all, stages };
}
