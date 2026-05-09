# Changelog

All notable changes to `@p8n.ai/pi-listens` will be documented in this file.

This project follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.2.3] - 2026-05-09
### Added

- Conversational mode (`conversational` config option, default `false`). When enabled, the agent speaks its responses, thinks out loud, and uses `voice_ask` for all decisions instead of text or forms.
- `/voice-chatty` command to toggle conversational mode at runtime without editing config.
- `PI_LISTENS_CONVERSATIONAL` environment variable.

### Fixed

- Consecutive `voice_output` calls now play in sequence instead of each one cutting off the previous. Uses an internal playback queue.
- Voice orb no longer flickers to teal (idle) between queued voice outputs — stays pink (speaking) throughout.
- Voice orb shows purple (agent working) instead of teal (idle) when speech finishes but the agent is still processing.
- `voice_ask` waits for any queued speech to finish before speaking its question, instead of interrupting.

### Removed

- Unused `transcribing` orb state (was defined but never activated).

## [0.2.2] - 2026-05-09

## [0.2.1] - 2026-05-09

### Changed

- Remove automatic read-aloud of assistant replies (`autoSpeakAssistant`). The agent controls speech via the `voice_output` tool — no more unsolicited summaries.
- `voice_output` now stops any in-flight playback before starting new speech, preventing overlapping audio.
- Voice loop waits for any tool-initiated playback to finish before opening the mic for the next listen cycle.
- Remove `autoSpeakAssistant`, `maxAutoSpeakChars` config options and `PI_LISTENS_AUTO_SPEAK`, `PI_LISTENS_MAX_AUTO_SPEAK_CHARS` env vars.
- Remove the "S" (read-aloud toggle) key and pill from the voice panel.
- Remove `--no-speak` flag from `/voice-on`.

### Added

- Voice orb now shows a **speaking** state (pink/magenta palette with wave animation) when `voice_output` or `voice_ask` is playing audio. Status bar shows "speaking…" with ♪/♫ indicators.

## [0.2.0] - 2026-05-09

### Added

- `/voice-init` command to create a global settings file (`~/.pi/pi-listens.json`) with sensible defaults.
- `/voice-check` command (replaces `/voice-status`) with improved diagnostic output.

### Changed

- `/voice-on` now enables auto-speak by default for a full hands-free experience. Use `--no-speak` to opt out. _(removed in next release)_
- Rename `/voice-status` to `/voice-check` to better communicate its diagnostic purpose.

### Removed

- `/listen` slash command. Use `/voice-on` for the hands-free voice loop, or the `voice_input` agent tool for programmatic speech input.
## [0.1.2] - 2026-05-09

### Changed

- Stream TTS audio directly to the local player so speech starts sooner.
- Make `voice_output` non-blocking by default; pass `wait_for_playback: true` to wait.
- Replace the `R` voice-panel shortcut with Space for easier listen/stop control.

## [0.1.1] - 2026-05-09

### Fixed

- Return Sarvam STT results faster after flushing microphone audio.
- Stop current speech playback before starting a new listen, without cancelling the new recording.
- Keep spoken auto-summaries concise and avoid headings, hashtags, bullet lists, and boilerplate recaps.

## [0.1.0] - 2026-05-09

### Added

- Initial release of `@p8n.ai/pi-listens` for Pi.
- Sarvam AI speech-to-text tools for microphone input and audio file transcription.
- Sarvam AI text-to-speech tools for spoken output and spoken clarification loops.
- `/listen`, `/speak`, `/voice-on`, and `/voice-status` slash commands.
- Interactive voice panel with listen, auto-listen, and close controls.
- Config support through environment variables, user config, and project config.
- Global config at `~/.pi/pi-listens.json`, with project-level overrides from `<project>/.pi/pi-listens.json`.

### Fixed

- Stop active audio capture/playback subprocesses when voice mode is closed or the Pi session shuts down.
- Clean up generated audio files when spoken playback is interrupted.

[Unreleased]: https://github.com/p8n-ai/pi-listens/compare/v0.2.3...HEAD
[0.1.0]: https://github.com/p8n-ai/pi-listens/releases/tag/v0.1.0
[0.1.1]: https://github.com/p8n-ai/pi-listens/releases/tag/v0.1.1
[0.1.2]: https://github.com/p8n-ai/pi-listens/releases/tag/v0.1.2
[0.2.0]: https://github.com/p8n-ai/pi-listens/releases/tag/v0.2.0
[0.2.1]: https://github.com/p8n-ai/pi-listens/releases/tag/v0.2.1
[0.2.2]: https://github.com/p8n-ai/pi-listens/releases/tag/v0.2.2
[0.2.3]: https://github.com/p8n-ai/pi-listens/releases/tag/v0.2.3
