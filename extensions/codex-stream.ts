/**
 * Load a patched openai-codex-responses implementation for CLIProxyAPI.
 *
 * Differences from stock pi-ai:
 * - extractAccountId never throws; plain API keys are allowed
 * - chatgpt-account-id header is omitted when account id is unavailable
 * - provider id(s) are added to CODEX_TOOL_CALL_PROVIDERS for tool-call id handling
 * - model/message api id uses cliproxyapi-codex-responses
 *
 * The patched module is derived at runtime from the installed
 * @earendil-works/pi-ai openai-codex-responses implementation so we track
 * upstream protocol fixes without vendoring 1200+ lines.
 *
 * That implementation is looked up in this order: the PI_CLIPROXYAPI_PI_AI_MODULE
 * override, the host's own copy resolved from its CLI entry, pi's extension-loader
 * resolution, and finally the pi-ai this package depends on. The last step is what
 * keeps compiled single-binary hosts working, where pi-ai exists only inside the
 * executable and no copy is readable from disk.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Api, AssistantMessageEventStream, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";

export const CLIPROXYAPI_CODEX_API = "cliproxyapi-codex-responses" as const;

export type CliproxyCodexStreamSimple = (
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
) => AssistantMessageEventStream;

export type CliproxyCodexStreams = {
	streamSimple: CliproxyCodexStreamSimple;
	stream: CliproxyCodexStreamSimple;
	api: typeof CLIPROXYAPI_CODEX_API;
};

export interface CliproxyCodexStreamOptions {
	shouldUseFast?: (model: Model<Api>) => boolean;
}

type PayloadHook = NonNullable<SimpleStreamOptions["onPayload"]>;

export function withPriorityServiceTier(payload: unknown): unknown {
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
		return payload;
	}
	return {
		...(payload as Record<string, unknown>),
		service_tier: "priority",
	};
}

/** Apply Fast before pi's shared payload hooks so later extensions retain final control. */
export async function applyFastPayloadHook(
	payload: unknown,
	model: Model<Api>,
	onPayload?: PayloadHook,
): Promise<unknown> {
	const fastPayload = withPriorityServiceTier(payload);
	const nextPayload = await onPayload?.(fastPayload, model);
	return nextPayload === undefined ? fastPayload : nextPayload;
}

export function wrapStreamSimpleForFast(
	streamSimple: CliproxyCodexStreamSimple,
	shouldUseFast?: (model: Model<Api>) => boolean,
): CliproxyCodexStreamSimple {
	return (model, context, streamOptions) => {
		if (!shouldUseFast?.(model)) {
			return streamSimple(model, context, streamOptions);
		}
		return streamSimple(model, context, {
			...streamOptions,
			onPayload: (payload, payloadModel) => applyFastPayloadHook(payload, payloadModel, streamOptions?.onPayload),
		});
	};
}

const EXTRACT_ACCOUNT_ID_PATCH = `function extractAccountId(token) {
    // CLIProxyAPI accepts plain API keys as well as ChatGPT JWTs.
    // Never throw: missing account id simply means no chatgpt-account-id header.
    try {
        const parts = token.split(".");
        if (parts.length !== 3)
            return "";
        const payload = JSON.parse(atob(parts[1]));
        const accountId = payload?.[JWT_CLAIM_PATH]?.chatgpt_account_id;
        return typeof accountId === "string" && accountId.trim() ? accountId : "";
    }
    catch {
        return "";
    }
}`;

function rewriteRelativeImports(source: string, originalDir: string): string {
	return source.replace(/from\s+"((?:\.\.?\/)[^"]+)"/g, (_full, relPath: string) => {
		const absolute = pathToFileURL(join(originalDir, relPath)).href;
		return `from ${JSON.stringify(absolute)}`;
	});
}

