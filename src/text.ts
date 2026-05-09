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
		.replace(/```[\s\S]*?```/g, " I am skipping a code block. ")
		.replace(/`([^`]+)`/g, "$1")
		.replace(/https?:\/\/\S+/g, "link")
		.replace(/\s+/g, " ")
		.trim();
	if (prepared.length > maxChars) {
		prepared = `${prepared.slice(0, Math.max(0, maxChars - 80)).trim()}… I have more details on screen.`;
	}
	return prepared;
}

export function conciseTranscript(transcript: string): string {
	const trimmed = transcript.trim();
	return trimmed.length === 0 ? "(no speech recognized)" : trimmed;
}
