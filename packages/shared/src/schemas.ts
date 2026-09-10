import { z } from 'zod';
import { ISSUE_PRIORITIES, ISSUE_STATUSES } from './domain.ts';
import { ROLES } from './rbac.ts';
import { THEME_IDS } from './themes.ts';

/**
 * Wire contracts shared by the API and the web client. The API validates every
 * request body against these; the web client imports the inferred types so a
 * contract change is a compile error on both sides rather than a runtime 400.
 */

export const uuid = z.uuid();

/**
 * Deliberately permissive on composition and strict on length. Length is the
 * property that actually correlates with resistance to guessing, and character
 * -class rules mostly push users toward predictable substitutions.
 */
export const passwordSchema = z
  .string()
  .min(12, 'Password must be at least 12 characters')
  .max(200, 'Password must be at most 200 characters');

export const registerSchema = z.object({
  email: z.email().max(254).toLowerCase().trim(),
  name: z.string().min(1).max(80).trim(),
  password: passwordSchema,
});
export type RegisterInput = z.infer<typeof registerSchema>;

export const loginSchema = z.object({
  email: z.email().max(254).toLowerCase().trim(),
  password: z.string().min(1).max(200),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const createWorkspaceSchema = z.object({
  name: z.string().min(1).max(80).trim(),
  slug: z
    .string()
    .min(2)
    .max(48)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Slug must be lowercase alphanumeric with single hyphens')
    .optional(),
});
export type CreateWorkspaceInput = z.infer<typeof createWorkspaceSchema>;

export const updateWorkspaceSchema = z
  .object({
    name: z.string().min(1).max(80).trim(),
    theme: z.enum(THEME_IDS),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'No fields to update' });

export const inviteMemberSchema = z.object({
  email: z.email().max(254).toLowerCase().trim(),
  role: z.enum(ROLES),
});
export type InviteMemberInput = z.infer<typeof inviteMemberSchema>;

export const setMemberRoleSchema = z.object({
  role: z.enum(ROLES),
});

export const createProjectSchema = z.object({
  name: z.string().min(1).max(80).trim(),
  key: z
    .string()
    .min(2)
    .max(6)
    .regex(/^[A-Z][A-Z0-9]*$/, 'Key must be uppercase letters and digits, starting with a letter')
    .optional(),
  description: z.string().max(2000).trim().optional(),
});
export type CreateProjectInput = z.infer<typeof createProjectSchema>;

export const updateProjectSchema = z
  .object({
    name: z.string().min(1).max(80).trim(),
    description: z.string().max(2000).trim().nullable(),
    archived: z.boolean(),
  })
  .partial();

export const createIssueSchema = z.object({
  /**
   * Optional client-generated id. An offline client must be able to name an
   * issue the moment it is created -- to render it, reference it, and queue
   * edits against it -- long before the server has seen it. Letting the client
   * choose the uuid also makes create naturally idempotent: a replayed insert
   * collides on the primary key instead of producing a second row.
   */
  id: uuid.optional(),
  title: z.string().min(1).max(200).trim(),
  description: z.string().max(20_000).trim().optional(),
  status: z.enum(ISSUE_STATUSES).default('TODO'),
  priority: z.enum(ISSUE_PRIORITIES).default('NONE'),
  assigneeId: uuid.nullable().optional(),
});
export type CreateIssueInput = z.infer<typeof createIssueSchema>;

/**
 * Every field optional so the board can PATCH a lone `status` on drag-drop.
 * `.refine` rejects `{}`, which would otherwise be an authorized no-op write.
 */
export const updateIssueSchema = z
  .object({
    title: z.string().min(1).max(200).trim(),
    description: z.string().max(20_000).trim().nullable(),
    status: z.enum(ISSUE_STATUSES),
    priority: z.enum(ISSUE_PRIORITIES),
    assigneeId: uuid.nullable(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'No fields to update' });
export type UpdateIssueInput = z.infer<typeof updateIssueSchema>;

export const listIssuesQuerySchema = z.object({
  status: z.enum(ISSUE_STATUSES).optional(),
  assigneeId: uuid.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  /**
   * Opaque keyset cursor, echoed back from a previous page.
   *
   * Not a row offset. `OFFSET n` re-counts from the start on every page, so an
   * insert between requests shifts every later row: the reader silently skips
   * one and sees another twice. A cursor names the last row seen, which is
   * stable regardless of what else is written.
   */
  cursor: z.string().max(200).optional(),
});

export const createCommentSchema = z.object({
  body: z.string().min(1).max(10_000).trim(),
});
export type CreateCommentInput = z.infer<typeof createCommentSchema>;

export const createDocumentSchema = z.object({
  title: z.string().min(1).max(200).trim(),
  /** Optional: a document can hang off the workspace rather than a project. */
  projectId: uuid.nullable().optional(),
});
export type CreateDocumentInput = z.infer<typeof createDocumentSchema>;

export const updateDocumentSchema = z
  .object({ title: z.string().min(1).max(200).trim() })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'No fields to update' });
