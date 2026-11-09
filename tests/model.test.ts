import { beforeEach, describe, expect, it } from "vite-plus/test";
import { decodeTrack, id, image, threadOf, toProgram, toTrack } from "../src/model";
import { mockHost, song } from "./helpers";

beforeEach(() => mockHost());
describe("service identity and privileges", () => {
  // Missing service artist IDs are plain-text credits, not a reason to reject the track.
  it.each([0, "0", undefined])("keeps artists without a linkable ID (%s)", (artistId) => {
    const credit =
      artistId === undefined
        ? { name: "Unlinked artist" }
        : { id: artistId, name: "Unlinked artist" };
    const track = toTrack({
      ...song(),
      ar: [credit],
      al: { id: 20, name: "Album", artists: [credit] },
    });
    expect(track.artists).toMatchObject([{ id: "", name: "Unlinked artist" }]);
    expect(track.album.artists).toMatchObject([{ id: "", name: "Unlinked artist" }]);
    expect(track.unavailable).toBe(false);
  });
  it("keeps long IDs exact and rejects already rounded numeric IDs", () => {
    expect(id("9007199254740999")).toBe("9007199254740999");
    expect(() => id(Number("9007199254740999"))).toThrow();
    expect(() => decodeTrack("program:1:2:3")).toThrow();
  });
  it("allows subscribed VIP tracks with positive privileges and rejects previews without permission", () => {
    expect(toTrack({ ...song(), fee: 1 }).unavailable).toBe(false);
    expect(toTrack({ ...song(), fee: 1, privilege: undefined }).unavailable).toBe(true);
    expect(toTrack({ ...song(), privilege: { st: -1, pl: 320000 } }).unavailable).toBe(true);
  });
  it("distinguishes episode, audio and show IDs without relying on in-memory metadata", () => {
    const episode = toProgram(
      { id: "9007199254740999", name: "Episode", mainSong: { id: 2 }, duration: 123 },
      { id: 3, name: "Show", dj: { userId: 4, nickname: "DJ" } },
    );
    expect(decodeTrack(episode.id)).toEqual({ programId: "9007199254740999", songId: "2" });
    expect(threadOf(episode.id)).toBe("A_DJ_1_9007199254740999");
    expect(threadOf("song:2")).toBe("R_SO_4_2");
    expect(episode.showId).toBe("3");
  });
  it("sizes known CDN images while preserving existing queries", () => {
    const address = image("http://p1.music.126.net/cover.jpg?x=1")!;
    expect(new URL(address).searchParams.get("param")).toBe("{size}y{size}");
    expect(new URL(address).searchParams.get("x")).toBe("1");
    expect(image("file:///private/image")).toBeUndefined();
  });
});
