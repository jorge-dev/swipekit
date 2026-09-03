# CLI demo for the README, rendered headlessly by VHS.
#
#   brew install vhs
#   vhs scripts/demo.tape        # writes docs/demo-cli.gif
#
# Three commands, a real decision: is this niche worth it, who is winning it, give
# me the file. Every command reads the local SQLite library and never browses, so it
# renders identically every time and cannot stall on a captcha. It does need a
# library with data in it — run the research once first (see README), or the tables
# come back empty.
#
# `swipekit` must be on PATH (`npm link`), or every line renders "command not found".

Output docs/demo-cli.gif

Set Shell zsh
Set FontSize 19
Set Width 1060
Set Height 470
Set Padding 28
Set Theme "Catppuccin Mocha"
Set TypingSpeed 55ms
Set WindowBar Colorful
Set BorderRadius 10

Hide
Type "clear" Enter
Show
Sleep 400ms

# One number decides a niche: how many SMALL accounts are landing BIG slideshows.
Type "swipekit stats"
Enter
Sleep 4s

# Who is actually winning it — and winning it more than once. A 5k-follower account
# with a 1.4M-view post and repeatable:yes is the whole pitch in one row.
Type "swipekit accounts --repeatable --limit 5"
Enter
Sleep 6s

# The whole argument as one self-contained HTML file, slide thumbnails included.
Type "swipekit report --posts 12"
Enter
Sleep 4s

Sleep 1s
