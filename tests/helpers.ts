import { createCipheriv, createHash } from "node:crypto";
import { vi } from "vite-plus/test";
import type { Host } from "../src/types";

export function mockHost(
  values: Record<string, unknown> = {},
  settings: Record<string, string> = {},
): Host {
  const data = new Map(Object.entries(values));
  const value: Host = {
    platform: "darwin",
    arch: "arm64",
    dir: "/plugin",
    dataDir: "/data",
    storage: {
      get: (key) => data.get(key),
      set: (key, item) => {
        data.set(key, item);
      },
      remove: (key) => {
        data.delete(key);
      },
    },
    setting: (key) => settings[key] || "",
    t: (text) => text,
    language: () => "en",
    crypto: {
      md5: (text) => createHash("md5").update(text).digest("hex"),
      aesEcbEncrypt: (key, text) => {
        const cipher = createCipheriv("aes-128-ecb", Buffer.from(key), null);
        return Buffer.concat([cipher.update(text), cipher.final()]).toString("hex");
      },
    },
    signInPrompt: vi.fn(),
    openURL: vi.fn(),
  };
  vi.stubGlobal("host", value);
  return value;
}

export const song = (value = 1) => ({
  id: value,
  name: `Song ${value}`,
  ar: [{ id: 10, name: "Artist" }],
  al: { id: 20, name: "Album" },
  dt: 90000,
  fee: 0,
  privilege: { st: 0, pl: 320000 },
});
