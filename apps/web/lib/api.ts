import type { IssuePriority, IssueStatus, Role } from '@relay/shared';

const BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * Every call sends the session cookie. The API is on a different port, so
 * without `credentials: 'include'` the browser would omit it and every request
 * would look unauthenticated.
 */
export async function api<T>(
  path: string,
  options: { method?: string; body?: unknown } = {},
): Promise<T> {
  const response = await fetch(`${BASE_URL}${path}`, {
    method: options.method ?? 'GET',
    credentials: 'include',
    headers: options.body ? { 'content-type': 'application/json' } : {},
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  if (response.status === 204) return undefined as T;

  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    throw new ApiError(
      response.status,
      payload?.error ?? 'unknown',
      payload?.message ?? `Request failed with ${response.status}`,
    );
  }

  return payload as T;
}

export type Me = { user: { id: string; email: string; name: string } };

export type WorkspaceSummary = {
  id: string;
  name: string;
  slug: string;
  role: Role;
};

export type ProjectSummary = {
  id: string;
  key: string;
  name: string;
  description: string | null;
  archived: boolean;
  openIssues: number;
};

export type IssueSummary = {
  id: string;
  key: string;
  number: number;
  title: string;
  status: IssueStatus;
  priority: IssuePriority;
  assigneeId: string | null;
  assigneeName: string | null;
};

export type Member = {
  userId: string;
  email: string;
  name: string;
  role: Role;
};
