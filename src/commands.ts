import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { VoiceToolServices } from "./tools.js";
import { conciseTranscript } from "./text.js";
import { audioExtensionForCodec } from "./config.js";
import { applyVoiceChrome, installVoiceUi, uninstallVoiceUi } from "./voice-ui.js";

export type VoiceLoopStatus = "idle" | "listening" | "agent" | "speaking" | "error";

export interface VoiceModeState {
	enabled: boolean;
	autoListen: boolean;
	isListening: boolean;
	status: VoiceLoopStatus;
	agentActive: boolean;
	activeSpeechCount: number;
	uiInstalled?: boolean;
	previousEditorFactory?: unknown;
	lastTranscript?: string;
	lastError?: string;
	recordSeconds?: number;
	silenceStopSeconds?: number;
	listenAbortController?: AbortController;
	speakAbortController?: AbortController;
}

export function registerVoiceCommands(pi: ExtensionAPI, services: VoiceToolServices, state: VoiceModeState) {
	pi.registerCommand("voice-init", {
		description: "Create a global pi-listens settings file at ~/.pi/pi-listens.json with sensible defaults",
		handler: async (args, ctx) => {
			await initSettings(services, ctx, args.includes("--overwrite"));
		},
	});

	pi.registerCommand("speak", {
		description: "Speak text with the configured voice TTS provider",
		handler: async (args, ctx) => {
			const text = args.trim();
			if (!text) {
				ctx.ui.notify("Usage: /speak <text>", "warning");
				return;
			}
			await speakText(services, text, ctx.signal);
		},
	});

	pi.registerCommand("voice-on", {
		description: "Enable hands-free voice loop with auto-listen. Use --manual to only listen on demand.",
		handler: async (args, ctx) => {
			state.enabled = true;
			state.autoListen = !args.includes("--manual");
			installVoiceUi(ctx, state, createVoiceUiCallbacks(pi, services, state, ctx));
			applyVoiceChrome(ctx, state);
			ctx.ui.notify("Voice mode enabled. Press Q in the voice panel to close it.", "info");
			prewarmVoiceProvider(services, ctx.signal);
			if (!args.includes("--no-listen")) await listenAndSend(pi, services, ctx, parseSeconds(args));
		},
	});


	pi.registerCommand("voice-check", {
		description: "Check pi-listens setup: provider credentials, recorder, player, and voice-mode status",
		handler: async (_args, ctx) => {
			const config = services.getConfig();
			const audio = services.getAudio().describe();
			const provider = services.getSpeech().describe();
			const ready = provider.authConfigured && audio.recorder !== "missing" && audio.player !== "missing";
			ctx.ui.notify(
				[
					ready ? "✓ pi-listens is ready." : "⚠ pi-listens needs attention.",
					"",
					`Provider: ${provider.name}`,
					`${provider.authLabel}: ${provider.authStatus}`,
					`Recorder: ${audio.recorder}`,
					`Player: ${audio.player}`,
					`Streaming player: ${audio.streamingPlayer}`,
					`STT: ${provider.sttSummary}`,
					`TTS: ${provider.ttsSummary}`,
					"",
					`Voice mode: ${state.enabled ? "on" : "off"}`,
					`Auto-listen: ${state.autoListen ? "on" : "off"}`,
					`Conversational: ${config.conversational ? "on" : "off"}`,
				].join("\n"),
				ready ? "info" : "warning",
			);
		},
	});

	pi.registerCommand("voice-chatty", {
		description: "Toggle conversational mode. When on, the agent speaks its responses and thinks out loud instead of only writing text.",
		handler: async (_args, ctx) => {
			const config = services.getConfig();
			(config as unknown as Record<string, unknown>).conversational = !config.conversational;
			const mode = config.conversational ? "on" : "off";
			ctx.ui.notify(`Conversational mode: ${mode}. ${config.conversational ? "The agent will speak its responses." : "The agent will write text and speak only for status updates."}`, "info");
		},
	});
}


