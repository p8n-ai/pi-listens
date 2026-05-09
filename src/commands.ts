import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { VoiceToolServices } from "./tools.js";
import { conciseTranscript, prepareSpokenText } from "./text.js";
import { audioExtensionForCodec } from "./config.js";
import { applyVoiceChrome, installVoiceUi, uninstallVoiceUi } from "./voice-ui.js";

export type VoiceLoopStatus = "idle" | "listening" | "transcribing" | "agent" | "speaking" | "error";

export interface VoiceModeState {
	enabled: boolean;
	autoListen: boolean;
	autoSpeakAssistant: boolean;
	isListening: boolean;
	status: VoiceLoopStatus;
	uiInstalled?: boolean;
	previousEditorFactory?: unknown;
	lastAssistantText?: string;
	lastTranscript?: string;
	lastError?: string;
	recordSeconds?: number;
	silenceStopSeconds?: number;
	listenAbortController?: AbortController;
	speakAbortController?: AbortController;
}

export function registerVoiceCommands(pi: ExtensionAPI, services: VoiceToolServices, state: VoiceModeState) {
	pi.registerCommand("listen", {
		description: "Record speech, transcribe with Sarvam AI, and send it to pi as a user message",
		handler: async (args, ctx) => {
			await listenAndSend(pi, services, ctx, parseSeconds(args));
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
		description: "Enable hands-free voice loop. Use --speak to read short assistant replies aloud.",
		handler: async (args, ctx) => {
			state.enabled = true;
			if (args.includes("--speak")) state.autoSpeakAssistant = true;
			if (args.includes("--no-speak")) state.autoSpeakAssistant = false;
			state.autoListen = !args.includes("--manual");
			installVoiceUi(ctx, state, createVoiceUiCallbacks(pi, services, state, ctx));
			applyVoiceChrome(ctx, state);
			ctx.ui.notify("Voice mode enabled. Press Q in the voice panel to close it.", "info");
			if (!args.includes("--no-listen")) await listenAndSend(pi, services, ctx, parseSeconds(args));
		},
	});


	pi.registerCommand("voice-status", {
		description: "Show pi-listens Sarvam AI, recorder, player, and voice-mode status",
		handler: async (_args, ctx) => {
			const config = services.getConfig();
			const audio = services.getAudio().describe();
			ctx.ui.notify(
				[
					`Voice mode: ${state.enabled ? "on" : "off"}`,
					`Auto-speak assistant: ${state.autoSpeakAssistant ? "on" : "off"}`,
					`Auto-listen: ${state.autoListen ? "on" : "off"}`,
					`Status: ${state.status}`,
					`Sarvam API key: ${config.apiKey ? "set" : "missing"}`,
					`Recorder: ${audio.recorder}`,
					`Player: ${audio.player}`,
					`STT: ${config.sttModel} (${config.translateInputToEnglish ? "translate→English" : config.sttMode}, ${config.sttLanguageCode})`,
					`TTS: ${config.ttsModel} (${config.ttsLanguageCode}, speaker ${config.ttsSpeaker})`,
				].join("\n"),
				config.apiKey && audio.recorder !== "missing" && audio.player !== "missing" ? "info" : "warning",
			);
		},
	});
}

export async function maybeContinueVoiceLoop(pi: ExtensionAPI, services: VoiceToolServices, state: VoiceModeState, ctx: ExtensionContext) {
	if (!state.enabled || state.isListening) return;
	if (state.autoSpeakAssistant && state.lastAssistantText) {
		const spoken = prepareSpokenText(state.lastAssistantText, services.getConfig().maxAutoSpeakChars);
		if (spoken) {
			try {
				await speakText(services, spoken, ctx.signal, state, ctx);
			} catch (err) {
				if (isCancelled(err)) {
					state.status = "idle";
					state.lastError = undefined;
					applyVoiceChrome(ctx, state);
					return;
				}
				state.status = "error";
				state.lastError = errorMessage(err);
				applyVoiceChrome(ctx, state);
				ctx.ui.notify(`pi-listens could not speak assistant response: ${errorMessage(err)}`, "warning");
			}
		}
	}
	if (!state.enabled || !state.autoListen) { state.status = "idle"; applyVoiceChrome(ctx, state); return; }
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

async function speakText(services: VoiceToolServices, text: string, signal?: AbortSignal, state?: VoiceModeState, ctx?: ExtensionContext) {
	const config = services.getConfig();
	const speakAbortController = state ? new AbortController() : undefined;
	const speakSignal = combineSignals(signal, speakAbortController?.signal);
	let path: string | undefined;

	if (state) {
		state.speakAbortController?.abort();
		state.speakAbortController = speakAbortController;
		state.status = "speaking";
		if (ctx) applyVoiceChrome(ctx, state);
	}

	try {
		await mkdir(config.audioDir, { recursive: true });
		path = join(config.audioDir, `pi-listens-command-${Date.now()}.${audioExtensionForCodec(config.ttsOutputCodec)}`);
		const result = await services.getSpeech().synthesizeToFile(text, path, speakSignal.signal);
		path = result.path;
		await services.getAudio().play(result.path, speakSignal.signal);
	} finally {
		speakSignal.cleanup();
		if (path) await services.getAudio().cleanup(path);
		if (state && state.speakAbortController === speakAbortController) state.speakAbortController = undefined;
		if (state && state.status === "speaking") {
			state.status = "idle";
			if (ctx) applyVoiceChrome(ctx, state);
		}
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
		toggleSpeak: () => { state.autoSpeakAssistant = !state.autoSpeakAssistant; applyVoiceChrome(ctx, state); },
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

export function stopVoiceMode(services: VoiceToolServices, state: VoiceModeState, ctx?: ExtensionContext | ExtensionCommandContext) {
	state.enabled = false;
	state.autoListen = false;
	state.isListening = false;
	state.status = "idle";
	state.lastError = undefined;

	const listenAbortController = state.listenAbortController;
	state.listenAbortController = undefined;
	listenAbortController?.abort();

	const speakAbortController = state.speakAbortController;
	state.speakAbortController = undefined;
	speakAbortController?.abort();

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
