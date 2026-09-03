#!/usr/bin/env bash
# Turn a raw screen recording of an agent session into a README-sized GIF.
#
#   ./scripts/cut-demo.sh recording.mp4 docs/demo.gif
#
# A real session is ~15 minutes, most of it Chrome scrolling. Rather than cutting
# that out — watching it drive a browser IS the demo — the crawl is time-compressed
# and the ends play near real speed.
#
# Four segments, concatenated. The gap between C and D is deliberate: it skips a
# file-open hiccup in this particular recording (the report link 404'd once before
# the browser found the file), landing straight on the rendered report. Retune all
# of the boundaries below for a different recording — where the report lands moves
# with how much work the agent decided to do.
set -euo pipefail

IN="${1:?usage: cut-demo.sh <recording> [out.gif]}"
OUT="${2:-docs/demo.gif}"

# seconds into the source
A_IN=13     ; A_OUT=21     # prompt lands, the skill fires — real speed
B_OUT=762                  # the crawl: Chrome opening, scrolling, minimising
C_IN=762    ; C_OUT=849    # the verdict, the accounts table, "report's written"
D_IN=865    ; D_OUT=880    # the rendered HTML report, scrolling — the deliverable

B_SPEED=64                 # crawl compression
C_SPEED=8                  # answer scroll
D_SPEED=5                  # report scroll — slower, it is the payoff
FPS=10
WIDTH=980

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

echo "cutting…"
ffmpeg -v error -y -i "$IN" -filter_complex "
  [0:v]trim=${A_IN}:${A_OUT},setpts=PTS-STARTPTS[a];
  [0:v]trim=${A_OUT}:${B_OUT},setpts=(PTS-STARTPTS)/${B_SPEED}[b];
  [0:v]trim=${C_IN}:${C_OUT},setpts=(PTS-STARTPTS)/${C_SPEED}[c];
  [0:v]trim=${D_IN}:${D_OUT},setpts=(PTS-STARTPTS)/${D_SPEED}[d];
  [a][b][c][d]concat=n=4:v=1[v];
  [v]fps=${FPS},scale=${WIDTH}:-2:flags=lanczos[out]
" -map "[out]" -an "$TMP/cut.mp4"

# Two-pass palette. A single-pass GIF of a dark terminal bands badly.
echo "building palette…"
ffmpeg -v error -y -i "$TMP/cut.mp4" -vf "palettegen=max_colors=144:stats_mode=diff" "$TMP/pal.png"
echo "encoding gif…"
ffmpeg -v error -y -i "$TMP/cut.mp4" -i "$TMP/pal.png" \
  -lavfi "paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle" "$OUT"

# GitHub renders an inline GIF up to ~10MB. A dark UI over a photographic desktop
# lands just over that, and lossy LZW gets it back under without a visible cost.
if command -v gifsicle >/dev/null; then
  gifsicle -O3 --lossy=90 -o "$TMP/opt.gif" "$OUT" && mv "$TMP/opt.gif" "$OUT"
else
  echo "  note: gifsicle not installed — output may exceed 10MB (brew install gifsicle)" >&2
fi

printf "  %s  %s  %ss\n" "$OUT" \
  "$(du -h "$OUT" | cut -f1)" \
  "$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$OUT" | cut -d. -f1)"
