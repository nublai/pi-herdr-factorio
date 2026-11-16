import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { PI_CLI } from "../../../host/bundle/assets/pi.ts";

it("strips NODE_OPTIONS in the wrapper entry point's actual spawn", () => {
	const dir = mkdtempSync(join(tmpdir(), "factory-pi-spawn-env-"));
	const planted = join(dir, "planted.cjs");
	const loaded = join(dir, "loaded");
	const executed = join(dir, "executed");
	const fakePi = join(dir, "fake-pi.cjs");
	const wrapper = join(dir, "pi.mts");

	try {
		writeFileSync(
			planted,
			`require("node:fs").appendFileSync(${JSON.stringify(loaded)}, process.pid + "\\n");
`,
		);
		writeFileSync(
			fakePi,
			`require("node:fs").writeFileSync(${JSON.stringify(executed)}, String(process.pid));
`,
		);

		// Redirect only the executable path; retain main() and its real spawn.
		const source = readFileSync(
			new URL("../../../host/bundle/assets/pi.ts", import.meta.url),
			"utf8",
		);

		assert.ok(source.includes(JSON.stringify(PI_CLI)));
		writeFileSync(
			wrapper,
			source.replace(JSON.stringify(PI_CLI), JSON.stringify(fakePi)),
		);

		const env = {
			...process.env,
			FACTORY_PI_TOOLS: "read",
			NODE_OPTIONS: `--require ${planted}`,
		};

		const control = spawnSync(process.execPath, ["-e", ""], {
			env,
			timeout: 10_000,
		});

		assert.equal(control.status, 0, control.stderr.toString());
		assert.equal(readFileSync(loaded, "utf8"), `${control.pid}\n`);
		rmSync(loaded);

		const result = spawnSync(
			process.execPath,
			["--experimental-strip-types", wrapper],
			{ env, timeout: 10_000 },
		);

		assert.equal(result.status, 0, result.stderr.toString());
		const childPid = readFileSync(executed, "utf8");
		const loaderPids = readFileSync(loaded, "utf8").trim().split("\n");

		assert.notEqual(childPid, String(result.pid), "the fake Pi child ran");
		assert.ok(loaderPids.includes(String(result.pid)), "wrapper loaded it");
		assert.ok(!loaderPids.includes(childPid), "Pi child must not load it");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
