import { CustomEditor, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { VoiceModeState } from "./commands.js";
import { characterBounds, DEFAULT_VOICE_CHARACTER, renderVoiceCharacter, type CharacterInteraction, type VoiceCharacterPalette } from "./characters.js";
import { renderVoiceCharacterImage } from "./character-images.js";

type EditorFactory = ReturnType<ExtensionContext["ui"]["getEditorComponent"]>;

export interface VoiceUiCallbacks {
	startListening: () => void;
	disable: () => void;
	toggleAutoListen: () => void;
}

const CHARACTER_BOUNDS = characterBounds(DEFAULT_VOICE_CHARACTER);
const CHARACTER_WIDTH = CHARACTER_BOUNDS.width;
const CHARACTER_HEIGHT = CHARACTER_BOUNDS.height;
const MOUSE_ENABLE = "\x1b[?1000h\x1b[?1006h";
const MOUSE_DISABLE = "\x1b[?1000l\x1b[?1006l";
type SgrMouseEvent = { button: number; col: number; row: number; pressed: boolean };

export function installVoiceUi(ctx: ExtensionContext, state: VoiceModeState, callbacks: VoiceUiCallbacks) {
	if (!ctx.hasUI || state.uiInstalled) return;
	state.previousEditorFactory = ctx.ui.getEditorComponent() as EditorFactory;
	state.uiInstalled = true;
	ctx.ui.setEditorComponent((tui, editorTheme, keybindings) => new VoiceLoopEditor(tui, editorTheme, keybindings, state, callbacks, ctx.ui.theme));
	applyVoiceChrome(ctx, state);
}

export function uninstallVoiceUi(ctx: ExtensionContext, state: VoiceModeState) {
	if (!ctx.hasUI) return;
	disableTerminalMouseInput();
	ctx.ui.setEditorComponent((state.previousEditorFactory as EditorFactory | undefined) ?? undefined);
	ctx.ui.setWidget("pi-listens", undefined);
	ctx.ui.setWorkingIndicator();
	ctx.ui.setWorkingMessage();
	ctx.ui.setStatus("pi-listens", undefined);
	state.uiInstalled = false;
	state.previousEditorFactory = undefined;
}

export function applyVoiceChrome(ctx: ExtensionContext, state: VoiceModeState) {
	if (!ctx.hasUI) return;
	const status = state.enabled
		? state.status === "listening"
			? "listening…"
			: state.status === "agent"
				? "agent working"
				: state.status === "speaking"
					? "speaking…"
					: "voice on"
		: "voice ready";
	ctx.ui.setStatus("pi-listens", status);
	if (!state.enabled) return;
	ctx.ui.setWorkingIndicator({
		frames: state.status === "listening"
			? [ctx.ui.theme.fg("accent", "●"), ctx.ui.theme.fg("muted", "•")]
			: state.status === "speaking"
				? [ctx.ui.theme.fg("accent", "♪"), ctx.ui.theme.fg("muted", "♫")]
				: [ctx.ui.theme.fg("accent", "◌")],
		intervalMs: state.status === "speaking" ? 200 : 250,
	});
}

class VoiceLoopEditor extends CustomEditor {
	private animationTimer?: ReturnType<typeof setInterval>;
	private frame = 0;
	private interactions: CharacterInteraction[] = [];
	private lastRenderWidth = 80;
	private lastRenderLineCount = 0;
	private mouseEnabled = false;

	constructor(
		tui: ConstructorParameters<typeof CustomEditor>[0],
		theme: ConstructorParameters<typeof CustomEditor>[1],
		keybindings: ConstructorParameters<typeof CustomEditor>[2],
		private readonly loopState: VoiceModeState,
		private readonly callbacks: VoiceUiCallbacks,
		private readonly voiceTheme: any,
	) {
		super(tui, theme, keybindings);
		this.animationTimer = setInterval(() => {
			this.frame++;
			this.tui.requestRender();
		}, frameIntervalForStatus(this.loopState.status));
		this.enableMouseInput();
	}

	handleInput(data: string): void {
		const mouse = parseSgrMouse(data);
		if (mouse) {
			if (mouse.pressed && mouse.button === 0) this.triggerMouseCharacterClick(mouse);
			return;
		}
		if (data === " ") {
			this.triggerCharacterClick(1);
			this.callbacks.startListening();
			return;
		}
		if (data.toLowerCase() === "a") {
			this.triggerCharacterClick(0.65, 0.18, 0.1);
			this.callbacks.toggleAutoListen();
			return;
		}
		if (data.toLowerCase() === "q") {
			this.triggerCharacterClick(0.4, 0, 0.18);
			this.callbacks.disable();
			return;
		}
		super.handleInput(data);
	}

	dispose(): void {
		if (this.animationTimer) {
			clearInterval(this.animationTimer);
			this.animationTimer = undefined;
		}
		this.disableMouseInput();
	}

	render(width: number): string[] {
		this.lastRenderWidth = width;
		const lines: string[] = [];
		const addCentered = (text = "") => lines.push(center(text, width));
		const palette = paletteForStatus(this.loopState.status);
		this.interactions = this.interactions.filter((interaction) => this.frame - interaction.frame < 32);

		lines.push("");
		const imageLines = renderVoiceCharacterImage(this.loopState.status, width, palette, this.frame);
		if (imageLines) {
			lines.push(...imageLines);
		} else {
			for (const characterLine of renderVoiceCharacter(DEFAULT_VOICE_CHARACTER, { status: this.loopState.status, frame: this.frame, palette, interactions: this.interactions })) addCentered(characterLine);
		}
		addCentered(compactStatus(this.loopState.status, palette, this.frame));
		addCentered(color(palette.dim, "any language → English"));
		lines.push("");
		for (const line of controlRail(this.loopState, palette, width)) addCentered(line);
		if (this.loopState.lastError) {
			lines.push("");
			addCentered(truncateToWidth(color(paletteForStatus("error").fg, this.loopState.lastError), Math.max(10, width - 4)));
		}
		this.lastRenderLineCount = lines.length;
		return lines;
	}

	private triggerMouseCharacterClick(mouse: SgrMouseEvent): void {
		const centerCol = Math.max(1, this.lastRenderWidth / 2);
		let x = clamp((mouse.col - centerCol) / (CHARACTER_WIDTH / 2), -0.95, 0.95);

		const terminalRows = process.stdout.rows ?? this.lastRenderLineCount;
		const approximateTop = Math.max(1, terminalRows - this.lastRenderLineCount - 2);
		const characterCenterRow = approximateTop + 1 + (CHARACTER_HEIGHT - 1) / 2;
		let y = clamp((mouse.row - characterCenterRow) / ((CHARACTER_HEIGHT - 1) / 2), -0.95, 0.95);

		// Terminal mouse coordinates are global, while the extension API does not expose
		// the editor's exact row. If the estimate misses, still give a centered response.
		if (!Number.isFinite(x)) x = 0;
		if (!Number.isFinite(y) || Math.abs(mouse.row - characterCenterRow) > CHARACTER_HEIGHT) y = 0;

		this.triggerCharacterClick(1.25, x, y, true);
	}

	private enableMouseInput(): void {
		if (this.mouseEnabled || !process.stdout.isTTY) return;
		process.stdout.write(MOUSE_ENABLE);
		this.mouseEnabled = true;
	}

	private disableMouseInput(): void {
		if (!this.mouseEnabled) return;
		disableTerminalMouseInput();
		this.mouseEnabled = false;
	}

	private triggerCharacterClick(strength: number, x = 0, y = 0, burst = false): void {
		this.interactions.push({ frame: this.frame, x, y, strength });
		if (burst) {
			this.interactions.push({ frame: this.frame - 3, x: x * 0.45, y: y * 0.45, strength: strength * 0.55 });
			this.interactions.push({ frame: this.frame - 7, x: -x * 0.28, y: -y * 0.28, strength: strength * 0.32 });
		}
		this.interactions = this.interactions.slice(-8);
		this.tui.requestRender();
	}
}

function compactStatus(status: VoiceModeState["status"], palette: VoiceCharacterPalette, frame = 0): string {
	const labels: Record<VoiceModeState["status"], string> = {
		idle: "ready",
		listening: "listening",
		agent: "working",
		speaking: "speaking",
		error: "attention",
	};
	return shimmer(labels[status], palette, frame);
}

function paletteForStatus(status: VoiceModeState["status"]): VoiceCharacterPalette {
	switch (status) {
		case "listening":
			return { fg: "38;2;80;220;255", bright: "38;2;180;245;255", soft: "38;2;50;140;255", dim: "38;2;24;75;130" };
		case "agent":
			return { fg: "38;2;167;139;250", bright: "38;2;216;180;254", soft: "38;2;124;58;237", dim: "38;2;76;29;149" };
		case "speaking":
			return { fg: "38;2;255;120;210", bright: "38;2;255;200;240", soft: "38;2;219;39;119", dim: "38;2;131;24;67" };
		case "error":
			return { fg: "38;2;255;107;107", bright: "38;2;255;190;190", soft: "38;2;220;38;38", dim: "38;2;127;29;29" };
		default:
			return { fg: "38;2;94;234;212", bright: "38;2;204;251;241", soft: "38;2;20;184;166", dim: "38;2;19;78;74" };
	}
}


function disableTerminalMouseInput(): void {
	if (process.stdout.isTTY) process.stdout.write(MOUSE_DISABLE);
}

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}

