import type { AudioRuntime } from "../audio.js";

export interface TranscriptionResult {
	transcript: string;
	languageCode?: string;
	languageProbability?: number;
	requestId?: string;
}

export interface SynthesisResult {
	path: string;
	bytes: number;
}

export interface SynthesisStreamResult {
	stream: ReadableStream<Uint8Array>;
}

export interface TranscriptionOptions {
	seconds?: number;
	mode?: string;
}

export interface VoiceProviderInfo {
	id: string;
	name: string;
	authLabel: string;
	authConfigured: boolean;
	authStatus: string;
	sttSummary: string;
	ttsSummary: string;
	configTemplate: Record<string, unknown>;
	setupInstructions: string[];
}

export interface VoiceProvider {
	readonly id: string;
	readonly name: string;
	describe(): VoiceProviderInfo;
	transcribeMicrophone(audio: AudioRuntime, signal?: AbortSignal, options?: TranscriptionOptions): Promise<TranscriptionResult>;
	transcribeFile(path: string, signal?: AbortSignal, options?: TranscriptionOptions): Promise<TranscriptionResult>;
	synthesizeToFile(text: string, path: string, signal?: AbortSignal): Promise<SynthesisResult>;
	synthesizeStream(text: string, signal?: AbortSignal): Promise<SynthesisStreamResult>;
	/** Optionally warm provider-side TTS connections/models before the first audible response. */
	prewarmTts?(signal?: AbortSignal): Promise<void>;
}
