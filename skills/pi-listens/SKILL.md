---
name: pi-listens
description: Use when interacting with the user by voice through @p8n.ai/pi-listens, Sarvam AI speech-to-text, or Sarvam AI text-to-speech. Applies when the user says they are speaking, wants voice input/output, asks Pi to listen, or when clarification should be gathered by voice.
---

# Pi Listens Voice Interaction

This Pi package provides voice tools backed by Sarvam AI.

## Tools

- `voice_output`: speak a short message to the user with Sarvam TTS.
- `voice_input`: listen to the microphone and transcribe the user's speech.
- `voice_ask`: speak a concise question, then listen and transcribe the answer.
- `voice_transcribe_file`: transcribe an existing audio file.
- `voice_setup_check`: diagnose API key, recorder, player, and voice settings.

## Commands

- `/init`: create a global settings file with defaults. User only needs to set their Sarvam API key.
- `/speak <text>`: speak text with Sarvam TTS.
- `/voice-on`: start hands-free voice loop (auto-listens after each agent turn by default).
- `/voice-check`: show setup diagnostics and voice-mode status.

## Usage rules

1. When you need user input, clarification, or confirmation, use `voice_ask` instead of asking only in text.
2. Before using `voice_input`, make sure the user already knows you are listening. If not, use `voice_ask`.
3. Use `voice_output` only for concise spoken status updates or spoken summaries that matter to the user.
4. Spoken output must be brief: 1-2 short sentences, no markdown headings, no hashtags, no bullet lists, no boilerplate recap, and no full task summaries. Leave details in text.
5. Do not speak code blocks, diffs, stack traces, logs, long tables, or lengthy explanations. Summarize briefly and leave details in text.
6. Treat transcripts returned by `voice_input` or `voice_ask` as user input, while allowing for speech-recognition mistakes. If the transcript is ambiguous, ask a short follow-up with `voice_ask`.
7. If speech is not recognized, rely on the tool's text fallback when available, or ask again with a shorter prompt.

## Good voice question style

- Ask one thing at a time.
- Keep questions under one sentence where possible.
- Offer clear options if the answer space is constrained.
- Prefer: "Which option should I use: A, B, or C?"
- Avoid: long multi-part questions or reading implementation details aloud.
