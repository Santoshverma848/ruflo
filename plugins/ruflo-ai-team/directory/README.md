# RuFlo AI Team — Claude Directory Bundle

This review-safe bundle contains only the Claude plugin manifest, MCP endpoint
configuration, skills, agents, commands, and icon. The runtime implementation,
deployment files, tests, dependencies, generated databases, and credentials are
intentionally excluded from the directory upload.

The hosted MCP service is configured at `https://team.ruv.io/mcp` and requires
OAuth for tenant data and team operations.

## After installing: connect the service

The bundle contains no runtime. Open **Customize → Connectors**, connect **ruflo-ai-team** (`https://team.ruv.io/mcp`) and sign in. Without it the skills have no tools and will ask you to connect.
