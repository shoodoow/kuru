---
name: hyperframes
description: Make a finished video (MP4) from HTML with HyperFrames, on your own computer. The general video skill - use it for any video that is not a kinetic-type reel (kinetic-reel) or a painted cartoon (painted-animation) - a product launch or promo built from a website, an explainer on a topic, a narrated or captioned video, captions or designed overlays added to existing footage, a talking-head recut, a beat-synced video for a music track, a video explaining a pull request, social clips, motion graphics, or a slideshow deck. Use when the person asks to make, edit, caption or render a video and no narrower skill fits.
---

# HyperFrames

[HyperFrames](https://github.com/heygen-com/hyperframes) (Apache 2.0) turns HTML, CSS, media and seekable
animation into video: headless Chrome seeks each frame and ffmpeg encodes it. It ships about twenty skills of its
own, one per kind of video. They are not installed on this computer ahead of time, because every installed skill is
listed to every agent on every turn. This skill gets them **into the project folder**, where only this job reads them.

## 1. Set up the project

```bash
node -v                                   # must be 22 or later. If it is older, stop and report it as a blocker.
export HYPERFRAMES_NO_UPDATE_CHECK=1 HYPERFRAMES_SKIP_SKILLS=1
cd ~/work && npx -y hyperframes init <project> --non-interactive && cd <project>
npx hyperframes telemetry disable
npx hyperframes browser ensure            # finds chromium or downloads the Chrome it renders with
npx hyperframes doctor --json             # read "ok" and fix what it names before going on
```
Give `init` what the job starts from: `--video <file>` or `--audio <file>` for existing footage or a track,
`--resolution` for a vertical or square video. `npx hyperframes init --help` lists the rest. The installed version
is the authority for every flag here: when a command refuses one, read its `--help`.

## 2. Get HyperFrames' own skills, inside the project

```bash
npx -y skills add heygen-com/hyperframes --all -y        # no -g: they belong to this project only
find . -name SKILL.md -path '*skills*' | sort
```
Never add `-g`, and never run `npx hyperframes skills` here: both install for every agent on the account.
Open the `hyperframes` router skill among the files just listed with `read` and follow it. It sends you to one
workflow skill; read that one and the domain skills it names, and no others.

| The job | Workflow skill |
|---|---|
| Launch, promo or tour of a product from its website | `product-launch-video` |
| Explainer on a topic, from text alone | `faceless-explainer` |
| Explain a GitHub pull request | `pr-to-video` |
| Captions on existing footage, footage unchanged | `embedded-captions` |
| Designed overlays on a talking-head or interview | `talking-head-recut` |
| Short, design-led, no narration | `motion-graphics` |
| Cut to the beat of a music track | `music-to-video` |
| A deck to click through, not a rendered video | `slideshow` |
| Anything longer or freeform | `general-video` |

If the install fails, work from `npx hyperframes docs` and the project's own `AGENTS.md` / `CLAUDE.md`, and say so
in the report.

## 3. Direction first, then style frames

What separates a professional video from an amateur one is decided before any animation:
1. **Work from the person's words, all of them.** List every requirement in their brief (length, size, scenes, wording,
   style, what to leave out) in `brief-check.md`, and tick each one off before you report.
2. **Read `hyperframes-creative`** (palette, typography, composition, beat planning) and write `design.md`: one typeface
   pair at most, a palette of three to five colours with exact values, the grid and margins, the motion feel (easing,
   speed, how scenes hand over), and the sound plan. A real typeface and sound design matter more than effects.
3. **Gather real assets**: the product's logo, colours and images (`npx hyperframes capture <url>` when there is a
   site), a music bed and sound effects. Never fake a logo or a screenshot.
4. **Style frames**: build the three or four key moments as still frames (`npx hyperframes snapshot`). When the person
   has not yet approved a look for this video, stop here: report the frames' paths and `design.md`, and say the build
   continues once they are approved. A changed look costs minutes now and hours later.

## 4. Build, and look at it

```bash
npx hyperframes lint                       # static check; an error here stops a render
npx hyperframes check --snapshots          # one browser pass: console errors, layout, motion, contrast
npx hyperframes snapshot --at 1,4,8        # PNG frames without a full render
```
Open the snapshots with `read` and judge them the way the person will: text readable and inside the frame, nothing
overlapping, no empty frame at a cut, motion that starts and lands. Fix and look again, for every scene.

Before rendering, hold it to this bar, scene by scene; fix anything that misses and look again:
- **Type**: one typeface pair, sizes from a scale, no text touching an edge, nothing below 32px at 1080p.
- **Layout**: everything on the grid in `design.md`, generous margins, one focal point per frame.
- **Motion**: eased, never linear; elements arrive in an order, not all at once; nothing moves without a reason.
- **Pacing**: each line on screen long enough to read twice; cuts on the beat or on a phrase.
- **Colour**: only the palette; contrast readable on every background.
- **Sound**: music under any voice, sound effects on the big moments, no silence by accident.

Voice: `npx hyperframes tts "<text>" -o voice.wav -v af_heart` speaks with the same local Kokoro model as the
`kokoro-tts` skill. For a whole script with per-line timings, use `kokoro-tts`. `npx hyperframes transcribe <file>`
gives word-level timestamps for captions.

## 5. Render

Rendering is the heavy step, and HyperFrames reads the machine's memory, not your computer's limit, so it will
start more Chromes than you can hold. Ask first and set the worker count yourself:
```bash
# computer_memory: action request, gb = 2 + 0.5 per worker, minutes = your estimate
PRODUCER_LOW_MEMORY_MODE=1 npx hyperframes render --quality draft --workers 1 -o renders/draft.mp4     # a first look, within the everyday limit
npx hyperframes render --quality delivery --workers <n> -o renders/<name>.mp4                          # the real one, after the grant
```
- With an NVIDIA card (`nvidia-smi` prints one) add `--gpu` for hardware encoding.
- `Target closed` or `Runtime.callFunctionOn timed out` means too little memory: fewer workers, or a larger
  `--protocol-timeout`. A long render that died carries on with `--resume`.
- Never pass `--docker`: there is no Docker on your computer.
- `release` the memory when the MP4 exists.

Then review the finished file at least twice: pull a frame every two seconds into a contact sheet
(`ffmpeg -i <mp4> -vf "fps=0.5,scale=480:-1,tile=4x4" sheet.png`), open it with `read`, check it against the bar
above and `brief-check.md`, fix, render again. Report the measured length and resolution, and what the last review
still found.

## Do not

- `publish`, `cloud render` or `lambda`: they upload the project to an outside service. Only when the person asked
  for exactly that.
- Invent facts, figures, logos or quotes for a product video. Use what the source gives; `npx hyperframes capture
  <url>` pulls a site's real text, colours and images into a folder to build from.
