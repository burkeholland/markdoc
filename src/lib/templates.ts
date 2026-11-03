/**
 * Document templates offered by "New document" on the dashboard and by the `template`
 * parameter of POST /api/documents (and the MCP create tool).
 *
 * This module is imported on both the server and the client, so it must stay free of
 * React/DOM imports: `icon` is a lucide icon name that the dashboard maps to a component.
 *
 * `{{date}}` and `{{user}}` in `title`/`content` are replaced at creation with the ISO date
 * (YYYY-MM-DD) and the creator's login.
 */

export type TemplateIcon = "File" | "Users" | "BookOpen" | "DraftingCompass" | "CalendarCheck" | "PenLine" | "Scale" | "ListChecks" | "Sparkles";

export interface Template {
  id: string;
  name: string;
  description: string;
  icon: TemplateIcon;
  /** Document title; may contain placeholders. */
  title: string;
  /** Markdown body; may contain placeholders. */
  content: string;
  /** `false` hides the template from the picker and GET /api/templates; it stays creatable by id. Default true. */
  showInPicker?: boolean;
}

export interface TemplateVars {
  user: string;
  /** ISO date, YYYY-MM-DD. Defaults to today. */
  date?: string;
}

export const BLANK_TEMPLATE_ID = "blank";
/** The first-run tutorial document ("Start with a guided doc" on the empty dashboard). Hidden from the picker. */
export const WELCOME_TEMPLATE_ID = "welcome";

