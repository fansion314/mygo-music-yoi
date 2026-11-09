import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mock = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  eapi: vi.fn(),
  details: vi.fn(),
  privileges: vi.fn(),
  epoch: 0,
  signedIn: true,
  listeners: [] as (() => void)[],
  storage: new Map<string, unknown>(),
  needAccount: vi.fn(),
  account: vi.fn(),
}));
vi.mock("../src/api", () => ({
  apiGet: mock.apiGet,
  apiPost: mock.apiPost,
  eapi: mock.eapi,
  hasSession: () => mock.signedIn,
  sessionEpoch: () => mock.epoch,
  onSessionChange: (fn: () => void) => {
    mock.listeners.push(fn);
    return () => undefined;
  },
}));
vi.mock("../src/auth", () => ({ needAccount: mock.needAccount, account: mock.account }));
vi.mock("../src/catalog", () => ({
  songDetails: mock.details,
  tracksWithPrivileges: mock.privileges,
}));

import {
  addToPlaylist,
  createPlaylist,
  deletePlaylist,
  followArtist,
  isLiked,
  like,
  liked,
  likedSongIds,
  played,
  playlist,
  playlists,
  recent,
  removeFromPlaylist,
  renamePlaylist,
  savePlaylist,
  stationNext,
} from "../src/library";
import { toTrack } from "../src/model";

const me = { id: "1", name: "Listener" };
const song = (id: string) => ({ id, name: `Song ${id}`, privilege: { st: 0, pl: 320000 } });
const list = (id = "10", creator = "1", specialType = 0) => ({
  id,
  name: "List",
  creator: { userId: creator, nickname: "Owner" },
  specialType,
});
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

beforeEach(() => {
  vi.resetAllMocks();
  mock.epoch++;
  mock.signedIn = true;
  mock.storage.clear();
  vi.stubGlobal("host", {
    t: (text: string) => text,
    storage: {
      get: (key: string) => mock.storage.get(key),
      set: (key: string, value: unknown) => mock.storage.set(key, value),
      remove: (key: string) => mock.storage.delete(key),
    },
  });
  for (const listener of mock.listeners) listener();
  mock.needAccount.mockResolvedValue(me);
  mock.account.mockResolvedValue(me);
  mock.details.mockImplementation(async (ids: string[]) => ids.map(song));
  mock.privileges.mockImplementation(async (rows: ReturnType<typeof song>[]) => rows.map(toTrack));
  mock.apiGet.mockResolvedValue({ code: 200, playlist: list() });
  mock.apiPost.mockResolvedValue({ code: 200 });
  mock.eapi.mockResolvedValue({ code: 200 });
});

