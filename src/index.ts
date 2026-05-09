import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createAudioRuntime, type AudioRuntime } from "./audio.js";
import { maskSecret, resolveConfig, type PiListensConfig } from "./config.js";
import { SarvamSpeechClient } from "./sarvam.js";
import { attachStateToServices, maybeContinueVoiceLoop, registerVoiceCommands, stopVoiceMode, type VoiceModeState } from "./commands.js";
import { registerVoiceTools, type VoiceToolServices } from "./tools.js";
import { firstTextContent } from "./text.js";

export default function piListensExtension(pi: ExtensionAPI) {
	let config: PiListensConfig = resolveConfig(process.cwd());
	let audio: AudioRuntime = createAudioRuntime(config);
	let lastCwd = process.cwd();

	const speech = new SarvamSpeechClient(() => config);
	const state: VoiceModeState = {

		enabled: false,
		autoListen: false,
		autoSpeakAssistant: config.autoSpeakAssistant,
		isListening: false,
		status: "idle",
		recordSeconds: config.recordSeconds,
		silenceStopSeconds: config.silenceStopSeconds,
	};

	const services: VoiceToolServices = {
		getConfig: () => config,
		getAudio: () => audio,
		getSpeech: () => speech,
	};
	attachStateToServices(services, state);

	function reloadConfig(cwd: string) {
		lastCwd = cwd;
		config = resolveConfig(cwd);
		audio = createAudioRuntime(config);
		if (!state.enabled) { state.autoSpeakAssistant = config.autoSpeakAssistant; state.recordSeconds = config.recordSeconds; state.silenceStopSeconds = config.silenceStopSeconds; }
	}

	registerVoiceTools(pi, services);
	registerVoiceCommands(pi, services, state);

	pi.on("session_start", async (_event, ctx) => {
		reloadConfig(ctx.cwd);
		const audioInfo = audio.describe();
		const ready = Boolean(config.apiKey) && audioInfo.recorder !== "missing" && audioInfo.player !== "missing";
		ctx.ui.setStatus("pi-listens", state.enabled ? "voice on" : ready ? "voice ready" : "voice setup needed");
		if (!ready) {
			ctx.ui.notify(
				[
					"pi-listens is loaded but not fully ready.",
					`Sarvam API key: ${maskSecret(config.apiKey)}`,
					`Recorder: ${audioInfo.recorder}`,
					`Player: ${audioInfo.player}`,
					"Run /voice-status or call voice_setup_check for details.",
				].join("\n"),
				"warning",
			);
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		stopVoiceMode(services, state, ctx);
	});

	pi.on("before_agent_start", async (event) => {
		return {
			systemPrompt: `${event.systemPrompt}\n\nPi Listens voice guidance:\n- The user may primarily interact by speech through Sarvam AI. Text input is still possible.\n- When voice mode is active, treat it as a hands-free conversation: listen only while the voice UI/input tool is active, then pause listening while you work.\n- Use voice_output for concise spoken progress, completion, or status updates that matter to the user.\n- When you need clarification, confirmation, or any user input, prefer voice_ask with a concise spoken question instead of asking only in text.\n- Use voice_input only after the user already knows you are listening.\n- Do not speak code blocks, logs, diffs, stack traces, or long explanations; summarize them briefly and leave detail in text.`,
		};
	});

	pi.on("message_end", async (event) => {
		if (event.message.role !== "assistant") return;
		state.lastAssistantText = firstTextContent(event.message);
	});

	pi.on("agent_end", async (_event, ctx) => {
		await maybeContinueVoiceLoop(pi, services, state, ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		reloadConfig(ctx.cwd || lastCwd);
	});
}
