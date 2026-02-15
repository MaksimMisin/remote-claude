The Telegram integration has two compounding problems: **too much noise** (every tool call is a separate message) and **missing useful content** (diffs, plans, reasoning, long responses get lost or truncated). A typical 10-minute Claude session produces 30+ messages in Telegram, yet the user can't see what files actually changed, can't read the full plan Claude proposed, and gets truncated summaries.

## Success Metrics

- Edit diffs visible in Telegram for every file change
- Full responses delivered
- Plans visible in both approval prompt AND after approval was given/rejected
- Minimize topic change noise
- Phone buzzes only for finished + questions, not activity digests

# !!! MOST IMPORTANT FUCKING CRITERIA !!!

YOU VERIFIED IT WORKS IN CHROME!