# pi-listens — Sarvam AI voice extension for Pi

Single TypeScript extension, no build step. Pi loads `src/index.ts` directly.

| File | Purpose |
|------|---------|
| `src/index.ts` | Extension entry, event hooks |
| `src/tools.ts` | Agent tools (voice_output, voice_input, voice_ask) |
| `src/commands.ts` | Slash commands (/voice-init, /speak, /voice-on, /voice-check) |
| `src/sarvam.ts` | Sarvam AI client (WebSocket STT, REST TTS) |
| `src/audio.ts` | Local mic recording and playback |
| `src/config.ts` | Config resolution (defaults → user → project → env) |

## Rules

- **STT uses WebSocket streaming**, not the 30s REST endpoint.
- **Never push release commits to main.** Use `gh workflow run release.yml --field bump=patch`.

```bash
npm test                     # typecheck + unit tests
gh workflow run release.yml --field bump=patch   # trigger a release
```
