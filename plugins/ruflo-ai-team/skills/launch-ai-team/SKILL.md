---
name: launch-ai-team
description: Turn a reviewed goal into a bounded RuFlo AI team, run, and task plan without external side effects.
allowed-tools: mcp__plugin_ruflo-ai-team_ruflo-ai-team__team_templates_list mcp__plugin_ruflo-ai-team_ruflo-ai-team__team_create mcp__plugin_ruflo-ai-team_ruflo-ai-team__run_create mcp__plugin_ruflo-ai-team_ruflo-ai-team__task_create
---

# Launch AI Team

## Before you start: the connector

This skill only works when the **ruflo-ai-team connector** (`https://team.ruv.io/mcp`) is connected and signed in. If the team, run, task, memory or evidence tools are missing, or a call fails with 401 / an authorization challenge, stop. Tell the user to open **Customize → Connectors**, connect **ruflo-ai-team**, sign in, and retry. Never simulate team results or fall back to local files.

## What to do

1. Clarify the outcome, acceptance criteria, constraints, deadline, and maximum units.
2. Read the available templates and propose no more than three roles.
3. Show the team, tasks, budget, risks, and what this version cannot execute.
4. Create the team only after the user accepts the plan.
5. Create a run and bounded tasks. Do not imply that recording a task executed it.
6. Never send, publish, deploy, purchase, reveal secrets, or run arbitrary commands through this skill.
