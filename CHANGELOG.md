# Changelog

All notable changes to `@p8n.ai/pi-listens` will be documented in this file.

This project follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

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

[Unreleased]: https://github.com/p8n-ai/pi-listens/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/p8n-ai/pi-listens/releases/tag/v0.1.0
