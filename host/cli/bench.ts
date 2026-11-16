import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { isDigest } from "../../src/core/run.ts";
import type { PlatformProfile } from "../../src/trust/platform.ts";
import { exportBundle, verifyBundle } from "../bench/export.ts";
import { type CliIo, EXIT } from "./platform.ts";

const USAGE = `Usage:
  bench export --state-dir <dir> --run <id> --out <dir> [--repository <checkout>]
  bench verify <bundle>`;

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
		},
	});
}

export async function runBenchCli(
	argv: readonly string[],
	io: CliIo,
	platform: PlatformProfile,
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
		values.repository !== "";

	const isVerify =
		command === "verify" &&
		positionals.length === 2 &&
		Boolean(bundle) &&
		Object.keys(values).length === 0;

	if (!isExport && !isVerify) {
		io.stderr(`${USAGE}\n`);

		return EXIT.usage;
	}

	try {
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
