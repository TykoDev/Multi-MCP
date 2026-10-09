---
name: Feature request
about: Suggest a capability or improvement for Multi-MCP
title: '[feat] '
labels: enhancement
assignees: ''
---

## Problem

What are you trying to do that Multi-MCP does not support today? Describe the use case, not just the solution.

## Proposed solution

What you would like to happen. If it is a new browser tool, sketch its name, inputs, and whether it mutates the page.

## Ground rules

- [ ] It does **not** weaken the security posture (the Chromium sandbox, secrets discipline, scopes, the domain
      allowlist).
- [ ] Model access stays operator-controlled: the client's model via MCP sampling, or a provider configured by an
      administrator (keys sealed in `ttk.db`), never a key in the environment.
- [ ] If it adds a dependency, that is called out and justified (the default is Deno-native and `@std/*`).

## Alternatives considered

## Additional context

<!-- Related issues or prior art. -->