export const TEMPLATES: Template[] = [
  {
    id: BLANK_TEMPLATE_ID,
    name: "Blank",
    description: "An empty page with a title.",
    icon: "File",
    title: "Untitled",
    content: "",
  },
  {
    id: "meeting-notes",
    name: "Meeting notes",
    description: "Agenda, decisions and action items for a meeting.",
    icon: "Users",
    title: "Meeting notes",
    content: `# Meeting notes

**Date:** {{date}}
**Attendees:** @{{user}},
**Notes by:** @{{user}}

## Agenda

1. Review last week's action items
2. Topic one
3. Topic two
4. Open floor

## Discussion

### Topic one

- Key point
- Key point

### Topic two

- Key point

## Decisions

> Write each decision as a single sentence so it can be quoted later.

- Decision one
- Decision two

## Action items

- [ ] Action item — owner, due date
- [ ] Action item — owner, due date
- [ ] Send these notes to everyone who missed the meeting
`,
  },
  {
    id: "project-readme",
    name: "Project README",
    description: "Install, usage and contributing sections with code examples.",
    icon: "BookOpen",
    title: "Project README",
    content: `# Project name

<!-- Badges: build status, version, license -->
![Build](https://img.shields.io/badge/build-passing-brightgreen) ![License](https://img.shields.io/badge/license-MIT-blue)

One paragraph that says what this project does and who it is for.

## Features

- Feature one
- Feature two
- Feature three

## Installation

\`\`\`bash
npm install project-name
\`\`\`

## Usage

\`\`\`js
import { thing } from "project-name";

thing({ option: true });
\`\`\`

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| \`option\` | \`boolean\` | \`false\` | What it controls. |
| \`timeout\` | \`number\` | \`5000\` | Milliseconds before giving up. |

## Contributing

1. Fork the repository and create a branch.
2. Make your change and add tests.
3. Open a pull request.

> Please read the code of conduct before contributing.

## License

MIT © {{user}}
`,
  },
  {
    id: "design-doc",
    name: "Technical design doc",
    description: "Context, goals, proposal, alternatives, risks and open questions.",
    icon: "DraftingCompass",
    title: "Technical design doc",
    content: `# Technical design doc

| | |
| --- | --- |
| **Author** | @{{user}} |
| **Date** | {{date}} |
| **Status** | Draft |
| **Reviewers** | |

## Context

What exists today and why it is not enough. Link to the bug, the metric, or the conversation that started this.

## Goals

- Goal one
- Goal two

## Non-goals

- Something people might expect but this design does not do

## Proposal

Describe the design. Diagrams, data models and API shapes go here.

\`\`\`ts
interface Example {
  id: string;
  createdAt: Date;
}
\`\`\`

## Alternatives considered

### Alternative A

Why it was not chosen.

### Alternative B

Why it was not chosen.

## Risks and mitigations

| Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| Something breaks | Medium | High | Feature flag and staged rollout |

## Open questions

- [ ] Question one
- [ ] Question two
`,
  },
  {
    id: "weekly-status",
    name: "Weekly status",
    description: "Highlights, lowlights, next week and a metrics table.",
    icon: "CalendarCheck",
    title: "Weekly status {{date}}",
    content: `# Weekly status — {{date}}

*Posted by @{{user}}*

## Highlights

- Something that shipped or got unblocked
- Something the team should celebrate

## Lowlights

- Something that slipped, and why
- A risk that needs attention

## Next week

- [ ] Planned item
- [ ] Planned item
- [ ] Planned item

## Metrics

| Metric | Last week | This week | Change |
| --- | ---: | ---: | ---: |
| Active users | 0 | 0 | 0% |
| Open bugs | 0 | 0 | 0 |
| Deploys | 0 | 0 | 0 |

> Asks: anything you need from other teams or leadership.
`,
  },
  {
    id: "blog-post",
    name: "Blog post",
    description: "Front matter, an intro, a few sections and a conclusion.",
    icon: "PenLine",
    title: "Blog post",
    content: `---
title: "Blog post"
date: {{date}}
author: {{user}}
tags: [draft]
---

# Blog post

A short hook that tells the reader why this matters to them.

## The problem

Set the scene in a paragraph or two. Keep it concrete.

## What we tried

- First attempt
- Second attempt

> A pull quote or a surprising detail works well here.

## What worked

Explain the approach and show it:

\`\`\`bash
echo "show, don't tell"
\`\`\`

## Conclusion

Sum up the takeaway in two sentences and say what to do next.
`,
  },
  {
    id: "decision-record",
    name: "Decision record",
    description: "ADR: status, context, decision and consequences.",
    icon: "Scale",
    title: "Decision record",
    content: `# Decision record

| | |
| --- | --- |
| **Status** | Proposed |
| **Date** | {{date}} |
| **Deciders** | @{{user}} |

## Context

What is the issue we are seeing that motivates this decision or change?

## Decision

> We will …

State the decision in full sentences, in the active voice.

## Consequences

### Positive

- Becomes easier

### Negative

- Becomes harder

### Neutral

- Changes without getting better or worse

## Follow-ups

- [ ] Update the affected documentation
- [ ] Tell the people this affects
`,
  },
  {
    id: "checklist",
    name: "Checklist",
    description: "Grouped task lists you can tick off.",
    icon: "ListChecks",
    title: "Checklist",
    content: `# Checklist

*Owner: @{{user}} · Started {{date}}*

## Before

- [ ] Item
- [ ] Item
- [ ] Item

## During

- [ ] Item
- [ ] Item

## After

- [ ] Item
- [ ] Item

> Tip: click a checkbox in the rich view, or type \`[x]\` in the source, to mark an item done.
`,
  },
  {
    id: WELCOME_TEMPLATE_ID,
    name: "Welcome to Markdoc",
    description: "A short guided document: the three things that make Markdoc different, each with something to try.",
    icon: "Sparkles",
    title: "Welcome to Markdoc",
    showInPicker: false,
    content: `# Welcome to Markdoc

This document is the tutorial. Each section ends with something to do. Hi @{{user}} — nothing here is precious.

## 1. Two surfaces, one document

The Markdown source is on the left and the rendered page on the right. Type in either one; the other follows. Headings build the outline in the sidebar.

**Try it:** Type \`/\` here for a block menu.

## 2. Comments that stick to words

Select any text and press **Comment** in the toolbar. The thread follows the words as the document changes, and everyone with access sees it live.

**Try it:** Select this sentence and press Comment.

## 3. Collaborate with an agent

Markdoc is built so people *and* agents can work on the same document. An AI agent such as GitHub Copilot CLI joins with a key you create: it reads, comments and proposes suggestions you accept or reject.

**Try it:** Type \`/agent\` here and follow the three steps to connect your agent.

Once it is connected, select a sentence, press **Comment** and @-mention Copilot in the comment: that is the request, and the answer lands in the thread.

## Your first three tasks

- [ ] Type \`/\` and insert a block from the menu
- [ ] Select a sentence and press Comment
- [ ] Type /agent and connect an AI agent

Delete this doc when you're done — it's just a doc.
`,
  },
];

/** Templates offered by the picker (dashboard dialog, empty state, palette, GET /api/templates). */
export const PICKER_TEMPLATES: Template[] = TEMPLATES.filter((t) => t.showInPicker !== false);

export function getTemplate(id: string): Template | undefined {
  return TEMPLATES.find((t) => t.id === id);
}

export function todayIso(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** Fill `{{date}}` / `{{user}}` in the template and return the title/content to create the document with. */
export function applyTemplate(template: Template, vars: TemplateVars): { title: string; content: string } {
  const date = vars.date ?? todayIso();
  const fill = (s: string) => s.replace(/\{\{\s*date\s*\}\}/g, date).replace(/\{\{\s*user\s*\}\}/g, vars.user);
  return { title: fill(template.title).trim(), content: fill(template.content) };
}
