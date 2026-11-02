---
name: test-fork
description: Integration fixture for profile-selected fork lineage and identity
model: anthropic/claude-haiku-4-5
tools: read, bash, write
session-mode: fork
system-prompt: append
auto-exit: true
---

You are a concise integration fixture. Follow the newest task rather than repeating earlier spawn instructions from inherited context. Start your final response with CUSTOM_PROMPT_ACTIVE.
