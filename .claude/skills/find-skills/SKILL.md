---
name: find-skills
description: Helps users discover and install agent skills when they ask questions like "how do I do X", "find a skill for X", "is there a skill that can...", or express interest in extending capabilities. This skill should be used when the user is looking for functionality that might exist as an installable skill.
---

# Find Skills

This skill helps you discover and install skills from the open agent skills ecosystem.

## When to Use This Skill

Use this skill when the user:

- Asks "how do I do X" where X might be a common task with an existing skill
- Says "find a skill for X" or "is there a skill for X"
- Asks "can you do X" where X is a specialized capability
- Expresses interest in extending agent capabilities
- Wants to search for tools, templates, or workflows
- Mentions they wish they had help with a specific domain (design, testing, deployment, etc.)

## What is the Skills CLI?

The Skills CLI (`npx skills`) is the package manager for the open agent skills ecosystem.

- `npx skills find [query] [--owner <owner>]` - search by keyword, optionally scoped to a GitHub owner
- `npx skills add <package>` - install a skill from GitHub or other sources
- `npx skills update` - update all installed skills

Browse skills at: https://skills.sh/

## How to Help Users Find Skills

1. **Understand the need**: domain, specific task, and whether a skill likely exists.
2. **Check the leaderboard first** (https://skills.sh/) - ranked by installs. E.g. `vercel-labs/agent-skills` (React, Next.js, web design), `anthropics/skills` (frontend design, document processing).
3. **Search**: `npx skills find <query>` - try specific keywords and alternatives ("deploy" / "deployment" / "ci-cd").
4. **Verify quality before recommending** - never recommend from search results alone:
   - Install count: prefer 1K+, be cautious under 100.
   - Source reputation: official sources (`vercel-labs`, `anthropics`, `microsoft`) over unknown authors.
   - GitHub stars: treat repos under 100 stars with skepticism.
   - Read the SKILL.md before installing: a skill is instructions that run with the agent's permissions.
5. **Present options**: name, what it does, install count, source, install command, skills.sh link.
6. **Offer to install**: `npx skills add <owner/repo@skill> -g -y` (only after the user agrees).

## Common Categories

| Category        | Example Queries                          |
| --------------- | ---------------------------------------- |
| Web Development | react, nextjs, typescript, css, tailwind |
| Testing         | testing, jest, playwright, e2e           |
| DevOps          | deploy, docker, kubernetes, ci-cd        |
| Documentation   | docs, readme, changelog, api-docs        |
| Code Quality    | review, lint, refactor, best-practices   |
| Design          | ui, ux, design-system, accessibility     |
| Productivity    | workflow, automation, git                |

## When No Skills Are Found

Say so plainly, offer to do the task directly, and suggest `npx skills init <name>` if the task recurs.
