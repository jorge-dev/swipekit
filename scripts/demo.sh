#!/usr/bin/env bash
# Paced demo of the swipekit CLI, for screen recording.
#
# Read-only by default: it reports on the library you already have and never browses,
# so it's instant, deterministic, and can't hit a captcha mid-take.
#
#   ./scripts/demo.sh              # read-only, ~60s, safe for a first take
#   ./scripts/demo.sh --live       # adds one real TikTok search (opens Chrome, ~90s)
#
# Press ENTER to advance between beats, so you control the pacing while recording.

set -euo pipefail
cd "$(dirname "$0")/.."

LIVE=false
[[ "${1:-}" == "--live" ]] && LIVE=true

bold() { printf "\n\033[1m%s\033[0m\n" "$1"; }
dim()  { printf "\033[2m%s\033[0m\n" "$1"; }
beat() { printf "\n\033[2m  [enter]\033[0m "; read -r; }
run()  { swipekit "$@" 2>/dev/null; }

command -v swipekit >/dev/null || {
  echo "swipekit is not on your PATH. Run 'npm link' in the repo first." >&2
  exit 1
}

clear 2>/dev/null || true
bold "swipekit: what's actually working on TikTok, with the receipts"
dim  "Everything below reads a local SQLite file. No account, no API key, nothing uploaded."
beat

bold "1. What's in the library"
dim  "\$ swipekit stats"
run stats
dim  "go/no-go is the number that decides a niche: small accounts with a big slideshow."
dim  "Under 5 the lane isn't there. Over 20 it's live."
beat

bold "2. The accounts worth copying"
dim  "\$ swipekit accounts --min-views-30d 100000 --limit 6"
run accounts --min-views-30d 100000 --limit 6
dim  "spike = best ÷ median views. A high spike on few posts is one lucky hit."
dim  "A spike near 1 with high posts/wk is a machine. Opposite lessons."
dim  "'reliable: NO' means we hold too few of their posts to trust the cadence. It says so"
dim  "rather than quietly showing you a wrong number."
beat

bold "3. The posts, ranked by intent rather than views"
dim  "\$ swipekit top --sort saves --limit 5 --max-followers 100000"
run top --sort saves --limit 5 --max-followers 100000
dim  "Saves are the win condition. A save means 'reference material, I'll come back to"
dim  "this', which is the intent that becomes an install. Norm is 1-2%. 6-9% is the ceiling."
beat

bold "4. Which formats recur across UNRELATED accounts"
dim  "\$ swipekit formats"
run formats
dim  "One account doing something well is a person. Several unrelated accounts converging"
dim  "on the same hook is a format. That distinction is the whole point."
beat

bold "5. Sounds worth tracking"
dim  "\$ swipekit sounds --limit 5"
run sounds --limit 5
dim  "Slideshow trends are sound-locked. Pulling one sound returns every account running"
dim  "that same skeleton right now. Nobody makes this move by hand because it's tedious."
beat

if $LIVE; then
  bold "6. Live: watch it actually scroll TikTok"
  dim  "\$ swipekit discover \"morning routine\" --target 60"
  dim  "A real Chrome window opens. It scrolls like a person and reads the responses"
  dim  "TikTok's own JavaScript makes. No API, no reverse-engineered signing."
  dim  "(If a captcha appears: solve it in the window, it waits and resumes.)"
  beat
  run discover "morning routine" --target 60
  beat
fi

bold "Where it all lives"
dim  "The library path is the first line of 'swipekit stats'. Inside it:"
dim  "  swipekit.db                every post, account, run and analysis (plain SQLite)"
dim  "  posts/<id>/                   downloaded slides + metadata.json"
dim  "~/.swipekit/chrome-profile   the persistent, logged-out Chrome profile"
echo
dim  "It never logs in. That's deliberate, and it's the line this tool stays on."
echo
bold "The real interface is your agent. Ask it a question in plain English."
dim  "See README.md → Quickstart"
echo
