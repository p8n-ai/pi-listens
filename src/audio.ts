import { mkdir, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { spawn, type StdioOptions } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { once } from "node:events";
import type { PiListensConfig } from "./config.js";

export interface AudioRuntime {
	record(seconds?: number, signal?: AbortSignal): Promise<string>;
	streamPcm(signal?: AbortSignal): AsyncIterable<Buffer>;
	play(path: string, signal?: AbortSignal): Promise<void>;
	playStream(stream: ReadableStream<Uint8Array>, signal?: AbortSignal): Promise<void>;
	cleanup(path: string): Promise<void>;
	stopPlayback(): void;
	stopAll(): void;
	hasActivePlayback(): boolean;
	waitForPlaybackIdle(timeoutMs?: number): Promise<void>;
	describe(): { recorder: string; player: string; streamingPlayer: string };
	/** Enqueue a playback task. Waits for any prior queued playback to finish before starting. */
	enqueuePlayback(fn: () => Promise<void>): Promise<void>;
	/** Clear the playback queue and stop current playback (for interrupts). */
	interruptPlayback(): void;
}

export function createAudioRuntime(config: PiListensConfig): AudioRuntime {
	const recorder = config.recordCommand ? "custom" : detectRecorder();
	const player = config.playCommand ? "custom" : detectPlayer();
	const streamingPlayer = detectStreamingPlayer();
	let playbackQueue: Promise<void> = Promise.resolve();
	let queueGeneration = 0;

	return {
		async record(seconds = config.recordSeconds, signal?: AbortSignal): Promise<string> {
			if (!recorder) {
				throw new Error(
					"No microphone recorder found. Install sox (`rec`) or ffmpeg, or set PI_LISTENS_RECORD_COMMAND. See README for command templates.",
				);
			}
			await mkdir(config.audioDir, { recursive: true });
			const path = join(config.audioDir, `pi-listens-input-${Date.now()}-${randomUUID()}.wav`);
			const useUtteranceMode = config.recordMode === "utterance" && recorder === "rec";
			const command = config.recordCommand
				? customCommand(config.recordCommand, {
					path,
					seconds,
					sampleRate: config.recordSampleRate,
					silenceStartSeconds: config.silenceStartSeconds,
					silenceStopSeconds: config.silenceStopSeconds,
					silenceThreshold: config.silenceThreshold,
				})
				: useUtteranceMode
					? utteranceRecorderCommand(recorder, path, config.recordSampleRate, config.silenceStartSeconds, config.silenceStopSeconds, config.silenceThreshold)
					: recorderCommand(recorder, path, seconds, config.recordSampleRate);
			await run(command.command, command.args, signal, { ...(useUtteranceMode ? { timeoutMs: seconds * 1000, resolveOnTimeout: true } : {}), kind: "record" });
			return path;
		},

		streamPcm(signal?: AbortSignal): AsyncIterable<Buffer> {
			if (!recorder) {
				throw new Error(
					"No microphone recorder found. Install sox (`rec`) or ffmpeg, or set PI_LISTENS_STREAM_COMMAND. See README for command templates.",
				);
			}
			const command = config.streamCommand
				? customCommand(config.streamCommand, { sampleRate: config.recordSampleRate })
				: pcmStreamCommand(recorder, config.recordSampleRate);
			return streamCommandOutput(command.command, command.args, signal, "record");
		},

		async play(path: string, signal?: AbortSignal): Promise<void> {
			if (!player) {
				throw new Error(
					"No audio player found. Install afplay, sox (`play`), ffplay, or aplay, or set PI_LISTENS_PLAY_COMMAND. See README for command templates.",
				);
			}
			const command = config.playCommand ? customCommand(config.playCommand, { path }) : playerCommand(player, path);
			await run(command.command, command.args, signal, { kind: "play" });
		},

		async playStream(stream: ReadableStream<Uint8Array>, signal?: AbortSignal): Promise<void> {
			if (!streamingPlayer) {
				throw new Error(
					"No streaming audio player found. Install ffplay or sox (`play`) for low-latency TTS playback, or use file playback fallback.",
				);
			}
			const command = streamingPlayerCommand(streamingPlayer, config.ttsOutputCodec, config.ttsSampleRate);
			await pipeStreamToCommand(stream, command.command, command.args, signal);
		},

		async cleanup(path: string): Promise<void> {
			if (!config.deleteAudio) return;
			await rm(path, { force: true }).catch(() => undefined);
		},

		stopPlayback(): void {
			stopActiveAudioProcesses({ kind: "play" });
		},

		stopAll(): void {
			stopActiveAudioProcesses();
		},

		hasActivePlayback(): boolean {
			return hasActiveProcesses("play");
		},

		async waitForPlaybackIdle(timeoutMs = 30_000): Promise<void> {
			// Wait for the queue to drain and all active playback processes to finish
			const start = Date.now();
			const queueSnapshot = playbackQueue;
			await Promise.race([
				queueSnapshot.catch(() => {}),
				new Promise<void>((r) => setTimeout(r, timeoutMs)),
			]);
			// Also wait for any straggling processes
			while (hasActiveProcesses("play") && Date.now() - start < timeoutMs) {
				await new Promise((r) => setTimeout(r, 150));
			}
		},

		describe() {
			return { recorder: recorder ?? "missing", player: player ?? "missing", streamingPlayer: streamingPlayer ?? "missing" };
		},

		enqueuePlayback(fn: () => Promise<void>): Promise<void> {
			const gen = queueGeneration;
			const task = playbackQueue
				.catch(() => {}) // don't let prior failures block the queue
				.then(() => {
					if (queueGeneration !== gen) throw new Error("Playback cancelled"); // queue was interrupted since enqueue
					return fn();
				});
			playbackQueue = task;
			return task;
		},

		interruptPlayback(): void {
			queueGeneration++; // invalidate all pending tasks
			playbackQueue = Promise.resolve();
			stopActiveAudioProcesses({ kind: "play" });
		},
	};
}

type CommandSpec = { command: string; args: string[] };

function recorderCommand(recorder: string, path: string, seconds: number, sampleRate: number): CommandSpec {
	if (recorder === "rec") {
		return { command: "rec", args: ["-q", "-r", String(sampleRate), "-c", "1", "-b", "16", path, "trim", "0", String(seconds)] };
	}
	if (recorder === "ffmpeg-avfoundation") {
		return {
			command: "ffmpeg",
			args: ["-hide_banner", "-loglevel", "error", "-y", "-f", "avfoundation", "-i", ":0", "-t", String(seconds), "-ar", String(sampleRate), "-ac", "1", path],
		};
	}
	if (recorder === "ffmpeg-alsa") {
		return {
			command: "ffmpeg",
			args: ["-hide_banner", "-loglevel", "error", "-y", "-f", "alsa", "-i", "default", "-t", String(seconds), "-ar", String(sampleRate), "-ac", "1", path],
		};
	}
	if (recorder === "ffmpeg-pulse") {
		return {
			command: "ffmpeg",
			args: ["-hide_banner", "-loglevel", "error", "-y", "-f", "pulse", "-i", "default", "-t", String(seconds), "-ar", String(sampleRate), "-ac", "1", path],
		};
	}
	throw new Error(`Unsupported recorder: ${recorder}`);
}

function pcmStreamCommand(recorder: string, sampleRate: number): CommandSpec {
	if (recorder === "rec") {
		return { command: "rec", args: ["-q", "-r", String(sampleRate), "-c", "1", "-b", "16", "-e", "signed-integer", "-t", "raw", "-"] };
	}
	if (recorder === "ffmpeg-avfoundation") {
		return {
			command: "ffmpeg",
			args: ["-hide_banner", "-loglevel", "error", "-f", "avfoundation", "-i", ":0", "-ar", String(sampleRate), "-ac", "1", "-f", "s16le", "pipe:1"],
		};
	}
	if (recorder === "ffmpeg-alsa") {
		return {
			command: "ffmpeg",
			args: ["-hide_banner", "-loglevel", "error", "-f", "alsa", "-i", "default", "-ar", String(sampleRate), "-ac", "1", "-f", "s16le", "pipe:1"],
		};
	}
	if (recorder === "ffmpeg-pulse") {
		return {
			command: "ffmpeg",
			args: ["-hide_banner", "-loglevel", "error", "-f", "pulse", "-i", "default", "-ar", String(sampleRate), "-ac", "1", "-f", "s16le", "pipe:1"],
		};
	}
	throw new Error(`Unsupported streaming recorder: ${recorder}`);
}

function utteranceRecorderCommand(
	recorder: string,
	path: string,
	sampleRate: number,
	silenceStartSeconds: number,
	silenceStopSeconds: number,
	silenceThreshold: string,
 ): CommandSpec {
	if (recorder === "rec") {
		return {
			command: "rec",
			args: [
				"-q",
				"-r",
				String(sampleRate),
				"-c",
				"1",
				"-b",
				"16",
				path,
				"silence",
				"1",
				String(silenceStartSeconds),
				silenceThreshold,
				"1",
				String(silenceStopSeconds),
				silenceThreshold,
			],
		};
	}
	throw new Error(`Unsupported utterance recorder: ${recorder}`);
}

function playerCommand(player: string, path: string): CommandSpec {
	if (player === "afplay") return { command: "afplay", args: [path] };
	if (player === "play") return { command: "play", args: ["-q", path] };
	if (player === "ffplay") return { command: "ffplay", args: ["-nodisp", "-autoexit", "-loglevel", "error", path] };
	if (player === "aplay") return { command: "aplay", args: [path] };
	throw new Error(`Unsupported player: ${player}`);
}

function customCommand(template: string, values: Record<string, string | number>): CommandSpec {
	let command = template;
	for (const [key, value] of Object.entries(values)) {
		command = command.replaceAll(`{${key}}`, shellQuote(String(value)));
	}
	return { command: "sh", args: ["-lc", command] };
}

function detectRecorder(): string | null {
	if (isCommandAvailable("rec")) return "rec";
	if (isCommandAvailable("ffmpeg")) {
		if (process.platform === "darwin") return "ffmpeg-avfoundation";
		if (process.platform === "linux") return "ffmpeg-alsa";
	}
	return null;
}

function detectPlayer(): string | null {
	if (process.platform === "darwin" && isCommandAvailable("afplay")) return "afplay";
	if (isCommandAvailable("play")) return "play";
	if (isCommandAvailable("ffplay")) return "ffplay";
	if (isCommandAvailable("aplay")) return "aplay";
	return null;
}

function detectStreamingPlayer(): string | null {
	// SoX `play` tends to start consuming piped TTS audio with less probing/buffering
	// than ffplay. Prefer it for lower perceived voice_output latency when present.
	if (isCommandAvailable("play")) return "play";
	if (isCommandAvailable("ffplay")) return "ffplay";
	if (isCommandAvailable("aplay")) return "aplay";
	return null;
}

function isCommandAvailable(command: string): boolean {
	const paths = (process.env.PATH ?? "").split(":").filter(Boolean);
	for (const dir of paths) {
		try {
			accessSync(join(dir, command), constants.X_OK);
			return true;
		} catch {
			// keep looking
		}
	}
	return false;
}

function run(command: string, args: string[], signal?: AbortSignal, options: { timeoutMs?: number; resolveOnTimeout?: boolean; kind?: AudioProcessKind } = {}): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error("Cancelled"));
			return;
		}

		const child = spawnManaged(command, args, options.kind ?? "other");
		let stderr = "";
		let stdout = "";
		let timedOut = false;
		const timeout = options.timeoutMs
			? setTimeout(() => {
				timedOut = true;
				terminateChild(child);
			}, options.timeoutMs)
			: undefined;
		const onAbort = () => terminateChild(child);
		signal?.addEventListener("abort", onAbort, { once: true });

		child.stdout?.on("data", (chunk) => {
			stdout += chunk.toString();
		});
		child.stderr?.on("data", (chunk) => {
			stderr += chunk.toString();
		});

		const cleanup = () => {
			signal?.removeEventListener("abort", onAbort);
			if (timeout) clearTimeout(timeout);
		};

		child.on("error", (err) => {
			cleanup();
			reject(err);
		});
		child.on("close", (code, termSignal) => {
			cleanup();
			if (signal?.aborted) {
				reject(new Error("Cancelled"));
				return;
			}
			if (code === 0 || (timedOut && options.resolveOnTimeout)) {
				resolve();
				return;
			}
			const output = [stderr.trim(), stdout.trim()].filter(Boolean).join("\n");
			reject(new Error(`${command} failed${termSignal ? ` (${termSignal})` : ""}${code === null ? "" : ` with exit code ${code}`}${output ? `: ${output}` : ""}`));
		});
	});
}

