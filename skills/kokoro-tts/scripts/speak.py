#!/usr/bin/env python3
"""speak.py: text to speech with Kokoro. One line of text is one spoken line; a blank line is a longer pause.

Writes the audio and, beside it, a .json list of {text, start, end} in seconds for timing a video to the voice.
Run with /shared/kokoro/venv/bin/python (see setup.sh).
"""
import argparse
import json
import os
import sys

import numpy as np
import soundfile as sf
from kokoro_onnx import Kokoro

# A voice's first letter names its language.
LANGS = {"a": "en-us", "b": "en-gb", "e": "es", "f": "fr-fr", "h": "hi", "i": "it", "j": "ja", "p": "pt-br", "z": "cmn"}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("file", nargs="?", help="text file, one spoken line per line")
    ap.add_argument("--text", help="speak this instead of a file")
    ap.add_argument("--out", default="voice.wav")
    ap.add_argument("--voice", default="af_heart")
    ap.add_argument("--lang", help="default: the voice's own language")
    ap.add_argument("--speed", type=float, default=1.0)
    ap.add_argument("--gap", type=float, default=0.25, help="seconds of silence between lines")
    ap.add_argument("--pause", type=float, default=0.7, help="seconds of silence for a blank line")
    ap.add_argument("--voices", action="store_true", help="list the voices and stop")
    args = ap.parse_args()

    home = os.environ.get("KOKORO_HOME", "/shared/kokoro")
    model, voices = os.path.join(home, "kokoro-v1.0.onnx"), os.path.join(home, "voices-v1.0.bin")
    if not (os.path.exists(model) and os.path.exists(voices)):
        print(f"Kokoro is not installed in {home}. Run the skill's scripts/setup.sh first.", file=sys.stderr)
        return 1
    kokoro = Kokoro(model, voices)
    known = sorted(kokoro.get_voices())
    if args.voices:
        print("\n".join(known))
        return 0
    if args.voice not in known:
        print(f"No voice named {args.voice}. Voices: {', '.join(known)}", file=sys.stderr)
        return 1
    if args.text is None and not args.file:
        ap.error("give a text file or --text")
    raw = args.text if args.text is not None else open(args.file, encoding="utf-8").read()
    lang = args.lang or LANGS.get(args.voice[0], "en-us")

    rate = 24000
    pieces, cues, at, spoken = [], [], 0.0, False
    for line in raw.splitlines():
        text = line.strip()
        if not text:
            # A blank line before anything is spoken is not a pause.
            if spoken:
                pieces.append(np.zeros(int(max(0.0, args.pause - args.gap) * rate), dtype=np.float32))
                at += max(0.0, args.pause - args.gap)
            continue
        samples, rate = kokoro.create(text, voice=args.voice, speed=args.speed, lang=lang)
        samples = np.asarray(samples, dtype=np.float32)
        length = len(samples) / rate
        cues.append({"text": text, "start": round(at, 3), "end": round(at + length, 3)})
        pieces += [samples, np.zeros(int(args.gap * rate), dtype=np.float32)]
        at += length + args.gap
        spoken = True
    if not cues:
        print("There was no text to speak.", file=sys.stderr)
        return 1
    # The gap after the last line is not part of the piece.
    audio = np.concatenate(pieces[:-1])
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    sf.write(args.out, audio, rate)
    timings = os.path.splitext(args.out)[0] + ".json"
    with open(timings, "w", encoding="utf-8") as handle:
        json.dump(cues, handle, ensure_ascii=False, indent=1)
    print(f"{args.out}  {len(audio) / rate:.2f} s, {len(cues)} lines, voice {args.voice} ({lang})  timings: {timings}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
