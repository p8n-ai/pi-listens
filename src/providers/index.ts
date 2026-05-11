import type { PiListensConfig, VoiceProviderName } from "../config.js";
import { SarvamVoiceProvider } from "./sarvam.js";
import type { SynthesisResult, SynthesisStreamResult, TranscriptionOptions, TranscriptionResult, VoiceProvider, VoiceProviderInfo } from "./types.js";
export type { SynthesisResult, SynthesisStreamResult, TranscriptionOptions, TranscriptionResult, VoiceProvider, VoiceProviderInfo } from "./types.js";

export function createVoiceProvider(getConfig: () => PiListensConfig): VoiceProvider {
	return new VoiceProviderRouter(getConfig);
}

class VoiceProviderRouter implements VoiceProvider {
	private activeName: VoiceProviderName | undefined;
	private activeProvider: VoiceProvider | undefined;

	constructor(private readonly getConfig: () => PiListensConfig) {}

	get id(): string {
		return this.active().id;
	}

	get name(): string {
		return this.active().name;
	}

	describe(): VoiceProviderInfo {
		return this.active().describe();
	}

	transcribeMicrophone(...args: Parameters<VoiceProvider["transcribeMicrophone"]>): Promise<TranscriptionResult> {
		return this.active().transcribeMicrophone(...args);
	}

	transcribeFile(...args: Parameters<VoiceProvider["transcribeFile"]>): Promise<TranscriptionResult> {
		return this.active().transcribeFile(...args);
	}

	synthesizeToFile(...args: Parameters<VoiceProvider["synthesizeToFile"]>): Promise<SynthesisResult> {
		return this.active().synthesizeToFile(...args);
	}

	synthesizeStream(...args: Parameters<VoiceProvider["synthesizeStream"]>): Promise<SynthesisStreamResult> {
		return this.active().synthesizeStream(...args);
	}

	private active(): VoiceProvider {
		const providerName = this.getConfig().provider;
		if (!this.activeProvider || this.activeName !== providerName) {
			this.activeProvider = createProvider(providerName, this.getConfig);
			this.activeName = providerName;
		}
		return this.activeProvider;
	}
}

function createProvider(providerName: VoiceProviderName, getConfig: () => PiListensConfig): VoiceProvider {
	switch (providerName) {
		case "sarvam":
			return new SarvamVoiceProvider(getConfig);
		default:
			return assertNever(providerName);
	}
}

function assertNever(value: never): never {
	throw new Error(`Unsupported voice provider: ${String(value)}`);
}
