import { beforeEach, expect, it, vi } from "vite-plus/test";
const session = vi.hoisted(() => ({ epoch: 0 }));
vi.mock("../src/api", () => ({
  apiGet: vi.fn(),
  eapi: vi.fn(),
  sessionEpoch: () => session.epoch,
}));
vi.mock("../src/auth", () => ({ needAccount: vi.fn(async () => ({ id: "10" })) }));
import { apiGet, eapi } from "../src/api";
import { likeEpisode, show, shows } from "../src/podcasts";
import { mockHost } from "./helpers";
beforeEach(() => {
  vi.resetAllMocks();
  mockHost();
  session.epoch++;
});
it("pages subscriptions and uses episode IDs for likes, audio IDs for streams", async () => {
  vi.mocked(apiGet).mockImplementation(async (path, data) => {
    if (path.includes("subed"))
      return data?.offset === 0
        ? { djRadios: [{ id: 1, name: "First" }], hasMore: true }
        : { djRadios: [{ id: 2, name: "Second" }], hasMore: false };
    if (path.includes("byradio"))
      return { programs: [{ id: 5, name: "Episode", mainSong: { id: 6 } }], more: false };
    return { data: { id: 1, name: "First", dj: { userId: 7, nickname: "Publisher" } } };
  });
  expect((await shows()).map((row) => row.id)).toEqual(["1", "2"]);
  const result = await show({ id: "1" });
  expect(result.episodes[0].id).toBe("program:5:6");
  expect(result.show.publisherPage).toBe("user:7");
  await likeEpisode({ id: result.episodes[0].id, on: true });
  expect(eapi).toHaveBeenCalledWith("/api/resource/like", { threadId: "A_DJ_1_5" });
});
it("fails rather than silently truncating when subscriptions repeat a page forever", async () => {
  vi.mocked(apiGet).mockResolvedValue({ djRadios: [{ id: 1, name: "First" }], hasMore: true });
  await expect(shows()).rejects.toThrow("did not advance");
});

// Per-request session checks alone cannot protect an operation that collects several pages.
it("rejects subscription collection if the account changes between pages", async () => {
  vi.mocked(apiGet)
    .mockImplementationOnce(async () => {
      const page = { djRadios: [{ id: 1, name: "Old account subscription" }], hasMore: true };
      session.epoch++;
      return page;
    })
    .mockResolvedValue({ djRadios: [{ id: 2, name: "New account subscription" }], hasMore: false });
  await expect(shows()).rejects.toMatchObject({ code: "signIn" });
  expect(apiGet).toHaveBeenCalledTimes(1);
});

// A late write must not be exposed as a successful episode toggle for the replacement account.
it("rejects an episode like response from a replaced session", async () => {
  vi.mocked(eapi).mockImplementationOnce(async () => {
    session.epoch++;
    return { code: 200 };
  });
  await expect(likeEpisode({ id: "program:5:6", on: true })).rejects.toMatchObject({
    code: "signIn",
  });
});
