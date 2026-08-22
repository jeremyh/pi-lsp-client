import type { ToolResultEvent } from "@earendil-works/pi-coding-agent";

export type DiagnosticsRunner = (filePath: string) => Promise<string>;

const MUTATION_TOOL_NAMES = new Set(["write", "edit", "apply_patch"]);
const CLEAN_DIAGNOSTICS_TEXT = "No diagnostics found";
const UNSUPPORTED_EXTENSION_TEXT = "No LSP server configured for extension:";
const CLEAN_DIAGNOSTICS_SUMMARY = /^\d+ files? checked · 0 errors · \d+ warnings? suppressed$/u;
export const POST_EDIT_DIAGNOSTICS_WIDGET_KEY = "pi-lsp";

type WidgetPlacement = "aboveEditor" | "belowEditor";
type WidgetSetter = (key: string, content: string[] | undefined, options?: { placement?: WidgetPlacement }) => void;

export interface PostEditDiagnosticsResult {
	content?: ToolResultEvent["content"];
	widgetLines: string[] | undefined;
}

interface DiagnosticBlock {
	filePath: string;
	diagnostics: string;
}

export async function appendPostEditDiagnostics(
	event: ToolResultEvent,
	runDiagnostics: DiagnosticsRunner,
): Promise<PostEditDiagnosticsResult | undefined> {
	if (event.isError || !MUTATION_TOOL_NAMES.has(event.toolName)) return undefined;

	const filePaths = extractMutatedFilePaths(event);
	if (filePaths.length === 0) return undefined;

	const blocks: DiagnosticBlock[] = [];
	for (const filePath of filePaths) {
		const diagnostics = (await runDiagnostics(filePath)).trim();
		if (isCleanPostEditDiagnostics(diagnostics)) continue;
		blocks.push({ filePath, diagnostics });
	}

	if (blocks.length === 0) {
		return { widgetLines: undefined };
	}

	return {
		content: [
			...event.content,
			...blocks.map(({ filePath, diagnostics }) => ({
				type: "text" as const,
				text: `\n\nLSP errors detected in ${filePath}, please fix:\n${diagnostics}`,
			})),
		],
		widgetLines: undefined,
	};
}

function isCleanPostEditDiagnostics(diagnostics: string): boolean {
	return (
		diagnostics.length === 0 ||
		diagnostics === CLEAN_DIAGNOSTICS_TEXT ||
		CLEAN_DIAGNOSTICS_SUMMARY.test(diagnostics) ||
		diagnostics.startsWith(UNSUPPORTED_EXTENSION_TEXT)
	);
}

export function syncPostEditDiagnosticsWidget(
	setWidget: WidgetSetter,
	result: PostEditDiagnosticsResult | undefined,
): void {
	if (!result) return;
	setWidget(POST_EDIT_DIAGNOSTICS_WIDGET_KEY, result.widgetLines, { placement: "belowEditor" });
}

export function extractMutatedFilePaths(event: ToolResultEvent): string[] {
	const paths = new Set<string>();
	addStringValue(paths, event.input["path"]);
	addStringValue(paths, event.input["filePath"]);
	addStringArray(paths, event.input["paths"]);
	addStringArray(paths, event.input["filePaths"]);
	addPatchInput(paths, event.input["input"]);
	addPatchFiles(paths, event.input["files"]);
	addPatchFiles(paths, event.input["changes"]);
	return [...paths];
}

function addStringValue(paths: Set<string>, value: unknown): void {
	if (typeof value === "string" && value.length > 0) {
		paths.add(value);
	}
}

function addStringArray(paths: Set<string>, value: unknown): void {
	if (!Array.isArray(value)) return;
	for (const item of value) {
		addStringValue(paths, item);
	}
}

function addPatchInput(paths: Set<string>, value: unknown): void {
	if (typeof value !== "string") return;
	for (const line of value.split("\n")) {
		const path = extractPatchHeaderPath(line);
		if (path !== undefined) paths.add(path);
	}
}

function extractPatchHeaderPath(line: string): string | undefined {
	const prefixes = ["*** Add File: ", "*** Update File: ", "*** Move to: "] as const;
	for (const prefix of prefixes) {
		if (line.startsWith(prefix)) return line.slice(prefix.length).trim();
	}
	return undefined;
}

function addPatchFiles(paths: Set<string>, value: unknown): void {
	if (!Array.isArray(value)) return;
	for (const item of value) {
		if (!isRecord(item)) continue;
		addStringValue(paths, item["path"]);
		addStringValue(paths, item["filePath"]);
		addStringValue(paths, item["movePath"]);
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
