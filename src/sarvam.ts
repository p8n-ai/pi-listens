import { readFile, writeFile } from "node:fs/promises";
import { SarvamAIClient } from "sarvamai";
import type { AudioRuntime } from "./audio.js";
import type { PiListensConfig, SttMode } from "./config.js";

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

type StreamingData = {
	transcript?: string;
	request_id?: string;
	language_code?: string;
	language_probability?: number;
	error?: string;
	code?: string;
	event_type?: string;
	signal_type?: string;
};

type StreamingResponse = {
	type?: "data" | "error" | "events" | string;
	data?: StreamingData;
};

type StreamingSocket = {
	transcribe(params: { audio: string; sample_rate: number; encoding: "audio/wav" }): void;
	flush(): void;
	close(): void;
	waitForOpen(): Promise<void>;
	onMessage(handler: (message: StreamingResponse) => void): void;
	onError(handler: (error: Error) => void): void;
};

export class SarvamSpeechClient {
	private client: SarvamAIClient | null = null;
	private clientKey: string | null = null;

	constructor(private readonly getConfig: () => PiListensConfig) {}

	async transcribeMicrophone(audio: AudioRuntime, signal?: AbortSignal, options: { seconds?: number; mode?: SttMode } = {}): Promise<TranscriptionResult> {
		const config = this.getConfig();
		return this.withStreamingSocket(signal, options.mode, "pcm_s16le", async (socket, collect) => {
			const recorderController = new AbortController();
			const stopRecorder = () => recorderController.abort();
			signal?.addEventListener("abort", stopRecorder, { once: true });
			const startedAt = Date.now();
			let speechStarted = false;
			let lastVoiceAt = Date.now();
			let pending = Buffer.alloc(0);
			const chunkBytes = Math.max(1600, Math.round(config.recordSampleRate * 2 * (config.streamChunkMs / 1000)));
			const maxSeconds = Math.max(1, Math.round(options.seconds ?? config.streamMaxSeconds ?? config.recordSeconds));

			const streamSignal = combineSignals(signal, recorderController.signal);
			try {
				for await (const chunk of audio.streamPcm(streamSignal.signal)) {
					if (signal?.aborted) throw new Error("Cancelled");
					const now = Date.now();
					const rms = pcm16Rms(chunk);
					if (rms > silenceThresholdAmplitude(config.silenceThreshold)) {
						speechStarted = true;
						lastVoiceAt = now;
					}

					pending = Buffer.concat([pending, chunk]);
					while (pending.byteLength >= chunkBytes) {
						const audioChunk = pending.subarray(0, chunkBytes);
						pending = pending.subarray(chunkBytes);
						socket.transcribe({ audio: audioChunk.toString("base64"), sample_rate: config.recordSampleRate, encoding: "audio/wav" });
					}

					const hitMaxDuration = now - startedAt >= maxSeconds * 1000;
					const hitTrailingSilence = speechStarted && now - lastVoiceAt >= config.silenceStopSeconds * 1000;
					if (hitMaxDuration || hitTrailingSilence) break;
				}
				if (pending.byteLength > 0) {
					socket.transcribe({ audio: pending.toString("base64"), sample_rate: config.recordSampleRate, encoding: "audio/wav" });
				}
				socket.flush();
				await collect();
			} finally {
				streamSignal.cleanup();
				recorderController.abort();
				signal?.removeEventListener("abort", stopRecorder);
			}
		});
	}

	async transcribeFile(path: string, signal?: AbortSignal, options: { mode?: SttMode } = {}): Promise<TranscriptionResult> {
		const config = this.getConfig();
		const audio = await readFile(path);
		return this.withStreamingSocket(signal, options.mode, "wav", async (socket, collect) => {
			socket.transcribe({ audio: audio.toString("base64"), sample_rate: config.recordSampleRate, encoding: "audio/wav" });
			socket.flush();
			await collect();
		});
	}

