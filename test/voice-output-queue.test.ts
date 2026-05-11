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

test("voice_output serializes multiple queued playback requests", async () => {
	const registered = new Map<string, any>();
	const pi = { registerTool(tool: any) { registered.set(tool.name, tool); } } as any;
	let queue: Promise<void> = Promise.resolve();
	let currentText = "";
	let releaseFirstPlayback!: () => void;
	const firstPlaybackDone = new Promise<void>((resolve) => { releaseFirstPlayback = resolve; });
	const started: string[] = [];
	const finished: string[] = [];

	const services = {
		getConfig: () => ({
			recordSeconds: 1,
			textFallback: false,
			audioDir: "/tmp",
			ttsOutputCodec: "wav",
		}),
		getAudio: () => ({
			describe: () => ({ recorder: "mock", player: "mock", streamingPlayer: "mock" }),
			enqueuePlayback: (fn: () => Promise<void>) => {
				const task = queue.catch(() => undefined).then(fn);
				queue = task;
				return task;
			},
			playStream: async () => {
				const text = currentText;
				started.push(text);
				if (text === "first") await firstPlaybackDone;
				finished.push(text);
			},
		}),
		getSpeech: () => ({
			synthesizeStream: async (text: string) => {
				currentText = text;
				return { stream: new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } }) };
			},
		}),
		isListening: () => false,
		waitForListeningIdle: async () => undefined,
		notifySpeaking: () => undefined,
		resetSpeechCount: () => undefined,
	} as any;

	registerVoiceTools(pi, services);
	const voiceOutput = registered.get("voice_output");

	const first = voiceOutput.execute("tool-call-1", { text: "first", wait_for_playback: true }, undefined, () => undefined);
	await waitUntil(() => started.includes("first"));
	const second = voiceOutput.execute("tool-call-2", { text: "second", wait_for_playback: true }, undefined, () => undefined);
	await delay(20);

	assert.deepEqual(started, ["first"], "second playback should not start until first finishes");
	releaseFirstPlayback();
	await Promise.all([first, second]);

	assert.deepEqual(started, ["first", "second"]);
	assert.deepEqual(finished, ["first", "second"]);
});

test("voice_ask waits for queued playback before speaking its question", async () => {
	const registered = new Map<string, any>();
	const pi = { registerTool(tool: any) { registered.set(tool.name, tool); } } as any;
	let releasePlaybackIdle!: () => void;
	const playbackIdle = new Promise<void>((resolve) => { releasePlaybackIdle = resolve; });
	let questionSynthesisStarted = false;

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
			waitForPlaybackIdle: async () => { await playbackIdle; },
			playStream: async () => undefined,
		}),
		getSpeech: () => ({
			synthesizeStream: async () => {
				questionSynthesisStarted = true;
				return { stream: new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } }) };
			},
			transcribeMicrophone: async () => ({ transcript: "yes" }),
		}),
		isListening: () => false,
		waitForListeningIdle: async () => undefined,
		notifySpeaking: () => undefined,
		notifyListening: () => undefined,
		resetSpeechCount: () => undefined,
	} as any;
	const ctx = { hasUI: false } as any;

	registerVoiceTools(pi, services);
	const voiceAsk = registered.get("voice_ask");
	const ask = voiceAsk.execute("tool-call", { question: "Ready?" }, undefined, () => undefined, ctx);
	await delay(20);
	assert.equal(questionSynthesisStarted, false, "voice_ask should wait for pending playback before speaking");

	releasePlaybackIdle();
	const result = await ask;

	assert.equal(questionSynthesisStarted, true);
	assert.equal(result.details.transcript, "yes");
});

async function waitUntil(predicate: () => boolean, timeoutMs = 250): Promise<void> {
	const start = Date.now();
	while (!predicate()) {
		if (Date.now() - start > timeoutMs) throw new Error("Timed out waiting for condition");
		await delay(5);
	}
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
