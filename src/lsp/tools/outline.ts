import { basename, resolve } from "node:path";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { withLspClient } from "../client-wrapper.js";
import { SYMBOL_KIND_MAP } from "../language-mappings.js";
import type { DocumentSymbol, Range, SymbolInfo } from "../types.js";
import { handleMissingDependencyError } from "../utils.js";

const Params = Type.Object({
	path: Type.String({ description: "Source file to outline" }),
	query: Type.Optional(Type.String({ description: "Case-insensitive symbol-name filter" })),
});

export interface OutlineSymbol {
	name: string;
	kind: string;
	startLine: number;
	endLine: number;
	containerName?: string;
	children?: OutlineSymbol[];
}

export interface LspOutlineDetails {
	path: string;
	query?: string;
	symbols: OutlineSymbol[];
	totalSymbols: number;
	error?: string;
	errorKind?: "missing_dependency" | "unsupported" | "request_failed";
}

function isDocumentSymbol(symbol: DocumentSymbol | SymbolInfo): symbol is DocumentSymbol {
	return "range" in symbol;
}

function normalizedKind(kind: number): string {
	const name = SYMBOL_KIND_MAP[kind]?.toLowerCase();
	switch (name) {
		case "class":
		case "interface":
		case "function":
		case "method":
		case "constructor":
		case "property":
		case "field":
		case "variable":
		case "enum":
		case "struct":
		case "module":
		case "namespace":
			return name;
		case "constant":
			return "variable";
		default:
			return "symbol";
	}
}

function rangeLines(range: Range): Pick<OutlineSymbol, "startLine" | "endLine"> {
	return {
		startLine: range.start.line + 1,
		endLine: range.end.line + 1,
	};
}

function outlineFromDocumentSymbol(symbol: DocumentSymbol): OutlineSymbol {
	const children = symbol.children?.map(outlineFromDocumentSymbol);
	return {
		name: symbol.name,
		kind: normalizedKind(symbol.kind),
		...rangeLines(symbol.range),
		...(children && children.length > 0 ? { children } : {}),
	};
}

function outlineFromSymbolInfo(symbol: SymbolInfo): OutlineSymbol {
	return {
		name: symbol.name,
		kind: normalizedKind(symbol.kind),
		...rangeLines(symbol.location.range),
		...(symbol.containerName ? { containerName: symbol.containerName } : {}),
	};
}

function filterDocumentSymbol(symbol: DocumentSymbol, query: string): DocumentSymbol | undefined {
	const children = symbol.children
		?.map((child) => filterDocumentSymbol(child, query))
		.filter((child): child is DocumentSymbol => child !== undefined);
	const matches = symbol.name.toLocaleLowerCase().includes(query);
	if (!matches && (!children || children.length === 0)) return undefined;
	return {
		...symbol,
		...(children && children.length > 0 ? { children } : {}),
	};
}

function isUnsupportedDocumentSymbolsError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	const code = "code" in error && typeof error.code === "number" ? error.code : undefined;
	return code === -32601 || /document.?symbol|unsupported|not supported|method not found/i.test(error.message);
}

function formatSymbol(symbol: OutlineSymbol, indent = 0): string[] {
	const prefix = "  ".repeat(indent);
	const name = symbol.containerName ? `${symbol.containerName} > ${symbol.name}` : symbol.name;
	const lines = [`${prefix}${name}  ${symbol.kind}  ${symbol.startLine}-${symbol.endLine}`];
	for (const child of symbol.children ?? []) lines.push(...formatSymbol(child, indent + 1));
	return lines;
}

export const lsp_outline = defineTool({
	name: "lsp_outline",
	label: "LSP Outline",
	description: "Show the meaningful symbols and full source ranges in one known source file.",
	parameters: Params,
	async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
		const path = resolve(params.path);
		try {
			const result = await withLspClient<Array<DocumentSymbol | SymbolInfo> | null>(
				path,
				(client) => client.documentSymbols(path),
				"documentSymbols",
				signal === undefined ? {} : { signal },
			);
			const symbols = result ?? [];
			const query = params.query?.trim().toLocaleLowerCase();
			const documentSymbols = symbols.filter(isDocumentSymbol);
			let outline: OutlineSymbol[];
			if (documentSymbols.length === symbols.length) {
				const filtered = query
					? documentSymbols
							.map((symbol) => filterDocumentSymbol(symbol, query))
							.filter((symbol): symbol is DocumentSymbol => symbol !== undefined)
					: documentSymbols;
				outline = filtered.map(outlineFromDocumentSymbol);
			} else {
				const flatSymbols = symbols.filter((symbol): symbol is SymbolInfo => !isDocumentSymbol(symbol));
				outline = flatSymbols
					.filter((symbol) => !query || symbol.name.toLocaleLowerCase().includes(query))
					.map(outlineFromSymbolInfo);
			}

			const title = basename(path);
			const text =
				outline.length === 0 ? `${title}\nNo symbols found.` : [title, ...outline.flatMap(formatSymbol)].join("\n");
			const details: LspOutlineDetails = {
				path,
				...(params.query !== undefined ? { query: params.query } : {}),
				symbols: outline,
				totalSymbols: outline.length,
			};
			return { content: [{ type: "text", text }], details };
		} catch (error) {
			const missingDependency = handleMissingDependencyError(error);
			const message = missingDependency
				? (missingDependency.split("\n")[0] ?? missingDependency)
				: isUnsupportedDocumentSymbolsError(error)
					? "Document symbols are not supported by the language server."
					: `Unable to get outline: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`;
			const details: LspOutlineDetails = {
				path,
				...(params.query !== undefined ? { query: params.query } : {}),
				symbols: [],
				totalSymbols: 0,
				error: message,
				errorKind: missingDependency
					? "missing_dependency"
					: isUnsupportedDocumentSymbolsError(error)
						? "unsupported"
						: "request_failed",
			};
			return { content: [{ type: "text", text: message }], details };
		}
	},
});
