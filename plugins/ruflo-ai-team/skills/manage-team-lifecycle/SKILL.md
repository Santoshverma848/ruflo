---
name: manage-team-lifecycle
description: Pause, resume, or complete a RuFlo AI team while preserving its tenant-local evidence.
allowed-tools: mcp__plugin_ruflo-ai-team_ruflo-ai-team__team_get mcp__plugin_ruflo-ai-team_ruflo-ai-team__team_update mcp__plugin_ruflo-ai-team_ruflo-ai-team__evidence_export
---

# Manage Team Lifecycle

## Before you start: the connector

This skill only works when the **ruflo-ai-team connector** (`https://team.ruv.io/mcp`) is connected and signed in. If the team, run, task, memory or evidence tools are missing, or a call fails with 401 / an authorization challenge, stop. Tell the user to open **Customize → Connectors**, connect **ruflo-ai-team**, sign in, and retry. Never simulate team results or fall back to local files.

## What to do

Read current state before changing it. Explain that pausing or completing a team changes coordination state only. Preserve its evidence bundle and do not describe completion as deletion. This v0.1 skill has no data-deletion, public-sharing, or external-action capability.
