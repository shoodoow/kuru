---
name: kokoro-tts
description: Turn text into natural spoken audio (WAV/MP3) on your own computer with Kokoro, a small open text-to-speech model. No API key, no online service, runs on the CPU faster than real time. Use for a voice-over or narration for a video, reading a script or an article aloud, an audio version of a document, a spoken message, or whenever the person asks for a voice, "say this", TTS or text to speech. Gives per-line timings so a video's cuts and captions can follow the voice. Voices in American and British English, Spanish, French, Italian, Portuguese, Hindi, Japanese and Chinese.
---

# Kokoro text to speech

Kokoro-82M (Apache 2.0) through `kokoro-onnx`. About four seconds of speech per second of work on a plain CPU, so
a five-minute narration takes a minute or two. It needs about 1 GB of memory, which fits the everyday limit: no
`computer_memory` request is needed for speech alone.

## 1. Set up (once per computer)

```bash
bash <skill directory>/scripts/setup.sh
```
The skill directory is the line at the very top of this skill. The script makes a Python environment and downloads
the model (about 350 MB) into `/shared/kokoro`, where every agent on this account can use it. When it is already
there the script returns at once, so run it every time.

## 2. Speak

```bash
/shared/kokoro/venv/bin/python <skill directory>/scripts/speak.py script.txt --out out/voice.wav --voice af_heart
/shared/kokoro/venv/bin/python <skill directory>/scripts/speak.py --text "One short line." --out out/line.wav
```
- `script.txt`: one sentence or beat per line. A blank line is a longer pause. Each line is spoken on its own, so
  a line is also the unit you can time a cut or a caption to.
- `--voice` (list below), `--speed 0.8..1.3` (1.0 default), `--gap 0.25` seconds between lines, `--pause 0.7`
  seconds for a blank line, `--lang` only when the voice's own language is not the text's.
- It prints the total length and writes `out/voice.json` beside the audio: `[{ "text", "start", "end" }, ...]` in
  seconds. Build the video's timeline from that file instead of guessing how long a line takes.
- MP3 or AAC: `ffmpeg -y -i out/voice.wav -af loudnorm=I=-16:TP=-1.5 -b:a 160k out/voice.mp3`.

## 3. Voices

The first letter is the language, the second is `f` female or `m` male.

| Language | `--lang` | Good first choices | Also |
|---|---|---|---|
| American English | `en-us` | `af_heart`, `af_bella`, `am_michael`, `am_fenrir` | `af_nicole` (soft), `af_sarah`, `af_sky`, `am_adam`, `am_puck`, `am_onyx` |
| British English | `en-gb` | `bf_emma`, `bm_george` | `bf_isabella`, `bf_lily`, `bm_fable`, `bm_daniel`, `bm_lewis` |
| Spanish | `es` | `ef_dora`, `em_alex` | |
| French | `fr-fr` | `ff_siwis` | |
| Italian | `it` | `if_sara`, `im_nicola` | |
| Portuguese (Brazil) | `pt-br` | `pf_dora`, `pm_alex` | |
| Hindi | `hi` | `hf_alpha`, `hm_omega` | `hf_beta`, `hm_psi` |
| Japanese | `ja` | `jf_alpha`, `jm_kumo` | |
| Chinese | `cmn` | `zf_xiaoxiao`, `zm_yunxi` | |

`speak.py --voices` prints every voice. There is no voice for other languages (Persian, Arabic, Turkish, German,
Russian and so on): say so plainly instead of reading the text with an English voice, which comes out as nonsense.

## Writing for the ear

- Short sentences, one idea each. Write numbers and symbols the way they are said: "twelve percent", "version two
  point five", "kuru dot app". Spell out an abbreviation the first time unless it is said as a word.
- Fix a mispronounced name by respelling it the way it sounds ("Kooroo"), then listen again.
- A comma is a short breath and a full stop a longer one. Use them to pace the read; do not write "(pause)".
- One voice for the whole piece. Change the voice only for a second speaker.

## Check it before you use it

You cannot hear the file, so measure it:
```bash
ffprobe -v error -show_entries format=duration -of csv=p=0 out/voice.wav          # the length you expect?
ffmpeg -i out/voice.wav -af volumedetect -f null - 2>&1 | grep -E "mean_volume|max_volume"   # not silent, not clipped
```
`voice.json` should have one entry per spoken line, and no line should be far longer than its text suggests. Say
in the report that the audio was checked by measurement, not by ear.

## With a video

Write the script first, speak it, and only then lay out the video: each shot starts at its line's `start` from
`voice.json`, and the video is as long as the voice plus a beat at each end. Mix the voice over music by ducking
the music, not by raising the voice:
```bash
ffmpeg -y -i out/voice.wav -i music.m4a -filter_complex "[1:a]volume=0.25[m];[0:a][m]amix=inputs=2:duration=first:normalize=0,loudnorm=I=-14:TP=-1.2[a]" -map "[a]" -c:a aac -b:a 192k out/mix.m4a
```
