import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { VoiceToolServices } from "./tools.js";
import { conciseTranscript } from "./text.js";
import { audioExtensionForCodec, maskSecret } from "./config.js";
import { applyVoiceChrome, installVoiceUi, uninstallVoiceUi } from "./voice-ui.js";

export type VoiceLoopStatus = "idle" | "listening" | "transcribing" | "agent" | "speaking" | "error";

export interface VoiceModeState {
	enabled: boolean;
	autoListen: boolean;
	isListening: boolean;
	status: VoiceLoopStatus;
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
	pi.registerCommand("init", {
		description: "Create a global pi-listens settings file at ~/.pi/pi-listens.json with sensible defaults",
		handler: async (args, ctx) => {
			await initSettings(services, ctx, args.includes("--overwrite"));
		},
	});

	pi.registerCommand("speak", {
		description: "Speak text with Sarvam AI TTS",
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
			if (!args.includes("--no-listen")) await listenAndSend(pi, services, ctx, parseSeconds(args));
		},
	});


	pi.registerCommand("voice-check", {
		description: "Check pi-listens setup: Sarvam AI key, recorder, player, and voice-mode status",
		handler: async (_args, ctx) => {
			const config = services.getConfig();
			const audio = services.getAudio().describe();
			const ready = Boolean(config.apiKey) && audio.recorder !== "missing" && audio.player !== "missing";
			ctx.ui.notify(
				[
					ready ? "✓ pi-listens is ready." : "⚠ pi-listens needs attention.",
					"",
					`Sarvam API key: ${maskSecret(config.apiKey)}`,
					`Recorder: ${audio.recorder}`,
					`Player: ${audio.player}`,
					`Streaming player: ${audio.streamingPlayer}`,
					`STT: ${config.sttModel} (${config.translateInputToEnglish ? "translate→English" : config.sttMode}, ${config.sttLanguageCode})`,
					`TTS: ${config.ttsModel} (${config.ttsLanguageCode}, speaker ${config.ttsSpeaker})`,
					"",
					`Voice mode: ${state.enabled ? "on" : "off"}`,
					`Auto-listen: ${state.autoListen ? "on" : "off"}`,
				].join("\n"),
				ready ? "info" : "warning",
			);
		},
	});
}

const INIT_SETTINGS_TEMPLATE = {
	apiKey: "paste-your-sarvam-api-key-here",
	sttModel: "saaras:v3",
	sttMode: "transcribe",
	sttLanguageCode: "unknown",
	translateInputToEnglish: true,
	ttsModel: "bulbul:v3",
	ttsLanguageCode: "en-IN",
	ttsSpeaker: "shubh",
	recordSeconds: 300,
	recordSampleRate: 16000,
	streamChunkMs: 250,
	streamMaxSeconds: 300,
	silenceStartSeconds: 0.2,
	silenceStopSeconds: 3.5,
	silenceThreshold: "1%",
	ttsSampleRate: 24000,
	ttsOutputCodec: "wav",
	textFallback: true,
};

async function initSettings(services: VoiceToolServices, ctx: ExtensionCommandContext, overwrite: boolean) {
	const dir = join(homedir(), ".pi");
	const filePath = join(dir, "pi-listens.json");

	if (existsSync(filePath) && !overwrite) {
		const existing = readFileSync(filePath, "utf8");
		let parsed: Record<string, unknown> = {};
		try { parsed = JSON.parse(existing) as Record<string, unknown>; } catch { /* ignore */ }
		const hasKey = typeof parsed.apiKey === "string" && parsed.apiKey !== "paste-your-sarvam-api-key-here" && parsed.apiKey.length > 0;
		ctx.ui.notify(
			[
				`Settings file already exists: ${filePath}`,
				hasKey ? "Sarvam API key: set" : "Sarvam API key: not yet configured",
				"",
				"Use /init --overwrite to replace it with fresh defaults.",
			].join("\n"),
			"info",
		);
		return;
	}

	await mkdir(dir, { recursive: true });
	await writeFile(filePath, `${JSON.stringify(INIT_SETTINGS_TEMPLATE, null, 2)}\n`, "utf8");

	const audio = services.getAudio().describe();
	ctx.ui.notify(
		[
			`✓ Created settings file: ${filePath}`,
			"",
			"Next step: open the file and replace the apiKey value with your Sarvam AI API key.",
			"Get a key at: https://dashboard.sarvam.ai",
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
	stopSpeaking(services, state);
	state.recordSeconds = seconds ?? services.getConfig().recordSeconds;
	state.silenceStopSeconds = services.getConfig().silenceStopSeconds;
	state.isListening = true;
	state.status = "listening";
	state.lastError = undefined;
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
	// Stop any in-flight playback before starting new speech
	services.getAudio().stopPlayback();
	await playSpeechBest(services, text, signal);
}

async function waitForPlaybackIdle(services: VoiceToolServices): Promise<void> {
	await services.getAudio().waitForPlaybackIdle();
}

async function playSpeechBest(services: VoiceToolServices, text: string, signal?: AbortSignal) {
	const audio = services.getAudio();
	if (audio.describe().streamingPlayer !== "missing") {
		const result = await services.getSpeech().synthesizeStream(text, signal);
		await audio.playStream(result.stream, signal);
		return;
	}

	const config = services.getConfig();
	await mkdir(config.audioDir, { recursive: true });
	const path = join(config.audioDir, `pi-listens-command-${Date.now()}.${audioExtensionForCodec(config.ttsOutputCodec)}`);
	try {
		const result = await services.getSpeech().synthesizeToFile(text, path, signal);
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
	services.getAudio().stopAll();

	if (ctx) uninstallVoiceUi(ctx, state);
}

const serviceState = new WeakMap<VoiceToolServices, VoiceModeState>();

export function attachStateToServices(services: VoiceToolServices, state: VoiceModeState) {
	serviceState.set(services, state);
}

function getStateFromServices(services: VoiceToolServices): VoiceModeState {
	const state = serviceState.get(services);
	if (!state) throw new Error("voice mode state not attached");
	return state;
}
