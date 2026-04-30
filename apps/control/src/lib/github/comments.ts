/**
 * Sticky PR comment helper.
 *
 * On every provision, Raft posts (or updates) a single comment on the PR
 * with the preview URL + a quick bundle summary. The "stickiness" is
 * achieved by an HTML comment marker hidden in the body — we list
 * comments, find the one carrying the marker, and PATCH it; otherwise
 * POST a new one.
 *
 *   GET    /repos/{owner}/{repo}/issues/{pr}/comments
 *   POST   /repos/{owner}/{repo}/issues/{pr}/comments
 *   PATCH  /repos/{owner}/{repo}/issues/comments/{comment_id}
 *
 * Returns the comment id (so the caller can persist it for fast updates).
 */
const GH_API = 'https://api.github.com';

const headers = (token: string): Record<string, string> => ({
  authorization: `Bearer ${token}`,
  accept: 'application/vnd.github+json',
  'user-agent': 'raft-control',
  'x-github-api-version': '2022-11-28',
  'content-type': 'application/json',
});

export interface IssueComment {
  id: number;
  body: string;
  user?: { login?: string };
}

export const listIssueComments = async (
  token: string,
  ownerRepo: string,
  issueNumber: number,
): Promise<IssueComment[]> => {
  const url = `${GH_API}/repos/${ownerRepo}/issues/${issueNumber}/comments?per_page=100`;
  const res = await fetch(url, { headers: headers(token) });
  if (!res.ok) throw new Error(`github list_comments failed: ${res.status} ${await res.text()}`);
  return res.json() as Promise<IssueComment[]>;
};

export const createIssueComment = async (
  token: string,
  ownerRepo: string,
  issueNumber: number,
  body: string,
): Promise<IssueComment> => {
  const url = `${GH_API}/repos/${ownerRepo}/issues/${issueNumber}/comments`;
  const res = await fetch(url, { method: 'POST', headers: headers(token), body: JSON.stringify({ body }) });
  if (!res.ok) throw new Error(`github create_comment failed: ${res.status} ${await res.text()}`);
  return res.json() as Promise<IssueComment>;
};

export const updateIssueComment = async (
  token: string,
  ownerRepo: string,
  commentId: number,
  body: string,
): Promise<IssueComment> => {
  const url = `${GH_API}/repos/${ownerRepo}/issues/comments/${commentId}`;
  const res = await fetch(url, { method: 'PATCH', headers: headers(token), body: JSON.stringify({ body }) });
  if (!res.ok) throw new Error(`github update_comment failed: ${res.status} ${await res.text()}`);
  return res.json() as Promise<IssueComment>;
};

export interface UpsertStickyCommentInput {
  token: string;
  ownerRepo: string;
  issueNumber: number;
  /** Body **without** the marker; we append it. */
  body: string;
  /** Hidden marker (e.g. "raft-preview"). Becomes `<!-- raft:{marker} -->`. */
  marker: string;
  /** Hint from prior persistence: try this id first to avoid the LIST round-trip. */
  knownCommentId?: number | null;
}

export interface UpsertStickyCommentResult {
  commentId: number;
  created: boolean;
  /** The body that was posted (with marker appended). */
  finalBody: string;
}

const wrapWithMarker = (body: string, marker: string): string =>
  `${body}\n\n<!-- raft:${marker} -->`;

const hasMarker = (body: string, marker: string): boolean =>
  body.includes(`<!-- raft:${marker} -->`);

/**
 * Upsert a sticky comment on a PR.
 *
 *   1. If `knownCommentId` is provided, PATCH it directly (cheapest path).
 *      If GitHub returns 404 (operator deleted it), fall through to step 2.
 *   2. LIST comments, find one carrying the marker, PATCH it.
 *   3. Otherwise POST a fresh comment.
 */
export const upsertStickyComment = async (
  input: UpsertStickyCommentInput,
): Promise<UpsertStickyCommentResult> => {
  const finalBody = wrapWithMarker(input.body, input.marker);

  if (input.knownCommentId != null) {
    try {
      const updated = await updateIssueComment(input.token, input.ownerRepo, input.knownCommentId, finalBody);
      return { commentId: updated.id, created: false, finalBody };
    } catch (e) {
      // 404 = comment was deleted by a human; fall through to recreate.
      if (!String(e).includes('404')) throw e;
    }
  }

  const existing = await listIssueComments(input.token, input.ownerRepo, input.issueNumber);
  const sticky = existing.find((c) => hasMarker(c.body, input.marker));
  if (sticky) {
    const updated = await updateIssueComment(input.token, input.ownerRepo, sticky.id, finalBody);
    return { commentId: updated.id, created: false, finalBody };
  }

  const created = await createIssueComment(input.token, input.ownerRepo, input.issueNumber, finalBody);
  return { commentId: created.id, created: true, finalBody };
};
