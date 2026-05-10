import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { characterBounds, DEFAULT_VOICE_CHARACTER, renderVoiceCharacter, type VoiceCharacterStatus } from "../src/characters.js";

const palette = {
	fg: "38;2;94;234;212",
	bright: "38;2;204;251;241",
	soft: "38;2;20;184;166",
	dim: "38;2;19;78;74",
};

const statuses: VoiceCharacterStatus[] = ["idle", "listening", "agent", "speaking", "error"];

test("default voice character defines frames for every voice state", () => {
	for (const status of statuses) {
		assert.ok(DEFAULT_VOICE_CHARACTER.frames[status].length > 0, `${status} should have at least one frame`);
	}
});

test("rendered character frames stay inside the declared bounds", () => {
	const bounds = characterBounds(DEFAULT_VOICE_CHARACTER);
	assert.ok(bounds.width > 0);
	assert.ok(bounds.height > 0);

	for (const status of statuses) {
		const lines = renderVoiceCharacter(DEFAULT_VOICE_CHARACTER, { status, frame: 0, palette });
		assert.ok(lines.length <= bounds.height);
		for (const line of lines) assert.ok(visibleWidth(line) <= bounds.width);
	}
});

test("character renderer changes the visible pose by state", () => {
	const listening = renderVoiceCharacter(DEFAULT_VOICE_CHARACTER, { status: "listening", frame: 0, palette }).join("\n");
	const speaking = renderVoiceCharacter(DEFAULT_VOICE_CHARACTER, { status: "speaking", frame: 0, palette }).join("\n");
	const working = renderVoiceCharacter(DEFAULT_VOICE_CHARACTER, { status: "agent", frame: 0, palette }).join("\n");

	assert.match(listening, /≋/);
	assert.match(speaking, /♪|♫/);
	assert.match(working, /▣/);
});
