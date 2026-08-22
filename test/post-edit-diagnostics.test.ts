import type { ExtensionContext, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";

import { type PostEditToolResultHandler, registerPostEditDiagnosticsHook } from "../src/index.js";
import { appendPostEditDiagnostics, syncPostEditDiagnosticsWidget } from "../src/lsp/post-edit-diagnostics.js";
import { lsp_diagnostics } from "../src/lsp/tools/diagnostics.js";

interface WidgetCall {
	key: string;
	content: string[] | undefined;
	placement: "aboveEditor" | "belowEditor" | undefined;
}

function writeEvent(path: string): ToolResultEvent {
	return {
		type: "tool_result",
		toolCallId: "call-1",
		toolName: "write",
		input: { path, content: "export const value: string = 123;" },
		content: [{ type: "text", text: "Wrote file successfully." }],
		isError: false,
		details: undefined,
	};
}

function editEvent(path: string): ToolResultEvent {
	return {
		type: "tool_result",
		toolCallId: "call-2",
		toolName: "edit",
		input: { path, edits: [{ oldText: "123", newText: "456" }] },
		content: [{ type: "text", text: "Edit applied successfully." }],
		isError: false,
		details: { diff: "--- a/file.ts\n+++ b/file.ts" },
	};
}

function applyPatchEvent(paths: string[]): ToolResultEvent {
	return {
		type: "tool_result",
		toolCallId: "call-3",
		toolName: "apply_patch",
		input: { paths },
		content: [{ type: "text", text: "Patch applied successfully." }],
		isError: false,
		details: undefined,
	};
}

function captureToolResultHandler(): PostEditToolResultHandler {
	let capturedHandler: PostEditToolResultHandler | undefined;
	const pi = {
		on(event: "tool_result", handler: PostEditToolResultHandler): void {
			if (event === "tool_result") capturedHandler = handler;
		},
	};

	registerPostEditDiagnosticsHook(pi);
	if (!capturedHandler) throw new Error("Expected extension to register a tool_result handler");
	return capturedHandler;
}

function extensionContextWithWidgetCalls(calls: WidgetCall[]): ExtensionContext {
	return {
		ui: {
			setWidget(key, content, options): void {
				if (typeof content === "function") throw new Error("Expected string widget content");
				calls.push({ key, content, placement: options?.placement });
			},
		},
	} as ExtensionContext;
}

describe("post-edit diagnostics", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("#given write tool result with diagnostics #when appending post-edit diagnostics #then adds LSP error block", async () => {
		// given
		const event = writeEvent("src/broken.ts");

		// when
		const result = await appendPostEditDiagnostics(event, async (filePath) => {
			expect(filePath).toBe("src/broken.ts");
			return "error[typescript] (2322) at 1:13: Type 'number' is not assignable to type 'string'.";
		});

		// then
		expect(result?.content).toEqual([
			{ type: "text", text: "Wrote file successfully." },
			{
				type: "text",
				text:
					"\n\nLSP errors detected in src/broken.ts, please fix:\n" +
					"error[typescript] (2322) at 1:13: Type 'number' is not assignable to type 'string'.",
			},
		]);
		expect(result?.widgetLines).toBeUndefined();
	});

	it("#given edit tool result with no diagnostics #when appending post-edit diagnostics #then requests widget clear", async () => {
		// given
		const event = editEvent("src/clean.ts");

		// when
		const result = await appendPostEditDiagnostics(event, async () => "No diagnostics found");

		// then
		expect(result).toEqual({ widgetLines: undefined });
	});

	it("#given compact diagnostics summary with zero errors #when appending #then treats it as clean", async () => {
		// given
		const event = editEvent("src/clean.ts");

		// when
		const result = await appendPostEditDiagnostics(
			event,
			async () => "1 file checked · 0 errors · 3 warnings suppressed",
		);

		// then
		expect(result).toEqual({ widgetLines: undefined });
	});

	it("#given post-edit diagnostics for unsupported extension #when appending #then treats it as clean", async () => {
		// given
		const event = editEvent("ccapi-cf-proxy/wrangler.toml");

		// when
		const result = await appendPostEditDiagnostics(
			event,
			async () => "No LSP server configured for extension: .toml\n\nAvailable servers: typescript, deno",
		);

		// then
		expect(result).toEqual({ widgetLines: undefined });
	});

	it("#given apply_patch result with multiple files #when appending post-edit diagnostics #then adds one block per file with diagnostics", async () => {
		// given
		const event = applyPatchEvent(["src/a.ts", "src/b.ts"]);

		// when
		const result = await appendPostEditDiagnostics(event, async (filePath) => {
			if (filePath === "src/a.ts") return "No diagnostics found";
			return "error[typescript] (2304) at 1:1: Cannot find name 'missing'.";
		});

		// then
		expect(result?.content).toEqual([
			{ type: "text", text: "Patch applied successfully." },
			{
				type: "text",
				text:
					"\n\nLSP errors detected in src/b.ts, please fix:\n" +
					"error[typescript] (2304) at 1:1: Cannot find name 'missing'.",
			},
		]);
		expect(result?.widgetLines).toBeUndefined();
	});

	it("#given senpi apply_patch input text #when extracting mutated files #then diagnoses updated file", async () => {
		// given
		const event = {
			...applyPatchEvent([]),
			input: {
				input: [
					"*** Begin Patch",
					"*** Update File: src/broken.ts",
					"@@",
					"-export const value: string = 'ok';",
					"+export const value: string = 123;",
					"*** End Patch",
				].join("\n"),
			},
		};

		// when
		const result = await appendPostEditDiagnostics(event, async (filePath) => {
			expect(filePath).toBe("src/broken.ts");
			return "error[typescript] (2322) at 1:13: Type 'number' is not assignable to type 'string'.";
		});

		// then
		expect(result?.content?.at(-1)).toEqual({
			type: "text",
			text:
				"\n\nLSP errors detected in src/broken.ts, please fix:\n" +
				"error[typescript] (2322) at 1:13: Type 'number' is not assignable to type 'string'.",
		});
	});

	it("#given failed mutation result #when appending post-edit diagnostics #then skips diagnostics", async () => {
		// given
		const event = { ...writeEvent("src/broken.ts"), isError: true };

		// when
		const result = await appendPostEditDiagnostics(event, async () => {
			throw new Error("should not run");
		});

		// then
		expect(result).toBeUndefined();
	});

	it("#given post-edit diagnostics result #when syncing widget #then clears stale widget instead of rendering below editor", async () => {
		// given
		const event = writeEvent("src/broken.ts");
		const result = await appendPostEditDiagnostics(event, async () => "error[typescript] at 1:1: broken");
		const calls: Array<{ key: string; content: string[] | undefined; placement: string | undefined }> = [];

		// when
		syncPostEditDiagnosticsWidget((key, content, options) => {
			calls.push({ key, content, placement: options?.placement });
		}, result);

		// then
		expect(calls).toEqual([{ key: "pi-lsp", content: undefined, placement: "belowEditor" }]);
	});

	it("#given clean post-edit diagnostics result #when syncing widget #then clears stale widget", async () => {
		// given
		const event = writeEvent("src/clean.ts");
		const result = await appendPostEditDiagnostics(event, async () => "No diagnostics found");
		const calls: Array<{ key: string; content: string[] | undefined; placement: string | undefined }> = [];

		// when
		syncPostEditDiagnosticsWidget((key, content, options) => {
			calls.push({ key, content, placement: options?.placement });
		}, result);

		// then
		expect(calls).toEqual([{ key: "pi-lsp", content: undefined, placement: "belowEditor" }]);
	});

	it("#given registered extension #when write returns LSP errors #then returns model-visible diagnostics without footer widget", async () => {
		// given
		const handler = captureToolResultHandler();
		const event = writeEvent("src/broken.ts");
		const widgetCalls: WidgetCall[] = [];
		const ctx = extensionContextWithWidgetCalls(widgetCalls);
		const diagnostics = vi.spyOn(lsp_diagnostics, "execute").mockResolvedValue({
			content: [{ type: "text", text: "error[typescript] (2322) at 1:13: broken" }],
			details: {
				filePath: "src/broken.ts",
				severity: "error",
				mode: "file",
				diagnostics: [],
				totalDiagnostics: 1,
				truncated: false,
			},
		});

		// when
		const result = await handler(event, ctx);

		// then
		expect(diagnostics).toHaveBeenCalledWith(
			"call-1:post-edit-diagnostics:src/broken.ts",
			{ paths: ["src/broken.ts"] },
			undefined,
			undefined,
			ctx,
		);
		expect(widgetCalls).toEqual([{ key: "pi-lsp", content: undefined, placement: "belowEditor" }]);
		expect(result).toEqual({
			content: [
				{ type: "text", text: "Wrote file successfully." },
				{
					type: "text",
					text:
						"\n\nLSP errors detected in src/broken.ts, please fix:\n" +
						"error[typescript] (2322) at 1:13: broken",
				},
			],
		});
	});
});
