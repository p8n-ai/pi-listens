import assert from "node:assert/strict";
import test from "node:test";
import { conciseTranscript } from "../src/text.js";

test("conciseTranscript returns placeholder for empty input", () => {
	assert.equal(conciseTranscript(""), "(no speech recognized)");
	assert.equal(conciseTranscript("  "), "(no speech recognized)");
});

test("conciseTranscript trims and returns non-empty input", () => {
	assert.equal(conciseTranscript("  hello world  "), "hello world");
});
