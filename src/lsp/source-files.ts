import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, type Stats, statSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import { findWorkspaceRoot, formatServerLookupError, withLspClient } from "./client-wrapper.js";
import { isLspDeadConnectionError, LspInvalidPathError } from "./errors.js";
import { findServerForExtension } from "./server-resolution.js";
import type { Diagnostic, ResolvedServer } from "./types.js";

const EXCLUDED_DIRECTORIES = new Set([
	".cache",
	".git",
	".gradle",
	".idea",
	".next",
	".pi",
	".turbo",
	"bin",
	"build",
	"coverage",
	"dist",
	"generated",
	"node_modules",
	"obj",
	"out",
	"target",
	"tmp",
	"vendor",
	".venv",
	"venv",
	"__pycache__",
]);

export interface SourceFile {
	path: string;
	server: ResolvedServer;
	root: string;
}

export interface FileDiagnostic {
	filePath: string;
	diagnostic: Diagnostic;
}

export interface FileDiagnosticError {
	filePath: string;
	error: string;
}

export interface DiagnosticBatch {
	files: SourceFile[];
	diagnostics: FileDiagnostic[];
	fileErrors: FileDiagnosticError[];
}

export function isExcludedPath(filePath: string, root: string): boolean {
	const relativePath = relative(root, filePath);
	if (relativePath.startsWith("..") || relativePath === "") return false;
	return relativePath.split(/[\\/]/u).some((part) => EXCLUDED_DIRECTORIES.has(part));
}

function sourceFileForPath(filePath: string, allowUnsupported: boolean): SourceFile | undefined {
	const extension = extname(filePath);
	const result = findServerForExtension(extension);
	if (result.status !== "found") {
		if (allowUnsupported) return undefined;
		throw new LspInvalidPathError(formatServerLookupError(result));
	}

	return {
		path: filePath,
		server: result.server,
		root: findWorkspaceRoot(filePath),
	};
}

function addSourceFile(files: Map<string, SourceFile>, file: SourceFile | undefined): void {
	if (file) files.set(file.path, file);
}

function collectSupportedFiles(directory: string): SourceFile[] {
	const files = new Map<string, SourceFile>();
	if (EXCLUDED_DIRECTORIES.has(directory.split(/[\\/]/u).at(-1) ?? "")) {
		return [];
	}

	function walk(current: string): void {
		let entries: string[];
		try {
			entries = readdirSync(current).sort();
		} catch {
			return;
		}

		for (const entry of entries) {
			const fullPath = join(current, entry);
			let stat: Stats;
			try {
				stat = lstatSync(fullPath);
			} catch {
				continue;
			}

			if (stat.isSymbolicLink()) continue;
			if (stat.isDirectory()) {
				if (!EXCLUDED_DIRECTORIES.has(entry)) walk(fullPath);
				continue;
			}
			if (!stat.isFile()) continue;
			addSourceFile(files, sourceFileForPath(fullPath, true));
		}
	}

	walk(directory);
	return [...files.values()];
}

