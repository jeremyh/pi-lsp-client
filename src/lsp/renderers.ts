import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";

import { uriToDisplayPath } from "./formatters.js";
import { SYMBOL_KIND_MAP } from "./language-mappings.js";
import type { LspDiagnosticsDetails } from "./tools/diagnostics.js";
import type { LspFindReferencesDetails } from "./tools/find-references.js";
import type { LspGotoDefinitionDetails } from "./tools/goto-definition.js";
import type { LspPrepareRenameDetails, LspRenameDetails } from "./tools/rename.js";
import type { LspSymbolsDetails } from "./tools/symbols.js";
import type { Diagnostic, DocumentSymbol, Location, LocationLink, SymbolInfo } from "./types.js";
import { shorten } from "./utils.js";

const COLLAPSED_HEAD = 3;
const EXPANDED_HEAD = 20;
const PATH_BUDGET = 80;

interface ResultLike<TDetails> {
	content: ReadonlyArray<{ type: string; text?: string }>;
	details?: TDetails;
}

interface RenderResultOptions {
	expanded?: boolean;
	isPartial?: boolean;
}

interface PositionArgs {
	filePath: string;
	line: number;
	character: number;
}

interface SymbolsArgs {
	filePath: string;
	scope: "document" | "workspace";
	query?: string;
}

interface RenameArgs extends PositionArgs {
	newName: string;
}

interface DiagnosticsArgs {
	filePath: string;
	severity?: string;
}

function locText(loc: Location | LocationLink): string {
	if ("targetUri" in loc) {
		return `${shorten(uriToDisplayPath(loc.targetUri), PATH_BUDGET)}:${loc.targetRange.start.line + 1}:${loc.targetRange.start.character}`;
	}
	return `${shorten(uriToDisplayPath(loc.uri), PATH_BUDGET)}:${loc.range.start.line + 1}:${loc.range.start.character}`;
}

function diagSeverityKey(severity?: number): "error" | "warning" | "muted" | "dim" {
	switch (severity) {
		case 1:
			return "error";
		case 2:
			return "warning";
		case 3:
			return "muted";
		case 4:
			return "dim";
		default:
			return "muted";
	}
}

function diagSeverityChar(severity?: number): string {
	switch (severity) {
		case 1:
			return "E";
		case 2:
			return "W";
		case 3:
			return "I";
		case 4:
			return "H";
		default:
			return "?";
	}
}

function unique<T>(items: T[], key: (item: T) => string): T[] {
	const seen = new Set<string>();
	const out: T[] = [];
	for (const item of items) {
		const k = key(item);
		if (seen.has(k)) continue;
		seen.add(k);
		out.push(item);
	}
	return out;
}

function symbolKindName(kind: number): string {
	return SYMBOL_KIND_MAP[kind] ?? `Kind(${kind})`;
}

export function renderDiagnosticsCall(args: DiagnosticsArgs, theme: Theme): Text {
	const head = theme.fg("toolTitle", theme.bold("lsp_diagnostics "));
	const file = theme.fg("accent", shorten(args.filePath, PATH_BUDGET));
	const sev = args.severity ? theme.fg("muted", ` [${args.severity}]`) : "";
	return new Text(head + file + sev, 0, 0);
}

