import { beforeEach, expect, it, vi } from "vite-plus/test";
const session = vi.hoisted(() => ({ epoch: 0, listeners: [] as (() => void)[] }));
vi.mock("../src/api", () => ({
  apiGet: vi.fn(),
  eapi: vi.fn(),
  sessionEpoch: () => session.epoch,
  onSessionChange: (callback: () => void) => {
    session.listeners.push(callback);
    return () => undefined;
  },
}));
vi.mock("../src/auth", () => ({ needAccount: vi.fn(async () => ({ id: "1" })) }));
import { apiGet, eapi } from "../src/api";
import { comments, likeComment } from "../src/comments";
import { mockHost } from "./helpers";
const comment = (value: number) => ({
  commentId: value,
  content: `Comment ${value}`,
  user: { nickname: "User" },
  likedCount: 1,
});
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
beforeEach(() => {
  vi.resetAllMocks();
  mockHost();
  session.epoch++;
  for (const listener of session.listeners) listener();
});
it("pages latest comments independently of hot comments and deduplicates overlaps", async () => {
  vi.mocked(apiGet).mockImplementation(async (_, params) => {
    const offset = Number(params?.offset || 0);
    return {
      hotComments: offset === 0 ? [comment(100), comment(1)] : [],
      comments: Array.from({ length: 30 }, (_, index) => comment(offset + index + 1)),
      total: 61,
      more: offset < 60,
    };
  });
  const first = await comments({ trackId: "song:1" });
  const second = await comments({ trackId: "song:1", offset: 30 });
  expect(first.comments[0].id).toBe("100");
  expect(second.comments[0].id).toBe("30");
  expect(new Set([...first.comments, ...second.comments].map((row) => row.id)).size).toBe(60);
  expect(apiGet).toHaveBeenNthCalledWith(2, "/api/v1/resource/comments/R_SO_4_1", {
    limit: 30,
    offset: 30,
  });
});
it("uses the episode thread for comment writes and preserves reply text", async () => {
  vi.mocked(apiGet).mockResolvedValue({
    comments: [
      {
        ...comment(1),
        beReplied: [{ user: { nickname: "A" }, content: "Reply" }],
        ipLocation: { location: "Shanghai" },
      },
    ],
    more: false,
  });
  const page = await comments({ trackId: "program:2:3" });
  expect(page.comments[0].text).toContain("Reply");
  await likeComment({ trackId: "program:2:3", commentId: "1", on: true });
  expect(eapi).toHaveBeenCalledWith("/api/v1/comment/like", {
    threadId: "A_DJ_1_2",
    commentId: "1",
  });
});

// Repeated latest pages previously kept the runtime fetching forever after host timeout.
it("rejects repeated comment pages that claim more without adding any rows", async () => {
  let calls = 0;
  vi.mocked(apiGet).mockImplementation(async () => {
    // Keep a regressed implementation finite so its failure is reported rather than hanging.
    if (++calls > 2) throw new Error("Test stopped repeated requests");
    return {
      comments: Array.from({ length: 30 }, (_, index) => comment(index + 1)),
      total: 100,
      more: true,
    };
  });
  await comments({ trackId: "song:4" });
  await expect(comments({ trackId: "song:4", offset: 30 })).rejects.toThrow("did not advance");
  expect(apiGet).toHaveBeenCalledTimes(2);
});

// Clearing a pending map did not cancel jobs already chained to an older account's request.
it("rejects queued comment requests from the epoch in which they were invoked", async () => {
  const response = deferred<{ comments: ReturnType<typeof comment>[]; more: boolean }>();
  const started = deferred<void>();
  vi.mocked(apiGet).mockImplementationOnce(() => {
    started.resolve();
    return response.promise;
  });
  const first = comments({ trackId: "song:5" });
  await started.promise;
  const queued = comments({ trackId: "song:5", offset: 30 });
  const settled = Promise.allSettled([first, queued]);
  session.epoch++;
  for (const listener of session.listeners) listener();
  response.resolve({ comments: [comment(1)], more: false });
  const results = await settled;
  expect(results.map((result) => result.status)).toEqual(["rejected", "rejected"]);
  for (const result of results)
    if (result.status === "rejected") expect(result.reason.message).toContain("account changed");
  expect(apiGet).toHaveBeenCalledTimes(1);
});

// A write finishing after account change must not report success for an old optimistic toggle.
it("rejects a late like response without changing a previously returned comment", async () => {
  vi.mocked(apiGet).mockResolvedValue({ comments: [comment(1)], more: false });
  const page = await comments({ trackId: "song:6" });
  const response = deferred<{ code: number }>();
  const started = deferred<void>();
  vi.mocked(eapi).mockImplementationOnce(() => {
    started.resolve();
    return response.promise;
  });
  const mutation = likeComment({ trackId: "song:6", commentId: "1", on: true });
  const rejected = expect(mutation).rejects.toThrow("account changed");
  await started.promise;
  session.epoch++;
  for (const listener of session.listeners) listener();
  response.resolve({ code: 200 });
  await rejected;
  expect(page.comments[0]).toMatchObject({ liked: false, likes: 1 });
});
