# Changelog

All notable changes to `@p8n.ai/pi-listens` will be documented in this file.

This project follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- `/init` command to create a global settings file (`~/.pi/pi-listens.json`) with sensible defaults.
- `/voice-check` command (replaces `/voice-status`) with improved diagnostic output.

### Changed

- `/voice-on` now enables auto-speak by default for a full hands-free experience. Use `--no-speak` to opt out.
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
- Interactive voice panel with listen, auto-listen, read-aloud, and close controls.
- Config support through environment variables, user config, and project config.
- Global config at `~/.pi/pi-listens.json`, with project-level overrides from `<project>/.pi/pi-listens.json`.

### Fixed

- Stop active audio capture/playback subprocesses when voice mode is closed or the Pi session shuts down.
- Clean up generated audio files when spoken playback is interrupted.

[Unreleased]: https://github.com/p8n-ai/pi-listens/compare/v0.1.2...HEAD
[0.1.0]: https://github.com/p8n-ai/pi-listens/releases/tag/v0.1.0
[0.1.1]: https://github.com/p8n-ai/pi-listens/releases/tag/v0.1.1
[0.1.2]: https://github.com/p8n-ai/pi-listens/releases/tag/v0.1.2
