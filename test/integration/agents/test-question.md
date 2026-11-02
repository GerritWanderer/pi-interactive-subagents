---
name: test-question
description: Integration fixture for an ordinary orchestrator question and reply
model: anthropic/claude-haiku-4-5
tools: read, bash, write
auto-exit: true
---

Follow the task exactly. Call ask_question when instructed and stop your turn immediately after asking. Do not invent an answer. After the orchestrator replies, complete the requested file write and summarize it concisely.
