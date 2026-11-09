import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  eapi: vi.fn(),
  hasSession: vi.fn(),
  parseJSON: vi.fn(),
  account: vi.fn(),
  needAccount: vi.fn(),
}));
vi.mock("../src/api", () => ({ ...mocks }));
vi.mock("../src/auth", () => ({ account: mocks.account, needAccount: mocks.needAccount }));
import {
  album,
  artist,
  browse,
  home,
  search,
  songDetails,
  suggest,
  tracksWithPrivileges,
} from "../src/catalog";

const song = (value: string, extra = {}) => ({
  id: value,
  name: `Song ${value}`,
  ar: [{ id: "5", name: "Artist" }],
  al: { id: "6", name: "Album" },
  dt: 1234,
  ...extra,
});
let storage: Map<string, unknown>;

beforeEach(() => {
  vi.resetAllMocks();
  storage = new Map();
  vi.stubGlobal("host", {
    t: (text: string) => text,
    storage: {
      get: (key: string) => storage.get(key),
      set: (key: string, value: unknown) => storage.set(key, value),
      remove: (key: string) => storage.delete(key),
    },
  });
  mocks.hasSession.mockReturnValue(false);
  mocks.parseJSON.mockImplementation((text: string) => JSON.parse(text));
  mocks.account.mockResolvedValue(null);
  mocks.needAccount.mockResolvedValue({ id: "42", name: "Listener" });
  mocks.eapi.mockImplementation(async (_path: string, data: { c: string }) => {
    const ids = JSON.parse(data.c).map((item: { id: string }) => item.id);
    return {
      code: 200,
      songs: ids.map((value: string) => song(value)),
      privileges: ids.map((value: string) => ({ id: value, st: 0, pl: 320000 })),
    };
  });
});

describe("song details and privileges", () => {
  // The detail API need not preserve order and may omit removed tracks.
  it("batches details, restores order and repeats, and marks missing tracks unavailable", async () => {
    mocks.eapi.mockImplementation(async (_path: string, data: { c: string }) => {
      const ids: string[] = JSON.parse(data.c).map((item: { id: string }) => item.id);
      expect(ids.length).toBeLessThanOrEqual(400);
      return {
        songs: ids
          .filter((value) => value !== "2")
          .reverse()
          .map((value) => song(value)),
        privileges: ids.map((value) => ({ id: value, st: 0, pl: 320000 })),
      };
    });
    const requested = [...Array.from({ length: 401 }, (_, index) => String(index + 1)), "1"];
    const details = await songDetails(requested);
    expect(mocks.eapi).toHaveBeenCalledTimes(2);
    expect(details.map((item) => item.id)).toEqual(requested);
    expect(details[1].privilege).toMatchObject({ st: -1, pl: 0 });
    expect(details[0].privilege.pl).toBe(320000);
  });

  // A malformed response must not become a playlist of fake removed tracks.
  it("rejects malformed detail responses", async () => {
    mocks.eapi.mockResolvedValue({});
    await expect(songDetails(["1"])).rejects.toThrow("invalid song detail");
  });

  // Search incorrectly marks some VIP catalogs as removed; EAPI says otherwise.
  it("refreshes privileges without losing recommendation metadata", async () => {
    const tracks = await tracksWithPrivileges([
      song("1", { name: "Daily title", fee: 1, privilege: { st: -200, pl: 0 } }),
    ]);
    expect(tracks[0]).toMatchObject({
      id: "song:1",
      name: "Daily title",
      duration: 1234,
      unavailable: false,
    });
  });

  it("keeps string IDs exact and refuses rounded numbers", async () => {
    const exact = "9223372036854775807";
    const details = await songDetails([exact]);
    expect(details[0].id).toBe(exact);
    expect(JSON.parse(mocks.eapi.mock.calls[0][1].c)[0].id).toBe(exact);
    await expect(songDetails([Number(exact) as unknown as string])).rejects.toThrow("unsafe");
  });
});

