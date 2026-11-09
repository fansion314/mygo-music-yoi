import { apiGet, eapi, onSessionChange, sessionEpoch } from "./api";
import { needAccount } from "./auth";
import { id, image, offsetOf, threadOf } from "./model";
import type { Comment, Raw } from "./types";

const pageSize = 30;
interface Snapshot {
  rows: Comment[];
  seen: Set<string>;
  cursor: number;
  more: boolean;
  total: number;
  epoch: number;
  started: boolean;
}
const snapshots = new Map<string, Snapshot>();
// Serialize calls per thread, since the host may retry a page while another
// view is asking for the same comments.
const pending = new Map<string, Promise<unknown>>();
onSessionChange(() => {
  snapshots.clear();
  pending.clear();
});
export function toComment(raw: Raw): Comment {
  let text = String(raw.content || "");
  for (const reply of raw.beReplied || [])
    text += `\n↳ ${reply.user?.nickname || ""}: ${reply.content || ""}`;
  if (raw.ipLocation?.location) text += `\n${raw.ipLocation.location}`;
  return {
    id: id(raw.commentId),
    author: String(raw.user?.nickname || ""),
    avatarUrl: image(raw.user?.avatarUrl),
    text,
    time: Number(raw.time || 0),
    likes: Number(raw.likedCount || 0),
    liked: !!raw.liked,
  };
}
export async function comments({ trackId, offset = 0 }: { trackId: string; offset?: number }) {
  const thread = threadOf(trackId),
    at = offsetOf(offset);
  const invokedEpoch = sessionEpoch();
  const previous = pending.get(thread) || Promise.resolve();
  const job = previous
    .catch(() => {})
    .then(() => {
      if (invokedEpoch !== sessionEpoch())
        throw new Error("The account changed while loading comments");
      return readPage(thread, at);
    });
  pending.set(thread, job);
  try {
    return await job;
  } finally {
    if (pending.get(thread) === job) pending.delete(thread);
  }
}
async function readPage(thread: string, offset: number) {
  const epoch = sessionEpoch();
  let snapshot = snapshots.get(thread);
  if (!snapshot || snapshot.epoch !== epoch || offset === 0) {
    snapshot = {
      rows: [],
      seen: new Set(),
      cursor: 0,
      more: true,
      total: 0,
      epoch,
      started: false,
    };
    snapshots.set(thread, snapshot);
    // Keep memory bounded when browsing a long session.
    if (snapshots.size > 20) snapshots.delete(snapshots.keys().next().value!);
  }
  while (snapshot.rows.length < offset + pageSize && snapshot.more) {
    const res = await apiGet(`/api/v1/resource/comments/${thread}`, {
      limit: pageSize,
      offset: snapshot.cursor,
    });
    if (epoch !== sessionEpoch()) throw new Error("The account changed while loading comments");
    if (!Array.isArray(res.comments)) throw new Error("Invalid comments response");
    const latest: Raw[] = res.comments;
    const rows: Raw[] = snapshot.started ? latest : [...(res.hotComments || []), ...latest];
    const before = snapshot.rows.length;
    for (const raw of rows) {
      const comment = toComment(raw);
      if (!snapshot.seen.has(comment.id)) {
        snapshot.seen.add(comment.id);
        snapshot.rows.push(comment);
      }
    }
    // The server cursor counts its latest list, never the appended hot list.
    snapshot.cursor += latest.length;
    snapshot.started = true;
    if (res.more && latest.length > 0 && snapshot.rows.length === before)
      throw new Error("Comments pagination did not advance");
    snapshot.more = !!res.more && latest.length > 0;
    snapshot.total = Number(res.total || 0);
  }
  return {
    comments: snapshot.rows.slice(offset, offset + pageSize),
    total: Math.max(snapshot.total, snapshot.rows.length),
    more: snapshot.rows.length > offset + pageSize || snapshot.more,
  };
}
export async function likeComment({
  trackId,
  commentId,
  on,
}: {
  trackId: string;
  commentId: string;
  on: boolean;
}): Promise<void> {
  const thread = threadOf(trackId),
    comment = id(commentId);
  await needAccount();
  const epoch = sessionEpoch();
  await eapi(`/api/v1/comment/${on ? "like" : "unlike"}`, { threadId: thread, commentId: comment });
  if (epoch !== sessionEpoch()) throw new Error("The account changed while liking the comment");
  for (const row of snapshots.get(thread)?.rows || []) {
    if (row.id === comment && row.liked !== on) {
      row.likes = Math.max(0, (row.likes || 0) + (on ? 1 : -1));
      row.liked = on;
    }
  }
}
