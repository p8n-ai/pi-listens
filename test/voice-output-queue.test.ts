import assert from "node:assert/strict";
import test from "node:test";
import { registerVoiceTools } from "../src/tools.js";

test("voice_output waits for active listening before starting playback", async () => {
	const registered = new Map<string, any>();
	const pi = { registerTool(tool: any) { registered.set(tool.name, tool); } } as any;

	let listening = true;
	let synthesizeStartedAt = 0;
	let playStartedAt = 0;
	let listenEndedAt = 0;

	const services = {
		getConfig: () => ({
			recordSeconds: 1,
			textFallback: false,
			audioDir: "/tmp",
			ttsOutputCodec: "wav",
		}),
		getAudio: () => ({
			describe: () => ({ recorder: "mock", player: "mock", streamingPlayer: "mock" }),
			enqueuePlayback: (fn: () => Promise<void>) => Promise.resolve().then(fn),
			playStream: async () => { playStartedAt = Date.now(); },
		}),
		getSpeech: () => ({
			synthesizeStream: async () => {
				synthesizeStartedAt = Date.now();
				return { stream: new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } }) };
			},
		}),
		isListening: () => listening,
		waitForListeningIdle: async () => {
			while (listening) await new Promise((resolve) => setTimeout(resolve, 5));
		},
		notifySpeaking: () => undefined,
		resetSpeechCount: () => undefined,
	} as any;

	registerVoiceTools(pi, services);
	const voiceOutput = registered.get("voice_output");
	assert.ok(voiceOutput, "voice_output tool registered");

	setTimeout(() => {
		listening = false;
		listenEndedAt = Date.now();
	}, 30);

	const result = await voiceOutput.execute("tool-call", { text: "hello", wait_for_playback: true }, undefined, () => undefined);

	assert.equal(result.details.played, true);
	assert.equal(result.details.queuedBehindListening, true);
	assert.ok(synthesizeStartedAt >= listenEndedAt, "TTS synthesis should wait until listening ends");
	assert.ok(playStartedAt >= listenEndedAt, "playback should wait until listening ends");
});

test("voice_output waits again if listening starts during TTS synthesis", async () => {
	const registered = new Map<string, any>();
	const pi = { registerTool(tool: any) { registered.set(tool.name, tool); } } as any;

	let listening = false;
	let playStartedAt = 0;
	let listenEndedAt = 0;

	const services = {
		getConfig: () => ({
			recordSeconds: 1,
			textFallback: false,
			audioDir: "/tmp",
			ttsOutputCodec: "wav",
		}),
		getAudio: () => ({
			describe: () => ({ recorder: "mock", player: "mock", streamingPlayer: "mock" }),
			enqueuePlayback: (fn: () => Promise<void>) => Promise.resolve().then(fn),
			playStream: async () => { playStartedAt = Date.now(); },
		}),
		getSpeech: () => ({
			synthesizeStream: async () => {
				listening = true;
				setTimeout(() => {
					listening = false;
					listenEndedAt = Date.now();
				}, 30);
				return { stream: new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } }) };
			},
		}),
		isListening: () => listening,
		waitForListeningIdle: async () => {
			while (listening) await new Promise((resolve) => setTimeout(resolve, 5));
		},
		notifySpeaking: () => undefined,
		resetSpeechCount: () => undefined,
	} as any;

	registerVoiceTools(pi, services);
	const voiceOutput = registered.get("voice_output");

	const result = await voiceOutput.execute("tool-call", { text: "hello", wait_for_playback: true }, undefined, () => undefined);

	assert.equal(result.details.played, true);
	assert.equal(result.details.queuedBehindListening, false);
	assert.ok(playStartedAt >= listenEndedAt, "playback should wait for listening that starts during synthesis");
});

test("voice_ask marks the answer capture phase as listening", async () => {
	const registered = new Map<string, any>();
	const pi = { registerTool(tool: any) { registered.set(tool.name, tool); } } as any;
	const listeningTransitions: boolean[] = [];

	const services = {
		getConfig: () => ({
			recordSeconds: 1,
			textFallback: false,
			audioDir: "/tmp",
			ttsOutputCodec: "wav",
			translateInputToEnglish: true,
			sttMode: "transcribe",
		}),
		getAudio: () => ({
			describe: () => ({ recorder: "mock", player: "mock", streamingPlayer: "mock" }),
			enqueuePlayback: (fn: () => Promise<void>) => Promise.resolve().then(fn),
			waitForPlaybackIdle: async () => undefined,
			playStream: async () => undefined,
		}),
		getSpeech: () => ({
			synthesizeStream: async () => ({
				stream: new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } }),
			}),
			transcribeMicrophone: async () => {
				assert.deepEqual(listeningTransitions, [true], "voice_ask should enter listening before transcribing");
				return { transcript: "yes" };
			},
		}),
		isListening: () => listeningTransitions.at(-1) === true,
		waitForListeningIdle: async () => undefined,
		notifySpeaking: () => undefined,
		notifyListening: (listening: boolean) => { listeningTransitions.push(listening); },
		resetSpeechCount: () => undefined,
	} as any;
	const ctx = { hasUI: false } as any;

	registerVoiceTools(pi, services);
	const voiceAsk = registered.get("voice_ask");
	const result = await voiceAsk.execute("tool-call", { question: "Ready?" }, undefined, () => undefined, ctx);

	assert.equal(result.details.transcript, "yes");
	assert.deepEqual(listeningTransitions, [true, false]);
});