describe("library reading", () => {
  // The host's non-paged playlist API must include lists beyond the first server page.
  it("collects every playlist page and identifies mine, saved and fixed", async () => {
    mock.apiGet
      .mockResolvedValueOnce({
        code: 200,
        playlist: Array.from({ length: 200 }, (_, i) => list(String(i + 1))),
        more: true,
      })
      .mockResolvedValueOnce({
        code: 200,
        playlist: [list("201", "1", 5), { ...list("202", "2"), subscribed: true }],
        more: false,
      });
    const result = await playlists();
    expect(result).toHaveLength(202);
    expect(result[200]).toMatchObject({ id: "201", mine: true, fixed: true });
    expect(result[201]).toMatchObject({ id: "202", mine: false, saved: true });
    expect(mock.apiGet.mock.calls[1][1]).toMatchObject({ uid: "1", offset: 200 });
  });

  // A server repeating its first page must fail rather than hang or claim a complete list.
  it("rejects a playlist paging loop", async () => {
    mock.apiGet.mockResolvedValue({ playlist: [list()], more: true });
    await expect(playlists()).rejects.toThrow("stopped advancing");
    expect(mock.apiGet).toHaveBeenCalledTimes(2);
  });

  // A long list may contain metadata for a prefix, so song details must follow trackIds.
  it("loads all track IDs in server order and leaves missing songs unavailable", async () => {
    mock.apiGet.mockResolvedValue({
      playlist: {
        ...list(),
        trackCount: 3,
        tracks: [song("3")],
        trackIds: [{ id: "3" }, { id: "2" }, { id: "4" }],
      },
    });
    mock.details.mockResolvedValue([song("2"), song("3")]);
    const result = await playlist({ id: "10" });
    expect(mock.details).toHaveBeenCalledWith(["3", "2", "4"]);
    expect(result.tracks?.map((track) => track.id)).toEqual(["song:3", "song:2", "song:4"]);
    expect(result.tracks?.[2].unavailable).toBe(true);
  });

  // A partial server payload must not appear as a successfully loaded full playlist.
  it("rejects a truncated playlist lacking its remaining IDs", async () => {
    mock.apiGet.mockResolvedValue({ playlist: { ...list(), tracks: [song("3")], trackCount: 2 } });
    await expect(playlist({ id: "10" })).rejects.toThrow("complete playlist");
  });

  // Liked songs follow the fixed playlist's ordering and continue beyond one host page.
  it("paginates the liked playlist rather than unordered like-state IDs", async () => {
    const trackIds = Array.from({ length: 101 }, (_, i) => ({ id: String(101 - i) }));
    mock.apiGet.mockImplementation(async (path: string) =>
      path === "/api/user/playlist"
        ? { playlist: [list("10", "1", 5)], more: false }
        : { playlist: { ...list("10", "1", 5), trackCount: 101, trackIds } },
    );
    const first = await liked({ offset: 0 });
    const next = await liked({ offset: 100 });
    expect(first.tracks).toHaveLength(100);
    expect(first.tracks[0].id).toBe("song:101");
    expect(first.more).toBe(true);
    expect(next).toMatchObject({ tracks: [{ id: "song:1" }], more: false });
  });

  // Song likes and episode likes address different resource types even for equal audio IDs.
  it("splits episode like checks from music likes", async () => {
    mock.eapi.mockImplementation(async (path: string) =>
      path === "/api/song/like/get"
        ? { ids: ["7"] }
        : { data: [{ resourceId: "99", liked: true }] },
    );
    expect(await isLiked({ ids: ["song:7", "song:8", "program:99:8"] })).toEqual({
      "song:7": true,
      "song:8": false,
      "program:99:8": true,
    });
    expect(mock.eapi).toHaveBeenCalledWith("/api/resource/commentInfo/list", {
      resourceType: "1",
      resourceIds: "[99]",
    });
  });

  // Signed-out viewing still returns a complete false state without asking for credentials.
  it("answers signed-out like states without network access", async () => {
    mock.signedIn = false;
    expect(await isLiked({ ids: ["song:7", "program:99:8"] })).toEqual({
      "song:7": false,
      "program:99:8": false,
    });
    expect(mock.eapi).not.toHaveBeenCalled();
  });

  // Logging out while a request is pending must prevent its response from entering the cache.
  it("discards late like responses from an old account", async () => {
    const pending = deferred<{ ids: string[] }>();
    mock.eapi.mockReturnValueOnce(pending.promise);
    const old = likedSongIds();
    await vi.waitFor(() => expect(mock.eapi).toHaveBeenCalledTimes(1));
    mock.epoch++;
    for (const listener of mock.listeners) listener();
    pending.resolve({ ids: ["7"] });
    await expect(old).rejects.toMatchObject({ code: "signIn" });
    mock.eapi.mockResolvedValue({ ids: ["8"] });
    expect(await likedSongIds()).toEqual(["8"]);
  });

  // A like write cannot be undone locally by a preceding read completing afterwards.
  it("does not cache a read that predates a successful like mutation", async () => {
    const pending = deferred<{ ids: string[] }>();
    mock.eapi.mockReturnValueOnce(pending.promise).mockResolvedValueOnce({ code: 200 });
    const old = likedSongIds();
    await vi.waitFor(() => expect(mock.eapi).toHaveBeenCalledTimes(1));
    await like({ id: "song:8", on: true });
    pending.resolve({ ids: ["7"] });
    await old;
    mock.eapi.mockResolvedValue({ ids: ["7", "8"] });
    expect(await likedSongIds()).toEqual(["7", "8"]);
    expect(mock.eapi).toHaveBeenCalledTimes(3);
  });

  // Recent is the server history, while played only keeps local context for Heart Mode.
  it("reads server history and keeps played as a local hook", async () => {
    mock.eapi.mockResolvedValue({ data: { list: [{ data: song("9") }] } });
    expect((await recent())[0].id).toBe("song:9");
    mock.eapi.mockClear();
    played({ id: "song:8" });
    played({ id: "program:99:7" });
    expect(mock.storage.get("lastPlayed")).toBe("song:8");
    expect(mock.eapi).not.toHaveBeenCalled();
  });
});

