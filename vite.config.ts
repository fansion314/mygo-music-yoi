import { defineConfig } from "vite-plus";

export default defineConfig({
  build: {
    outDir: ".cache/build",
    target: "es2022",
    minify: false,
    lib: { entry: "src/index.ts", formats: ["es"], fileName: () => "index.js" },
    rollupOptions: {
      output: {
        banner:
          "// YOI — You Own It. SPDX-License-Identifier: AGPL-3.0-only\n// Derived from egoist/mygo-cloudmusic; see NOTICE.md.",
      },
    },
  },
  plugins: [
    {
      name: "yoi-installable-entry",
      async writeBundle(_, bundle) {
        const { writeFile } = await import("node:fs/promises");
        const entry = bundle["index.js"];
        if (entry?.type !== "chunk") throw new Error("Missing plugin bundle");
        await writeFile("index.js", entry.code);
      },
    },
  ],
  test: { include: ["tests/**/*.test.ts"], restoreMocks: true },
  fmt: { ignorePatterns: ["index.js", "pnpm-lock.yaml", "LICENSE"] },
  lint: {
    ignorePatterns: ["index.js", ".cache/**", "dist/**"],
    rules: { "typescript/no-explicit-any": "off" },
  },
});
