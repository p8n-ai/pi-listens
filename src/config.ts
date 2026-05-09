import { existsSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

export type SttMode = "transcribe" | "translate" | "verbatim" | "translit" | "codemix";
export type RecordMode = "utterance" | "fixed";

export interface PiListensConfig {
	apiKey?: string;
	sttModel: string;
	sttMode: SttMode;
	sttLanguageCode: string;
	translateInputToEnglish: boolean;
	ttsModel: string;
	ttsLanguageCode: string;
	ttsSpeaker: string;
	ttsPace?: number;
	ttsTemperature?: number;
	ttsSampleRate: number;
	ttsOutputCodec: "wav" | "mp3" | "linear16" | "mulaw" | "alaw" | "opus" | "flac" | "aac";
	recordSeconds: number;
	recordSampleRate: number;
	recordMode: RecordMode;
	silenceStartSeconds: number;
	silenceStopSeconds: number;
	silenceThreshold: string;
	recordCommand?: string;
	playCommand?: string;
	streamCommand?: string;
	streamChunkMs: number;
	streamMaxSeconds: number;
	audioDir: string;
	deleteAudio: boolean;
	textFallback: boolean;
}

const DEFAULT_CONFIG: PiListensConfig = {
	sttModel: "saaras:v3",
	sttMode: "transcribe",
	sttLanguageCode: "unknown",
	translateInputToEnglish: true,
	ttsModel: "bulbul:v3",
	ttsLanguageCode: "en-IN",
	ttsSpeaker: "shubh",
	ttsPace: 1,
	ttsTemperature: 0.6,
	ttsSampleRate: 24000,
	ttsOutputCodec: "wav",
	recordSeconds: 300,
	recordSampleRate: 16000,
	streamChunkMs: 250,
	streamMaxSeconds: 300,
	recordMode: "utterance",
	silenceStartSeconds: 0.2,
	silenceStopSeconds: 3.5,
	silenceThreshold: "1%",
	audioDir: join(tmpdir(), "pi-listens"),
	deleteAudio: true,
	textFallback: true,
};

type RawConfig = Partial<PiListensConfig>;

export function resolveConfig(cwd: string): PiListensConfig {
	const legacyUserPath = join(homedir(), ".pi", "agent", "pi-listens.json");
	const userPath = join(homedir(), ".pi", "pi-listens.json");
	const projectPath = join(cwd, ".pi", "pi-listens.json");
	const fileConfig = {
		...readJson(legacyUserPath),
		...readJson(userPath),
		...readJson(projectPath),
	};

	const envConfig: RawConfig = {
		apiKey: env("SARVAM_API_KEY") ?? env("SARVAM_API_SUBSCRIPTION_KEY") ?? env("PI_LISTENS_SARVAM_API_KEY"),
		sttModel: env("PI_LISTENS_STT_MODEL"),
		sttMode: parseSttMode(env("PI_LISTENS_STT_MODE")),
		sttLanguageCode: env("PI_LISTENS_STT_LANGUAGE"),
		translateInputToEnglish: parseBoolean(env("PI_LISTENS_TRANSLATE_INPUT_TO_ENGLISH")),
		ttsModel: env("PI_LISTENS_TTS_MODEL"),
		ttsLanguageCode: env("PI_LISTENS_TTS_LANGUAGE"),
		ttsSpeaker: env("PI_LISTENS_TTS_SPEAKER"),
		ttsPace: parseNumber(env("PI_LISTENS_TTS_PACE")),
		ttsTemperature: parseNumber(env("PI_LISTENS_TTS_TEMPERATURE")),
		ttsSampleRate: parseInteger(env("PI_LISTENS_TTS_SAMPLE_RATE")),
		ttsOutputCodec: parseCodec(env("PI_LISTENS_TTS_OUTPUT_CODEC")),
		recordSeconds: parseInteger(env("PI_LISTENS_RECORD_SECONDS")),
		recordSampleRate: parseInteger(env("PI_LISTENS_RECORD_SAMPLE_RATE")),
		recordMode: parseRecordMode(env("PI_LISTENS_RECORD_MODE")),
		silenceStartSeconds: parseNumber(env("PI_LISTENS_SILENCE_START_SECONDS")),
		silenceStopSeconds: parseNumber(env("PI_LISTENS_SILENCE_STOP_SECONDS")),
		silenceThreshold: env("PI_LISTENS_SILENCE_THRESHOLD"),
		recordCommand: env("PI_LISTENS_RECORD_COMMAND"),
		playCommand: env("PI_LISTENS_PLAY_COMMAND"),
		streamCommand: env("PI_LISTENS_STREAM_COMMAND"),
		streamChunkMs: parseInteger(env("PI_LISTENS_STREAM_CHUNK_MS")),
		streamMaxSeconds: parseInteger(env("PI_LISTENS_STREAM_MAX_SECONDS")),
		audioDir: env("PI_LISTENS_AUDIO_DIR"),
		deleteAudio: parseBoolean(env("PI_LISTENS_DELETE_AUDIO")),
		textFallback: parseBoolean(env("PI_LISTENS_TEXT_FALLBACK")),
	};

	return mergeDefined(DEFAULT_CONFIG, fileConfig, envConfig);
}

function readJson(path: string): RawConfig {
	if (!existsSync(path)) return {};
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as RawConfig;
		return parsed && typeof parsed === "object" ? parsed : {};
	} catch {
		return {};
	}
}

function env(name: string): string | undefined {
	const value = process.env[name];
	return value && value.trim() ? value.trim() : undefined;
}

function parseBoolean(value: string | undefined): boolean | undefined {
	if (value === undefined) return undefined;
	if (["1", "true", "yes", "on"].includes(value.toLowerCase())) return true;
	if (["0", "false", "no", "off"].includes(value.toLowerCase())) return false;
	return undefined;
}

function parseInteger(value: string | undefined): number | undefined {
	if (value === undefined) return undefined;
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function parseNumber(value: string | undefined): number | undefined {
	if (value === undefined) return undefined;
	const parsed = Number.parseFloat(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function parseSttMode(value: string | undefined): SttMode | undefined {
	if (!value) return undefined;
	const allowed = new Set(["transcribe", "translate", "verbatim", "translit", "codemix"]);
	return allowed.has(value) ? (value as SttMode) : undefined;
}

function parseRecordMode(value: string | undefined): RecordMode | undefined {
	if (!value) return undefined;
	return value === "utterance" || value === "fixed" ? value : undefined;
}

function parseCodec(value: string | undefined): PiListensConfig["ttsOutputCodec"] | undefined {
	if (!value) return undefined;
	const allowed = new Set(["wav", "mp3", "linear16", "mulaw", "alaw", "opus", "flac", "aac"]);
	return allowed.has(value) ? (value as PiListensConfig["ttsOutputCodec"]) : undefined;
}

function mergeDefined(...configs: RawConfig[]): PiListensConfig {
	const merged: Record<string, unknown> = {};
	for (const config of configs) {
		for (const [key, value] of Object.entries(config)) {
			if (value !== undefined) merged[key] = value;
		}
	}
	return merged as unknown as PiListensConfig;
}

export function maskSecret(value: string | undefined): string {
	if (!value) return "not set";
	if (value.length <= 8) return "set";
	return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

export function audioExtensionForCodec(codec: PiListensConfig["ttsOutputCodec"]): string {
	if (codec === "linear16" || codec === "mulaw" || codec === "alaw") return "raw";
	return codec;
}
