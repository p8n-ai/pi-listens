
export function conciseTranscript(transcript: string): string {
	const trimmed = transcript.trim();
	return trimmed.length === 0 ? "(no speech recognized)" : trimmed;
}