export function renderDiagnosticsResult(
	result: ResultLike<LspDiagnosticsDetails>,
	options: RenderResultOptions,
	theme: Theme,
): Text {
	if (options.isPartial) return new Text(theme.fg("warning", "Checking..."), 0, 0);

	const details = result.details;
	if (!details) return new Text(theme.fg("muted", result.content[0]?.text ?? ""), 0, 0);

	if (details.error) {
		const lines: string[] = [
			theme.fg(
				details.errorKind === "missing_dependency" ? "warning" : "error",
				details.error.split("\n")[0] ?? "error",
			),
			...details.error
				.split("\n")
				.slice(1)
				.map((l) => theme.fg("dim", `  ${l}`)),
		];
		return new Text(lines.join("\n"), 0, 0);
	}

	const total = details.totalDiagnostics;
	if (total === 0) {
		return new Text(theme.fg("success", "No diagnostics"), 0, 0);
	}

	const counts = { error: 0, warning: 0, info: 0, hint: 0 };
	for (const d of details.diagnostics) {
		switch (d.diagnostic.severity) {
			case 1:
				counts.error++;
				break;
			case 2:
				counts.warning++;
				break;
			case 3:
				counts.info++;
				break;
			case 4:
				counts.hint++;
				break;
		}
	}
	const badges: string[] = [];
	if (counts.error > 0) badges.push(theme.fg("error", `E:${counts.error}`));
	if (counts.warning > 0) badges.push(theme.fg("warning", `W:${counts.warning}`));
	if (counts.info > 0) badges.push(theme.fg("muted", `I:${counts.info}`));
	if (counts.hint > 0) badges.push(theme.fg("dim", `H:${counts.hint}`));

	const uniqueDiagnosticFiles = unique(details.diagnostics, (d) => d.file);
	const fileCount = uniqueDiagnosticFiles.length;
	const summary =
		badges.join(" ") +
		theme.fg("muted", ` • ${fileCount} file${fileCount === 1 ? "" : "s"}`) +
		(details.truncated ? theme.fg("warning", " (truncated)") : "");

	if (!options.expanded) {
		const files = uniqueDiagnosticFiles.slice(0, COLLAPSED_HEAD);
		const lines: string[] = [summary];
		for (const f of files) {
			lines.push(theme.fg("muted", `  ${shorten(f.file, PATH_BUDGET)}`));
		}
		if (uniqueDiagnosticFiles.length > COLLAPSED_HEAD) {
			lines.push(theme.fg("dim", `  … ${uniqueDiagnosticFiles.length - COLLAPSED_HEAD} more files`));
		}
		return new Text(lines.join("\n"), 0, 0);
	}

	const grouped = new Map<string, Diagnostic[]>();
	for (const { file, diagnostic } of details.diagnostics) {
		const arr = grouped.get(file) ?? [];
		arr.push(diagnostic);
		grouped.set(file, arr);
	}

	const lines: string[] = [summary, ""];
	let renderedRows = 0;
	for (const [file, diagnostics] of grouped) {
		if (renderedRows >= EXPANDED_HEAD) break;
		lines.push(theme.fg("accent", shorten(file, PATH_BUDGET)));
		for (const d of diagnostics) {
			if (renderedRows >= EXPANDED_HEAD) break;
			const sevKey = diagSeverityKey(d.severity);
			const sev = theme.fg(sevKey, diagSeverityChar(d.severity));
			const at = theme.fg("muted", `${d.range.start.line + 1}:${d.range.start.character}`);
			const msg = theme.fg("toolOutput", truncateToWidth(d.message, 160));
			lines.push(`  ${sev} ${at}  ${msg}`);
			renderedRows++;
		}
	}
	if (total > EXPANDED_HEAD) {
		lines.push(theme.fg("dim", `… ${total - EXPANDED_HEAD} more diagnostics not shown`));
	}
	return new Text(lines.join("\n"), 0, 0);
}

export function renderGotoDefinitionCall(args: PositionArgs, theme: Theme): Text {
	const head = theme.fg("toolTitle", theme.bold("lsp_goto_definition "));
	const loc = theme.fg("accent", `${shorten(args.filePath, PATH_BUDGET)}:${args.line}:${args.character}`);
	return new Text(head + loc, 0, 0);
}

export function renderGotoDefinitionResult(
	result: ResultLike<LspGotoDefinitionDetails>,
	_options: RenderResultOptions,
	theme: Theme,
): Text {
	const details = result.details;
	if (details?.error) {
		return new Text(theme.fg("warning", details.error.split("\n")[0] ?? "error"), 0, 0);
	}
	if (!details || details.locations.length === 0) {
		return new Text(theme.fg("dim", "No definition found"), 0, 0);
	}
	const [head] = details.locations;
	if (!head) {
		return new Text(theme.fg("dim", "No definition found"), 0, 0);
	}
	const more = details.locations.length - 1;
	const headStr = theme.fg("success", "→ ") + theme.fg("accent", locText(head));
	const tail = more > 0 ? theme.fg("dim", ` (+${more} more)`) : "";
	return new Text(headStr + tail, 0, 0);
}

export function renderFindReferencesCall(args: PositionArgs & { includeDeclaration?: boolean }, theme: Theme): Text {
	const head = theme.fg("toolTitle", theme.bold("lsp_find_references "));
	const loc = theme.fg("accent", `${shorten(args.filePath, PATH_BUDGET)}:${args.line}:${args.character}`);
	return new Text(head + loc, 0, 0);
}

