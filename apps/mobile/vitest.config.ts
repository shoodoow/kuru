import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    alias: {
      "expo-constants": fileURLToPath(new URL("./src/test/expo-constants.ts", import.meta.url)),
      "expo-secure-store": fileURLToPath(new URL("./src/test/expo-secure-store.ts", import.meta.url)),
    },
  },
});
