import { describe, expect, it } from "vitest";
import { loadCliproxyCodexStreams } from "../extensions/codex-stream.ts";

describe("patched Codex session cleanup", () => {
	it("exposes the patched module's session-scoped WebSocket cleanup", async () => {
		const streams = await loadCliproxyCodexStreams();

		expect(streams).toHaveProperty("closeWebSocketSessions", expect.any(Function));
		streams.closeWebSocketSessions("unused-test-session");
		streams.closeWebSocketSessions("unused-test-session");
	});
});
