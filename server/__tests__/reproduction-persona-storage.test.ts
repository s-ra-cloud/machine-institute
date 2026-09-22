import { beforeEach, describe, expect, it, vi } from "vitest";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { insertReproductionSchema, reproductions } from "../../shared/schema";
import { buildConventionName, buildFsAgentDescription } from "../agent-naming";

const mocks = vi.hoisted(() => ({
  insert: vi.fn(), values: vi.fn(), returning: vi.fn(),
  select: vi.fn(), from: vi.fn(), where: vi.fn(), orderBy: vi.fn(),
  transaction: vi.fn(), execute: vi.fn(),
}));
vi.mock("../db", () => ({ db: mocks }));
import { DatabaseStorage } from "../storage";
import { migrateReproductionPersona } from "../reproduction-schema";

const base = {
  projectId: "mirror", journalId: "mirror", documentId: "paper", gpu: "A10G",
  prompt1: "saved reproducer prompt", prompt2: "saved judge prompt", modelName: "gpt-5-mini",
};
const dialect = new PgDialect();

beforeEach(() => {
  vi.resetAllMocks();
  mocks.insert.mockReturnValue({ values: mocks.values });
  mocks.values.mockReturnValue({ returning: mocks.returning });
  mocks.select.mockReturnValue({ from: mocks.from });
  mocks.from.mockReturnValue({ where: mocks.where });
  mocks.where.mockResolvedValue([]);
  mocks.transaction.mockImplementation(async fn => fn({ execute: mocks.execute }));
});

describe("reproduction persona persistence", () => {
  it("excludes provenance in SQL projections for public collections and detail, preserving full internal reads", async () => {
    const storage = new DatabaseStorage();
    mocks.from.mockReturnValue({ where: mocks.where, orderBy: mocks.orderBy });
    mocks.orderBy.mockResolvedValue([]);
    await storage.getAllReproductions();
    mocks.where.mockReturnValueOnce({ orderBy: mocks.orderBy });
    await storage.getReproductionsByProject("mirror");
    mocks.where.mockResolvedValueOnce([{ id: "run", agentId: "qP" }]);
    expect(await storage.getPublicReproductionById("run")).toEqual({ id: "run", agentId: "qP" });
    for (const [projection] of mocks.select.mock.calls) {
      expect(projection).toHaveProperty("id", reproductions.id);
      expect(projection).toHaveProperty("agentId", reproductions.agentId);
      expect(projection).not.toHaveProperty("questioningJson");
      expect(Object.values(projection)).not.toContain(reproductions.questioningJson);
    }
    mocks.select.mockClear();
    const full = { id: "run", questioningJson: '{"schemaVersion":2}' };
    mocks.where.mockResolvedValueOnce([full]);
    expect(await storage.getReproductionById("run")).toBe(full);
    expect(mocks.select).toHaveBeenCalledWith();
  });

  it("defaults omitted persona to P, accepts qP and rejects all other values", () => {
    expect(insertReproductionSchema.parse(base).agentId).toBe("P");
    expect(insertReproductionSchema.parse({ ...base, agentId: "qP" }).agentId).toBe("qP");
    for (const agentId of [null, "", "qp", "Q", 0, ["P"]]) {
      expect(insertReproductionSchema.safeParse({ ...base, agentId }).success).toBe(false);
    }
    expect(insertReproductionSchema.parse({ ...base, questioningJson: "untrusted" }))
      .not.toHaveProperty("questioningJson");
  });

  it("locks only active paper/model/persona tuples and keeps questioning JSON nullable", () => {
    const config = getTableConfig(reproductions);
    const index = config.indexes.find(i => i.config.name === "reproductions_journal_doc_model_uniq")!;
    expect(index.config.columns.map(c => (c as any).name))
      .toEqual(["journal_id", "document_id", "model_name", "agent_id"]);
    expect(index.config.unique).toBe(true);
    expect(dialect.sqlToQuery(index.config.where!).sql).toContain("status IN ('pending', 'generating')");
    expect(reproductions.questioningJson.notNull).toBe(false);
  });

  it("filters catalogue locks by selected persona (P for old callers)", async () => {
    const storage = new DatabaseStorage();
    for (const persona of [undefined, "qP"] as const) {
      await storage.getReproducedPapersForJournal("mirror", persona);
      const query = dialect.sqlToQuery(mocks.where.mock.lastCall![0]);
      expect(query.params).toEqual(["mirror", persona ?? "P", "failed"]);
      expect(query.sql).toContain('"agent_id"');
    }
  });

  it("preserves selected persona in inserts and returns null on atomic lock conflicts", async () => {
    const run = insertReproductionSchema.parse({ ...base, agentId: "qP" });
    mocks.returning.mockResolvedValue([{ ...run, id: "run" }]);
    expect(await new DatabaseStorage().createReproduction(run)).toMatchObject({ agentId: "qP" });
    expect(mocks.values).toHaveBeenCalledWith(run);
    mocks.returning.mockRejectedValue({ code: "23505" });
    expect(await new DatabaseStorage().createReproduction(run)).toBeNull();
    mocks.returning.mockRejectedValue(new Error("offline"));
    await expect(new DatabaseStorage().createReproduction(run)).rejects.toThrow("offline");
  });

  it("migrates the active unique index and JSON column in one transaction", async () => {
    await migrateReproductionPersona();
    expect(mocks.transaction).toHaveBeenCalledOnce();
    const statements = mocks.execute.mock.calls.map(([query]) => dialect.sqlToQuery(query).sql).join("\n");
    expect(statements).toContain("ACCESS EXCLUSIVE");
    expect(statements).toContain("ADD COLUMN IF NOT EXISTS questioning_json TEXT");
    expect(statements).toContain("(journal_id, document_id, model_name, agent_id)");
    expect(statements).toContain("WHERE status IN ('pending', 'generating')");
    expect(statements).toContain("CHECK (agent_id IN ('P', 'qP'))");
  });

  it("names and describes questioning publication agents distinctly", () => {
    expect(buildConventionName("gpt-5-mini", "qP")).toContain("qP-N1");
    expect(buildFsAgentDescription({ model: "gpt-5-mini", agentId: "qP" }))
      .toContain("qP (Questioning Reproduction Agent)");
  });
});