describe("library writes", () => {
  // Fixed liked lists cannot be renamed, deleted or manipulated through normal playlist APIs.
  it("protects fixed playlists and other listeners playlists before writing", async () => {
    mock.apiGet.mockResolvedValue({ playlist: list("10", "1", 5) });
    await expect(renamePlaylist({ id: "10", name: "New" })).rejects.toMatchObject({
      code: "unsupported",
    });
    await expect(deletePlaylist({ id: "10" })).rejects.toMatchObject({ code: "unsupported" });
    await expect(addToPlaylist({ id: "10", trackIds: ["song:7"] })).rejects.toMatchObject({
      code: "unsupported",
    });
    mock.apiGet.mockResolvedValue({ playlist: list("10", "2") });
    await expect(removeFromPlaylist({ id: "10", trackIds: ["song:7"] })).rejects.toMatchObject({
      code: "unsupported",
    });
    expect(mock.eapi).not.toHaveBeenCalled();
  });

  // A known NetEase 512 response is retried once with the same list repeated.
  it("retries code 512 without changing song order or losing ID precision", async () => {
    mock.eapi.mockResolvedValueOnce({ code: 512 }).mockResolvedValueOnce({ code: 200 });
    await addToPlaylist({ id: "10", trackIds: ["song:9223372036854775807", "song:7"] });
    expect(mock.eapi.mock.calls[0][1].trackIds).toBe("[9223372036854775807,7]");
    expect(mock.eapi.mock.calls[1][1].trackIds).toBe(
      "[9223372036854775807,7,9223372036854775807,7]",
    );
  });

  // Duplicate additions are failures, not success-shaped empty responses.
  it("reports duplicate additions and persistent 512 failures", async () => {
    mock.eapi.mockResolvedValue({ code: 502 });
    await expect(addToPlaylist({ id: "10", trackIds: ["song:7"] })).rejects.toThrow(
      "already in the playlist",
    );
    mock.eapi.mockResolvedValue({ code: 512 });
    await expect(addToPlaylist({ id: "10", trackIds: ["song:7"] })).rejects.toThrow(
      "could not be changed",
    );
  });

  // Episode audio IDs cannot be accidentally added as normal music.
  it("rejects episodes before playlist manipulation", async () => {
    await expect(addToPlaylist({ id: "10", trackIds: ["program:99:7"] })).rejects.toMatchObject({
      code: "unsupported",
    });
    expect(mock.eapi).not.toHaveBeenCalled();
  });

  // Create tolerates the API's ID-only form but still presents an editable own playlist.
  it("normalizes ID-only creation and deletes validated own playlists", async () => {
    mock.eapi.mockResolvedValueOnce({ code: 200, id: "20" });
    expect(await createPlaylist({ name: " New " })).toMatchObject({
      id: "20",
      name: "New",
      mine: true,
    });
    await deletePlaylist({ id: "10" });
    expect(mock.eapi).toHaveBeenLastCalledWith("/api/playlist/remove", { ids: "[10]" });
  });

  // Following retains the old client's Web API workaround rather than the rejected EAPI route.
  it("follows artists over Web API and saves other listeners playlists", async () => {
    await followArtist({ id: "7", on: true });
    expect(mock.apiPost).toHaveBeenCalledWith("/api/artist/sub", {
      artistId: "7",
      artistIds: "[7]",
    });
    mock.apiGet.mockResolvedValue({ playlist: list("10", "2") });
    await savePlaylist({ id: "10", on: false });
    expect(mock.eapi).toHaveBeenLastCalledWith("/api/playlist/unsubscribe", { id: "10" });
  });
});

describe("stations", () => {
  // Each public station ID must select the matching NetEase recommendation mode.
  it.each([
    ["default", "DEFAULT"],
    ["familiar", "FAMILIAR"],
    ["explore", "EXPLORE"],
  ])("routes %s FM to its matching mode", async (station, mode) => {
    mock.eapi.mockResolvedValue({ data: [{ id: "7" }] });
    expect((await stationNext({ id: station }))[0].id).toBe("song:7");
    expect(mock.eapi).toHaveBeenCalledWith("/api/v1/radio/get", { mode, limit: 3 });
  });

  // Heart Mode starts from the recently played liked song and retains that start during refill.
  it("keeps the heart seed stable while continuing from the previous batch", async () => {
    played({ id: "song:8" });
    mock.apiGet.mockResolvedValue({ playlist: [list("10", "1", 5)], more: false });
    mock.eapi.mockImplementation(async (path: string) =>
      path === "/api/song/like/get" ? { ids: ["7", "8"] } : { data: [{ songInfo: song("9") }] },
    );
    await stationNext({ id: "heart" });
    await stationNext({ id: "heart" });
    const calls = mock.eapi.mock.calls.filter(
      ([path]) => path === "/api/playmode/intelligence/list",
    );
    expect(calls[0][1]).toMatchObject({ songId: "8", startMusicId: "8", playlistId: "10" });
    expect(calls[1][1]).toMatchObject({ songId: "9", startMusicId: "8", playlistId: "10" });
  });

  // A selected station with no playable tracks must surface an error rather than spin refill.
  it("rejects an empty feed and heart mode with no liked songs", async () => {
    mock.eapi.mockResolvedValue({ data: [] });
    await expect(stationNext({ id: "default" })).rejects.toMatchObject({ code: "unavailable" });
    mock.eapi.mockResolvedValue({ ids: [] });
    await expect(stationNext({ id: "heart" })).rejects.toMatchObject({ code: "unavailable" });
  });
});