async function initSettings(services: VoiceToolServices, ctx: ExtensionCommandContext, overwrite: boolean) {
	const dir = join(homedir(), ".pi");
	const filePath = join(dir, "pi-listens.json");

	if (existsSync(filePath) && !overwrite) {
		const existing = readFileSync(filePath, "utf8");
		let parsed: Record<string, unknown> = {};
		try { parsed = JSON.parse(existing) as Record<string, unknown>; } catch { /* ignore */ }
		const provider = services.getSpeech().describe();
		const hasCredential = providerHasConfiguredCredential(parsed, provider.configTemplate);
		ctx.ui.notify(
			[
				`Settings file already exists: ${filePath}`,
				`${provider.authLabel}: ${hasCredential ? "set" : "not yet configured"}`,
				"",
				"Use /voice-init --overwrite to replace it with fresh defaults.",
			].join("\n"),
			"info",
		);
		return;
	}

	await mkdir(dir, { recursive: true });
	const provider = services.getSpeech().describe();
	await writeFile(filePath, `${JSON.stringify(provider.configTemplate, null, 2)}\n`, "utf8");

	const audio = services.getAudio().describe();
	ctx.ui.notify(
		[
			`✓ Created settings file: ${filePath}`,
			"",
			...provider.setupInstructions,
			"",
			`Recorder: ${audio.recorder}`,
			`Player: ${audio.player}`,
			audio.recorder === "missing" || audio.player === "missing"
				? "⚠ Install SoX (rec/play) or ffmpeg for microphone and audio playback."
				: "✓ Audio recorder and player detected.",
		].join("\n"),
		"info",
	);
}

function prewarmVoiceProvider(services: VoiceToolServices, signal?: AbortSignal) {
	void services.getSpeech().prewarmTts?.(signal).catch(() => undefined);
}

function providerHasConfiguredCredential(config: Record<string, unknown>, template: Record<string, unknown>): boolean {
	const credentialKeys = new Set([
		"apiKey",
		...Object.keys(template).filter((key) => /(?:apiKey|token|secret|credential)$/i.test(key)),
	]);
	for (const key of credentialKeys) {
		const value = config[key];
		if (typeof value !== "string" || !value.trim()) continue;
		if (value === template[key]) continue;
		return true;
	}
	return false;
}
export async function maybeContinueVoiceLoop(pi: ExtensionAPI, services: VoiceToolServices, state: VoiceModeState, ctx: ExtensionContext) {
	if (!state.enabled || state.isListening) return;
	if (!state.autoListen) { state.status = "idle"; applyVoiceChrome(ctx, state); return; }
	// Wait for any in-flight tool-initiated playback to finish before opening the mic
	await waitForPlaybackIdle(services);
	ctx.ui.notify("Listening for your next instruction…", "info");
	await listenAndSend(pi, services, ctx, undefined, { followUpWhenBusy: true });
}