export function gitRoot(cwd = process.cwd()): string | undefined {
	try {
		return execFileSync("git", ["rev-parse", "--show-toplevel"], {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
	} catch {
		return undefined;
	}
}

function gitStatusPaths(cwd: string): string[] | undefined {
	try {
		const output = execFileSync(
			"git",
			["--no-optional-locks", "status", "--porcelain=v1", "-z", "--untracked-files=all"],
			{
				cwd,
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
			},
		).toString();
		const entries = output.split("\0");
		const paths: string[] = [];

		for (let index = 0; index < entries.length; index++) {
			const entry = entries[index];
			if (!entry) continue;
			const status = entry.slice(0, 2);
			const path = entry.slice(3);
			const isRenameOrCopy = status.includes("R") || status.includes("C");
			if (status.includes("D")) continue;
			if (isRenameOrCopy) {
				paths.push(path);
				index++;
				continue;
			}
			paths.push(path);
		}
		return paths;
	} catch {
		return undefined;
	}
}

export function collectGitChangedFiles(cwd = process.cwd()): { root: string; files: string[] } | undefined {
	const root = gitRoot(cwd);
	if (!root) return undefined;

	const paths = gitStatusPaths(root);
	if (!paths) return { root, files: [] };

	const files = new Set<string>();
	for (const path of paths) {
		const absolutePath = resolve(root, path);
		if (isExcludedPath(absolutePath, root)) continue;
		try {
			if (statSync(absolutePath).isFile()) files.add(absolutePath);
		} catch {
			// Deleted files and files removed during discovery are not diagnosable.
		}
	}
	return { root, files: [...files] };
}

export function collectSourceFilesForPaths(paths: string[]): SourceFile[] {
	const files = new Map<string, SourceFile>();
	for (const inputPath of paths) {
		const absolutePath = resolve(inputPath);
		if (!existsSync(absolutePath)) {
			throw new LspInvalidPathError(`Path does not exist: ${absolutePath}`);
		}

		if (statSync(absolutePath).isDirectory()) {
			for (const file of collectSupportedFiles(absolutePath)) addSourceFile(files, file);
			continue;
		}
		if (!statSync(absolutePath).isFile()) {
			throw new LspInvalidPathError(`Path is not a file or directory: ${absolutePath}`);
		}
		addSourceFile(files, sourceFileForPath(absolutePath, false));
	}
	return [...files.values()];
}

export function collectGitChangedSourceFiles(cwd = process.cwd()): { root: string; files: SourceFile[] } | undefined {
	const changed = collectGitChangedFiles(cwd);
	if (!changed) return undefined;

	const files: SourceFile[] = [];
	for (const filePath of changed.files) {
		const file = sourceFileForPath(filePath, true);
		if (file) files.push(file);
	}
	return { root: changed.root, files };
}

export function collectWorkspaceSourceFiles(cwd = process.cwd()): { root: string; files: SourceFile[] } {
	const root = gitRoot(cwd) ?? resolve(cwd);
	return { root, files: collectSupportedFiles(root) };
}

export async function diagnoseSourceFiles(files: SourceFile[], signal?: AbortSignal): Promise<DiagnosticBatch> {
	const groups = new Map<string, SourceFile[]>();
	for (const file of files) {
		const key = `${file.root}\0${file.server.id}`;
		const group = groups.get(key) ?? [];
		group.push(file);
		groups.set(key, group);
	}

	const diagnostics: FileDiagnostic[] = [];
	const fileErrors: FileDiagnosticError[] = [];
	for (const group of groups.values()) {
		const first = group[0];
		if (!first) continue;

		const groupDiagnostics: FileDiagnostic[] = [];
		const groupErrors: FileDiagnosticError[] = [];
		const processedFiles = new Set<string>();
		try {
			const batch = await withLspClient(
				first.path,
				async (client) => {
					for (const file of group) {
						if (processedFiles.has(file.path)) continue;
						try {
							const result = await client.diagnostics(file.path);
							groupDiagnostics.push(
								...result.items.map((diagnostic) => ({
									filePath: file.path,
									diagnostic,
								})),
							);
							processedFiles.add(file.path);
						} catch (error) {
							if (isLspDeadConnectionError(error)) throw error;
							groupErrors.push({
								filePath: file.path,
								error: error instanceof Error ? error.message : String(error),
							});
							processedFiles.add(file.path);
						}
					}
					return { diagnostics: groupDiagnostics, fileErrors: groupErrors };
				},
				"diagnostics",
				signal === undefined ? {} : { signal },
			);
			diagnostics.push(...batch.diagnostics);
			fileErrors.push(...batch.fileErrors);
		} catch (error) {
			signal?.throwIfAborted();
			diagnostics.push(...groupDiagnostics);
			fileErrors.push(...groupErrors);
			const message = error instanceof Error ? error.message : String(error);
			fileErrors.push(
				...group
					.filter((file) => !processedFiles.has(file.path))
					.map((file) => ({ filePath: file.path, error: message })),
			);
		}
	}

	return { files, diagnostics, fileErrors };
}
