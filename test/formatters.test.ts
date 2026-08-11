import { describe, expect, it } from "vitest";

import {
	filterDiagnosticsBySeverity,
	formatApplyResult,
	formatDiagnostic,
	formatDocumentSymbol,
	formatLocation,
	formatPrepareRenameResult,
	formatSeverity,
	formatSymbolInfo,
	formatSymbolKind,
	uriToDisplayPath,
	uriToPath,
} from "../src/lsp/formatters.js";

describe("formatLocation", () => {
	it("#given a non-file dependency URI #when formatting #then preserves the URI", () => {
		const loc = {
			uri: "jar:file:/kotlin-stdlib.jar!/kotlin/Suppress.class",
			range: {
				start: { line: 0, character: 0 },
				end: { line: 0, character: 1 },
			},
		};

		expect(formatLocation(loc)).toBe("jar:file:/kotlin-stdlib.jar!/kotlin/Suppress.class:1:0");
	});

	it("#given a Location #when formatting #then returns file:line:column with 1-based line", () => {
		// given
		const loc = {
			uri: "file:///tmp/foo.ts",
			range: {
				start: { line: 41, character: 5 },
				end: { line: 41, character: 12 },
			},
		};

		// when
		const formatted = formatLocation(loc);

		// then
		expect(formatted).toBe("/tmp/foo.ts:42:5");
	});

	it("#given a LocationLink #when formatting #then uses targetRange and targetUri", () => {
		// given
		const loc = {
			targetUri: "file:///tmp/bar.ts",
			targetRange: {
				start: { line: 0, character: 0 },
				end: { line: 0, character: 3 },
			},
			targetSelectionRange: {
				start: { line: 0, character: 0 },
				end: { line: 0, character: 3 },
			},
		};

		// when
		const formatted = formatLocation(loc);

		// then
		expect(formatted).toBe("/tmp/bar.ts:1:0");
	});
});

describe("formatSeverity", () => {
	it("#given each severity number #when formatting #then maps to readable string", () => {
		// given / when / then
		expect(formatSeverity(1)).toBe("error");
		expect(formatSeverity(2)).toBe("warning");
		expect(formatSeverity(3)).toBe("information");
		expect(formatSeverity(4)).toBe("hint");
	});

	it("#given undefined severity #when formatting #then returns 'unknown'", () => {
		// given / when / then
		expect(formatSeverity(undefined)).toBe("unknown");
	});

	it("#given out-of-range severity #when formatting #then returns 'unknown(N)'", () => {
		// given / when / then
		expect(formatSeverity(99)).toBe("unknown(99)");
	});
});

describe("formatSymbolKind", () => {
	it("#given known kind #when formatting #then returns its name", () => {
		// given / when / then
		expect(formatSymbolKind(5)).toBe("Class");
		expect(formatSymbolKind(12)).toBe("Function");
	});

	it("#given unknown kind #when formatting #then returns 'Unknown(N)'", () => {
		// given / when / then
		expect(formatSymbolKind(999)).toBe("Unknown(999)");
	});
});

describe("filterDiagnosticsBySeverity", () => {
	const diagnostics = [
		{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, severity: 1, message: "e" },
		{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, severity: 2, message: "w" },
		{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, severity: 3, message: "i" },
		{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, severity: 4, message: "h" },
	];

	function firstDiagnostic(result: ReturnType<typeof filterDiagnosticsBySeverity>) {
		const diagnostic = result[0];
		if (!diagnostic) throw new Error("expected first diagnostic");
		return diagnostic;
	}

	it("#given no severity #when filtering #then returns all diagnostics", () => {
		// given / when
		const result = filterDiagnosticsBySeverity(diagnostics);

		// then
		expect(result).toEqual(diagnostics);
	});

	it("#given 'all' severity #when filtering #then returns all diagnostics", () => {
		// given / when
		const result = filterDiagnosticsBySeverity(diagnostics, "all");

		// then
		expect(result).toEqual(diagnostics);
	});

	it("#given 'error' severity #when filtering #then returns only error diagnostics", () => {
		// given / when
		const result = filterDiagnosticsBySeverity(diagnostics, "error");

		// then
		expect(result).toHaveLength(1);
		expect(firstDiagnostic(result).message).toBe("e");
	});

	it("#given 'warning' severity #when filtering #then returns only warning diagnostics", () => {
		// given / when
		const result = filterDiagnosticsBySeverity(diagnostics, "warning");

		// then
		expect(result).toHaveLength(1);
		expect(firstDiagnostic(result).message).toBe("w");
	});
});