async function listenAndSend(
	pi: ExtensionAPI,
	services: VoiceToolServices,
	ctx: ExtensionContext | ExtensionCommandContext,
	seconds: number | undefined,
	options: { followUpWhenBusy?: boolean } = {},
) {
	const state = getStateFromServices(services);
	if (state.isListening) {
		state.listenAbortController?.abort();
		return;
	}
	state.recordSeconds = seconds ?? services.getConfig().recordSeconds;
	state.silenceStopSeconds = services.getConfig().silenceStopSeconds;
	state.isListening = true;
	state.status = "listening";
	state.lastError = undefined;
	// Mark listening before touching playback so any just-queued speech sees the
	// listening state and waits instead of resolving as a skipped "spoke" call.
	pauseSpeakingForListening(services, state);
	const listenAbortController = new AbortController();
	state.listenAbortController = listenAbortController;
	const listenSignal = combineSignals(ctx.signal, listenAbortController.signal);
	applyVoiceChrome(ctx, state);
	if (ctx.hasUI) ctx.ui.setStatus("pi-listens", "listening…");
	let transcript = "";
	try {
		const result = await services.getSpeech().transcribeMicrophone(services.getAudio(), listenSignal.signal, {
			seconds: seconds ?? services.getConfig().recordSeconds,
			mode: services.getConfig().translateInputToEnglish ? "translate" : services.getConfig().sttMode,
		});
		transcript = result.transcript.trim();

		if (!transcript && services.getConfig().textFallback && ctx.hasUI) {
			const typed = await ctx.ui.input("I did not catch that. Type your message:", "Type a message for pi");
			transcript = typed?.trim() ?? "";
		}

		if (!transcript) {
			ctx.ui.notify("No speech recognized.", "warning");
			return;
		}

		ctx.ui.notify(`Heard: ${conciseTranscript(transcript)}`, "info");
		state.lastTranscript = transcript;
		state.status = "agent";
		applyVoiceChrome(ctx, state);
		if (ctx.isIdle()) {
			pi.sendUserMessage(transcript);
		} else {
			pi.sendUserMessage(transcript, { deliverAs: options.followUpWhenBusy ? "followUp" : "steer" });
		}
	} catch (err) {
		if (isCancelled(err)) {
			state.status = "idle";
			state.lastError = undefined;
			if (state.enabled) ctx.ui.notify("Listening cancelled.", "info");
		} else {
			state.status = "error"; state.lastError = errorMessage(err); ctx.ui.notify(`pi-listens failed: ${errorMessage(err)}`, "error");
		}
	} finally {
		listenSignal.cleanup();
		state.isListening = false;
		if (state.listenAbortController === listenAbortController) state.listenAbortController = undefined;
		if (state.status !== "agent" && state.status !== "error") state.status = "idle";
		applyVoiceChrome(ctx, state);
	}
}

async function speakText(services: VoiceToolServices, text: string, signal?: AbortSignal) {
	// Interrupt any queued/in-flight playback before starting command-initiated speech
	services.getAudio().interruptPlayback();
	await playSpeechBest(services, text, signal);
}

async function waitForPlaybackIdle(services: VoiceToolServices): Promise<void> {
	await services.getAudio().waitForPlaybackIdle();
}

async function playSpeechBest(services: VoiceToolServices, text: string, signal?: AbortSignal) {
	const audio = services.getAudio();
	if (audio.describe().streamingPlayer !== "missing") {
		const result = await services.getSpeech().synthesizeStream(text, signal);
		await services.waitForListeningIdle?.(signal);
		await audio.playStream(result.stream, signal);
		return;
	}

	const config = services.getConfig();
	await mkdir(config.audioDir, { recursive: true });
	const path = join(config.audioDir, `pi-listens-command-${Date.now()}.${audioExtensionForCodec(config.ttsOutputCodec)}`);
	try {
		const result = await services.getSpeech().synthesizeToFile(text, path, signal);
		await services.waitForListeningIdle?.(signal);
		await audio.play(result.path, signal);
	} finally {
		await audio.cleanup(path);
	}
}