function parseSgrMouse(data: string): SgrMouseEvent | undefined {
	const match = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/.exec(data);
	if (!match) return undefined;
	const code = Number(match[1]);
	const col = Number(match[2]);
	const row = Number(match[3]);
	if (!Number.isFinite(code) || !Number.isFinite(col) || !Number.isFinite(row)) return undefined;
	if (code >= 64) return undefined; // scroll wheel, not a click
	return { button: code & 3, col, row, pressed: match[4] === "M" };
}

function shimmer(text: string, palette: VoiceCharacterPalette, frame: number): string {
	return [...text].map((ch, index) => color((index + frame) % 6 === 0 ? palette.bright : palette.fg, ch)).join("");
}

function frameIntervalForStatus(status: VoiceModeState["status"]): number {
	return status === "listening" ? 80 : status === "speaking" ? 90 : status === "agent" ? 120 : 110;
}

function controlRail(state: VoiceModeState, palette: VoiceCharacterPalette, width: number): string[] {
	const listenLabel = state.isListening ? "stop" : "listen";
	const pills = [
		controlPill("Space", listenLabel, state.isListening ? "active" : "primary", palette),
		controlPill("A", state.autoListen ? "auto-listen on" : "auto-listen off", state.autoListen ? "active" : "muted", palette),
		controlPill("Q", "close", "danger", palette),
	];
	return wrapInline(pills, "  ", Math.max(24, width - 2));
}

