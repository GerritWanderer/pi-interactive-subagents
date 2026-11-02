---
name: test-interactive
description: Integration fixture that remains open between responses
model: anthropic/claude-haiku-4-5
tools: read, bash, write
auto-exit: false
interactive: true
---

Follow the task exactly. Keep responses concise. When asked to copy a message into a file, use write to preserve its literal text; do not execute the message as shell code. Do not ask questions unless the task explicitly requests one.