function parseSeconds(args: string): number | undefined {
	const match = args.match(/(?:^|\s)(\d{1,4})(?:\s|$)/);
	if (!match) return undefined;
	const parsed = Number.parseInt(match[1]!, 10);
	return Number.isFinite(parsed) ? Math.max(1, Math.min(3600, parsed)) : undefined;
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function createVoiceUiCallbacks(pi: ExtensionAPI, services: VoiceToolServices, state: VoiceModeState, ctx: ExtensionContext | ExtensionCommandContext) {
	return {
		startListening: () => { void listenAndSend(pi, services, ctx, undefined); },
		disable: () => {
			stopVoiceMode(services, state, ctx);
		},
		toggleAutoListen: () => { state.autoListen = !state.autoListen; applyVoiceChrome(ctx, state); },
	};
}

type CombinedSignal = { signal?: AbortSignal; cleanup: () => void };

function combineSignals(...signals: Array<AbortSignal | undefined>): CombinedSignal {
	const active = signals.filter((signal): signal is AbortSignal => Boolean(signal));
	if (active.length === 0) return { signal: undefined, cleanup: () => undefined };
	if (active.length === 1) return { signal: active[0], cleanup: () => undefined };
	const controller = new AbortController();
	const attached: AbortSignal[] = [];
	const abort = () => controller.abort();
	for (const signal of active) {
		if (signal.aborted) { controller.abort(); break; }
		signal.addEventListener("abort", abort, { once: true });
		attached.push(signal);
	}
	return {
		signal: controller.signal,
		cleanup: () => {
			for (const signal of attached) signal.removeEventListener("abort", abort);
		},
	};
}

function isCancelled(err: unknown): boolean {
	return err instanceof Error && /cancelled|aborted/i.test(err.message);
}

function stopSpeaking(services: VoiceToolServices, state: VoiceModeState) {
	const speakAbortController = state.speakAbortController;
	state.speakAbortController = undefined;
	speakAbortController?.abort();
	services.resetSpeechCount?.();
	services.getAudio().interruptPlayback();
}

function pauseSpeakingForListening(services: VoiceToolServices, state: VoiceModeState) {
	const speakAbortController = state.speakAbortController;
	state.speakAbortController = undefined;
	speakAbortController?.abort();
	services.resetSpeechCount?.();
	services.notifySpeaking?.(false);
	services.getAudio().stopPlayback();
}

export function stopVoiceMode(services: VoiceToolServices, state: VoiceModeState, ctx?: ExtensionContext | ExtensionCommandContext) {
	state.enabled = false;
	state.autoListen = false;
	state.isListening = false;
	state.status = "idle";
	state.lastError = undefined;

	const listenAbortController = state.listenAbortController;
	state.listenAbortController = undefined;
	listenAbortController?.abort();

	stopSpeaking(services, state);
	services.getAudio().interruptPlayback();
	services.getAudio().stopAll();

	if (ctx) uninstallVoiceUi(ctx, state);
}

const serviceState = new WeakMap<VoiceToolServices, VoiceModeState>();
const serviceCtx = new WeakMap<VoiceToolServices, ExtensionContext>();

export function attachStateToServices(services: VoiceToolServices, state: VoiceModeState) {
	serviceState.set(services, state);
	services.isListening = () => state.isListening;
	services.waitForListeningIdle = (signal?: AbortSignal) => waitForListeningIdle(state, signal);
	services.notifyListening = (listening) => {
		if (!state.enabled) return;
		state.isListening = listening;
		if (listening) {
			state.status = "listening";
		} else if (state.status === "listening") {
			state.status = state.agentActive ? "agent" : "idle";
		}
		const ctx = serviceCtx.get(services);
		if (ctx) applyVoiceChrome(ctx, state);
	};
	services.notifySpeaking = (speaking) => {
		if (!state.enabled) return;
		if (state.isListening) {
			// Listening always wins over speaking in the UI/state machine. Tool-initiated
			// speech is queued behind listening, so this mostly protects older in-flight calls.
			state.status = "listening";
		} else if (speaking) {
			state.status = "speaking";
		} else if (state.status === "speaking") {
			// Go back to agent-working if still mid-turn, idle otherwise
			state.status = state.agentActive ? "agent" : "idle";
		}
		const ctx = serviceCtx.get(services);
		if (ctx) applyVoiceChrome(ctx, state);
	};
}

export function updateServiceContext(services: VoiceToolServices, ctx: ExtensionContext) {
	serviceCtx.set(services, ctx);
}

function getStateFromServices(services: VoiceToolServices): VoiceModeState {
	const state = serviceState.get(services);
	if (!state) throw new Error("voice mode state not attached");
	return state;
}

async function waitForListeningIdle(state: VoiceModeState, signal?: AbortSignal): Promise<void> {
	while (state.isListening) {
		if (signal?.aborted) throw new Error("Cancelled");
		await delay(50, signal);
	}
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error("Cancelled"));
			return;
		}
		const cleanup = () => signal?.removeEventListener("abort", onAbort);
		const timeout = setTimeout(() => {
			cleanup();
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timeout);
			cleanup();
			reject(new Error("Cancelled"));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}
