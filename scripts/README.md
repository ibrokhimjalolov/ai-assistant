# agent-browser wrapper

`agent-browser` here is a thin wrapper that gives each runtime agent its own
**isolated, persistent** browser profile, so parallel agents never conflict.

- It scopes `AGENT_BROWSER_PROFILE` and `AGENT_BROWSER_SESSION` to the caller's
  working directory (each agent's Agent Home), then execs the real
  `agent-browser` (Vercel Labs).
- Agents call it by absolute path (`/Users/ibrokhim/AIAssistent/bin/agent-browser`)
  because the launchd daemon's PATH is minimal. Usage is taught in each agent's
  Agent Home `CLAUDE.md`.

## Install / update
    npm i -g agent-browser && agent-browser install   # one-time (real binary + Chrome)
    cp scripts/agent-browser /Users/ibrokhim/AIAssistent/bin/agent-browser
    chmod +x /Users/ibrokhim/AIAssistent/bin/agent-browser

The wrapper's `REAL` defaults to `/opt/homebrew/bin/agent-browser`; set
`AGENT_BROWSER_REAL` to override (the test uses this).

## Test
    sh scripts/agent-browser.test.sh