function patchWebSocketOnlyTransport(source: string): string {
	const sessionIdExpression = String.raw`(?:options\?\.sessionId|cacheSessionId)`;
	const disabledForSession = new RegExp(
		String.raw`const websocketDisabledForSession\s*=\s*transport !== "sse" && isWebSocketSseFallbackActive\(${sessionIdExpression}\);`,
	);
	const retryVariables = /let retriedWebSocketConnectionLimit\s*=\s*false;/;
	const connectionLimitRetry =
		/if \(!aborted && connectionLimitBeforeStart && !retriedWebSocketConnectionLimit\) \{\s*retriedWebSocketConnectionLimit = true;\s*continue;\s*\}/;
	const websocketFailureHandling = new RegExp(
		String.raw`if \(aborted \|\| \(isCodexNonTransportError\(error\) && !connectionLimitBeforeStart\)\) \{[\s\S]*?recordWebSocketFailure\((${sessionIdExpression}), error\);[\s\S]*?recordWebSocketSseFallback\(\1\);\s*break;`,
	);
	const fallbackSessionRecord = "websocketSseFallbackSessions.add(sessionId);";
	const fallbackActiveRecord = "stats.websocketFallbackActive = true;";

	for (const fragment of [fallbackSessionRecord, fallbackActiveRecord]) {
		if (!source.includes(fragment)) {
			throw new Error("openai-codex-responses source no longer supports the WebSocket-only transport patch");
		}
	}
	for (const pattern of [disabledForSession, retryVariables, connectionLimitRetry, websocketFailureHandling]) {
		if (!pattern.test(source)) {
			throw new Error("openai-codex-responses source no longer supports the WebSocket-only transport patch");
		}
	}

	return source
		.replace(disabledForSession, "const websocketDisabledForSession = false;")
		.replace(
			retryVariables,
			`let websocketRetries = 0;
                const maxWebSocketRetries = Number.isFinite(options?.maxRetries)
                    ? Math.min(Math.max(0, Math.floor(options.maxRetries)), 5)
                    : 3;`,
		)
		.replace(connectionLimitRetry, "")
		.replace(
			websocketFailureHandling,
			(
				_match,
				activeSessionId: string,
			) => `if (aborted || (isCodexNonTransportError(error) && !connectionLimitBeforeStart)) {
                            throw error;
                        }
                        if (!websocketStarted && websocketRetries < maxWebSocketRetries) {
                            websocketRetries++;
                            continue;
                        }
                        appendAssistantMessageDiagnostic(output, createAssistantMessageDiagnostic("provider_transport_failure", error, {
                            configuredTransport: transport,
                            fallbackTransport: undefined,
                            eventsEmitted: websocketStarted,
                            phase: websocketStarted ? "after_message_stream_start" : "before_message_stream_start",
                            requestBytes: new TextEncoder().encode(bodyJson).byteLength,
                        }));
                        recordWebSocketFailure(${activeSessionId}, error);
                        throw error;`,
		)
		.replace(fallbackSessionRecord, "")
		.replace(fallbackActiveRecord, "stats.websocketFallbackActive = false;");
}

export function patchCodexSource(source: string, providerIds: string[]): string {
	let src = source;

	if (!/function extractAccountId\(token\) \{/.test(src)) {
		throw new Error("openai-codex-responses source no longer contains extractAccountId(token)");
	}
	src = src.replace(/function extractAccountId\(token\) \{[\s\S]*?\n\}/, EXTRACT_ACCOUNT_ID_PATCH);

	if (!src.includes(`headers.set("chatgpt-account-id", accountId);`)) {
		throw new Error("openai-codex-responses source no longer sets chatgpt-account-id");
	}
	src = src.replace(
		`headers.set("chatgpt-account-id", accountId);`,
		`if (accountId) {\n        headers.set("chatgpt-account-id", accountId);\n    }`,
	);

	const providersMatch = src.match(/const CODEX_TOOL_CALL_PROVIDERS = new Set\(\[([^\]]*)\]\);/);
	if (!providersMatch) {
		throw new Error("openai-codex-responses source no longer defines CODEX_TOOL_CALL_PROVIDERS");
	}
	const existing = providersMatch[1];
	const extras = providerIds
		.filter((id) => id.trim())
		.map((id) => JSON.stringify(id.trim()))
		.join(", ");
	src = src.replace(
		/const CODEX_TOOL_CALL_PROVIDERS = new Set\(\[([^\]]*)\]\);/,
		`const CODEX_TOOL_CALL_PROVIDERS = new Set([${existing}${extras ? `, ${extras}` : ""}]);`,
	);

	// Keep assistant message api metadata aligned with the registered custom api id.
	src = src.replaceAll(`api: "openai-codex-responses"`, `api: ${JSON.stringify(CLIPROXYAPI_CODEX_API)}`);

	// CLIProxyAPI needs a persistent WebSocket transport. Reconnect before the
	// response starts and surface a failure rather than silently switching to SSE.
	src = patchWebSocketOnlyTransport(src);

	// The generated module lives outside the original source map directory.
	src = src.replace(/^\/\/# sourceMappingURL=.*$/gm, "");

	return src;
}

const CODEX_MODULE_SUBPATH = join("dist", "api", "openai-codex-responses.js");

/**
 * Absolute path to a pi-ai `openai-codex-responses.js`, or to a pi-ai package
 * root. The escape hatch for hosts whose layout we cannot introspect.
 */
export const PI_AI_MODULE_ENV = "PI_CLIPROXYAPI_PI_AI_MODULE";

