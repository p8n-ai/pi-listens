import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createAudioRuntime, type AudioRuntime } from "./audio.js";
import { resolveConfig, type PiListensConfig } from "./config.js";
import { createVoiceProvider } from "./providers/index.js";
import { attachStateToServices, maybeContinueVoiceLoop, registerVoiceCommands, stopVoiceMode, updateServiceContext, type VoiceModeState } from "./commands.js";
import { registerVoiceTools, type VoiceToolServices } from "./tools.js";
import { applyVoiceChrome } from "./voice-ui.js";

export default function piListensExtension(pi: ExtensionAPI) {
	let config: PiListensConfig = resolveConfig(process.cwd());
	let audio: AudioRuntime = createAudioRuntime(config);
	let lastCwd = process.cwd();

	const speech = createVoiceProvider(() => config);
	const state: VoiceModeState = {
		enabled: false,
		autoListen: false,
		isListening: false,
		status: "idle",
		agentActive: false,
		activeSpeechCount: 0,
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
		if (!state.enabled) { state.recordSeconds = config.recordSeconds; state.silenceStopSeconds = config.silenceStopSeconds; }
	}

	registerVoiceTools(pi, services);
	registerVoiceCommands(pi, services, state);

	pi.on("session_start", async (_event, ctx) => {
		reloadConfig(ctx.cwd);
		updateServiceContext(services, ctx);
		const audioInfo = audio.describe();
		const provider = speech.describe();
		const ready = provider.authConfigured && audioInfo.recorder !== "missing" && audioInfo.player !== "missing";
		ctx.ui.setStatus("pi-listens", state.enabled ? "voice on" : ready ? "voice ready" : "voice setup needed");
		if (ready && config.conversational) void speech.prewarmTts?.(ctx.signal).catch(() => undefined);
		if (!ready) {
			ctx.ui.notify(
				[
					"pi-listens is loaded but not fully ready.",
					`Provider: ${provider.name}`,
					`${provider.authLabel}: ${provider.authStatus}`,
					`Recorder: ${audioInfo.recorder}`,
					`Player: ${audioInfo.player}`,
					"Run /voice-init to create a settings file, or /voice-check for details.",
				].join("\n"),
				"warning",
			);
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		stopVoiceMode(services, state, ctx);
	});

	pi.on("before_agent_start", async (event) => {
		const voiceGuidance = config.conversational
			? buildConversationalPrompt()
			: buildDefaultVoicePrompt();
		return {
			systemPrompt: `${event.systemPrompt}\n\n${voiceGuidance}`,
		};
	});


	pi.on("agent_start", async (_event, ctx) => {
		state.agentActive = true;
		if (state.enabled && state.status === "idle") {
			state.status = "agent";
			applyVoiceChrome(ctx, state);
		}
	});

	pi.on("agent_end", async (_event, ctx) => {
		state.agentActive = false;
		updateServiceContext(services, ctx);
		await maybeContinueVoiceLoop(pi, services, state, ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		reloadConfig(ctx.cwd || lastCwd);
	});
}

function buildDefaultVoicePrompt(): string {
	return [
		"Pi Listens voice guidance:",
		"- The user may primarily interact by speech through the configured Pi Listens voice provider. Text input is still possible.",
		"- When voice mode is active, treat it as a hands-free conversation: listen only while the voice UI/input tool is active, then pause listening while you work.",
		"- Use voice_output only for concise spoken progress, completion, or status updates that matter to the user.",
		"- Spoken replies must be brief: 1-2 short sentences, no headings, no hashtags, no bullet lists, no boilerplate recap, and no full task summaries. Leave details in text.",
		"- When you need clarification, confirmation, or any user input, prefer voice_ask with a concise spoken question instead of asking only in text.",
		"- Use voice_input only after the user already knows you are listening.",
		"- Do not speak code blocks, logs, diffs, stack traces, or long explanations; summarize briefly and leave detail in text.",
	].join("\n");
}

function buildConversationalPrompt(): string {
	return [
		"Pi Listens voice guidance (conversational mode):",
		"- The user is interacting by voice through Pi Listens. This is a spoken conversation — respond as a natural, helpful human colleague would.",
		"- SPEAK your responses using voice_output. Do not just write text and stay silent — the user expects to hear you.",
		"- Break longer responses into multiple short voice_output calls (1-3 sentences each) rather than one long block. This feels more natural.",
		"- When you have options, ideas, or suggestions, talk through them conversationally. Do not present numbered lists — discuss them like a colleague would.",
		"- When you need any input, clarification, or decision from the user, always use voice_ask. Do not use text prompts, forms, or the interview tool unless the user explicitly asks for one.",
		"- Use voice_input only after the user already knows you are listening.",
		"- Think out loud briefly — share what you are about to do (e.g., 'Let me look at that file' or 'I will run the tests now') before doing it.",
		"- After completing work, summarize the outcome by speaking — do not just leave a text summary.",
		"- Keep each spoken segment concise and conversational. No headings, hashtags, bullet lists, or boilerplate in speech.",
		"- Code, diffs, logs, and stack traces still go in text — but always speak a brief natural summary of what they show.",
		"- Match the user's energy and language. If they are casual, be casual. If they are brief, be brief.",
	].join("\n");
}
