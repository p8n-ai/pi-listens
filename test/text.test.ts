import assert from "node:assert/strict";
import test from "node:test";
import { prepareSpokenText } from "../src/text.js";

test("prepareSpokenText keeps spoken summaries concise and skips boilerplate", () => {
	const spoken = prepareSpokenText(
		`# Summary\n\nDone.\n\n- Changed src/audio.ts\n- Added tests\n\nHere is what changed: playback now stops before listening starts. More details are visible on screen. #shipit`,
		140,
	);

	assert.equal(spoken.includes("#"), false);
	assert.equal(spoken.includes("- Changed"), false);
	assert.equal(spoken.length <= 140, true);
	assert.match(spoken, /playback now stops/i);
});

test("prepareSpokenText does not read code blocks aloud", () => {
	const spoken = prepareSpokenText(
		`Here is the command:\n\n\`\`\`bash\nnpm test\n\`\`\`\n\nThe fix is ready for review.`,
		160,
	);

	assert.equal(spoken.includes("npm test"), false);
	assert.match(spoken, /skipped a code block|fix is ready/i);
});
