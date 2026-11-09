import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
const session = vi.hoisted(() => ({ epoch: 1, listeners: [] as (() => void)[] }));
vi.mock("../src/api", () => ({
  apiGet: vi.fn(),
  eapi: vi.fn(),
  sessionEpoch: () => session.epoch,
  onSessionChange: (callback: () => void) => {
    session.listeners.push(callback);
    return () => {};
  },
}));
import { apiGet, eapi } from "../src/api";
import { lyrics, parseLRC, parseYRC, requestedLevel, stream } from "../src/playback";
import { mockHost } from "./helpers";

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
};
beforeEach(() => {
  vi.resetAllMocks();
  mockHost();
  session.epoch++;
  for (const callback of session.listeners) callback();
});
afterEach(() => vi.useRealTimers());
const audio = (extras = {}) => ({
  data: [
    {
      url: "https://m7.music.126.net/audio",
      type: "mp3",
      level: "exhigh",
      br: 320000,
      size: 123,
      gain: -3,
      peak: 0.7,
      ...extras,
    },
  ],
});
const changeAccount = () => {
  session.epoch++;
  for (const callback of session.listeners) callback();
};

describe("stream request control", () => {
  it("coalesces prefetch and playback for the same audio ID and effective quality", async () => {
    const request = deferred<ReturnType<typeof audio>>();
    vi.mocked(eapi).mockReturnValue(request.promise);
    const first = stream({ id: "song:2", quality: "high" });
    const second = stream({ id: "program:1:2", quality: "high" });
    expect(eapi).toHaveBeenCalledTimes(1);
    request.resolve(audio());
    const [one, two] = await Promise.all([first, second]);
    expect(one).toEqual(two);
    one.gain = 99;
    expect(two.gain).toBe(-3);
  });

  it("does not merge different requested qualities and does not cache unknown expiries", async () => {
    vi.mocked(eapi).mockResolvedValue(audio());
    await Promise.all([
      stream({ id: "song:1", quality: "high" }),
      stream({ id: "song:1", quality: "lossless" }),
    ]);
    await stream({ id: "song:1", quality: "high" });
    expect(eapi).toHaveBeenCalledTimes(3);
  });

  it("caches successful URLs for at most ten seconds and honors a shorter service expiry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    vi.mocked(eapi).mockResolvedValue(audio({ exp: 1200 }));
    await stream({ id: "song:1" });
    await vi.advanceTimersByTimeAsync(9_999);
    await stream({ id: "song:1" });
    expect(eapi).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await stream({ id: "song:1" });
    expect(eapi).toHaveBeenCalledTimes(2);
    vi.mocked(eapi).mockResolvedValue(audio({ exp: 1 }));
    await stream({ id: "song:2" });
    await vi.advanceTimersByTimeAsync(1_000);
    await stream({ id: "song:2" });
    expect(eapi).toHaveBeenCalledTimes(4);
  });

  it("does not cache a URL whose expiry elapsed while the request was pending", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const request = deferred<ReturnType<typeof audio>>();
    vi.mocked(eapi)
      .mockReturnValueOnce(request.promise)
      .mockResolvedValue(audio({ exp: 1 }));
    const first = stream({ id: "song:1" });
    await vi.advanceTimersByTimeAsync(1_001);
    request.resolve(audio({ exp: 1 }));
    await first;
    await stream({ id: "song:1" });
    expect(eapi).toHaveBeenCalledTimes(2);
  });

  it("bounds the short URL cache to 32 entries", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    vi.mocked(eapi).mockResolvedValue(audio({ exp: 1200 }));
    for (let id = 1; id <= 33; id++) await stream({ id: `song:${id}` });
    await stream({ id: "song:2" });
    expect(eapi).toHaveBeenCalledTimes(33);
    await stream({ id: "song:1" });
    expect(eapi).toHaveBeenCalledTimes(34);
  });

  it("coalesces failures without retrying or retaining a failed result", async () => {
    const request = deferred<ReturnType<typeof audio>>(),
      failure = new Error("Network failed");
    vi.mocked(eapi).mockReturnValueOnce(request.promise).mockResolvedValue(audio());
    const first = stream({ id: "song:1" }),
      second = stream({ id: "song:1" });
    const results = Promise.allSettled([first, second]);
    request.reject(failure);
    expect((await results).map((result) => result.status)).toEqual(["rejected", "rejected"]);
    expect(eapi).toHaveBeenCalledTimes(1);
    await stream({ id: "song:1" });
    expect(eapi).toHaveBeenCalledTimes(2);
  });

  it.each([{ apiCode: -460 }, { apiCode: 460 }, { apiCode: 429 }, { status: 429 }])(
    "cools down all stream IDs for 60 seconds after %j without retrying",
    async (details) => {
      vi.useFakeTimers();
      vi.setSystemTime(1_000_000);
      vi.mocked(eapi)
        .mockRejectedValueOnce(Object.assign(new Error("Risk"), details))
        .mockResolvedValue(audio());
      const first = await stream({ id: "song:1" }).catch((error) => error);
      expect(first.message).toContain("60 seconds");
      expect(first.code).toBeUndefined();
      expect(host.storage.get("streamCooldownUntil")).toBe(1_060_000);
      await vi.advanceTimersByTimeAsync(1_001);
      await expect(stream({ id: "program:2:3" })).rejects.toThrow("59 seconds");
      expect(eapi).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(58_999);
      await stream({ id: "song:1" });
      expect(eapi).toHaveBeenCalledTimes(2);
      expect(host.storage.get("streamCooldownUntil")).toBeUndefined();
    },
  );

  it("preserves cooldown through a module reload and account switch", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    host.storage.set("streamCooldownUntil", 1_060_000);
    changeAccount();
    vi.resetModules();
    const restored = await import("../src/playback");
    await expect(restored.stream({ id: "song:8" })).rejects.toThrow("60 seconds");
    expect(eapi).not.toHaveBeenCalled();
  });

  it.each([-460, 460, 429])(
    "cools down when an otherwise successful response carries per-track risk code %s",
    async (code) => {
      vi.useFakeTimers();
      vi.setSystemTime(1_000_000);
      vi.mocked(eapi).mockResolvedValue({ code: 200, data: [{ code, url: null }] });
      await expect(stream({ id: "song:1" })).rejects.toThrow("60 seconds");
      await expect(stream({ id: "song:2" })).rejects.toThrow("60 seconds");
      expect(eapi).toHaveBeenCalledTimes(1);
    },
  );

  it.each([Infinity, NaN, "1060000", 1_100_000, 900_000])(
    "discards a malformed or expired persisted deadline %j",
    async (until) => {
      vi.useFakeTimers();
      vi.setSystemTime(1_000_000);
      host.storage.set("streamCooldownUntil", until);
      vi.mocked(eapi).mockResolvedValue(audio());
      await stream({ id: "song:1" });
      expect(eapi).toHaveBeenCalledTimes(1);
      expect(host.storage.get("streamCooldownUntil")).toBeUndefined();
    },
  );

  it("invalidates cached URLs when the account changes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    vi.mocked(eapi).mockResolvedValue(audio({ exp: 1200 }));
    await stream({ id: "song:1" });
    changeAccount();
    await stream({ id: "song:1" });
    expect(eapi).toHaveBeenCalledTimes(2);
  });

  it.each(["success", "risk"])(
    "rejects an old account pending %s without poisoning new account state",
    async (outcome) => {
      const old = deferred<ReturnType<typeof audio>>(),
        fresh = deferred<ReturnType<typeof audio>>();
      vi.mocked(eapi).mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
      const previous = stream({ id: "song:1" });
      const rejected = expect(previous).rejects.toMatchObject({ code: "sessionChanged" });
      changeAccount();
      const next = stream({ id: "song:1" });
      if (outcome === "success") old.resolve(audio({ exp: 1200 }));
      else old.reject(Object.assign(new Error("Risk"), { apiCode: -460 }));
      await rejected;
      const sameNew = stream({ id: "song:1" });
      expect(eapi).toHaveBeenCalledTimes(2);
      expect(host.storage.get("streamCooldownUntil")).toBeUndefined();
      fresh.resolve(audio({ exp: 1200 }));
      await Promise.all([next, sameNew]);
    },
  );
});
describe("audio and timed lyrics", () => {
  it("requests five-level audio while preserving the actual returned cache bucket", async () => {
    mockHost({}, { quality: "hires" });
    vi.mocked(eapi).mockResolvedValue({
      code: 200,
      data: [
        {
          url: "http://m7.music.126.net/audio",
          type: "FLAC",
          level: "lossless",
          br: 900000,
          size: 100,
          gain: -4,
          peak: 0.8,
        },
      ],
    });
    expect(await stream({ id: "program:1:2", quality: "standard" })).toMatchObject({
      type: "flac",
      quality: "lossless",
      gain: -4,
      peak: 0.8,
    });
    expect(eapi).toHaveBeenCalledWith("/api/song/enhance/player/url/v1", {
      ids: "[2]",
      level: "hires",
      encodeType: "flac",
    });
  });
  it("never plays a VIP preview or sends cookies to an arbitrary media host", async () => {
    vi.mocked(eapi).mockResolvedValue({
      data: [{ url: "https://m7.music.126.net/a", type: "mp3", freeTrialInfo: {} }],
    });
    await expect(stream({ id: "song:1" })).rejects.toMatchObject({ code: "unavailable" });
    vi.mocked(eapi).mockResolvedValue({
      data: [{ url: "https://attacker.example/a", type: "mp3" }],
    });
    await expect(stream({ id: "song:1" })).rejects.toMatchObject({ code: "unavailable" });
  });
  it("validates the plugin quality and maps app quality explicitly", () => {
    expect(requestedLevel("high")).toBe("exhigh");
    mockHost({}, { quality: "typo" });
    expect(() => requestedLevel("high")).toThrow();
  });
  it("parses absolute YRC word times and nearest translations, ignoring credits", () => {
    const lines = parseYRC(
      '{"t":0,"c":[]}\n[1000,300](1000,100,0)A(1100,50,0) (1150,150,0)B',
      "[00:01.020]译文",
    );
    expect(lines).toEqual([
      {
        start: 1000,
        end: 1300,
        text: "A B",
        translation: "译文",
        words: [
          { start: 1000, end: 1100, text: "A " },
          { start: 1150, end: 1300, text: "B" },
        ],
      },
    ]);
    expect(parseLRC("[offset:-100]\n[00:01.2][00:02.345]Line")).toEqual([
      { start: 1100, text: "Line" },
      { start: 2245, text: "Line" },
    ]);
  });
  it("keeps line lyrics if the optional word endpoint fails and leaves episode transcription to the host", async () => {
    vi.mocked(apiGet).mockResolvedValue({ lrc: { lyric: "[00:01]Line" } });
    vi.mocked(eapi).mockRejectedValue(new Error("optional failure"));
    expect(await lyrics({ id: "song:1" })).toEqual({ lrc: "[00:01]Line", translation: "" });
    expect(await lyrics({ id: "program:1:2" })).toEqual({});
  });

  // Sequential endpoints could each take 20 seconds and exceed the host's 30-second call budget.
  it("starts both lyric endpoints before either one responds", async () => {
    const base = deferred<{ lrc: { lyric: string } }>();
    const words = deferred<{ yrc: { lyric: string } }>();
    vi.mocked(apiGet).mockReturnValueOnce(base.promise);
    vi.mocked(eapi).mockReturnValueOnce(words.promise);
    const result = lyrics({ id: "song:1" });
    expect(apiGet).toHaveBeenCalledTimes(1);
    expect(eapi).toHaveBeenCalledTimes(1);
    words.resolve({ yrc: { lyric: "[1000,200](1000,200,0)Line" } });
    base.resolve({ lrc: { lyric: "[00:01]Line" } });
    expect(await result).toMatchObject({
      lrc: "[00:01]Line",
      lines: [{ start: 1000, text: "Line" }],
    });
  });

  // Account replacement is an operation failure, not an optional word-lyrics outage to hide.
  it.each(["base", "words"])(
    "propagates sessionChanged from the %s lyric endpoint",
    async (endpoint) => {
      const changed = Object.assign(new Error("Account changed"), { code: "sessionChanged" });
      vi.mocked(apiGet).mockResolvedValue({ lrc: { lyric: "[00:01]Line" } });
      vi.mocked(eapi).mockResolvedValue({ yrc: { lyric: "[1000,200](1000,200,0)Line" } });
      if (endpoint === "base") vi.mocked(apiGet).mockRejectedValueOnce(changed);
      else vi.mocked(eapi).mockRejectedValueOnce(changed);
      await expect(lyrics({ id: "song:1" })).rejects.toBe(changed);
    },
  );
});
