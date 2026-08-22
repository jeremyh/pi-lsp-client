import { relative, resolve } from "node:path";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { DEFAULT_MAX_DIAGNOSTICS } from "../constants.js";
import {
	collectGitChangedSourceFiles,
	collectSourceFilesForPaths,
	collectWorkspaceSourceFiles,
	diagnoseSourceFiles,
	type FileDiagnostic,
	type SourceFile,
} from "../source-files.js";
import type { Diagnostic } from "../types.js";
import { handleMissingDependencyError } from "../utils.js";

const Params = Type.Object({
	paths: Type.Optional(
		Type.Array(Type.String(), {
			description: "Files or directories to diagnose. Directories are searched recursively.",
		}),
	),
	all: Type.Optional(Type.Boolean({ description: "Diagnose the supported workspace." })),
	include_warnings: Type.Optional(Type.Boolean({ description: "Include warning details (default: false)." })),
});

export type DiagnosticsScope = "changed" | "paths" | "workspace";

export interface LspDiagnosticsDetails {
	scope: DiagnosticsScope;
	paths?: string[];
	includeWarnings: boolean;
	filesChecked: number;
	diagnostics: Array<{ file: string; diagnostic: Diagnostic }>;
	rawDiagnostics: Array<{ file: string; diagnostic: Diagnostic }>;
	totalDiagnostics: number;
	errorCount: number;
	warningCount: number;
	suppressedWarnings: number;
	truncated: boolean;
	fileErrors: Array<{ file: string; error: string }>;
	error?: string;
	errorKind?: "missing_dependency" | "invalid_scope";
}

function displayPath(filePath: string, root: string): string {
	const path = relative(root, filePath).replaceAll("\\", "/");
	return path && !path.startsWith("../") && path !== ".." ? path : filePath;
}

function compactDiagnostic({ diagnostic }: FileDiagnostic): string {
	const line = diagnostic.range.start.line + 1;
	const character = diagnostic.range.start.character;
	const message = diagnostic.message.replaceAll(/\s+/gu, " ").trim();
	return `  ${line}:${character}  ${message}`;
}

function severityIsError(diagnostic: Diagnostic): boolean {
	return diagnostic.severity === undefined || diagnostic.severity === 1;
}

function severityIsWarning(diagnostic: Diagnostic): boolean {
	return diagnostic.severity === 2;
}

function groupVisibleDiagnostics(diagnostics: FileDiagnostic[], root: string, includeWarnings: boolean): string[] {
	const grouped = new Map<string, FileDiagnostic[]>();
	for (const item of diagnostics) {
		if (!severityIsError(item.diagnostic) && !(includeWarnings && severityIsWarning(item.diagnostic))) continue;
		const group = grouped.get(item.filePath) ?? [];
		group.push(item);
		grouped.set(item.filePath, group);
	}

	const lines: string[] = [];
	for (const [filePath, items] of grouped) {
		lines.push(displayPath(filePath, root));
		for (const item of items) lines.push(compactDiagnostic(item));
		lines.push("");
	}
	if (lines.at(-1) === "") lines.pop();
	return lines;
}

function summary(
	filesChecked: number,
	errorCount: number,
	warningCount: number,
	includeWarnings: boolean,
	suppressedWarnings: number,
): string {
	const errors = `${errorCount} error${errorCount === 1 ? "" : "s"}`;
	const warnings = includeWarnings
		? `${warningCount} warning${warningCount === 1 ? "" : "s"}`
		: `${suppressedWarnings} warning${suppressedWarnings === 1 ? "" : "s"} suppressed`;
	return `${filesChecked} file${filesChecked === 1 ? "" : "s"} checked · ${errors} · ${warnings}`;
}

function noChangedFilesDetails(): LspDiagnosticsDetails {
	return {
		scope: "changed",
		includeWarnings: false,
		filesChecked: 0,
		diagnostics: [],
		rawDiagnostics: [],
		totalDiagnostics: 0,
		errorCount: 0,
		warningCount: 0,
		suppressedWarnings: 0,
		truncated: false,
		fileErrors: [],
	};
}