export function renderFindReferencesResult(
	result: ResultLike<LspFindReferencesDetails>,
	options: RenderResultOptions,
	theme: Theme,
): Text {
	const details = result.details;
	if (details?.error) {
		return new Text(theme.fg("warning", details.error.split("\n")[0] ?? "error"), 0, 0);
	}
	if (!details || details.totalReferences === 0) {
		return new Text(theme.fg("dim", "No references"), 0, 0);
	}
	const total = details.totalReferences;
	const fileCount = unique(details.references, (r) => r.uri).length;
	const summary =
		theme.fg("success", `${total} reference${total === 1 ? "" : "s"}`) +
		theme.fg("muted", ` • ${fileCount} file${fileCount === 1 ? "" : "s"}`) +
		(details.truncated ? theme.fg("warning", " (truncated)") : "");

	if (!options.expanded) {
		const head = unique(details.references, (r) => r.uri).slice(0, COLLAPSED_HEAD);
		const lines: string[] = [summary];
		for (const ref of head) {
			lines.push(theme.fg("muted", `  ${shorten(uriToDisplayPath(ref.uri), PATH_BUDGET)}`));
		}
		if (fileCount > COLLAPSED_HEAD) {
			lines.push(theme.fg("dim", `  … ${fileCount - COLLAPSED_HEAD} more files`));
		}
		return new Text(lines.join("\n"), 0, 0);
	}

	const display = details.references.slice(0, EXPANDED_HEAD);
	const lines: string[] = [summary, ""];
	for (const ref of display) {
		lines.push(theme.fg("accent", locText(ref)));
	}
	if (total > EXPANDED_HEAD) {
		lines.push(theme.fg("dim", `… ${total - EXPANDED_HEAD} more references`));
	}
	return new Text(lines.join("\n"), 0, 0);
}

export function renderSymbolsCall(args: SymbolsArgs, theme: Theme): Text {
	const head = theme.fg("toolTitle", theme.bold("lsp_symbols "));
	const scope = theme.fg("muted", `[${args.scope}]`);
	if (args.scope === "workspace") {
		const q = theme.fg("accent", ` "${shorten(args.query ?? "", 40)}"`);
		return new Text(head + scope + q, 0, 0);
	}
	const file = theme.fg("accent", ` ${shorten(args.filePath, PATH_BUDGET)}`);
	return new Text(head + scope + file, 0, 0);
}

function renderDocumentSymbol(s: DocumentSymbol, indent: number, theme: Theme): string {
	const prefix = "  ".repeat(indent);
	const kind = theme.fg("muted", `(${symbolKindName(s.kind)})`);
	const name = theme.fg("accent", s.name);
	const at = theme.fg("dim", `L${s.range.start.line + 1}`);
	const lines: string[] = [`${prefix}${name} ${kind} ${at}`];
	if (s.children) {
		for (const child of s.children) {
			lines.push(renderDocumentSymbol(child, indent + 1, theme));
		}
	}
	return lines.join("\n");
}

export function renderSymbolsResult(
	result: ResultLike<LspSymbolsDetails>,
	options: RenderResultOptions,
	theme: Theme,
): Text {
	const details = result.details;
	if (details?.error) {
		return new Text(theme.fg("warning", details.error.split("\n")[0] ?? "error"), 0, 0);
	}
	if (!details || details.totalSymbols === 0) {
		return new Text(theme.fg("dim", "No symbols"), 0, 0);
	}

	const total = details.totalSymbols;
	const summary =
		theme.fg("success", `${total} symbol${total === 1 ? "" : "s"}`) +
		theme.fg("muted", ` • ${details.scope}`) +
		(details.truncated ? theme.fg("warning", " (truncated)") : "");

	if (!options.expanded) {
		const head = details.symbols.slice(0, COLLAPSED_HEAD);
		const lines: string[] = [summary];
		for (const s of head) {
			lines.push(theme.fg("muted", `  ${s.name}`));
		}
		if (total > COLLAPSED_HEAD) {
			lines.push(theme.fg("dim", `  … ${total - COLLAPSED_HEAD} more`));
		}
		return new Text(lines.join("\n"), 0, 0);
	}

	const lines: string[] = [summary, ""];
	let rendered = 0;
	for (const s of details.symbols) {
		if (rendered >= EXPANDED_HEAD) break;
		if ("range" in s) {
			lines.push(renderDocumentSymbol(s as DocumentSymbol, 0, theme));
		} else {
			const sym = s as SymbolInfo;
			const kind = theme.fg("muted", `(${symbolKindName(sym.kind)})`);
			const name = theme.fg("accent", sym.name);
			const loc = theme.fg("dim", locText(sym.location));
			lines.push(`${name} ${kind}  ${loc}`);
		}
		rendered++;
	}
	if (total > rendered) {
		lines.push(theme.fg("dim", `… ${total - rendered} more`));
	}
	return new Text(lines.join("\n"), 0, 0);
}

