import { mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { AgentToolUpdateCallback, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { AudioRuntime } from "./audio.js";
import { audioExtensionForCodec, type PiListensConfig } from "./config.js";
import type { SarvamSpeechClient, TranscriptionResult } from "./sarvam.js";
import { conciseTranscript } from "./text.js";

export interface VoiceToolServices {
	getConfig: () => PiListensConfig;
	getAudio: () => AudioRuntime;
	getSpeech: () => SarvamSpeechClient;
}

const VoiceOutputParams = Type.Object({
	text: Type.String({ description: "Short text to speak to the user. Keep it concise; do not speak code blocks or long logs." }),
	wait_for_playback: Type.Optional(Type.Boolean({ description: "Wait until audio playback completes before returning. Default true." })),
});

const VoiceInputParams = Type.Object({
	seconds: Type.Optional(Type.Number({ description: "Maximum listening time in seconds. Streaming STT stops earlier after a sustained pause.", minimum: 1, maximum: 3600 })),
	text_fallback: Type.Optional(Type.Boolean({ description: "If speech is not recognized and UI is available, ask the user to type. Default true." })),
});

const VoiceAskParams = Type.Object({
	question: Type.String({ description: "Short question to speak to the user before listening." }),
	seconds: Type.Optional(Type.Number({ description: "Maximum listening time in seconds. Streaming STT stops earlier after a sustained pause.", minimum: 1, maximum: 3600 })),
	text_fallback: Type.Optional(Type.Boolean({ description: "If speech is not recognized and UI is available, ask the user to type. Default true." })),
});

const VoiceTranscribeParams = Type.Object({
	path: Type.String({ description: "Path to an audio file to transcribe with Sarvam AI." }),
});

const SetupCheckParams = Type.Object({});

type VoiceOutputInput = { text: string; wait_for_playback?: boolean };
type VoiceInputInput = { seconds?: number; text_fallback?: boolean };
type VoiceAskInput = { question: string; seconds?: number; text_fallback?: boolean };
type VoiceTranscribeInput = { path: string };

export function registerVoiceTools(pi: ExtensionAPI, services: VoiceToolServices) {
	pi.registerTool({
		name: "voice_output",
		label: "Voice Output",
		description: "Speak a short message to the user using Sarvam AI text-to-speech and local audio playback.",
		promptSnippet: "Speak short user-facing messages with Sarvam AI TTS",
		promptGuidelines: [
			"Use voice_output only when a spoken user-facing message matters, especially before waiting for voice input.",
			"Keep voice_output to 1-2 short conversational sentences. Do not speak headings, hashtags, bullet lists, boilerplate recaps, code, command output, stack traces, or long explanations.",
		],
		parameters: VoiceOutputParams,
		async execute(_toolCallId, params: VoiceOutputInput, signal, onUpdate) {
			onUpdate?.({ content: [{ type: "text", text: "Synthesizing speech with Sarvam AI…" }], details: {} });
			const result = await speak(params.text, services, signal);
			const playback = services.getAudio().play(result.path, signal).finally(() => services.getAudio().cleanup(result.path));
			if (params.wait_for_playback === false) {
				void playback.catch(() => undefined);
				return {
					content: [{ type: "text", text: `Started speaking to user: ${params.text}` }],
					details: { ...result, played: "started", text: params.text },
				};
			}
			onUpdate?.({ content: [{ type: "text", text: "Playing audio…" }], details: {} });
			await playback;
			return {
				content: [{ type: "text", text: `Spoke to user: ${params.text}` }],
				details: { ...result, played: true, text: params.text },
			};
		},
		renderCall(args: VoiceOutputInput, theme) {
			return new Text(`${theme.fg("toolTitle", theme.bold("voice_output "))}${theme.fg("muted", quote(args.text))}`, 0, 0);
		},
		renderResult(result, _options, theme) {
			const details = result.details as { text?: string; played?: boolean | "started" } | undefined;
			const label = details?.played === "started" ? "speaking" : details?.played === false ? "prepared" : "spoke";
			return new Text(`${theme.fg("success", "✓")} ${label}${details?.text ? ` ${theme.fg("dim", quote(details.text))}` : ""}`, 0, 0);
		},
	});

	pi.registerTool({
		name: "voice_input",
		label: "Voice Input",
		description: "Listen to the user's microphone, transcribe speech with Sarvam AI, and return the transcript. Use only after the user knows you are listening.",
		promptSnippet: "Listen to microphone and transcribe user speech with Sarvam AI STT",
		promptGuidelines: [
			"Use voice_input only after the user has been told you are listening; if you need to ask a question, prefer voice_ask.",
			"Treat voice_input transcripts as user input. If the transcript is empty, ask again or provide a text fallback.",
		],
		parameters: VoiceInputParams,
		async execute(_toolCallId, params: VoiceInputInput, signal, onUpdate, ctx) {
			const answer = await listenAndMaybeFallback(params, services, signal, onUpdate, ctx, "I did not catch that. Type your response:");
			return transcriptResult(answer, "User said");
		},
		renderCall(args: VoiceInputInput, theme) {
			return new Text(`${theme.fg("toolTitle", theme.bold("voice_input "))}${theme.fg("muted", `${args.seconds ?? services.getConfig().recordSeconds}s`)}`, 0, 0);
		},
		renderResult(result, _options, theme) {
			const details = result.details as { transcript?: string; fromTextFallback?: boolean } | undefined;
			const prefix = details?.fromTextFallback ? "typed" : "heard";
			return new Text(`${theme.fg("success", "✓")} ${prefix}: ${theme.fg("accent", details?.transcript ?? "")}`, 0, 0);
		},
	});

	pi.registerTool({
		name: "voice_ask",
		label: "Voice Ask",
		description: "Speak a question with Sarvam AI TTS, then listen to the microphone and transcribe the user's answer with Sarvam AI STT.",
		promptSnippet: "Ask the user a spoken question and listen for the answer",
		promptGuidelines: [
			"Use voice_ask whenever you need clarification, confirmation, or any user input in a voice-first session; do not ask only in text.",
			"Make voice_ask questions concise and answerable in one short spoken response.",
		],
		parameters: VoiceAskParams,
		async execute(_toolCallId, params: VoiceAskInput, signal, onUpdate, ctx) {
			onUpdate?.({ content: [{ type: "text", text: "Speaking question…" }], details: {} });
			const spoken = await speak(params.question, services, signal);
			try {
				await services.getAudio().play(spoken.path, signal);
			} finally {
				await services.getAudio().cleanup(spoken.path);
			}
			const answer = await listenAndMaybeFallback(
				params,
				services,
				signal,
				onUpdate,
				ctx,
				"I did not catch your spoken answer. Type your response:",
			);
			return transcriptResult({ ...answer, question: params.question }, "User answered");
		},
		renderCall(args: VoiceAskInput, theme) {
			return new Text(`${theme.fg("toolTitle", theme.bold("voice_ask "))}${theme.fg("muted", quote(args.question))}`, 0, 0);
		},
		renderResult(result, _options, theme) {
			const details = result.details as { transcript?: string; fromTextFallback?: boolean } | undefined;
			const prefix = details?.fromTextFallback ? "typed" : "answered";
			return new Text(`${theme.fg("success", "✓")} ${prefix}: ${theme.fg("accent", details?.transcript ?? "")}`, 0, 0);
		},
	});

	pi.registerTool({
		name: "voice_transcribe_file",
		label: "Voice Transcribe File",
		description: "Transcribe an existing audio file with Sarvam AI speech-to-text.",
		parameters: VoiceTranscribeParams,
		async execute(_toolCallId, params: VoiceTranscribeInput, signal) {
			const path = params.path.startsWith("@") ? params.path.slice(1) : params.path;
			const result = await services.getSpeech().transcribeFile(path, signal);
			return transcriptResult({ ...result, audioPath: path, fromTextFallback: false }, "Transcript");
		},
	});

	pi.registerTool({
		name: "voice_setup_check",
		label: "Voice Setup Check",
		description: "Check pi-listens Sarvam AI key, microphone recorder, audio player, and default voice settings.",
		parameters: SetupCheckParams,
		async execute() {
			const config = services.getConfig();
			const audio = services.getAudio().describe();
			const ok = Boolean(config.apiKey) && audio.recorder !== "missing" && audio.player !== "missing";
			return {
				content: [
					{
						type: "text",
						text: [
							ok ? "pi-listens setup looks ready." : "pi-listens setup needs attention.",
							`Sarvam API key: ${config.apiKey ? "set" : "missing"}`,
							`Recorder: ${audio.recorder}`,
							`Player: ${audio.player}`,
							`STT: ${config.sttModel} (${config.translateInputToEnglish ? "translate→English" : config.sttMode}, ${config.sttLanguageCode})`,
							`TTS: ${config.ttsModel} (${config.ttsLanguageCode}, speaker ${config.ttsSpeaker})`,
						].join("\n"),
					},
				],
				details: { ok, config: { ...config, apiKey: config.apiKey ? "set" : "missing" }, audio },
			};
		},
	});
}

async function speak(text: string, services: VoiceToolServices, signal?: AbortSignal) {
	const config = services.getConfig();
	await mkdir(config.audioDir, { recursive: true });
	const path = join(config.audioDir, `pi-listens-output-${Date.now()}-${randomUUID()}.${audioExtensionForCodec(config.ttsOutputCodec)}`);
	return services.getSpeech().synthesizeToFile(text, path, signal);
}

async function listenAndMaybeFallback(
	params: { seconds?: number; text_fallback?: boolean },
	services: VoiceToolServices,
	signal: AbortSignal | undefined,
	onUpdate: AgentToolUpdateCallback<unknown> | undefined,
	ctx: ExtensionContext,
	fallbackPrompt: string,
): Promise<TranscriptionResult & { audioPath?: string; fromTextFallback: boolean }> {
	const config = services.getConfig();
	const seconds = clampSeconds(params.seconds ?? config.recordSeconds);
	onUpdate?.({ content: [{ type: "text", text: `Streaming microphone audio to Sarvam for up to ${seconds}s…` }], details: {} });
	const result = await services.getSpeech().transcribeMicrophone(services.getAudio(), signal, {
		seconds,
		mode: config.translateInputToEnglish ? "translate" : config.sttMode,
	});
	if (result.transcript.trim()) return { ...result, fromTextFallback: false };

	const shouldFallback = params.text_fallback ?? config.textFallback;
	if (shouldFallback && ctx.hasUI) {
		const typed = await ctx.ui.input(fallbackPrompt, "Type here if speech was not recognized");
		if (typed?.trim()) return { transcript: typed.trim(), fromTextFallback: true };
	}

	return { ...result, fromTextFallback: false };
}

function transcriptResult(
	result: TranscriptionResult & { audioPath?: string; fromTextFallback?: boolean; question?: string },
	label: string,
) {
	return {
		content: [
			{
				type: "text" as const,
				text: `${label}: ${conciseTranscript(result.transcript)}`,
			},
		],
		details: {
			transcript: result.transcript,
			languageCode: result.languageCode,
			languageProbability: result.languageProbability,
			requestId: result.requestId,
			audioPath: result.audioPath,
			fromTextFallback: result.fromTextFallback ?? false,
			question: result.question,
		},
	};
}

function clampSeconds(seconds: number): number {
	if (!Number.isFinite(seconds)) return 300;
	return Math.max(1, Math.min(3600, Math.round(seconds)));
}

function quote(value: string | undefined): string {
	if (!value) return "";
	const singleLine = value.replace(/\s+/g, " ").trim();
	return `“${singleLine.length > 120 ? `${singleLine.slice(0, 117)}…` : singleLine}”`;
}
