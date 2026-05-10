import { visibleWidth } from "@earendil-works/pi-tui";
import type { VoiceLoopStatus } from "./commands.js";

export type VoiceCharacterStatus = VoiceLoopStatus;

export type VoiceCharacterPalette = {
	fg: string;
	bright: string;
	soft: string;
	dim: string;
};

export type CharacterInteraction = { frame: number; x: number; y: number; strength: number };

export interface VoiceCharacterFrame {
	lines: string[];
}

export interface VoiceCharacterDefinition {
	id: string;
	name: string;
	frames: Record<VoiceCharacterStatus, VoiceCharacterFrame[]>;
}

export interface VoiceCharacterRenderOptions {
	status: VoiceCharacterStatus;
	frame: number;
	palette: VoiceCharacterPalette;
	interactions?: CharacterInteraction[];
}

const OUTLINE = new Set([..."╭╮╯╰─│┤├┴┬╱╲/\\_"]);
const BODY = new Set([..."█▓▣▔"]);
const FACE = new Set([..."◕◉●•×⌄◡O–︿!"]);
const EFFECT = new Set([..."≋♪♫)(·✦▲ᕱ"]);

export const DEFAULT_VOICE_CHARACTER: VoiceCharacterDefinition = {
	id: "miko",
	name: "Miko",
	frames: {
		idle: [
			sprite([
				"              ▲              ",
				"            ╭─┴─╮            ",
				"         ╭──┤   ├──╮         ",
				"        ╱  ██◕ ◕██  ╲        ",
				"       │   ███⌄███   │       ",
				"       │  ╭███████╮  │       ",
				"        ╲ │███████│ ╱        ",
				"          ╰─┬███┬─╯          ",
				"            │╱ ╲│            ",
				"           ╱╲   ╱╲           ",
				"          ╱  ╲ ╱  ╲          ",
				"             ▔ ▔             ",
			]),
			sprite([
				"              ✦              ",
				"              ▲              ",
				"            ╭─┴─╮            ",
				"         ╭──┤   ├──╮         ",
				"        ╱  ██• •██  ╲        ",
				"       │   ███⌄███   │       ",
				"       │  ╭███████╮  │       ",
				"        ╲ │███████│ ╱        ",
				"          ╰─┬███┬─╯          ",
				"            │╱ ╲│            ",
				"           ╱╲   ╱╲           ",
				"             ▔ ▔             ",
			]),
		],
		listening: [
			sprite([
				"      ≋≋      ▲      ≋≋      ",
				"    ≋       ╭─┴─╮       ≋    ",
				"         ╭──┤   ├──╮         ",
				"        ╱  ██◉ ◉██  ╲        ",
				"       │  ᕱ██◡██ᕱ  │       ",
				"       │  ╭███████╮  │       ",
				"        ╲ │███████│ ╱        ",
				"          ╰─┬███┬─╯          ",
				"            │╱ ╲│            ",
				"           ╱╲   ╱╲           ",
				"        ≋ ╱  ╲ ╱  ╲ ≋        ",
				"             ▔ ▔             ",
			]),
			sprite([
				"   ≋≋≋        ▲        ≋≋≋   ",
				"  ≋        ╭─┴─╮        ≋   ",
				"         ╭──┤   ├──╮         ",
				"        ╱  ██◉ ◉██  ╲        ",
				"       │  ᕱ██◡██ᕱ  │       ",
				"       │  ╭███████╮  │       ",
				"        ╲ │███████│ ╱        ",
				"          ╰─┬███┬─╯          ",
				"            │╱ ╲│            ",
				"        ≋  ╱╲   ╱╲  ≋        ",
				"          ╱  ╲ ╱  ╲          ",
				"             ▔ ▔             ",
			]),
		],
		agent: [
			sprite([
				"             · ▲ ·            ",
				"            ╭─┴─╮            ",
				"         ╭──┤   ├──╮         ",
				"        ╱  ██• •██  ╲        ",
				"       │   ███–███   │       ",
				"       │  ╭███████╮  │       ",
				"        ╲ │██▣▣██│ ╱        ",
				"          ╰┬─────┬╯          ",
				"           │▔▔▔▔▔│           ",
				"           ╱╲   ╱╲           ",
				"          ╱  ╲ ╱  ╲          ",
				"             ▔ ▔             ",
			]),
			sprite([
				"          ·  · ▲ ·  ·         ",
				"            ╭─┴─╮            ",
				"         ╭──┤   ├──╮         ",
				"        ╱  ██• •██  ╲        ",
				"       │   ███–███   │       ",
				"       │  ╭███████╮  │       ",
				"        ╲ │██▣▣██│ ╱        ",
				"          ╰┬─────┬╯          ",
				"           │▔▔▔▔▔│           ",
				"          ╱╲     ╱╲          ",
				"         ╱  ╲   ╱  ╲         ",
				"             ▔ ▔             ",
			]),
		],
		speaking: [
			sprite([
				"    ♪ ))      ▲      (( ♫    ",
				"            ╭─┴─╮            ",
				"         ╭──┤   ├──╮         ",
				"        ╱  ██◉ ◉██  ╲        ",
				"       │   ███O███   │       ",
				"       │  ╭███████╮  │       ",
				"        ╲ │███████│ ╱        ",
				"          ╰─┬███┬─╯          ",
				"            │╱ ╲│            ",
				"           ╱╲   ╱╲           ",
				"          ╱  ╲ ╱  ╲          ",
				"             ▔ ▔             ",
			]),
			sprite([
				"  ♫ )))      ▲      ((( ♪    ",
				"            ╭─┴─╮            ",
				"         ╭──┤   ├──╮         ",
				"        ╱  ██◉ ◉██  ╲        ",
				"       │   ███◡███   │       ",
				"       │  ╭███████╮  │       ",
				"        ╲ │███████│ ╱        ",
				"          ╰─┬███┬─╯          ",
				"            │╱ ╲│            ",
				"           ╱╲   ╱╲           ",
				"          ╱  ╲ ╱  ╲          ",
				"             ▔ ▔             ",
			]),
		],
		error: [
			sprite([
				"             ! ▲ !            ",
				"            ╭─┴─╮            ",
				"         ╭──┤   ├──╮         ",
				"        ╱  ██× ×██  ╲        ",
				"       │   ███︿███   │       ",
				"       │  ╭███████╮  │       ",
				"        ╲ │███████│ ╱        ",
				"          ╰─┬███┬─╯          ",
				"            │╱ ╲│            ",
				"           ╱╲   ╱╲           ",
				"          ╱  ╲ ╱  ╲          ",
				"             ▔ ▔             ",
			]),
		],
	},
};

