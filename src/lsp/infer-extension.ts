import { lstatSync, readdirSync } from "node:fs";
import { extname, join } from "node:path";

import { EXT_TO_LANG } from "./language-mappings.js";

// Avoid spending the scan budget on generated, metadata, and dependency trees.
// This is especially important for Gradle projects: Gradle metadata trees
// can contain hundreds of files before app/src is reached.
const SKIP_DIRECTORIES = new Set([
	"node_modules",
	".git",
	".gradle",
	".idea",
	".vscode",
	".venv",
	"venv",
	"__pycache__",
	".pytest_cache",
	".mypy_cache",
	".ruff_cache",
	".tox",
	".nox",
	".eggs",
	"site-packages",
	".npm",
	".yarn",
	".pnpm-store",
	"dist",
	"build",
	"coverage",
	"target",
	"out",
]);
const MAX_SCAN_ENTRIES = 500;

export function inferExtensionFromDirectory(directory: string): string | null {
	const extensionCounts = new Map<string, number>();
	let scanned = 0;

	function walk(dir: string): void {
		if (scanned >= MAX_SCAN_ENTRIES) return;

		let entries: string[];
		try {
			entries = readdirSync(dir);
		} catch {
			return;
		}

		for (const entry of entries) {
			if (scanned >= MAX_SCAN_ENTRIES) return;

			const fullPath = join(dir, entry);

			let stat: ReturnType<typeof lstatSync> | undefined;
			try {
				stat = lstatSync(fullPath);
			} catch {
				continue;
			}

			if (stat.isSymbolicLink()) continue;
			scanned++;

			if (stat.isDirectory()) {
				if (!SKIP_DIRECTORIES.has(entry)) {
					walk(fullPath);
				}
			} else if (stat.isFile()) {
				const ext = extname(fullPath);
				if (ext && ext in EXT_TO_LANG) {
					extensionCounts.set(ext, (extensionCounts.get(ext) ?? 0) + 1);
				}
			}
		}
	}

	walk(directory);

	if (extensionCounts.size === 0) return null;

	let maxExt = "";
	let maxCount = 0;
	for (const [ext, count] of extensionCounts) {
		if (count > maxCount) {
			maxCount = count;
			maxExt = ext;
		}
	}

	return maxExt || null;
}