async function* streamCommandOutput(command: string, args: string[], signal?: AbortSignal, kind: AudioProcessKind = "other"): AsyncIterable<Buffer> {
	if (signal?.aborted) throw new Error("Cancelled");
	const child = spawnManaged(command, args, kind);
	let stderr = "";
	let exitCode: number | null = null;
	let exitSignal: NodeJS.Signals | null = null;
	let spawnError: Error | undefined;

	const stop = () => terminateChild(child);
	signal?.addEventListener("abort", stop, { once: true });
	child.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
	child.on("error", (err) => { spawnError = err; });
	child.on("close", (code, termSignal) => { exitCode = code; exitSignal = termSignal; });

	try {
		if (!child.stdout) throw new Error(`${command} did not provide stdout for audio streaming`);
		for await (const chunk of child.stdout) {
			if (signal?.aborted) throw new Error("Cancelled");
			yield Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		}
		if (exitCode === null && !spawnError) await once(child, "close");
		if (signal?.aborted) throw new Error("Cancelled");
		if (spawnError) throw spawnError;
		if (exitCode !== 0) {
			const output = stderr.trim();
			throw new Error(`${command} failed${exitSignal ? ` (${exitSignal})` : ""}${exitCode === null ? "" : ` with exit code ${exitCode}`}${output ? `: ${output}` : ""}`);
		}
	} finally {
		signal?.removeEventListener("abort", stop);
		if (!child.killed && exitCode === null) stop();
	}
}

