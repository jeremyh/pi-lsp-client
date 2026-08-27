import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import {
	createMessageConnection,
	type MessageConnection,
	StreamMessageReader,
	StreamMessageWriter,
} from "vscode-jsonrpc/node.js";

import { LspConnectionClosedError } from "../src/lsp/errors.js";
import type { SpawnedProcess } from "../src/lsp/process.js";
import { LspClientTransport } from "../src/lsp/transport.js";
import type { ResolvedServer } from "../src/lsp/types.js";

import { makeServer } from "./helpers/fake-lsp-client.js";

class NotificationHarness extends LspClientTransport {
	private readonly input = new PassThrough();
	private readonly writer = new PassThrough();

	constructor() {
		super("/root/a", makeServer("typescript"));
	}

	installDestroyedConnection(): void {
		const connection: MessageConnection = createMessageConnection(
			new StreamMessageReader(this.input),
			new StreamMessageWriter(this.writer),
		);
		connection.listen();
		this.connection = connection;
		this.writer.destroy();
	}

	notify(): Promise<void> {
		return this.sendNotification("window/logMessage", { type: 3, message: "test" });
	}

	disposeHarness(): void {
		this.connection?.dispose();
		this.input.destroy();
		this.writer.destroy();
	}
}

class StopHarness extends LspClientTransport {
	readonly requests: string[] = [];
	readonly notifications: string[] = [];
	private readonly input = new PassThrough();
	private readonly writer = new PassThrough();

	constructor(
		private readonly hangShutdown = false,
		private readonly useRealShutdown = false,
		private readonly delayWrites = false,
	) {
		super("/root/a", makeServer("typescript"));
		if (this.delayWrites) this.writer.cork();
		const connection: MessageConnection = createMessageConnection(
			new StreamMessageReader(this.input),
			new StreamMessageWriter(this.writer),
		);
		connection.listen();
		this.connection = connection;
		this.output = this.writer;
	}

	protected override sendRequest<T>(method: string): Promise<T>;
	protected override sendRequest<T>(method: string, params: unknown): Promise<T>;
	protected override async sendRequest<T>(method: string, _params?: unknown): Promise<T> {
		this.requests.push(method);
		return null as T;
	}

	protected override sendShutdownRequest(): Promise<void> {
		if (this.useRealShutdown) return super.sendShutdownRequest();
		this.requests.push("shutdown");
		if (this.hangShutdown) {
			return new Promise(() => {});
		}
		return Promise.resolve();
	}

	protected override async sendNotification(method: string): Promise<void> {
		this.notifications.push(method);
	}

	installFakeProcess(): NodeJS.Signals[] {
		let resolveExit!: (code: number) => void;
		let exitCode: number | null = null;
		const killSignals: NodeJS.Signals[] = [];
		const exited = new Promise<number>((resolve) => {
			resolveExit = resolve;
		});
		const process: SpawnedProcess = {
			stdin: this.input,
			stdout: this.input,
			stderr: this.input,
			pid: 123,
			get exitCode() {
				return exitCode;
			},
			exited,
			kill(signal) {
				killSignals.push(signal ?? "SIGTERM");
				exitCode = 0;
				resolveExit(0);
			},
			killed: false,
		};
		this.proc = process;
		return killSignals;
	}

	releaseWrites(): void {
		this.writer.uncork();
	}

	disposeHarness(): void {
		this.connection?.dispose();
		this.input.destroy();
		this.writer.destroy();
	}
}

