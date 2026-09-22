import { sql } from "drizzle-orm";
import { db } from "./db";

// Replace the historical paper/model lock atomically: concurrent processes
// must never see a window without a unique index. Fail startup on migration
// failure rather than accepting runs under an obsolete lock.
export async function migrateReproductionPersona(): Promise<void> {
  await db.transaction(async tx => {
    await tx.execute(sql`LOCK TABLE reproductions IN ACCESS EXCLUSIVE MODE`);
    await tx.execute(sql`ALTER TABLE reproductions ADD COLUMN IF NOT EXISTS questioning_json TEXT`);
    await tx.execute(sql`DROP INDEX IF EXISTS reproductions_journal_doc_model_uniq`);
    await tx.execute(sql`
      CREATE UNIQUE INDEX reproductions_journal_doc_model_uniq
      ON reproductions (journal_id, document_id, model_name, agent_id)
      WHERE status IN ('pending', 'generating')
    `);
    await tx.execute(sql`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'reproductions_agent_id_check'
            AND conrelid = 'reproductions'::regclass
        ) THEN
          ALTER TABLE reproductions ADD CONSTRAINT reproductions_agent_id_check
            CHECK (agent_id IN ('P', 'qP'));
        END IF;
      END $$
    `);
  });
}