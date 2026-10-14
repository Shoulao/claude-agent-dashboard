# agent-dashboard

A live dashboard pane for Claude Code. It shows what the session is doing while it runs:

- **Header**: repo, branch and how many files git sees changed, session time
- **Phase**: `scout · plan · edit · test · fix · verify`, inferred from tool calls
- **MAIN · WORKER · ADVISOR**: what each one is doing now, its counters, recent activity and share of tool calls; the model sits in the card title only (the advisor's from `advisorModel` in settings)
- **CONTEXT**: window fill, the auto-compact threshold, compactions
- **FILES**: files edited this session with `+added −removed` lines
- **TESTS**: passed / failed runs, streak, last green, slowest run (only real test runners count, not commands that mention "test")
- **COST**: session total, tokens per model, cache hit rate
- **LIMITS**: plan rate-limit windows and when they reset (subscription plans)
- **TOOLS**: calls over 10 s and MCP tools used
- **Session timeline**: activity lanes for main, worker, advisor and errors
- **tail -f session.log**: the latest events
- **Band above the prompt**: a one-line summary, shown while the pane is closed

Every number comes from real session events: tool calls, subagent spawns, model steps and the advisor server tool. Nothing is simulated.

## Install

```
/plugin install agent-dashboard --marketplace <owner>/<repo>
```

Answer `y` to add the marketplace, then pick the user scope. Open the pane with `/dashboard`.

## Options

| Option | Default | What it does |
| --- | --- | --- |
| `autoOpen` | `true` | Opens the pane when a session starts |
| `band` | `true` | Shows the one-line summary above the prompt |
| `background` | `dark` | `dark` draws a dark retro screen; `theme` keeps the app's pane colour |

Change them from the config menu, or with `claude plugin configure agent-dashboard`.

## Develop

```
claude plugin validate .
claude plugin test .
```

Edit the files, then run `/reload-plugins` in a session.
