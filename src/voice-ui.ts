import { CustomEditor, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { VoiceModeState } from "./commands.js";

type EditorFactory = ReturnType<ExtensionContext["ui"]["getEditorComponent"]>;

export interface VoiceUiCallbacks {
	startListening: () => void;
	disable: () => void;
	toggleSpeak: () => void;
	toggleAutoListen: () => void;
}

const ORB_WIDTH = 38;
const ORB_HEIGHT = 18;
const MOUSE_ENABLE = "\x1b[?1000h\x1b[?1006h";
const MOUSE_DISABLE = "\x1b[?1000l\x1b[?1006l";

type OrbShockwave = { frame: number; x: number; y: number; strength: number };
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
				: state.autoSpeakAssistant
					? "voice on + speak"
					: "voice on"
		: "voice ready";
	ctx.ui.setStatus("pi-listens", status);
	if (!state.enabled) return;
	ctx.ui.setWorkingIndicator({
		frames: state.status === "listening" ? [ctx.ui.theme.fg("accent", "●"), ctx.ui.theme.fg("muted", "•")] : [ctx.ui.theme.fg("accent", "◌")],
		intervalMs: 250,
	});
}

class VoiceLoopEditor extends CustomEditor {
	private animationTimer?: ReturnType<typeof setInterval>;
	private frame = 0;
	private shockwaves: OrbShockwave[] = [];
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
			if (mouse.pressed && mouse.button === 0) this.triggerMouseOrbClick(mouse);
			return;
		}
		if (data.toLowerCase() === "r") {
			this.triggerOrbClick(1);
			this.callbacks.startListening();
			return;
		}
		if (data.toLowerCase() === "s") {
			this.triggerOrbClick(0.5, -0.18, 0.12);
			this.callbacks.toggleSpeak();
			return;
		}
		if (data.toLowerCase() === "a") {
			this.triggerOrbClick(0.65, 0.18, 0.1);
			this.callbacks.toggleAutoListen();
			return;
		}
		if (data.toLowerCase() === "q") {
			this.triggerOrbClick(0.4, 0, 0.18);
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
		this.shockwaves = this.shockwaves.filter((wave) => this.frame - wave.frame < 40);

		lines.push("");
		for (const orbLine of animatedGlowingOrb(palette, this.loopState.status, this.frame, this.shockwaves)) addCentered(orbLine);
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

	private triggerMouseOrbClick(mouse: SgrMouseEvent): void {
		const centerCol = Math.max(1, this.lastRenderWidth / 2);
		let x = clamp((mouse.col - centerCol) / (ORB_WIDTH / 2), -0.95, 0.95);

		const terminalRows = process.stdout.rows ?? this.lastRenderLineCount;
		const approximateTop = Math.max(1, terminalRows - this.lastRenderLineCount - 2);
		const orbCenterRow = approximateTop + 1 + (ORB_HEIGHT - 1) / 2;
		let y = clamp((mouse.row - orbCenterRow) / ((ORB_HEIGHT - 1) / 2), -0.95, 0.95);

		// Terminal mouse coordinates are global, while the extension API does not expose
		// the editor's exact row. If the estimate misses, still give a centered response.
		if (!Number.isFinite(x)) x = 0;
		if (!Number.isFinite(y) || Math.abs(mouse.row - orbCenterRow) > ORB_HEIGHT) y = 0;

		this.triggerOrbClick(1.25, x, y, true);
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

	private triggerOrbClick(strength: number, x = 0, y = 0, burst = false): void {
		this.shockwaves.push({ frame: this.frame, x, y, strength });
		if (burst) {
			this.shockwaves.push({ frame: this.frame - 3, x: x * 0.45, y: y * 0.45, strength: strength * 0.55 });
			this.shockwaves.push({ frame: this.frame - 7, x: -x * 0.28, y: -y * 0.28, strength: strength * 0.32 });
		}
		this.shockwaves = this.shockwaves.slice(-8);
		this.tui.requestRender();
	}
}

function compactStatus(status: VoiceModeState["status"], palette: OrbPalette, frame = 0): string {
	const labels: Record<VoiceModeState["status"], string> = {
		idle: "ready",
		listening: "listening",
		transcribing: "English",
		agent: "working",
		speaking: "speaking",
		error: "attention",
	};
	return shimmer(labels[status], palette, frame);
}

type OrbPalette = { fg: string; bright: string; soft: string; dim: string };

function paletteForStatus(status: VoiceModeState["status"]): OrbPalette {
	switch (status) {
		case "listening":
			return { fg: "38;2;80;220;255", bright: "38;2;180;245;255", soft: "38;2;50;140;255", dim: "38;2;24;75;130" };
		case "transcribing":
			return { fg: "38;2;255;209;102", bright: "38;2;255;238;170", soft: "38;2;245;158;11", dim: "38;2;120;83;25" };
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

function animatedGlowingOrb(palette: OrbPalette, status: VoiceModeState["status"], frame: number, shockwaves: OrbShockwave[] = []): string[] {
	// Amp Neo-inspired dithered glow. The binary exposes its Neo glyph set as:
	// [" ", ".", "·", "·", ":", ":", "•", "•", "●", "●"].
	// We render the same style mathematically in Pi's simpler TUI component model.
	const width = ORB_WIDTH;
	const height = ORB_HEIGHT;
	const chars = [" ", ".", "·", "·", ":", ":", "•", "•", "●", "●"];
	const t = frame / 5;
	const pulse = 0.08 * Math.sin(t);
	const rows: string[] = [];

	for (let y = 0; y < height; y++) {
		let row = "";
		const ny = (y - (height - 1) / 2) / ((height - 1) / 2);
		for (let x = 0; x < width; x++) {
			const nx = (x - (width - 1) / 2) / ((width - 1) / 2);
			const ellipse = Math.sqrt((nx * nx) / (0.96 + pulse) + (ny * ny) / (0.82 + pulse));
			if (ellipse > 1.18) {
				row += " ";
				continue;
			}

			const radial = Math.max(0, 1 - ellipse);
			const rim = Math.max(0, 1 - Math.abs(ellipse - 0.74) * 5.0);
			const sweep = status === "transcribing" ? Math.max(0, 1 - Math.abs(nx - ((frame % 28) / 14 - 1)) * 2.8) : 0;
			const listeningRipple = status === "listening" ? 0.22 * Math.sin(18 * ellipse - t * 3.3) : 0;
			const speakingWave = status === "speaking" ? 0.2 * Math.sin(x * 0.65 + t * 3.8) : 0;
			const thinkingSwirl = status === "agent" ? 0.18 * Math.sin(Math.atan2(ny, nx) * 3 + t * 2.2) : 0;
			const highlight = Math.max(0, 1 - Math.hypot(nx + 0.32 * Math.cos(t), ny - 0.28 * Math.sin(t * 0.8)) * 2.2);
			const click = sampleClickEffect(nx, ny, frame, shockwaves);

			let intensity = radial * 1.25 + rim * 0.5 + highlight * 0.42 + sweep * 0.45 + listeningRipple + speakingWave + thinkingSwirl;
			intensity = clamp01(intensity + click.ring * 0.92 + click.bloom * 0.52 - click.dent * 0.22);
			const charIndex = Math.max(0, Math.min(chars.length - 1, Math.round(intensity * (chars.length - 1))));
			const ch = chars[charIndex] ?? " ";
			const colorCode = click.ring > 0.28 || intensity > 0.78 ? palette.bright : intensity > 0.46 ? palette.fg : intensity > 0.22 ? palette.soft : palette.dim;
			row += color(colorCode, ch);
		}
		rows.push(row);
	}
	return rows;
}

function sampleClickEffect(nx: number, ny: number, frame: number, shockwaves: OrbShockwave[]): { ring: number; bloom: number; dent: number } {
	let ring = 0;
	let bloom = 0;
	let dent = 0;
	for (const wave of shockwaves) {
		const age = frame - wave.frame;
		if (age < 0 || age > 38) continue;
		const progress = age / 38;
		const dx = nx - wave.x;
		const dy = (ny - wave.y) * 1.18;
		const dist = Math.hypot(dx, dy);
		const eased = 1 - (1 - progress) ** 2;
		const radius = 0.04 + eased * 1.22;
		const life = (1 - progress) ** 0.64 * wave.strength;
		ring = Math.max(ring, Math.max(0, 1 - Math.abs(dist - radius) * 10.5) * life);
		bloom = Math.max(bloom, Math.exp(-(dist * dist) / 0.085) * Math.sin(Math.min(1, progress * 2.2) * Math.PI) * wave.strength);
		dent = Math.max(dent, Math.exp(-(dist * dist) / 0.025) * Math.max(0, 1 - progress * 2.4) * wave.strength);
	}
	return { ring: clamp01(ring), bloom: clamp01(bloom), dent: clamp01(dent) };
}

function clamp01(value: number): number {
	return Math.max(0, Math.min(1, value));
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

function shimmer(text: string, palette: OrbPalette, frame: number): string {
	return [...text].map((ch, index) => color((index + frame) % 6 === 0 ? palette.bright : palette.fg, ch)).join("");
}

function frameIntervalForStatus(status: VoiceModeState["status"]): number {
	return status === "listening" ? 80 : status === "speaking" ? 90 : status === "agent" ? 120 : 110;
}

function controlRail(state: VoiceModeState, palette: OrbPalette, width: number): string[] {
	const listenLabel = state.isListening ? "stop" : "listen";
	const pills = [
		controlPill("R", listenLabel, state.isListening ? "active" : "primary", palette),
		controlPill("A", state.autoListen ? "auto-listen on" : "auto-listen off", state.autoListen ? "active" : "muted", palette),
		controlPill("S", state.autoSpeakAssistant ? "read aloud on" : "read aloud off", state.autoSpeakAssistant ? "active" : "muted", palette),
		controlPill("Q", "close", "danger", palette),
	];
	return wrapInline(pills, "  ", Math.max(24, width - 2));
}

function controlPill(key: string, label: string, tone: "primary" | "active" | "muted" | "danger", palette: OrbPalette): string {
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
