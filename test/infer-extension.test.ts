import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";

import { inferExtensionFromDirectory } from "../src/lsp/infer-extension.js";

describe("inferExtensionFromDirectory", () => {
	it("#given a Gradle project #when generated metadata exceeds the scan budget #then finds Kotlin sources", async () => {
		// given
		const root = join(tmpdir(), `pi-lsp-infer-${process.pid}-${Date.now()}`);
		const noisyDir = join(root, ".gradle");
		const sourceDir = join(root, "app", "src", "main");
		await mkdir(noisyDir, { recursive: true });
		await mkdir(sourceDir, { recursive: true });
		await Promise.all(
			Array.from({ length: 600 }, (_, index) => writeFile(join(noisyDir, `generated-${index}.sh`), "#!/bin/sh\n")),
		);
		await writeFile(join(sourceDir, "Main.kt"), "fun main() = Unit\n");

		try {
			// when
			const extension = inferExtensionFromDirectory(root);

			// then
			expect(extension).toBe(".kt");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
