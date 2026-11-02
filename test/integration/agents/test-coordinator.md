---
name: test-coordinator
description: Integration fixture for nested pending work
model: anthropic/claude-haiku-4-5
tools: read, bash, write
subagent_agents: test-echo
auto-exit: true
---

Follow the task exactly. Spawn the requested test-echo child, then end your turn with NESTED_WAITING. Do not poll, sleep, or claim completion. When its automatic result arrives, return the requested final token.