describe("search and native pages", () => {
  it("maps podcast search and its next-page state", async () => {
    mocks.apiGet.mockResolvedValue({
      result: {
        djRadios: [{ id: "8", name: "Show", dj: { userId: "9", nickname: "Host" } }],
        djRadiosCount: 32,
      },
    });
    const result = await search({ query: "radio", kind: "shows", offset: 30 });
    expect(mocks.apiGet).toHaveBeenCalledWith(
      "/api/cloudsearch/pc",
      expect.objectContaining({ type: 1009, offset: 30, limit: 30 }),
    );
    expect(result).toMatchObject({ shows: [{ id: "8", publisherPage: "user:9" }], more: true });
    expect(storage.has("lastSearchQuery")).toBe(false);
  });

  it("remembers submitted searches for the user-search extension and stops at total", async () => {
    mocks.apiGet.mockResolvedValue({ result: { songs: [song("3")], songCount: 1 } });
    const result = await search({ query: "  Singer:Name  ", kind: "tracks" });
    expect(result.more).toBe(false);
    expect(storage.get("lastSearchQuery")).toBe("Singer:Name");
    await expect(search({ query: "x", kind: "tracks", offset: -1 })).rejects.toThrow("offset");
    await expect(search({ query: "x", kind: "users" })).rejects.toMatchObject({
      code: "unsupported",
    });
  });

  it("deduplicates suggestions while respecting service ranking", async () => {
    mocks.apiGet.mockResolvedValue({
      result: {
        order: ["artists", "songs"],
        artists: [{ name: "A" }],
        songs: [{ name: "A" }, { name: "B" }],
      },
    });
    expect(await suggest({ query: "A" })).toEqual(["A", "B"]);
  });

  it("loads albums and remembers artists for their extended pages", async () => {
    mocks.apiGet.mockImplementation(async (path: string) => {
      if (path === "/api/v1/album/6")
        return { album: { id: "6", name: "Album" }, songs: [song("1")] };
      if (path === "/api/v1/artist/5")
        return { artist: { id: "5", name: "Artist" }, hotSongs: [song("1")] };
      if (path === "/api/artist/albums/5")
        return { hotAlbums: [{ id: "6", name: "Album" }], more: true };
      throw new Error(path);
    });
    expect(await album({ id: "6" })).toMatchObject({
      album: { id: "6" },
      tracks: [{ id: "song:1" }],
    });
    expect(await artist({ id: "5" })).toMatchObject({ artist: { id: "5" }, albums: [{ id: "6" }] });
    expect(
      (await browse({ page: "artists" })).sections.some((section) =>
        section.links?.some((link) => link.page === "artist:5"),
      ),
    ).toBe(true);
  });
});