class SpawnedTransportHarness extends LspClientTransport {
	stderr(): string {
		return this.stderrBuffer.join("");
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function waitForChildPid(transport: SpawnedTransportHarness): Promise<number> {
	const deadline = Date.now() + 2_000;
	while (Date.now() < deadline) {
		const pid = Number(transport.stderr().trim().split(/\s+/)[0]);
		if (Number.isInteger(pid) && pid > 0) return pid;
		await sleep(10);
	}
	throw new Error(`timed out waiting for child pid; stderr: ${transport.stderr()}`);
}

function makeStubbornDescendantServer(): ResolvedServer {
	const descendant = ["process.on('SIGTERM', () => {})", "setInterval(() => {}, 1000)"].join(";");
	const parent = [
		"const { spawn } = require('node:child_process')",
		`const child = spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: 'ignore' })`,
		"console.error(String(child.pid))",
		"process.on('SIGTERM', () => process.exit(0))",
		"setInterval(() => {}, 1000)",
	].join(";");
	return {
		...makeServer("spawned-test"),
		command: [process.execPath, "-e", parent],
	};
}

describe("LspClientTransport", () => {
	it("#given destroyed json-rpc writer #when notification is sent #then write failure rejects to caller", async () => {
		// given
		const harness = new NotificationHarness();
		harness.installDestroyedConnection();

		try {
			// when / then
			await expect(harness.notify()).rejects.toBeInstanceOf(LspConnectionClosedError);
		} finally {
			harness.disposeHarness();
		}
	});

	it("#given active connection #when stopping #then shutdown is a request before exit notification", async () => {
		// given
		const harness = new StopHarness();

		try {
			// when
			await harness.stop();

			// then
			expect(harness.requests).toEqual(["shutdown"]);
			expect(harness.notifications).toEqual(["exit"]);
		} finally {
			harness.disposeHarness();
		}
	});

	it("#given a shutdown request that never responds #when stopping #then process cleanup does not wait for the response", async () => {
		// given
		const harness = new StopHarness(true);
		const killSignals = harness.installFakeProcess();

		try {
			// when
			await harness.stop();

			// then
			expect(harness.requests).toEqual(["shutdown"]);
			expect(harness.notifications).toEqual([]);
			expect(killSignals).toEqual(["SIGTERM", "SIGKILL"]);
		} finally {
			harness.disposeHarness();
		}
	});

	it("#given shutdown write is pending #when stopping #then stream teardown does not cause an unhandled rejection", async () => {
		// given
		const harness = new StopHarness(false, true, true);
		const killSignals = harness.installFakeProcess();
		const unhandled: unknown[] = [];
		const onUnhandledRejection = (reason: unknown) => {
			unhandled.push(reason);
		};
		process.on("unhandledRejection", onUnhandledRejection);

		try {
			// when
			await harness.stop();
			await sleep(0);
			harness.releaseWrites();
			await sleep(0);

			// then
			expect(killSignals).toEqual(["SIGTERM", "SIGKILL"]);
			expect(unhandled).toEqual([]);
		} finally {
			process.off("unhandledRejection", onUnhandledRejection);
			harness.disposeHarness();
		}
	});

	it.skipIf(process.platform === "win32")(
		"#given a spawned server with an unresponsive shutdown and stubborn descendant #when stopping #then shutdown is prompt and the descendant is killed",
		async () => {
			// given
			const transport = new SpawnedTransportHarness(process.cwd(), makeStubbornDescendantServer());
			let childPid: number | undefined;
			const unhandled: unknown[] = [];
			const onUnhandledRejection = (reason: unknown) => {
				unhandled.push(reason);
			};
			process.on("unhandledRejection", onUnhandledRejection);

			try {
				await transport.start();
				childPid = await waitForChildPid(transport);

				// when
				const startedAt = Date.now();
				await transport.stop();

				// then
				expect(Date.now() - startedAt).toBeLessThan(2_000);
				await sleep(100);
				expect(isPidAlive(childPid)).toBe(false);
				expect(unhandled).toEqual([]);
			} finally {
				process.off("unhandledRejection", onUnhandledRejection);
				await transport.stop();
				if (childPid !== undefined && isPidAlive(childPid)) {
					try {
						process.kill(childPid, "SIGKILL");
					} catch {}
				}
			}
		},
	);
});
