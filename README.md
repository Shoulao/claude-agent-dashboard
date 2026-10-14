# agent-dashboard

A live dashboard pane for Claude Code. It shows what the session is doing while it runs:

- **Header**: session time, session cost (same total as `/cost`), the active agent and tool
- **Phase**: `scout · plan · edit · test · fix · verify`, inferred from tool calls
- **Cards**: main session (model, turns, tools, reads, edits, tests, errors), subagents (running/finished, type, model, tool count), advisor (calls, when, in which phase, plus a "same error came back" warning)
- **Session timeline**: activity lanes for main, scouts (Explore), other agents, advisor and errors
- **Cost & tokens**: input / output / cache tokens per model
- **tail -f session.log**: the latest events
- **Band above the prompt**: a one-line summary

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

Change them from the config menu, or with `claude plugin configure agent-dashboard`.

## Develop

```
claude plugin validate .
claude plugin test .
```

Edit the files, then run `/reload-plugins` in a session.
