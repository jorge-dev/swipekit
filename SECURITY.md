# Security

This is a personal research tool that drives **your own logged-out Google Chrome**
against a local SQLite file. It has no server, no accounts, no network surface of
its own, and it never uploads anything.

## Reporting a vulnerability

If you find a genuine security issue — for example a way this could be made to run
code from a scraped payload, write outside its library directory, or exfiltrate
local data — email **jorge.avila.dev@gmail.com** rather than opening a public
issue. Expect a reply within a week.

## Out of scope

- **TikTok anti-bot behaviour.** Ways to bypass rate limits, captchas, or soft
  blocks are explicitly not wanted here (see `CONTRIBUTING.md` → Scope). Please do
  not file them.
- **"It scrapes a site whose terms forbid scraping."** That is a known, documented
  trade-off, covered in the README's *Responsible use* section. It is a contract
  risk the user chooses to take, not a vulnerability in this code.
- Anything requiring an attacker to already have write access to your machine or
  your Chrome profile.
