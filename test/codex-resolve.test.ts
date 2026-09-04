import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	resolveCodexModuleFromNodeEntry,
	resolveCodexModuleFromOverride,
	resolveVendoredCodexModule,
} from "../extensions/codex-stream.ts";

const scratch: string[] = [];

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "cpa-resolve-"));
	scratch.push(dir);
	return dir;
}

function writeModule(path: string): string {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, "export const stream = () => {};\n", "utf8");
	return path;
}

afterEach(() => {
	for (const dir of scratch.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("resolveCodexModuleFromOverride", () => {
	it("ignores empty and whitespace-only values", () => {
		expect(resolveCodexModuleFromOverride(undefined)).toBeUndefined();
		expect(resolveCodexModuleFromOverride("")).toBeUndefined();
		expect(resolveCodexModuleFromOverride("   ")).toBeUndefined();
	});

	it("accepts a direct path to the module file", () => {
		const file = writeModule(join(tempDir(), "openai-codex-responses.js"));
		expect(resolveCodexModuleFromOverride(` ${file} `)).toBe(file);
	});

	it("accepts a pi-ai package root and finds the dist module", () => {
		const root = tempDir();
		const file = writeModule(join(root, "dist", "api", "openai-codex-responses.js"));
		expect(resolveCodexModuleFromOverride(root)).toBe(file);
	});

	it("accepts a dist directory containing the api module", () => {
		const dist = join(tempDir(), "dist");
		const file = writeModule(join(dist, "api", "openai-codex-responses.js"));
		expect(resolveCodexModuleFromOverride(dist)).toBe(file);
	});

	it("returns undefined when the override points nowhere", () => {
		expect(resolveCodexModuleFromOverride(join(tempDir(), "absent"))).toBeUndefined();
	});
});

describe("resolveCodexModuleFromNodeEntry", () => {
	it("finds the module in a node_modules tree above the entry", () => {
		const root = tempDir();
		const file = writeModule(
			join(root, "node_modules", "@earendil-works", "pi-ai", "dist", "api", "openai-codex-responses.js"),
		);
		const entry = writeModule(join(root, "node_modules", "host", "cli.js"));
		expect(resolveCodexModuleFromNodeEntry(entry)).toBe(file);
	});

	it("returns undefined for a compiled-binary virtual entry", () => {
		// bun --compile reports process.argv[1] as e.g. B:/~BUN/root/pi.exe, and every
		// require.resolve.paths entry lives under that virtual root. This is the case
		// that used to leave the loader with no candidates at all.
		expect(resolveCodexModuleFromNodeEntry("B:/~BUN/root/pi.exe")).toBeUndefined();
	});

	it("returns undefined for an entry that does not exist", () => {
		expect(resolveCodexModuleFromNodeEntry(join(tempDir(), "missing", "cli.js"))).toBeUndefined();
	});
});

describe("resolveVendoredCodexModule", () => {
	it("resolves the pi-ai this package depends on", () => {
		const vendored = resolveVendoredCodexModule();
		expect(vendored).toBeDefined();
		expect(vendored?.replaceAll("\\", "/")).toContain(
			"node_modules/@earendil-works/pi-ai/dist/api/openai-codex-responses.js",
		);
	});
});
