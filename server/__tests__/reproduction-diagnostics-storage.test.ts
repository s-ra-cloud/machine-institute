import { beforeEach, describe, expect, it, vi } from "vitest";
import { getTableConfig } from "drizzle-orm/pg-core";
import { reproductionFailureDiagnostics, reproductions } from "../../shared/schema";

const mocks = vi.hoisted(() => ({
  insert: vi.fn(), values: vi.fn(), onConflictDoUpdate: vi.fn(),
  select: vi.fn(), from: vi.fn(), where: vi.fn(),
}));
vi.mock("../db", () => ({ db: mocks }));
import { DatabaseStorage } from "../storage";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.insert.mockReturnValue({ values: mocks.values });
  mocks.values.mockReturnValue({ onConflictDoUpdate: mocks.onConflictDoUpdate });
  mocks.onConflictDoUpdate.mockResolvedValue(undefined);
  mocks.select.mockReturnValue({ from: mocks.from });
  mocks.from.mockReturnValue({ where: mocks.where });
  mocks.where.mockResolvedValue([]);
});

describe("private reproduction failure diagnostic storage", () => {
  it("uses a dedicated table with a cascading parent key and no public row column", () => {
    const privateConfig = getTableConfig(reproductionFailureDiagnostics);
    expect(privateConfig.name).toBe("reproduction_failure_diagnostics");
    expect(reproductionFailureDiagnostics.reproductionId.primary).toBe(true);
    expect(privateConfig.foreignKeys[0].onDelete).toBe("cascade");
    expect(privateConfig.foreignKeys[0].reference().foreignTable).toBe(reproductions);
    expect(getTableConfig(reproductions).columns.map(c => c.name)).not.toContain("diagnostics_json");
  });

  it("upserts by reproduction ID, keeping diagnostics out of reproduction updates", async () => {
    const json = JSON.stringify({ stage: "tool-loop", stopReason: "no-progress" });
    await new DatabaseStorage().saveReproductionFailureDiagnostics("run", json);
    expect(mocks.insert).toHaveBeenCalledWith(reproductionFailureDiagnostics);
    expect(mocks.values).toHaveBeenCalledWith({ reproductionId: "run", diagnosticsJson: json });
    expect(mocks.onConflictDoUpdate).toHaveBeenCalledWith({
      target: reproductionFailureDiagnostics.reproductionId,
      set: { diagnosticsJson: json, createdAt: expect.any(Date) },
    });
  });

  it("returns a stored snapshot or undefined for legacy runs", async () => {
    const storage = new DatabaseStorage();
    expect(await storage.getReproductionFailureDiagnostics("legacy")).toBeUndefined();
    const saved = { reproductionId: "run", diagnosticsJson: "{}", createdAt: new Date() };
    mocks.where.mockResolvedValue([saved]);
    expect(await storage.getReproductionFailureDiagnostics("run")).toEqual(saved);
    expect(mocks.from).toHaveBeenCalledWith(reproductionFailureDiagnostics);
  });

  it("surfaces write errors to the independent best-effort caller", async () => {
    mocks.onConflictDoUpdate.mockRejectedValue(new Error("storage unavailable"));
    await expect(new DatabaseStorage().saveReproductionFailureDiagnostics("run", "{}"))
      .rejects.toThrow("storage unavailable");
  });
});