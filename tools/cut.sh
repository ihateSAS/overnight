#!/usr/bin/env bash
# Cut a recorded take for the film: keep the click and the agent starting (first 4.6 s), skip the
# agent's warm-up, then run from just before the pieces fire to the end of the recording.
# usage: tools/cut.sh <label>   -> runs/<label>-cut.mp4
set -euo pipefail
cd "$(dirname "$0")/.."
L="$1"
PLAN=$(node -e "console.log((require('./runs/$L.json').marksMs.plan/1000 - 0.6).toFixed(2))")
ffmpeg -y -loglevel error -i "runs/$L.mp4" -filter_complex \
 "[0:v]trim=0:4.6,setpts=PTS-STARTPTS[a];[0:v]trim=start=$PLAN,setpts=PTS-STARTPTS[b];[a][b]concat=n=2:v=1:a=0,fps=30,format=yuv420p[v]" \
 -map "[v]" -c:v libx264 -crf 18 -preset medium "runs/$L-cut.mp4"
ffprobe -v error -show_entries format=duration -of csv=p=0 "runs/$L-cut.mp4"
