import { describe, expect, it } from "vitest";
import { runSandboxInstanceStoreConformance } from "@tanstack/ai-sandbox/testkit";
import { sqlitePersistence } from "../sqlite-persistence.js";

runSandboxInstanceStoreConformance(
  "opentag sqlite instances",
  () => sqlitePersistence({ url: ":memory:", migrate: true }).instances,
);

describe("sqlite instance store extra cases", () => {
  it("exposes instances on sqlitePersistence", () => {
    const persistence = sqlitePersistence({
      url: ":memory:",
      migrate: true,
    });
    try {
      expect(persistence.instances).toBeDefined();
      expect(typeof persistence.instances.get).toBe("function");
    } finally {
      persistence.close();
    }
  });
});