	async synthesizeToFile(text: string, path: string, signal?: AbortSignal): Promise<SynthesisResult> {
		const config = this.getConfig();
		const client = this.getClient(config);
		const response = await client.textToSpeech.convertStream(
			{
				text,
				target_language_code: config.ttsLanguageCode as never,
				speaker: config.ttsSpeaker as never,
				model: config.ttsModel as never,
				pace: config.ttsPace,
				temperature: config.ttsTemperature,
				speech_sample_rate: config.ttsSampleRate as never,
				enable_preprocessing: true,
				output_audio_codec: config.ttsOutputCodec as never,
			},
			{ abortSignal: signal },
		);
		const arrayBuffer = await response.arrayBuffer();
		const buffer = Buffer.from(arrayBuffer);
		await writeFile(path, buffer);
		return { path, bytes: buffer.byteLength };
	}

	private async withStreamingSocket(
		signal: AbortSignal | undefined,
		mode: SttMode | undefined,
		inputAudioCodec: "wav" | "pcm_s16le",
		streamAudio: (
			socket: StreamingSocket,
			collect: () => Promise<void>,
		) => Promise<void>,
	): Promise<TranscriptionResult> {
		const config = this.getConfig();
		this.getClient(config); // validate/cache API key for TTS; STT uses raw WebSocket so the documented `mode` query parameter is preserved.
		let transcript = "";
		let requestId: string | undefined;
		let languageCode: string | undefined;
		let languageProbability: number | undefined;
		let streamError: Error | undefined;
		let lastMessageAt = Date.now();
		const messageWaiters = new Set<() => void>();
		const socket = connectStreamingSocket(config, mode ?? (config.translateInputToEnglish ? "translate" : config.sttMode), inputAudioCodec);

		const closeOnAbort = () => socket.close();
		signal?.addEventListener("abort", closeOnAbort, { once: true });
		const notifyMessageWaiters = () => {
			const waiters = [...messageWaiters];
			messageWaiters.clear();
			for (const waiter of waiters) waiter();
		};
		socket.onMessage((message: StreamingResponse) => {
			lastMessageAt = Date.now();
			try {
				if (message.type === "error") {
					streamError = new Error(message.data?.error ?? message.data?.code ?? "Sarvam streaming STT failed");
					return;
				}
				if (message.type !== "data") return;
				const data = message.data;
				if (!data) return;
				transcript = mergeTranscript(transcript, data.transcript ?? "");
				requestId = data.request_id ?? requestId;
				languageCode = data.language_code ?? languageCode;
				languageProbability = data.language_probability ?? languageProbability;
			} finally {
				notifyMessageWaiters();
			}
		});
		socket.onError((error: Error) => { streamError = error; notifyMessageWaiters(); });

		try {
			await socket.waitForOpen();
			await streamAudio(socket, async () => {
				const startedWaitingAt = Date.now();
				const maxWaitMs = transcript.trim() ? 900 : 1600;
				const settleMs = 250;
				while (Date.now() - startedWaitingAt < maxWaitMs) {
					if (streamError) throw streamError;
					if (transcript.trim() && Date.now() - lastMessageAt >= settleMs) break;
					await waitForMessageOrTimeout(messageWaiters, 50, signal);
				}
			});
			if (streamError) throw streamError;
			return { transcript: transcript.trim(), languageCode, languageProbability, requestId };
		} finally {
			signal?.removeEventListener("abort", closeOnAbort);
			socket.close();
		}
	}

	private getClient(config: PiListensConfig): SarvamAIClient {
		if (!config.apiKey) {
			throw new Error("Sarvam API key is not configured. Set SARVAM_API_KEY or run with a pi-listens config file.");
		}
		if (!this.client || this.clientKey !== config.apiKey) {
			this.client = new SarvamAIClient({ apiSubscriptionKey: config.apiKey });
			this.clientKey = config.apiKey;
		}
		return this.client;
	}
}

function mergeTranscript(existing: string, incoming: string): string {
	const previous = existing.trim();
	const next = incoming.trim();
	if (!next) return previous;
	if (!previous) return next;
	if (next === previous || previous.endsWith(next) || previous.includes(next)) return previous;
	if (next.startsWith(previous)) return next;
	return `${previous} ${next}`;
}

