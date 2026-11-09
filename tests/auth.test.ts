import { createCipheriv, createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

function environment(signedIn = false) {
  const storage = new Map<string, unknown>();
  if (signedIn)
    storage.set("session", { version: 1, cookies: [{ name: "MUSIC_U", value: "existing" }] });
  const prompt = vi.fn();
  vi.stubGlobal("host", {
    storage: {
      get: (key: string) => storage.get(key),
      set: (key: string, value: unknown) => {
        storage.set(key, value);
      },
      remove: (key: string) => {
        storage.delete(key);
      },
    },
    t: (text: string) => text,
    signInPrompt: prompt,
    crypto: {
      md5: (text: string) => createHash("md5").update(text).digest("hex"),
      aesEcbEncrypt: (key: string, text: string) => {
        const cipher = createCipheriv("aes-128-ecb", key, null);
        return Buffer.concat([cipher.update(text), cipher.final()]).toString("hex");
      },
    },
  });
  return { storage, prompt };
}
function response(body: unknown, cookie?: string): Response {
  return new Response(JSON.stringify(body), {
    headers: cookie ? { "set-cookie": cookie } : undefined,
  });
}
const profile = {
  userId: "123",
  nickname: "Listener",
  avatarUrl: "http://p1.music.126.net/avatar.jpg",
};

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("NetEase accounts", () => {
  // Signed-out library operations should ask to sign in without hitting the network.
  it("returns no account and a sign-in error without a saved session", async () => {
    environment();
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const auth = await import("../src/auth");
    expect(await auth.account()).toBe(null);
    await expect(auth.needAccount()).rejects.toMatchObject({ code: "signIn" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  // Account menus and concurrent library calls share one validation request.
  it("validates a saved account once and deduplicates concurrent reads", async () => {
    environment(true);
    const fetcher = vi.fn().mockResolvedValue(response({ code: 200, profile }));
    vi.stubGlobal("fetch", fetcher);
    const auth = await import("../src/auth");
    const [first, second] = await Promise.all([auth.account(), auth.account()]);
    expect(first).toEqual(second);
    expect(first).toMatchObject({ id: "123", name: "Listener", page: "user:123" });
    expect(first?.imageUrl).toContain("https://p1.music.126.net/avatar.jpg");
    expect(await auth.needAccount()).toEqual(first);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  // QR waiting, scanning and confirmation must save cookies before loading the profile.
  it("completes QR sign-in and coalesces duplicate sign-in requests", async () => {
    const { storage, prompt } = environment();
    let checks = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/unikey")) return response({ code: 200, unikey: "qr-key" });
        if (url.includes("/qrcode/client/login")) {
          checks++;
          return checks === 3
            ? response({ code: "803" }, "MUSIC_U=new-session; Path=/; HttpOnly")
            : response({ code: checks === 1 ? 801 : 802 });
        }
        if (url.includes("/nuser/account/get")) return response({ code: 200, profile });
        throw new Error(`Unexpected test route ${url}`);
      }),
    );
    const auth = await import("../src/auth");
    const first = auth.signIn();
    const second = auth.signIn();
    expect(first).toBe(second);
    await vi.advanceTimersByTimeAsync(4_500);
    expect(await first).toMatchObject({ id: "123" });
    expect(storage.has("session")).toBe(true);
    expect(
      prompt.mock.calls.some(
        ([value]) => value.qr === "https://music.163.com/login?codekey=qr-key",
      ),
    ).toBe(true);
    expect(prompt.mock.calls.some(([value]) => value.text.includes("Confirm"))).toBe(true);
  });

  // An expired QR code gets replaced rather than polling the same dead key.
  it("renews an expired QR code", async () => {
    const { prompt } = environment();
    let keys = 0,
      checks = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/unikey")) return response({ code: 200, unikey: `key-${++keys}` });
        if (url.includes("/qrcode/client/login"))
          return ++checks === 1
            ? response({ code: 800 })
            : response({ code: 803 }, "MUSIC_U=renewed; Path=/");
        return response({ code: 200, profile });
      }),
    );
    const auth = await import("../src/auth");
    const pending = auth.signIn();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(await pending).toMatchObject({ id: "123" });
    expect(keys).toBe(2);
    expect(prompt.mock.calls.some(([value]) => value.qr?.endsWith("key-2"))).toBe(true);
  });

  // A login response arriving after sign-out must not resurrect the account.
  it("cancels a pending QR attempt when signing out", async () => {
    const { storage } = environment();
    let answer!: (value: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            answer = resolve;
          }),
      ),
    );
    const auth = await import("../src/auth");
    const pending = auth.signIn();
    const rejected = expect(pending).rejects.toMatchObject({ code: "sessionChanged" });
    await auth.signOut();
    answer(response({ code: 200, unikey: "late-key" }, "MUSIC_U=stale; Path=/"));
    await rejected;
    expect(await auth.account()).toBe(null);
    expect(storage.has("session")).toBe(false);
  });

  // A profile read already in flight at logout cannot refresh account caches.
  it("discards a late account read and clears local session even if logout is offline", async () => {
    const { storage } = environment(true);
    let answer!: (value: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) =>
        url.endsWith("/api/logout")
          ? Promise.reject(new Error("offline"))
          : new Promise<Response>((resolve) => {
              answer = resolve;
            }),
      ),
    );
    const auth = await import("../src/auth");
    const pending = auth.account();
    await auth.signOut();
    answer(response({ code: 200, profile }, "MUSIC_U=stale; Path=/"));
    expect(await pending).toBe(null);
    expect(await auth.account()).toBe(null);
    expect(storage.has("session")).toBe(false);
  });

  // A saved cookie without a valid profile must not count as being signed in.
  it("forgets an expired account without masking network outages", async () => {
    const { storage } = environment(true);
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(response({ code: 200, profile: null }));
    vi.stubGlobal("fetch", fetcher);
    const auth = await import("../src/auth");
    await expect(auth.account()).rejects.toThrow("offline");
    expect(storage.has("session")).toBe(true);
    expect(await auth.account()).toBe(null);
    expect(storage.has("session")).toBe(false);
  });
});
