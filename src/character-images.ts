import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getCapabilities, Image, type ImageDimensions } from "@earendil-works/pi-tui";
import type { VoiceLoopStatus } from "./commands.js";
import type { VoiceCharacterPalette } from "./characters.js";

const ASSET_DIR = join(dirname(fileURLToPath(import.meta.url)), "assets", "miko");
const MIKO_IMAGE_ID = 0x70694d; // "piM"; stable Kitty image replacement ID for this extension.

// Maps a voice status to the filename prefix used to discover animation frames.
// Frames are named <prefix>.png, <prefix>-2.png, <prefix>-3.png, etc.
const STATUS_PREFIX: Record<VoiceLoopStatus, string> = {
	idle: "idle",
	listening: "listening",
	agent: "working",
	speaking: "speaking",
	error: "error",
};

type LoadedImageAsset = { base64: string; filename: string; dimensions: ImageDimensions };

const frameCache = new Map<VoiceLoopStatus, LoadedImageAsset[]>();
const renderCache = new Map<string, string[]>();

export function renderVoiceCharacterImage(status: VoiceLoopStatus, width: number, palette: VoiceCharacterPalette, frame = 0): string[] | undefined {
	if (!getCapabilities().images) return undefined;

	const frames = loadImageFrames(status);
	if (frames.length === 0) return undefined;

	// Hold each PNG frame for several animation ticks so the cycle feels smooth.
	// The TUI animation timer ticks at ~80-120ms; we want roughly 1 full cycle
	// per 1.5-2.5s depending on state, so each frame holds for many ticks.
	const cadence = imageCadence(status);
	const frameIndex = Math.floor(frame / cadence) % frames.length;
	const asset = frames[frameIndex]!;
	const maxWidthCells = Math.max(14, Math.min(24, width - 6));
	const leftPadCells = Math.max(0, Math.floor((width - maxWidthCells) / 2));
	const cacheKey = `${status}:${frameIndex}:${width}:${maxWidthCells}:${leftPadCells}:${getCapabilities().images}`;
	const cached = renderCache.get(cacheKey);
	if (cached) return cached;

	const component = new Image(
		asset.base64,
		"image/png",
		{ fallbackColor: (text) => color(palette.dim, text) },
		{ filename: asset.filename, imageId: MIKO_IMAGE_ID, maxWidthCells },
		asset.dimensions,
	);
	const lines = component.render(width);
	if (lines.some((line) => line.includes("[Image:"))) return undefined;
	const centeredLines = leftPadCells > 0 ? lines.map((line) => line ? `\x1b[${leftPadCells}C${line}` : line) : lines;
	renderCache.set(cacheKey, centeredLines);
	return centeredLines;
}

export function hasVoiceCharacterImageAssets(): boolean {
	return Object.values(STATUS_PREFIX).every((prefix) => existsSync(join(ASSET_DIR, `${prefix}.png`)));
}

function loadImageFrames(status: VoiceLoopStatus): LoadedImageAsset[] {
	if (frameCache.has(status)) return frameCache.get(status)!;

	const prefix = STATUS_PREFIX[status];
	const frames: LoadedImageAsset[] = [];

	// Discover frame files: <prefix>.png, <prefix>-2.png, <prefix>-3.png, ...
	const candidates: string[] = [`${prefix}.png`];
	try {
		const allFiles = readdirSync(ASSET_DIR);
		// Collect numbered variants sorted by index
		const numbered = allFiles
			.filter((f) => {
				const match = f.match(new RegExp(`^${prefix}-(\\d+)\\.png$`));
				return match !== null;
			})
			.sort((a, b) => {
				const na = Number(a.match(/(\d+)\.png$/)?.[1] ?? 0);
				const nb = Number(b.match(/(\d+)\.png$/)?.[1] ?? 0);
				return na - nb;
			});
		candidates.push(...numbered);
	} catch {
		// ASSET_DIR doesn't exist or is unreadable
	}

	for (const filename of candidates) {
		const asset = loadSingleAsset(filename);
		if (asset) frames.push(asset);
	}

	frameCache.set(status, frames);
	return frames;
}

function loadSingleAsset(filename: string): LoadedImageAsset | undefined {
	const path = join(ASSET_DIR, filename);
	if (!existsSync(path)) return undefined;

	const buffer = readFileSync(path);
	const dimensions = pngDimensions(buffer);
	if (!dimensions) return undefined;

	return { base64: buffer.toString("base64"), filename, dimensions };
}

function pngDimensions(buffer: Buffer): ImageDimensions | undefined {
	if (buffer.length < 24) return undefined;
	if (buffer[0] !== 0x89 || buffer[1] !== 0x50 || buffer[2] !== 0x4e || buffer[3] !== 0x47) return undefined;
	return { widthPx: buffer.readUInt32BE(16), heightPx: buffer.readUInt32BE(20) };
}

function color(code: string, text: string): string {
	return `\x1b[${code}m${text}\x1b[39m`;
}

// How many animation ticks to hold each PNG frame before advancing.
// Timer intervals: listening=80ms, speaking=90ms, agent=120ms, idle=110ms.
//
// States with 20 frames (idle, listening, speaking) use cadence=2
// so each frame holds for 2 ticks, giving a relaxed smooth animation:
//   idle:      20 × 2 × 110ms = 4.4s per cycle (~4.5fps)
//   listening: 20 × 2 × 80ms  = 3.2s per cycle (~6fps)
//   speaking:  20 × 2 × 90ms  = 3.6s per cycle (~5.5fps)
//
// Error keeps 3 frames with cadence=2 for a calm wobble:
//   error:     3 × 2 × 110ms  = 0.66s per cycle
//
// Working/agent keeps cadence=1 with 3 frames for FAST typing feel:
//   agent:     3 × 1 × 120ms  = 0.36s per cycle (user confirmed fast is good)
function imageCadence(status: VoiceLoopStatus): number {
	switch (status) {
		case "agent": return 1;
		default: return 2;
	}
}
