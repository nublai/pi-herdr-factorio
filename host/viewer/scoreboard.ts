import type { ScoreboardReport } from "../../src/views/scoreboard.ts";
import { duration } from "./dashboard.ts";
import { escapeHtml as esc, page } from "./render.ts";

type Summary = ScoreboardReport["summary"];

const number = (value: number | null) =>
	value === null
		? "unknown"
		: value.toLocaleString("en", { maximumFractionDigits: 0 });

const dollars = (value: number | null) =>
	value === null
		? "unknown"
		: value > 0 && value < 10000
			? "<$0.01"
			: `$${(value / 1_000_000).toFixed(2)}`;

const rate = (value: Summary["landed"]) =>
	`${value.rate === null ? "unknown" : `${(value.rate * 100).toFixed(1)}%`} · ${value.count}/${value.total}${value.unknown > 0 ? ` · ${value.unknown} unknown` : ""}`;

function table(headers: string[], rows: string[][]): string {
	return `<div class="scroll scoreboard-table" role="region" aria-label="${esc(headers[0] ?? "Scoreboard")}" tabindex="0"><table><thead><tr>${headers.map((header) => `<th scope="col">${esc(header)}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((value) => `<td>${esc(value)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
}

function totals(summary: Summary): string[] {
	return [
		number(summary.runs),
		rate(summary.readyPr),
		rate(summary.landed),
		dollars(summary.estimate.usdMicros),
		dollars(summary.estimate.perRunUsdMicros),
		summary.landed.count === 0
			? "none"
			: dollars(summary.estimate.perLandedPrUsdMicros),
		`${number(summary.tokens.total)} · ${summary.tokens.kind}`,
		`${duration(summary.wallMs.total)} · ${summary.wallMs.kind} · ${summary.wallMs.source}`,
		summary.coverage.kind,
	];
}

export function renderScoreboard(
	report: ScoreboardReport,
	base: string,
	header: string,
): string {
	const summary = report.summary;

	const headers = [
		"Runs",
		"Ready PR",
		"Landed",
		"Estimate USD",
		"USD/run",
		"USD/landed PR",
		"Journal tokens",
		"Time",
		"Cost coverage",
	];

	const groups = (["revision", "ticket", "stage", "model", "failure"] as const)
		.map(
			(by) =>
				`<details${by === "revision" || by === "stage" ? " open" : ""}><summary>By ${by}</summary>${table(
					[by, ...headers],
					report.groups[by].map((group) => [
						group.key.replaceAll("_", " "),
						...totals(group),
					]),
				)}</details>`,
		)
		.join("");

	const timeline = table(
		["Time category", "Recorded time", "Runs known", "Runs missing"],
		Object.entries(summary.timeline).map(([key, value]) => [
			key,
			duration(value.total),
			number(value.known),
			number(value.missing),
		]),
	);

	const runs = table(
		["Ticket", "Outcome", "Revision", "Estimate USD", "Coverage"],
		report.runs.map((run) => [
			`#${run.issue} ${run.title ?? "Title unknown"}`,
			run.outcome.replaceAll("_", " "),
			run.revision,
			dollars(run.cost.estimate.usdMicros),
			run.cost.coverage.kind,
		]),
	);

	const gaps = table(
		["Ticket", "Source", "Evidence gap"],
		report.runs.flatMap((run) =>
			run.evidenceGaps.map((gap) => [`#${run.issue}`, gap.source, gap.reason]),
		),
	);

	return page(
		"Scoreboard",
		`<section class="scoreboard"><nav aria-label="Factory views"><a href="${base}/">All runs</a><a href="${base}/scoreboard.json">Scoreboard JSON</a></nav><h1 class="run-title">Scoreboard</h1><p>Terminal runs from local state. ${number(summary.runs)} runs · ${number(summary.outcomes.landed ?? 0)} landed · ${number(summary.outcomes.failed ?? 0)} failed · ${number(summary.outcomes.released ?? 0)} released.</p>${table(headers, [totals(summary)])}<p class="muted">All dollars are <code>api_equivalent_estimate</code>. Billed spend: <strong>unavailable</strong>. Includes failed and released runs.</p>${groups}<details><summary>Elapsed time categories</summary>${timeline}</details><details open><summary>Runs and issue titles</summary>${runs}</details><details><summary>Evidence gaps (${summary.coverage.evidenceGaps})</summary>${gaps}</details><details><summary>Coverage and method</summary><p>USD/landed PR divides all included estimates by the landed count, not just successful-run cost.</p><p>Ready PR uses recorded readiness or a factory-certified landing, never PR existence alone. Unknown readiness makes the rate unknown. Stage and model groups count participating runs; do not add their outcome counts. Model time cannot be attributed and stays unknown.</p><p>Stage time uses the v6 timeline where retained, otherwise summed stage receipt wall time. Mixed stage-time sources are labelled mixed, not exact. Revision and total elapsed categories require v6 facts. Partial token and time sums retain their coverage labels.</p><p>Cost coverage: ${esc(summary.coverage.kind)} · ${summary.coverage.priced}/${summary.coverage.requests} requests priced · ${summary.coverage.missingJournals} missing journals · ${summary.coverage.missingReceipts} missing receipts.</p><p>Run cost coverage: ${esc(JSON.stringify(summary.coverage.runs))}</p><p>Tariff digest <code>${esc(report.tariffDigest)}</code>. Cache usage is not reported. Uncertain charges are not priced. No billing source is available.</p></details></section>`,
		base,
		header,
	);
}
