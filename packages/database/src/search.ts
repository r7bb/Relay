import { sql } from 'drizzle-orm';
import type { Executor } from './index.ts';

/**
 * Full-text search across a workspace.
 *
 * Postgres rather than a dedicated engine. What that buys: results are read
 * from the same transaction that wrote them, so a freshly created issue is
 * findable immediately and there is no indexing pipeline to fall behind, fail
 * silently, or reconcile after a restore. The index is a stored generated
 * column, so it cannot drift from the row.
 *
 * What it costs: no fuzzy matching or typo tolerance, English-only stemming as
 * configured, and ranking that is far less tunable than a purpose-built
 * engine. Those are the reasons to reach for one -- not the word "search".
 */

export type SearchHit = {
  kind: 'issue' | 'document' | 'comment';
  id: string;
  title: string;
  /**
   * Matching text with the query terms wrapped in `<mark>`.
   *
   * Only ever contains the tags Postgres inserted -- the surrounding text is
   * escaped by the client, never rendered as HTML.
   */
  snippet: string;
  rank: number;
  /** Where to navigate. Comments point at the issue that holds them. */
  issueId: string | null;
  projectId: string | null;
};

/**
 * Turn user input into a tsquery.
 *
 * `websearch_to_tsquery` is the right parser for a search box: it accepts
 * quoted phrases, `or`, and leading `-` for exclusion, and -- unlike
 * `to_tsquery` -- it never throws on punctuation a user happens to type.
 */
export async function searchWorkspace(
  db: Executor,
  workspaceId: string,
  query: string,
  limit = 20,
): Promise<SearchHit[]> {
  const trimmed = query.trim();
  if (trimmed.length === 0) return [];

  /*
   * One UNION rather than three round trips, so ranking is comparable across
   * kinds and the limit applies to the merged set. `ts_headline` generates the
   * snippet from the same query, which is why the text is passed alongside the
   * vector.
   */
  const rows = await db.execute<{
    kind: SearchHit['kind'];
    id: string;
    title: string;
    snippet: string;
    rank: number;
    issue_id: string | null;
    project_id: string | null;
  }>(sql`
    with q as (select websearch_to_tsquery('english', ${trimmed}) as query)

    select 'issue' as kind,
           i.id::text as id,
           i.title as title,
           ts_headline('english', coalesce(i.description, i.title), q.query,
                       'StartSel=<mark>, StopSel=</mark>, MaxFragments=1, MaxWords=24, MinWords=8') as snippet,
           ts_rank(i.search_vector, q.query) as rank,
           i.id::text as issue_id,
           i.project_id::text as project_id
      from issues i, q
     where i.workspace_id = ${workspaceId} and i.search_vector @@ q.query

    union all

    select 'document', d.id::text, d.title,
           ts_headline('english', coalesce(d.search_text, d.title), q.query,
                       'StartSel=<mark>, StopSel=</mark>, MaxFragments=1, MaxWords=24, MinWords=8'),
           ts_rank(d.search_vector, q.query),
           null, d.project_id::text
      from documents d, q
     where d.workspace_id = ${workspaceId} and d.search_vector @@ q.query

    union all

    select 'comment', c.id::text, i2.title,
           ts_headline('english', c.body, q.query,
                       'StartSel=<mark>, StopSel=</mark>, MaxFragments=1, MaxWords=24, MinWords=8'),
           -- Comments rank below the things they are attached to: a match in
           -- a thread is usually a weaker answer than a match in the issue.
           ts_rank(c.search_vector, q.query) * 0.6,
           c.issue_id::text, i2.project_id::text
      from comments c
      join issues i2 on i2.id = c.issue_id, q
     where c.workspace_id = ${workspaceId} and c.search_vector @@ q.query

     order by rank desc
     limit ${limit}
  `);

  return [...rows].map((row) => ({
    kind: row.kind,
    id: row.id,
    title: row.title,
    snippet: row.snippet,
    rank: Number(row.rank),
    issueId: row.issue_id,
    projectId: row.project_id,
  }));
}