export const lsp_diagnostics = defineTool({
	name: "lsp_diagnostics",
	label: "LSP Diagnostics",
	description:
		"Diagnose supported source files with the language server. With no paths, checks changed git files; use all=true for the workspace. " +
		"Warnings are summarized but hidden by default.",
	parameters: Params,
	async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
		const includeWarnings = params.include_warnings === true;
		const hasExplicitPaths = params.paths !== undefined;
		let scope: DiagnosticsScope;
		let root: string;
		let files: SourceFile[] = [];

		try {
			if (hasExplicitPaths) {
				scope = "paths";
				const collected = collectSourceFilesForPaths(params.paths ?? []);
				root = collected[0]?.root ?? resolve(process.cwd());
				files = collected;
			} else if (params.all === true) {
				scope = "workspace";
				const collected = collectWorkspaceSourceFiles();
				root = collected.root;
				files = collected.files;
			} else {
				scope = "changed";
				const collected = collectGitChangedSourceFiles();
				if (!collected) {
					const text = "Not in a git repository; provide paths or use all=true.";
					return { content: [{ type: "text", text }], details: { ...noChangedFilesDetails(), error: text } };
				}
				root = collected.root;
				files = collected.files;
			}

			if (files.length === 0) {
				const text =
					scope === "changed" ? "No changed files to diagnose." : "No supported source files to diagnose.";
				const details: LspDiagnosticsDetails = {
					...noChangedFilesDetails(),
					scope,
					includeWarnings,
				};
				return { content: [{ type: "text", text }], details };
			}

			const batch = await diagnoseSourceFiles(files, signal);
			const allDiagnostics = batch.diagnostics;
			const errorCount = allDiagnostics.filter(({ diagnostic }) => severityIsError(diagnostic)).length;
			const warningCount = allDiagnostics.filter(({ diagnostic }) => severityIsWarning(diagnostic)).length;
			const suppressedWarnings = includeWarnings ? 0 : warningCount;
			const visibleDiagnostics = allDiagnostics.filter(
				({ diagnostic }) => severityIsError(diagnostic) || (includeWarnings && severityIsWarning(diagnostic)),
			);
			const truncated = visibleDiagnostics.length > DEFAULT_MAX_DIAGNOSTICS;
			const limitedDiagnostics = truncated
				? visibleDiagnostics.slice(0, DEFAULT_MAX_DIAGNOSTICS)
				: visibleDiagnostics;
			const visibleFiles = new Set(limitedDiagnostics.map(({ filePath }) => filePath));
			const lines: string[] = [];

			if (errorCount > 0) {
				const errorFiles = new Set(
					allDiagnostics.filter(({ diagnostic }) => severityIsError(diagnostic)).map(({ filePath }) => filePath),
				);
				lines.push(
					`${errorCount} error${errorCount === 1 ? "" : "s"} in ${errorFiles.size} file${errorFiles.size === 1 ? "" : "s"}`,
					"",
				);
			} else {
				lines.push(summary(files.length, errorCount, warningCount, includeWarnings, suppressedWarnings));
			}

			if (limitedDiagnostics.length > 0) {
				if (errorCount > 0) lines.push(...groupVisibleDiagnostics(limitedDiagnostics, root, includeWarnings));
				else if (visibleFiles.size > 0)
					lines.push("", ...groupVisibleDiagnostics(limitedDiagnostics, root, includeWarnings));
			}
			if (truncated) lines.push("", `${visibleDiagnostics.length - DEFAULT_MAX_DIAGNOSTICS} diagnostics not shown`);
			if (suppressedWarnings > 0)
				lines.push("", `${suppressedWarnings} warning${suppressedWarnings === 1 ? "" : "s"} suppressed`);
			if (batch.fileErrors.length > 0) {
				lines.push(
					"",
					`${batch.fileErrors.length} file${batch.fileErrors.length === 1 ? "" : "s"} could not be checked`,
				);
				for (const { filePath, error } of batch.fileErrors) {
					lines.push(`  ${displayPath(filePath, root)}: ${error.split("\n")[0] ?? error}`);
				}
			}

			const details: LspDiagnosticsDetails = {
				scope,
				...(scope === "paths" ? { paths: params.paths } : {}),
				includeWarnings,
				filesChecked: files.length,
				diagnostics: limitedDiagnostics.map(({ filePath, diagnostic }) => ({ file: filePath, diagnostic })),
				rawDiagnostics: allDiagnostics.map(({ filePath, diagnostic }) => ({ file: filePath, diagnostic })),
				totalDiagnostics: allDiagnostics.length,
				errorCount,
				warningCount,
				suppressedWarnings,
				truncated,
				fileErrors: batch.fileErrors.map(({ filePath, error }) => ({ file: filePath, error })),
			};
			return { content: [{ type: "text", text: lines.join("\n") }], details };
		} catch (error) {
			const message = handleMissingDependencyError(error);
			if (!message) throw error;
			const details: LspDiagnosticsDetails = {
				...noChangedFilesDetails(),
				scope: hasExplicitPaths ? "paths" : params.all === true ? "workspace" : "changed",
				includeWarnings,
				error: message,
				errorKind: "missing_dependency",
			};
			return { content: [{ type: "text", text: message }], details };
		}
	},
});
