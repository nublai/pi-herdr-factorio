import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { isDigest } from "../../src/core/run.ts";
import type { PlatformProfile } from "../../src/trust/platform.ts";
import { exportBundle, verifyBundle } from "../bench/export.ts";
import type { BenchRuntime } from "../bench/run.ts";
import { type CliIo, EXIT } from "./platform.ts";

const USAGE = `Usage:
  bench export --state-dir <dir> --run <id> --out <dir> [--repository <checkout>]
  bench verify <bundle>
  bench run --bundle <dir> --variant <file> --state-dir <scratch> --token-cap <n> [--assets-dir <dir>]`;

function parseBenchArgs(argv: readonly string[]) {
	return parseArgs({
		args: [...argv],
		allowPositionals: true,
		strict: true,
		options: {
			"state-dir": { type: "string" },
			run: { type: "string" },
			out: { type: "string" },
			repository: { type: "string" },
			bundle: { type: "string" },
			variant: { type: "string" },
			"token-cap": { type: "string" },
			"assets-dir": { type: "string" },
		},
	});
}

export async function runBenchCli(
	argv: readonly string[],
	io: CliIo,
	platform: PlatformProfile,
	runtime?: BenchRuntime,
): Promise<number> {
	let args: ReturnType<typeof parseBenchArgs>;

	try {
		args = parseBenchArgs(argv);
	} catch {
		io.stderr(`${USAGE}\n`);

		return EXIT.usage;
	}

	const { values, positionals } = args;
	const [command, bundle] = positionals;
	const runId = values.run ?? "";

	const isExport =
		command === "export" &&
		positionals.length === 1 &&
		isDigest(runId) &&
		Boolean(values["state-dir"]) &&
		Boolean(values.out) &&
		values.repository !== "" &&
		Object.keys(values).every((key) =>
			["state-dir", "run", "out", "repository"].includes(key),
		);

	const isVerify =
		command === "verify" &&
		positionals.length === 2 &&
		Boolean(bundle) &&
		Object.keys(values).length === 0;

	const cap = Number(values["token-cap"]);

	const isRun =
		command === "run" &&
		positionals.length === 1 &&
		Boolean(values.bundle) &&
		Boolean(values.variant) &&
		Boolean(values["state-dir"]) &&
		/^[1-9][0-9]*$/.test(values["token-cap"] ?? "") &&
		Number.isSafeInteger(cap) &&
		Object.keys(values).every((key) =>
			["bundle", "variant", "state-dir", "token-cap", "assets-dir"].includes(
				key,
			),
		);

	if (!isExport && !isVerify && !isRun) {
		io.stderr(`${USAGE}\n`);

		return EXIT.usage;
	}

	try {
		if (
			isRun &&
			values.bundle !== undefined &&
			values.variant !== undefined &&
			values["state-dir"] !== undefined
		) {
			const { runBench } = await import("../bench/run.ts");
			io.stdout(
				await runBench(
					{
						bundle: values.bundle,
						variantFile: values.variant,
						stateDir: values["state-dir"],
						tokenCap: cap,
						platform,
						env: io.env,
					},
					runtime ?? { exec: io.exec, assetsDir: values["assets-dir"] },
				),
			);

			return EXIT.ok;
		}

		const result =
			command === "verify" && bundle !== undefined
				? verifyBundle(bundle)
				: isDigest(runId) &&
						values["state-dir"] !== undefined &&
						values.out !== undefined
					? await exportBundle({
							stateDir: values["state-dir"],
							runId,
							out: values.out,
							repository: resolve(values.repository ?? "."),
							platform,
							env: io.env,
						})
					: null;

		if (result === null) throw new Error("invalid_export_arguments");
		io.stdout(`ok ${result.manifestDigest}\n`);

		return EXIT.ok;
	} catch (error) {
		io.stderr(
			`bench: ${error instanceof Error ? error.message : "operation_failed"}\n`,
		);

		return EXIT.invalid;
	}
}
