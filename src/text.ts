export function firstTextContent(message: unknown): string {
	if (!message || typeof message !== "object") return "";
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			if (!part || typeof part !== "object") return "";
			const p = part as { type?: string; text?: string };
			return p.type === "text" && typeof p.text === "string" ? p.text : "";
		})
		.filter(Boolean)
		.join("\n")
		.trim();
}

export function prepareSpokenText(text: string, maxChars: number): string {
	let prepared = text
		.replace(/```[\s\S]*?```/g, " I skipped a code block. ")
		.replace(/^\s{0,3}#{1,6}\s+/gm, "")
		.replace(/^\s*[-*+]\s+/gm, "")
		.replace(/^\s*\d+[.)]\s+/gm, "")
		.replace(/`([^`]+)`/g, "$1")
		.replace(/https?:\/\/\S+/g, "link")
		.replace(/[#*_>~|]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();

	prepared = conciseSpokenSummary(prepared);
	if (prepared.length > maxChars) {
		prepared = `${prepared.slice(0, Math.max(0, maxChars - 32)).trim()}… More on screen.`;
	}
	return prepared;
}

function conciseSpokenSummary(text: string): string {
	const sentences = text.match(/[^.!?]+[.!?]+|[^.!?]+$/g)?.map((part) => part.trim()).filter(Boolean) ?? [];
	if (sentences.length === 0) return text;

	const useful = sentences.filter((sentence) => !/^(sure|here('|’)s|summary|in summary|done|completed|i('|’)ve|i have)\b/i.test(sentence));
	const picked = (useful.length ? useful : sentences).slice(0, 2).join(" ").trim();
	return picked || text;
}

export function conciseTranscript(transcript: string): string {
	const trimmed = transcript.trim();
	return trimmed.length === 0 ? "(no speech recognized)" : trimmed;
}