function pcm16Rms(buffer: Buffer): number {
	let total = 0;
	let count = 0;
	for (let offset = 0; offset + 1 < buffer.byteLength; offset += 2) {
		const sample = buffer.readInt16LE(offset);
		total += sample * sample;
		count++;
	}
	return count ? Math.sqrt(total / count) : 0;
}

function silenceThresholdAmplitude(threshold: string): number {
	const trimmed = threshold.trim();
	if (trimmed.endsWith("%")) {
		const percent = Number.parseFloat(trimmed.slice(0, -1));
		if (Number.isFinite(percent)) return 32767 * (percent / 100);
	}
	const numeric = Number.parseFloat(trimmed);
	return Number.isFinite(numeric) ? numeric : 327;
}

function connectStreamingSocket(config: PiListensConfig, mode: SttMode, inputAudioCodec: "wav" | "pcm_s16le"): StreamingSocket {
	if (!config.apiKey) {
		throw new Error("Sarvam API key is not configured. Set SARVAM_API_KEY or run with a pi-listens config file.");
	}
	const url = new URL("wss://api.sarvam.ai/speech-to-text/ws");
	url.searchParams.set("language-code", config.sttLanguageCode);
	url.searchParams.set("model", config.sttModel);
	url.searchParams.set("mode", mode);
	url.searchParams.set("input_audio_codec", inputAudioCodec);
	url.searchParams.set("sample_rate", String(config.recordSampleRate));
	url.searchParams.set("high_vad_sensitivity", "true");
	url.searchParams.set("vad_signals", "true");
	url.searchParams.set("flush_signal", "true");

	const ws = new WebSocket(url, [`api-subscription-key.${config.apiKey}`]);
	const messageHandlers = new Set<(message: StreamingResponse) => void>();
	const errorHandlers = new Set<(error: Error) => void>();
	ws.addEventListener("message", (event) => {
		try {
			const parsed = JSON.parse(String(event.data)) as StreamingResponse;
			for (const handler of messageHandlers) handler(parsed);
		} catch (err) {
			const error = err instanceof Error ? err : new Error(String(err));
			for (const handler of errorHandlers) handler(error);
		}
	});
	ws.addEventListener("error", () => {
		for (const handler of errorHandlers) handler(new Error("Sarvam streaming WebSocket error"));
	});

	return {
		transcribe(params) {
			ws.send(JSON.stringify({ audio: { data: params.audio, sample_rate: params.sample_rate, encoding: params.encoding } }));
		},
		flush() {
			ws.send(JSON.stringify({ type: "flush" }));
		},
		close() {
			if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
		},
		waitForOpen() {
			if (ws.readyState === WebSocket.OPEN) return Promise.resolve();
			return new Promise<void>((resolve, reject) => {
				const cleanup = () => {
					ws.removeEventListener("open", onOpen);
					ws.removeEventListener("error", onError);
					ws.removeEventListener("close", onClose);
				};
				const onOpen = () => { cleanup(); resolve(); };
				const onError = () => { cleanup(); reject(new Error("Sarvam streaming WebSocket failed to open")); };
				const onClose = () => { cleanup(); reject(new Error("Sarvam streaming WebSocket closed before opening")); };
				ws.addEventListener("open", onOpen, { once: true });
				ws.addEventListener("error", onError, { once: true });
				ws.addEventListener("close", onClose, { once: true });
			});
		},
		onMessage(handler) { messageHandlers.add(handler); },
		onError(handler) { errorHandlers.add(handler); },
	};
}

function waitForMessageOrTimeout(waiters: Set<() => void>, timeoutMs: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error("Cancelled"));
			return;
		}

		const done = () => { cleanup(); resolve(); };
		const onAbort = () => { cleanup(); reject(new Error("Cancelled")); };
		const timeout = setTimeout(done, timeoutMs);
		const cleanup = () => {
			clearTimeout(timeout);
			waiters.delete(done);
			signal?.removeEventListener("abort", onAbort);
		};

		waiters.add(done);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
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