export function renderVoiceCharacter(character: VoiceCharacterDefinition, options: VoiceCharacterRenderOptions): string[] {
	const frames = character.frames[options.status] ?? character.frames.idle;
	const selected = frames[Math.floor(options.frame / frameCadence(options.status)) % frames.length] ?? frames[0];
	const pulse = interactionPulse(options.frame, options.interactions ?? []);
	return selected.lines.map((line, row) => colorizeCharacterLine(line, options.palette, pulse, row));
}

export function characterBounds(character: VoiceCharacterDefinition): { width: number; height: number } {
	let width = 0;
	let height = 0;
	for (const frames of Object.values(character.frames)) {
		for (const frame of frames) {
			height = Math.max(height, frame.lines.length);
			for (const line of frame.lines) width = Math.max(width, visibleWidth(line));
		}
	}
	return { width, height };
}

function sprite(lines: string[]): VoiceCharacterFrame {
	return { lines };
}

function frameCadence(status: VoiceCharacterStatus): number {
	return status === "listening" ? 4 : status === "speaking" ? 3 : status === "agent" ? 5 : 10;
}

function interactionPulse(frame: number, interactions: CharacterInteraction[]): number {
	let pulse = 0;
	for (const interaction of interactions) {
		const age = frame - interaction.frame;
		if (age < 0 || age > 28) continue;
		const life = (1 - age / 28) * interaction.strength;
		pulse = Math.max(pulse, life);
	}
	return Math.max(0, Math.min(1, pulse));
}

function colorizeCharacterLine(line: string, palette: VoiceCharacterPalette, pulse: number, row: number): string {
	let rendered = "";
	for (const ch of [...line]) {
		if (ch === " ") {
			rendered += " ";
		} else if (pulse > 0.1 && row % 3 === 0 && (ch === "·" || ch === "✦" || ch === "▲")) {
			rendered += color(palette.bright, "✦");
		} else if (BODY.has(ch)) {
			rendered += color(ch === "▓" || ch === "▣" ? palette.soft : palette.fg, ch);
		} else if (FACE.has(ch)) {
			rendered += color(palette.bright, ch);
		} else if (EFFECT.has(ch)) {
			rendered += color(palette.bright, ch);
		} else if (OUTLINE.has(ch)) {
			rendered += color(palette.dim, ch);
		} else {
			rendered += color(palette.soft, ch);
		}
	}
	return rendered;
}

function color(code: string, text: string): string {
	return `\x1b[${code}m${text}\x1b[39m`;
}
