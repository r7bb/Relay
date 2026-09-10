/**
 * Nudge kinds and the guide each one opens.
 *
 * Copy lives here, beside the kind list, rather than in the worker or the web
 * app. The worker decides *which* nudge to send and the client decides how to
 * render it, but both have to agree on the set -- and a nudge that links to a
 * guide that does not exist is a dead end in someone's inbox. Keeping them in
 * one exhaustive record makes that a type error instead.
 */

export const NUDGE_KINDS = [
  'create_workspace',
  'create_project',
  'create_issue',
  'try_document',
  'invite_teammate',
  'stale_issues',
] as const;

export type NudgeKind = (typeof NUDGE_KINDS)[number];

export type NudgeGuide = {
  /** Heading on the guide page. */
  title: string;
  /** One sentence on why this is worth doing. */
  summary: string;
  steps: string[];
  /** What the button does. `workspace` needs a workspace id in the URL. */
  action:
    | { kind: 'link'; label: string; to: 'workspaces' }
    | { kind: 'workspace'; label: string; path?: string }
    | { kind: 'sample-document'; label: string };
  /** Shown under the steps when there is something non-obvious to know. */
  note?: string;
};

export const NUDGE_GUIDES: Record<NudgeKind, NudgeGuide> = {
  create_workspace: {
    title: 'Create your first workspace',
    summary:
      'A workspace is the container for everything else: projects, issues, documents and the people who can see them.',
    steps: [
      'Open the workspaces page.',
      'Type a name in the box at the top — your team, your company, or just "Personal".',
      'Press Create. You become its owner, which means you can invite others and change its settings.',
    ],
    action: { kind: 'link', label: 'Go to workspaces', to: 'workspaces' },
    note: 'Everything in a workspace is invisible to anyone who is not a member of it.',
  },

  create_project: {
    title: 'Add a project',
    summary:
      'Projects group related issues and give them short readable keys, so you can say "REL-104" instead of pasting a URL.',
    steps: [
      'Open your workspace.',
      'Type a project name in the box under the heading.',
      'Press Create project. The key is derived from the name — "Web App" becomes REL.',
    ],
    action: { kind: 'workspace', label: 'Open your workspace' },
  },

  create_issue: {
    title: 'Track your first issue',
    summary:
      'Issues are the unit of work. The board shows them by status, and you can drag them along as things move.',
    steps: [
      'Open a project to see its board.',
      'Type what needs doing in the box at the top and press Add issue.',
      'Click the card to open it and set a priority or assignee.',
      'Use the status dropdown to move it across the board.',
    ],
    action: { kind: 'workspace', label: 'Open your workspace' },
    note: 'The board keeps working with no connection — try switching your network off and adding one anyway.',
  },

  try_document: {
    title: 'Try a collaborative document',
    summary:
      'Documents merge concurrent edits instead of overwriting them, so two people can type in the same paragraph and both keep their words.',
    steps: [
      'Create a document from your workspace page.',
      'Open the same document in a second window.',
      'Type in both at once, in the same sentence.',
      'Watch both edits survive — nothing is lost and no one has to take turns.',
    ],
    action: { kind: 'sample-document', label: 'Create a sample document' },
    note: 'This is a CRDT. The merge rules live in the data, so the server never has to pick a winner.',
  },

  invite_teammate: {
    title: 'Invite someone',
    summary:
      'Presence, mentions and live editing all need a second person before they show you anything interesting.',
    steps: [
      'Open your workspace and find the Members list.',
      'Invite by email — they need an account already.',
      'Pick a role: admins manage people, members manage work, guests can read and comment.',
      'Open a board in two browsers to see presence and live updates.',
    ],
    action: { kind: 'workspace', label: 'Open your workspace' },
    note: 'Member management is API-only for now: POST to /workspaces/:id/members.',
  },

  stale_issues: {
    title: 'Some issues have gone quiet',
    summary:
      'Work sitting in progress for a week is usually either done, blocked, or not actually started.',
    steps: [
      'Open the board and look at the In Progress column.',
      'Move anything finished to Done.',
      'For anything blocked, leave a comment saying what it is waiting on.',
      'Mention someone with @their-name if you need them to unblock it.',
    ],
    action: { kind: 'workspace', label: 'Open your workspace' },
  },
};

/** Starter content for the sample document, so the page is not empty. */
export const SAMPLE_DOCUMENT_TITLE = 'Getting started';

export const SAMPLE_DOCUMENT_BODY = `Welcome to Relay documents.

This text is a CRDT. Open this page in a second window and type in both at the
same time — in this very paragraph, if you like. Both sets of edits survive.

Try it:
  1. Copy the URL of this page.
  2. Open it in another window, or another browser.
  3. Type in both. Watch the other side update as you go.

Nothing here is locked, and no one has to take turns. The merge rules live in
the data structure, so the server never has to choose whose edit wins.
`;

export function isNudgeKind(value: string): value is NudgeKind {
  return (NUDGE_KINDS as readonly string[]).includes(value);
}