export function resolveCodexModuleFromOverride(value: string | undefined): string | undefined {
	const raw = value?.trim();
	if (!raw) {
		return undefined;
	}
	const candidates = raw.endsWith(".js")
		? [raw]
		: [join(raw, CODEX_MODULE_SUBPATH), join(raw, "api", "openai-codex-responses.js")];
	return candidates.find((candidate) => existsSync(candidate));
}

export function resolveCodexModuleFromNodeEntry(entryPath: string): string | undefined {
	try {
		const require = createRequire(pathToFileURL(realpathSync(entryPath)));
		for (const nodeModulesDir of require.resolve.paths("@earendil-works/pi-ai") ?? []) {
			const candidate = join(nodeModulesDir, "@earendil-works", "pi-ai", CODEX_MODULE_SUBPATH);
			if (existsSync(candidate)) {
				return candidate;
			}
		}
	} catch {
		// Ignore invalid or unavailable runtime entrypoints.
	}
	return undefined;
}

/**
 * Compiled single-binary hosts (`bun build --compile`) embed pi-ai in the
 * executable: `process.argv[1]` is a virtual path such as `B:/~BUN/root/pi.exe`,
 * every `require.resolve.paths` entry lives under that virtual root, and the
 * `/api/*` subpath does not resolve at all. Nothing readable exists on disk, so
 * the package depends on pi-ai itself and patches the copy installed alongside
 * this extension. Tried last, so a host-owned copy always wins.
 */
export function resolveVendoredCodexModule(): string | undefined {
	return resolveCodexModuleFromNodeEntry(fileURLToPath(import.meta.url));
}

function resolveOriginalCodexModulePath(): { path: string; dir: string } {
	const candidates: string[] = [];

	const override = resolveCodexModuleFromOverride(process.env[PI_AI_MODULE_ENV]);
	if (override) {
		candidates.push(override);
	}

	// pi's bundled Node CLI exposes pi-ai as a virtual module to extensions.
	// Resolve its physical nested dependency from the CLI entry so the
	// source-patching transport reads the implementation the host actually runs.
	if (process.argv[1]) {
		const bundledHostModule = resolveCodexModuleFromNodeEntry(process.argv[1]);
		if (bundledHostModule) {
			candidates.push(bundledHostModule);
		}
	}

	// Under pi's extension loader, `@earendil-works/pi-ai` may resolve to dist/compat.js
	// and package subpath resolve for `/api/*` can fail. Prefer locating the physical
	// dist file next to the resolved package entry.
	try {
		const subpath = import.meta.resolve("@earendil-works/pi-ai/api/openai-codex-responses");
		candidates.push(fileURLToPath(subpath));
	} catch {
		// ignore and try filesystem candidates
	}

	try {
		const main = fileURLToPath(import.meta.resolve("@earendil-works/pi-ai"));
		const distDir = dirname(main);
		candidates.push(join(distDir, "api/openai-codex-responses.js"));
		candidates.push(join(distDir, "openai-codex-responses.js"));
	} catch {
		// ignore
	}

	const vendored = resolveVendoredCodexModule();
	if (vendored) {
		candidates.push(vendored);
	}

	for (const path of candidates) {
		if (path && existsSync(path)) {
			return { path, dir: dirname(path) };
		}
	}

	throw new Error(`Cannot resolve openai-codex-responses.js (tried: ${candidates.join(", ") || "none"})`);
}

export async function loadCliproxyCodexStreams(
	providerIds: string[] = ["cliproxyapi"],
	options: CliproxyCodexStreamOptions = {},
): Promise<CliproxyCodexStreams> {
	const { path: originalPath, dir: originalDir } = resolveOriginalCodexModulePath();
	const originalSource = readFileSync(originalPath, "utf8");
	const patched = rewriteRelativeImports(patchCodexSource(originalSource, providerIds), originalDir);

	const hash = createHash("sha1").update(patched).digest("hex").slice(0, 16);
	const cacheDir = join(tmpdir(), "pi-cliproxyapi-provider");
	mkdirSync(cacheDir, { recursive: true });
	const outPath = join(cacheDir, `openai-codex-responses-cpa-${hash}.mjs`);
	if (!existsSync(outPath)) {
		writeFileSync(outPath, patched, "utf8");
	}

	const mod = (await import(pathToFileURL(outPath).href)) as {
		streamSimple: CliproxyCodexStreamSimple;
		stream: CliproxyCodexStreamSimple;
	};

	if (typeof mod.streamSimple !== "function" || typeof mod.stream !== "function") {
		throw new Error("patched openai-codex-responses module missing streamSimple/stream exports");
	}

	const streamSimple = wrapStreamSimpleForFast(mod.streamSimple, options.shouldUseFast);

	return {
		api: CLIPROXYAPI_CODEX_API,
		streamSimple,
		stream: mod.stream,
	};
}