async function pipeStreamToCommand(stream: ReadableStream<Uint8Array>, command: string, args: string[], signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) throw new Error("Cancelled");
	const child = spawnManaged(command, args, "play", ["pipe", "pipe", "pipe"]);
	let stderr = "";
	let stdout = "";
	let exitCode: number | null = null;
	let exitSignal: NodeJS.Signals | null = null;
	let spawnError: Error | undefined;

	const stop = () => terminateChild(child);
	signal?.addEventListener("abort", stop, { once: true });
	child.stdout?.on("data", (chunk) => { stdout += chunk.toString(); });
	child.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
	child.on("error", (err) => { spawnError = err; });
	child.on("close", (code, termSignal) => { exitCode = code; exitSignal = termSignal; });

	try {
		if (!child.stdin) throw new Error(`${command} did not provide stdin for streaming audio playback`);
		const stdin = child.stdin;
		const reader = stream.getReader();
		try {
			while (true) {
				if (signal?.aborted) throw new Error("Cancelled");
				if (spawnError) throw spawnError;
				const { done, value } = await reader.read();
				if (done) break;
				if (!value?.byteLength) continue;
				if (!stdin.write(Buffer.from(value))) await once(stdin, "drain");
			}
		} finally {
			reader.releaseLock();
		}
		stdin.end();
		if (exitCode === null && !spawnError) await once(child, "close");
		if (signal?.aborted) throw new Error("Cancelled");
		if (spawnError) throw spawnError;
		if (exitCode !== 0) {
			const output = [stderr.trim(), stdout.trim()].filter(Boolean).join("\n");
			throw new Error(`${command} failed${exitSignal ? ` (${exitSignal})` : ""}${exitCode === null ? "" : ` with exit code ${exitCode}`}${output ? `: ${output}` : ""}`);
		}
	} finally {
		signal?.removeEventListener("abort", stop);
		if (!child.killed && exitCode === null) stop();
	}
}

