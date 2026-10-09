---
name: Bug report
about: Report a defect in Multi-MCP
title: '[bug] '
labels: bug
assignees: ''
---

## Summary

A clear, one-sentence description of the bug.

## Environment

- Multi-MCP version: <!-- e.g. 0.2.0, or the commit -->
- Run mode: <!-- deno task dev / serve / stdio / Docker (bundled) / Docker (slim) / compiled binary -->
- Deno version: <!-- output of `deno --version`; N/A for the slim image -->
- OS / architecture: <!-- e.g. Ubuntu 24.04 x86_64, Windows 11, macOS 14 arm64 -->
- Transport: <!-- Streamable HTTP / stdio -->
- MCP client: <!-- e.g. Claude Code, Claude Desktop, custom -->

## `deno task doctor` output

<!-- Paste the output. It shows the parsed configuration (redact nothing sensitive — doctor never prints secrets). -->

```
```

## Steps to reproduce

1.
2.
3.

## Expected behavior

## Actual behavior

<!-- Include the exact error text. Tool failures start with `Error: <code>`; HTTP problems carry an x-request-id. -->

## Logs

<!-- Relevant log lines. Set TTK_LOG_LEVEL=debug and TTK_LOG_FORMAT=pretty for local runs.
     Do NOT paste API keys, OAuth tokens, or TTK_SECRETS values. -->

```
```

## Additional context

<!-- Screenshots of the live view, the tool call arguments, or anything else that helps. -->