export function renderPrepareRenameCall(args: PositionArgs, theme: Theme): Text {
	const head = theme.fg("toolTitle", theme.bold("lsp_prepare_rename "));
	const loc = theme.fg("accent", `${shorten(args.filePath, PATH_BUDGET)}:${args.line}:${args.character}`);
	return new Text(head + loc, 0, 0);
}

export function renderPrepareRenameResult(
	result: ResultLike<LspPrepareRenameDetails>,
	_options: RenderResultOptions,
	theme: Theme,
): Text {
	const details = result.details;
	if (details?.error) {
		return new Text(theme.fg("warning", details.error.split("\n")[0] ?? "error"), 0, 0);
	}
	const fallback = result.content[0]?.text ?? "";
	if (fallback.startsWith("Rename")) {
		return new Text(theme.fg("success", fallback), 0, 0);
	}
	return new Text(theme.fg("muted", fallback), 0, 0);
}

export function renderRenameCall(args: RenameArgs, theme: Theme): Text {
	const head = theme.fg("toolTitle", theme.bold("lsp_rename "));
	const loc = theme.fg("accent", `${shorten(args.filePath, PATH_BUDGET)}:${args.line}:${args.character}`);
	const arrow = theme.fg("muted", " → ");
	const newName = theme.fg("accent", `"${args.newName}"`);
	return new Text(head + loc + arrow + newName, 0, 0);
}

export function renderRenameResult(
	result: ResultLike<LspRenameDetails>,
	options: RenderResultOptions,
	theme: Theme,
): Text {
	const details = result.details;
	if (details?.error) {
		return new Text(theme.fg("warning", details.error.split("\n")[0] ?? "error"), 0, 0);
	}
	if (!details?.apply) {
		return new Text(theme.fg("dim", result.content[0]?.text ?? "No edit applied"), 0, 0);
	}
	const apply = details.apply;
	if (!apply.success) {
		const lines: string[] = [theme.fg("error", "Rename failed")];
		for (const err of apply.errors.slice(0, 5)) {
			lines.push(theme.fg("dim", `  ${err}`));
		}
		return new Text(lines.join("\n"), 0, 0);
	}

	const summary =
		theme.fg("success", `Applied ${apply.totalEdits} edit${apply.totalEdits === 1 ? "" : "s"}`) +
		theme.fg("muted", ` to ${apply.filesModified.length} file${apply.filesModified.length === 1 ? "" : "s"}`);

	if (!options.expanded) {
		const head = apply.filesModified.slice(0, COLLAPSED_HEAD);
		const lines: string[] = [summary];
		for (const f of head) {
			lines.push(theme.fg("muted", `  ${shorten(f, PATH_BUDGET)}`));
		}
		if (apply.filesModified.length > COLLAPSED_HEAD) {
			lines.push(theme.fg("dim", `  … ${apply.filesModified.length - COLLAPSED_HEAD} more`));
		}
		return new Text(lines.join("\n"), 0, 0);
	}

	const lines: string[] = [summary, ""];
	const display = apply.filesModified.slice(0, EXPANDED_HEAD);
	for (const f of display) {
		lines.push(theme.fg("accent", `  ${shorten(f, PATH_BUDGET)}`));
	}
	if (apply.filesModified.length > EXPANDED_HEAD) {
		lines.push(theme.fg("dim", `… ${apply.filesModified.length - EXPANDED_HEAD} more`));
	}
	return new Text(lines.join("\n"), 0, 0);
}