function streamingPlayerCommand(player: string, codec: PiListensConfig["ttsOutputCodec"], sampleRate: number): CommandSpec {
	if (player === "ffplay") {
		const args = ["-nodisp", "-autoexit", "-loglevel", "error", "-fflags", "nobuffer", "-flags", "low_delay", "-probesize", "32", "-analyzeduration", "0"];
		if (codec === "linear16") args.push("-f", "s16le", "-ar", String(sampleRate), "-ac", "1");
		if (codec === "mulaw") args.push("-f", "mulaw", "-ar", String(sampleRate), "-ac", "1");
		if (codec === "alaw") args.push("-f", "alaw", "-ar", String(sampleRate), "-ac", "1");
		args.push("-i", "pipe:0");
		return { command: "ffplay", args };
	}
	if (player === "play") {
		if (codec === "linear16") return { command: "play", args: ["-q", "-r", String(sampleRate), "-c", "1", "-b", "16", "-e", "signed-integer", "-t", "raw", "-"] };
		if (codec === "mulaw" || codec === "alaw") return { command: "play", args: ["-q", "-r", String(sampleRate), "-c", "1", "-t", codec, "-"] };
		return { command: "play", args: ["-q", "-t", soxTypeForCodec(codec), "-"] };
	}
	if (player === "aplay" && codec === "wav") return { command: "aplay", args: ["-q", "-"] };
	throw new Error(`Unsupported streaming player ${player} for codec ${codec}`);
}

