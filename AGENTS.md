# Agent Development Guide

A file for guiding coding agents.

## Commands

- Never use git commands except for readonly ones like `git status` and `git diff`.
- `npm run format` for formatting
- `npm run test` for testing

## Code Comments

- All code comments should be concise, plain-english written for a general audience of software
  engineers.
- Every public function, class, module, etc should have a concise, plain-english block comment
  describing what it does.
- Do not hard-code numeric values that are subject to change in comments.

## Issues and PR Guidelines

- Never create PRs or issues unless specifically asked by the user.

# Commit Message Guidelines

- Subject: `<scope>: <description>` (scope = subsystem/package/area; imperative; no `feat`/`fix`
  types).
- Body: blank line, then one concise bullet per key change if not already captured in the subject.
- Do not add AI attribution to commits or PRs (no Co-Authored-By, Generated-with, tool names, or
  session links).
