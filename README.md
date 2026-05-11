# @p8n.ai/pi-listens

Speech-first Pi package with a provider abstraction for speech-to-text (STT) and text-to-speech (TTS). The default bundled provider is [Sarvam AI](https://www.sarvam.ai/), which gives Pi tools and commands for:

- streaming speech-to-text (STT) with Sarvam Saaras (`saaras:v3`) over WebSockets
- text-to-speech (TTS) with Sarvam Bulbul (`bulbul:v3`)
- voice-first clarification loops where the agent speaks a question, listens, transcribes, and continues
- interactive TUI and headless/RPC usage through Pi extension tools and UI fallback

## Quick start

```bash
pi install npm:@p8n.ai/pi-listens
pi
```

Inside Pi, run `/voice-init` to create a global settings file with sensible defaults:

```
/voice-init
```

Then open `~/.pi/pi-listens.json` and replace the provider credential placeholder with your [Sarvam AI API key](https://dashboard.sarvam.ai).

Alternatively, set the provider and key via environment variables:

```bash
export PI_LISTENS_PROVIDER="sarvam"
export PI_LISTENS_SARVAM_API_KEY="your-sarvam-api-key"
# legacy aliases still work: SARVAM_API_KEY or SARVAM_API_SUBSCRIPTION_KEY
```

For local development from this checkout:

```bash
npm install
npm run typecheck
pi -e /Users/ravindrabarthwal/Projects/pi-listens
```

## System requirements

### Voice provider credentials

The bundled provider is Sarvam AI. Set one of:

```bash
export PI_LISTENS_SARVAM_API_KEY="..."
# or legacy aliases
export SARVAM_API_KEY="..."
export SARVAM_API_SUBSCRIPTION_KEY="..."
```

Sarvam's SDK uses the `api-subscription-key` auth model internally; this package uses the official `sarvamai` npm package inside the Sarvam provider module.

### Local microphone recorder and audio player

`pi-listens` records from the local microphone and plays audio locally.

Auto-detected recorders:

1. `rec` from SoX (recommended)
2. `ffmpeg` (`avfoundation` on macOS, `alsa` on Linux)

Auto-detected players:

1. `afplay` on macOS
2. `play` from SoX
3. `ffplay`
4. `aplay`

You can override capture/playback with command templates:

```bash
export PI_LISTENS_RECORD_COMMAND='rec -q -r {sampleRate} -c 1 -b 16 {path} trim 0 {seconds}'
export PI_LISTENS_STREAM_COMMAND='rec -q -r {sampleRate} -c 1 -b 16 -e signed-integer -t raw -'
export PI_LISTENS_PLAY_COMMAND='afplay {path}'
```

Template variables are shell-quoted automatically. Recording templates support `{path}`, `{seconds}`, `{sampleRate}`. Streaming templates write 16-bit mono PCM to stdout and support `{sampleRate}`.

## Agent tools

The package registers these tools for Pi's agent:

| Tool | Purpose |
| --- | --- |
| `voice_output` | Speak short user-facing text via the configured TTS provider and local playback. |
| `voice_input` | Stream microphone audio to the configured STT provider. |
| `voice_ask` | Speak a concise question, then listen and transcribe the user's answer. |
| `voice_transcribe_file` | Transcribe an existing audio file. |
| `voice_setup_check` | Check provider credentials, recorder, player, and model configuration. |

The extension also injects voice guidance into the system prompt:

- use `voice_ask` whenever user input is needed in voice-first sessions
- use `voice_output` only for short spoken status or response snippets
- keep spoken replies to 1-2 short sentences with no headings, hashtags, bullet lists, boilerplate recaps, or full task summaries
- do not speak code blocks, logs, diffs, stack traces, or long explanations

## Commands

| Command | Purpose |
| --- | --- |
| `/voice-init` | Create a global settings file at `~/.pi/pi-listens.json` with sensible defaults. Use `--overwrite` to replace an existing file. |
| `/speak <text>` | Speak text with the configured TTS provider. |
| `/voice-on [--manual] [--no-listen] [seconds]` | Start the hands-free voice loop. Auto-listens for the next instruction after each agent turn. `--manual` disables auto-listen (press Space to listen). |
| `/voice-check` | Show setup diagnostics and voice-mode status. |
| `/voice-chatty` | Toggle conversational mode. When on, the agent speaks its responses and thinks out loud. |

Voice panel controls in interactive mode:
- Space: listen now; press again while listening to stop; if Pi is speaking, stops playback first
- A: toggle auto-listen (listen again after each assistant reply)
- Q: close the panel and stop any active listening or speaking
- Click the character: visual sparkle feedback (terminals with mouse reporting)

The character animates to reflect the current state:

| State | Character Color | Pose | Status Bar |
| --- | --- | --- | --- |
| Idle | Teal | Calm standing pose with a subtle blink | `voice on` |
| Listening | Blue | Alert eyes, ear pose, and incoming wave lines | `listening…` |
| Speaking | Pink/Magenta | Open-mouth talking frames with music/sound waves | `speaking…` |
| Agent working | Purple | Focused face with a small terminal/laptop panel | `agent working` |
| Error | Red | Concerned face with alert marks | Shows error message |

The current implementation uses ANSI/Unicode sprite frames so it works in ordinary terminals. Pi's TUI also has an `Image` component for Kitty, iTerm2, Ghostty, and WezTerm, so future character packs can experiment with PNG sprites where the terminal supports inline images.

## Headless/RPC behavior

Pi extension tools work in interactive TUI and headless/RPC modes.

- The audio capture/playback still happens on the machine running Pi.
- When speech is not recognized, `voice_input` and `voice_ask` use Pi's extension UI text fallback if UI is available.
- In RPC mode that fallback becomes an `extension_ui_request` (`input`) event, so a client can provide textual input.
- In print/JSON modes, UI fallback is unavailable; the tool returns the empty transcription so the agent can recover.

## Configuration

Configuration is resolved in this order, with later entries overriding earlier ones:

1. defaults
2. `~/.pi/agent/pi-listens.json` (legacy global path, still supported)
3. `~/.pi/pi-listens.json` (global user config)
4. `<project>/.pi/pi-listens.json` (project config)
5. environment variables

Project config overrides global config, and environment variables override both.

Example config file:

```json
{
  "provider": "sarvam",
  "sarvamApiKey": "paste-your-sarvam-api-key-here",
  "sttModel": "saaras:v3",
  "sttMode": "transcribe",
  "sttLanguageCode": "unknown",
  "translateInputToEnglish": true,
  "ttsModel": "bulbul:v3",
  "ttsLanguageCode": "en-IN",
  "ttsSpeaker": "shubh",
  "recordSeconds": 300,
  "recordSampleRate": 16000,
  "streamChunkMs": 250,
  "streamMaxSeconds": 300,
  "silenceStartSeconds": 0.2,
  "silenceStopSeconds": 3.5,
  "silenceThreshold": "1%",
  "ttsSampleRate": 24000,
  "ttsOutputCodec": "wav",
  "textFallback": true,
  "conversational": false
}
```

Supported environment variables:

- `PI_LISTENS_PROVIDER` (`sarvam` by default)
- `PI_LISTENS_SARVAM_API_KEY` (preferred for the bundled Sarvam provider)
- `SARVAM_API_KEY` / `SARVAM_API_SUBSCRIPTION_KEY` (legacy aliases for the Sarvam provider key)
- `PI_LISTENS_STT_MODEL`
- `PI_LISTENS_STT_MODE` (`transcribe`, `translate`, `verbatim`, `translit`, `codemix`)
- `PI_LISTENS_STT_LANGUAGE` (default `unknown`)
- `PI_LISTENS_TRANSLATE_INPUT_TO_ENGLISH` (default `true`; speak any supported language, send English to the agent)
- `PI_LISTENS_TTS_MODEL`
- `PI_LISTENS_TTS_LANGUAGE` (default `en-IN`)
- `PI_LISTENS_TTS_SPEAKER` (default `shubh`)
- `PI_LISTENS_TTS_PACE`
- `PI_LISTENS_TTS_TEMPERATURE`
- `PI_LISTENS_TTS_SAMPLE_RATE`
- `PI_LISTENS_TTS_OUTPUT_CODEC` (`wav`, `mp3`, `linear16`, `mulaw`, `alaw`, `opus`, `flac`, `aac`)
- `PI_LISTENS_RECORD_SECONDS` (default `300`; maximum listen duration for one streaming utterance)
- `PI_LISTENS_RECORD_SAMPLE_RATE` (default `16000`; Sarvam streaming works best with 16kHz mono PCM)
- `PI_LISTENS_STREAM_CHUNK_MS` (default `250`; outgoing WebSocket audio chunk size)
- `PI_LISTENS_STREAM_MAX_SECONDS` (default `300`; default maximum for streaming microphone capture)
- `PI_LISTENS_SILENCE_START_SECONDS`
- `PI_LISTENS_SILENCE_STOP_SECONDS`
- `PI_LISTENS_SILENCE_THRESHOLD`

`recordSeconds` is the maximum time Pi will keep streaming one utterance. `silenceStopSeconds` is the quiet pause after which it considers the utterance complete, flushes the WebSocket, and submits the transcript. For example, `recordSeconds: 300` and `silenceStopSeconds: 3.5` means “let me speak for up to 5 minutes, but submit after 3.5 seconds of silence.”
- `PI_LISTENS_RECORD_COMMAND`
- `PI_LISTENS_PLAY_COMMAND`
- `PI_LISTENS_AUDIO_DIR`
- `PI_LISTENS_DELETE_AUDIO`
- `PI_LISTENS_TEXT_FALLBACK`
- `PI_LISTENS_CONVERSATIONAL` (default `false`; when `true`, the agent speaks its responses conversationally)

## Provider architecture

The extension code talks to a generic `VoiceProvider` interface for microphone transcription, file transcription, file synthesis, and streamed synthesis. Sarvam-specific WebSocket and SDK logic lives in `src/providers/sarvam.ts`; provider selection and routing live in `src/providers/index.ts`. To add another STT/TTS provider later, add a provider module that implements the interface and register it in the provider router.

## Notes

- The bundled Sarvam provider uses the WebSocket streaming API for microphone input, not the 30-second synchronous REST endpoint.
- Streaming input is sent as 16kHz, 16-bit, mono PCM (`pcm_s16le`) with `saaras:v3` by default.
- macOS may ask for microphone permissions the first time `rec` or `ffmpeg` records audio.
- Spoken output is intentionally optimized for concise interaction, not for reading code or full agent responses.
- When `conversational` mode is enabled, the agent speaks most of its responses, thinks out loud, and uses `voice_ask` for all clarification. Toggle at runtime with `/voice-chatty`.