describe("browse navigation", () => {
  it("provides a helpful empty user search and encodes queries in continuation links", async () => {
    const empty = await browse({ page: "users" });
    expect(empty.sections[0].empty).toContain("Search in the app first");
    storage.set("lastSearchQuery", "歌手:名");
    mocks.apiGet.mockResolvedValue({
      result: { userprofiles: [{ userId: "9", nickname: "Name" }], userprofileCount: 2 },
    });
    const first = await browse({ page: "users" });
    expect(first.sections[0].links?.[0].page).toBe("user:9");
    const continuation = first.sections[1].links![0].page;
    expect(continuation).toBe(`users:${encodeURIComponent("歌手:名")}:1`);
    await browse({ page: continuation });
    expect(mocks.apiGet).toHaveBeenLastCalledWith(
      "/api/cloudsearch/pc",
      expect.objectContaining({ s: "歌手:名", offset: 1 }),
    );
  });

  it("keeps public user playlists paginated and separates created and saved lists", async () => {
    mocks.apiGet.mockImplementation(async (path: string) =>
      path.startsWith("/api/v1/user/detail/")
        ? { profile: { nickname: "Owner", signature: "Description" } }
        : {
            playlist: [
              { id: "1", creator: { userId: "9" } },
              { id: "2", creator: { userId: "8" } },
            ],
            more: true,
          },
    );
    const page = await browse({ page: "user:9" });
    expect(page.title).toBe("Owner");
    expect(page.sections[0].playlists?.map((list) => list.id)).toEqual(["1"]);
    expect(page.sections[1].playlists?.map((list) => list.id)).toEqual(["2"]);
    expect(page.sections.at(-1)?.links?.[0].page).toBe("user:9:2");
  });

  it("preserves artist latest-song and album pagination with separate routes", async () => {
    mocks.apiPost.mockResolvedValue({ songs: [{ id: "1" }], total: 2 });
    const latest = await browse({ page: "artist-latest:5:0" });
    expect(latest.sections[0].tracks?.[0].id).toBe("song:1");
    expect(latest.sections[1].links?.[0].page).toBe("artist-latest:5:1");
    mocks.apiGet.mockResolvedValue({ hotAlbums: [{ id: "6", name: "Album" }], more: true });
    const albums = await browse({ page: "artist-albums:5:30" });
    expect(albums.sections[1].links?.[0].page).toBe("artist-albums:5:31");
  });

  it("shows event text and playable shares and advances by timestamp", async () => {
    mocks.apiGet.mockResolvedValue({
      events: [{ eventTime: 1000, json: JSON.stringify({ msg: "New music", song: song("1") }) }],
      more: true,
      lasttime: 1000,
    });
    const page = await browse({ page: "events:9:-1" });
    expect(page.sections[0].title).toContain("New music");
    expect(page.sections[0].tracks?.[0].id).toBe("song:1");
    expect(page.sections[1].links?.[0].page).toBe("events:9:1000");
    await expect(browse({ page: "events:9:1000" })).rejects.toThrow("non-advancing");
  });

  // One event page can share twenty songs; refreshing each separately can
  // exceed the host's thirty-second call deadline on a slow connection.
  it("refreshes all event song privileges in one batch without losing event order", async () => {
    mocks.apiGet.mockResolvedValue({
      events: Array.from({ length: 20 }, (_, index) => ({
        eventTime: 1000 + index,
        json: JSON.stringify({
          song: song(String((index % 2) + 1), { name: `Share ${index}`, fee: 1 }),
        }),
      })),
      more: false,
    });
    mocks.eapi.mockResolvedValue({
      songs: [song("2"), song("1")],
      privileges: [
        { id: "1", st: 0, pl: 320000 },
        { id: "2", st: -200, pl: 0 },
      ],
    });
    const page = await browse({ page: "events:9:-1" });
    expect(mocks.eapi).toHaveBeenCalledTimes(1);
    expect(JSON.parse(mocks.eapi.mock.calls[0][1].c)).toHaveLength(20);
    expect(page.sections.map((section) => section.tracks?.[0].name)).toEqual(
      Array.from({ length: 20 }, (_, index) => `Share ${index}`),
    );
    expect(page.sections.map((section) => section.tracks?.[0].unavailable)).toEqual(
      Array.from({ length: 20 }, (_, index) => index % 2 === 1),
    );
  });

  it("keeps followed artists navigable across pages", async () => {
    mocks.apiGet.mockResolvedValue({ data: [{ id: "5", name: "Artist" }], hasMore: true });
    const page = await browse({ page: "artists-followed:30" });
    expect(mocks.needAccount).toHaveBeenCalled();
    expect(page.sections[0].links?.[0].page).toBe("artist:5");
    expect(page.sections[1].links?.[0].page).toBe("artists-followed:31");
  });

  it("keeps a failed home shelf visible without dropping successful shelves", async () => {
    mocks.hasSession.mockReturnValue(true);
    mocks.apiGet.mockImplementation(async (path: string) => {
      if (path === "/api/v3/discovery/recommend/songs") throw new Error("Sign in first");
      if (path === "/api/v1/discovery/recommend/resource")
        return { recommend: [{ id: "1", name: "Featured" }] };
      if (path === "/api/toplist/detail") return { list: [{ id: "2", name: "Chart" }] };
      if (path === "/api/djradio/recommend/v1") return { djRadios: [{ id: "3", name: "Podcast" }] };
      throw new Error(path);
    });
    const page = await home();
    expect(page.sections[0].empty).toContain("Sign in first");
    expect(page.sections[1].playlists?.[0].id).toBe("1");
    expect(page.sections[2].morePage).toBe("charts");
    expect(page.sections[3].shows?.[0].id).toBe("3");
  });

  // An unnecessary anonymous daily request can invalidate simultaneous shelves
  // when the server answers 301 and the transport resets its session epoch.
  it("does not request account-only recommendations while signed out", async () => {
    mocks.apiGet.mockImplementation(async (path: string) => {
      if (path === "/api/personalized/playlist") return { result: [{ id: "1", name: "Featured" }] };
      if (path === "/api/toplist/detail") return { list: [] };
      if (path === "/api/djradio/recommend/v1") return { djRadios: [] };
      throw new Error(`Unexpected authenticated request ${path}`);
    });
    const page = await home();
    expect(page.sections[0].empty).toBe("Sign in for your daily song picks.");
    expect(page.sections[1].playlists?.[0].id).toBe("1");
    expect(
      mocks.apiGet.mock.calls.some(([path]) => path === "/api/v3/discovery/recommend/songs"),
    ).toBe(false);
  });

  it("rejects unknown pages without performing network writes", async () => {
    await expect(browse({ page: "delete-playlist:9" })).rejects.toMatchObject({
      code: "unsupported",
    });
    expect(mocks.apiPost).not.toHaveBeenCalled();
    expect(mocks.eapi).not.toHaveBeenCalled();
  });
});

describe("catalog response validation", () => {
  // A successful status with a changed payload must not erase a catalog by
  // reporting an empty page and more:false to the host.
  it.each([
    ["search", () => search({ query: "x", kind: "tracks" }), { result: { songCount: 1 } }],
    ["album", () => album({ id: "6" }), { album: { id: "6", name: "Album" } }],
    ["artist", () => artist({ id: "5" }), { artist: { id: "5", name: "Artist" } }],
    ["charts", () => browse({ page: "charts" }), {}],
    ["events", () => browse({ page: "events:9:-1" }), { more: false }],
    ["podcasts", () => browse({ page: "podcasts-hot:0" }), {}],
    ["user playlists", () => browse({ page: "user:9" }), { profile: { nickname: "User" } }],
  ] as [string, () => Promise<unknown>, Record<string, unknown>][])(
    "rejects a malformed %s response",
    async (_name, action, response) => {
      mocks.apiGet.mockResolvedValue(response);
      await expect(action()).rejects.toThrow("invalid catalog response");
    },
  );

  it("accepts an explicit zero-result search without a songs array", async () => {
    mocks.apiGet.mockResolvedValue({ result: { songCount: 0 } });
    expect(await search({ query: "no match", kind: "tracks" })).toEqual({
      tracks: [],
      more: false,
    });
    expect(mocks.eapi).not.toHaveBeenCalled();
  });
});