function controlPill(key: string, label: string, tone: "primary" | "active" | "muted" | "danger", palette: VoiceCharacterPalette): string {
	const bg = tone === "active" ? "48;2;17;83;91" : tone === "primary" ? "48;2;17;42;72" : tone === "danger" ? "48;2;54;24;36" : "48;2;15;23;42";
	const keyFg = tone === "danger" ? "38;2;255;190;190" : tone === "muted" ? "38;2;203;213;225" : palette.bright;
	const labelFg = tone === "muted" ? "38;2;148;163;184" : "38;2;226;232;240";
	return `\x1b[${bg}m\x1b[1m\x1b[${keyFg}m ${key} \x1b[22m\x1b[${labelFg}m ${label} \x1b[0m`;
}

function wrapInline(items: string[], gap: string, maxWidth: number): string[] {
	const lines: string[] = [];
	let current = "";
	for (const item of items) {
		const candidate = current ? `${current}${gap}${item}` : item;
		if (current && visibleWidth(candidate) > maxWidth) {
			lines.push(current);
			current = item;
		} else {
			current = candidate;
		}
	}
	if (current) lines.push(current);
	return lines;
}

function color(code: string, text: string): string {
	return `\x1b[${code}m${text}\x1b[39m`;
}

function center(text: string, width: number): string {
	const pad = Math.max(0, Math.floor((width - visibleWidth(text)) / 2));
	return truncateToWidth(`${" ".repeat(pad)}${text}`, width);
}