describe("formatDiagnostic", () => {
	it("#given a diagnostic #when formatting #then includes severity, source, code, location, and message", () => {
		// given
		const diag = {
			range: { start: { line: 9, character: 4 }, end: { line: 9, character: 10 } },
			severity: 1,
			source: "ts",
			code: "TS2322",
			message: "Type mismatch",
		};

		// when
		const formatted = formatDiagnostic(diag);

		// then
		expect(formatted).toContain("error");
		expect(formatted).toContain("[ts]");
		expect(formatted).toContain("(TS2322)");
		expect(formatted).toContain("10:4");
		expect(formatted).toContain("Type mismatch");
	});
});

describe("formatPrepareRenameResult", () => {
	it("#given null result #when formatting #then says cannot rename", () => {
		// given / when / then
		expect(formatPrepareRenameResult(null)).toBe("Cannot rename at this position");
	});

	it("#given defaultBehavior true #when formatting #then says rename supported", () => {
		// given / when / then
		expect(formatPrepareRenameResult({ defaultBehavior: true })).toContain("Rename supported");
	});

	it("#given range with placeholder #when formatting #then includes placeholder name", () => {
		// given
		const result = {
			range: { start: { line: 4, character: 7 }, end: { line: 4, character: 13 } },
			placeholder: "oldName",
		};

		// when
		const formatted = formatPrepareRenameResult(result);

		// then
		expect(formatted).toContain('current: "oldName"');
		expect(formatted).toContain("5:7-5:13");
	});
});

describe("formatApplyResult", () => {
	it("#given a successful apply #when formatting #then includes counts and file list", () => {
		// given
		const apply = { success: true, filesModified: ["/a.ts", "/b.ts"], totalEdits: 5, errors: [] };

		// when
		const formatted = formatApplyResult(apply);

		// then
		expect(formatted).toContain("Applied 5 edit(s) to 2 file(s)");
		expect(formatted).toContain("/a.ts");
		expect(formatted).toContain("/b.ts");
	});

	it("#given a failed apply #when formatting #then includes error details", () => {
		// given
		const apply = { success: false, filesModified: [], totalEdits: 0, errors: ["bad permissions"] };

		// when
		const formatted = formatApplyResult(apply);

		// then
		expect(formatted).toContain("Failed to apply some changes");
		expect(formatted).toContain("bad permissions");
	});
});

describe("uriToPath", () => {
	it("#given a non-file URI #when converting for display #then returns the original URI", () => {
		expect(uriToDisplayPath("jar:file:/kotlin-stdlib.jar!/kotlin/0")).toBe(
			"jar:file:/kotlin-stdlib.jar!/kotlin/0",
		);
	});

	it("#given a file URI #when converting #then returns absolute filesystem path", () => {
		// given / when / then
		expect(uriToPath("file:///tmp/foo.ts")).toBe("/tmp/foo.ts");
	});
});

describe("formatDocumentSymbol", () => {
	it("#given symbol with children #when formatting #then indents children", () => {
		// given
		const symbol = {
			name: "Foo",
			kind: 5,
			range: { start: { line: 0, character: 0 }, end: { line: 4, character: 0 } },
			selectionRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
			children: [
				{
					name: "bar",
					kind: 6,
					range: { start: { line: 1, character: 2 }, end: { line: 2, character: 0 } },
					selectionRange: { start: { line: 1, character: 2 }, end: { line: 1, character: 5 } },
				},
			],
		};

		// when
		const formatted = formatDocumentSymbol(symbol);

		// then
		expect(formatted).toContain("Foo (Class)");
		expect(formatted).toContain("  bar (Method)");
	});
});

describe("formatSymbolInfo", () => {
	it("#given a SymbolInfo #when formatting #then includes containerName when present", () => {
		// given
		const symbol = {
			name: "method",
			kind: 6,
			location: {
				uri: "file:///x.ts",
				range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
			},
			containerName: "Foo",
		};

		// when
		const formatted = formatSymbolInfo(symbol);

		// then
		expect(formatted).toBe("method (Method) (in Foo) - /x.ts:1:0");
	});
});
