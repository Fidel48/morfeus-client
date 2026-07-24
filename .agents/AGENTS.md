# Morfeus Client — Permanent Workspace Rules

## Web Search & Real-Time Query Directives (PERMANENT RULE)
1. **Single Web Search Badge**: Always render ONLY ONE single `web_search` badge per user turn in the chat UI. Duplicate intermediate `web_search` badges in the same turn must be suppressed from the chat timeline.
2. **Mandatory Date & Time**: Every response that utilizes `web_search` MUST state the exact Current Date and Time (e.g. "As of Friday, July 24, 2026 at 7:46:35 PM...").
3. **Mandatory Clickable Source Links**: Every response that utilizes `web_search` MUST include direct clickable Markdown source links (e.g. `[CoinMarketCap](url)`) pointing to the exact webpage URLs returned by the search tool.
4. **No Code Reversions**: DO NOT remove, overwrite, or simplify the multi-stage DuckDuckGo search engine (`html.duckduckgo.com` -> `lite.duckduckgo.com` -> `api.duckduckgo.com`) or the tool depth limit (max 5 turns) unless explicitly instructed by the user.
5. **Windows 11 Push-to-Talk Preservation**: DO NOT break or alter Push-to-Talk functionality on Windows 11. Maintain `latestText` preservation across interim and final speech events, and construct `latestText` directly from `event.results[0..N]` to prevent duplicate speech output (e.g. "hi. hi").
6. **Git Push Rule**: NEVER execute `git push` or push tags to GitHub without explicit, separate user authorization for that specific push.