function soxTypeForCodec(codec: PiListensConfig["ttsOutputCodec"]): string {
	if (codec === "aac") return "adts";
	if (codec === "linear16") return "raw";
	return codec;
}

type AudioProcessKind = "record" | "play" | "other";

type ManagedChild = ReturnType<typeof spawn>;

const activeChildren = new Set<ManagedChild>();
const childKinds = new WeakMap<ManagedChild, AudioProcessKind>();
const terminatingChildren = new WeakSet<ManagedChild>();
let processExitCleanupInstalled = false;

export function stopActiveAudioProcesses(options: { kind?: AudioProcessKind; force?: boolean } = {}): void {
	for (const child of [...activeChildren]) {
		if (!options.kind || childKinds.get(child) === options.kind) terminateChild(child, options.force);
	}
}

function hasActiveProcesses(kind: AudioProcessKind): boolean {
	for (const child of activeChildren) {
		if (childKinds.get(child) === kind) return true;
	}
	return false;
}

function spawnManaged(command: string, args: string[], kind: AudioProcessKind, stdio: StdioOptions = ["ignore", "pipe", "pipe"]): ManagedChild {
	installProcessExitCleanup();
	const child = spawn(command, args, {
		stdio,
		detached: process.platform !== "win32",
	});
	activeChildren.add(child);
	childKinds.set(child, kind);
	const untrack = () => activeChildren.delete(child);
	child.once("close", untrack);
	child.once("error", untrack);
	return child;
}

function installProcessExitCleanup(): void {
	if (processExitCleanupInstalled) return;
	processExitCleanupInstalled = true;
	process.once("exit", () => stopActiveAudioProcesses({ force: true }));
}

function terminateChild(child: ManagedChild, force = false): void {
	if (child.exitCode !== null || child.signalCode !== null || terminatingChildren.has(child)) return;
	terminatingChildren.add(child);
	sendSignal(child, "SIGTERM");
	if (force) {
		sendSignal(child, "SIGKILL");
		return;
	}
	const killTimer = setTimeout(() => sendSignal(child, "SIGKILL"), 1500);
	killTimer.unref();
	child.once("close", () => clearTimeout(killTimer));
}

function sendSignal(child: ManagedChild, signal: NodeJS.Signals): void {
	try {
		if (process.platform !== "win32" && child.pid) {
			process.kill(-child.pid, signal);
			return;
		}
	} catch {
		// Fall through to direct child signaling; the process may already be gone.
	}
	try {
		child.kill(signal);
	} catch {
		// Best-effort cleanup only.
	}
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'"'"'`)}'`;
}
