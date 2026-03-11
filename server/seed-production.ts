import { db } from "./db";
import { projectPapers, literatureReviews, editorials, syncMetadata } from "@shared/schema";
import { sql } from "drizzle-orm";
import fs from "fs";
import path from "path";

async function seedProduction() {
  const dataPath = path.join(__dirname, "prod-seed-data.json");
  if (!fs.existsSync(dataPath)) {
    console.log("No prod-seed-data.json found, skipping production seed.");
    return;
  }

  const data = JSON.parse(fs.readFileSync(dataPath, "utf-8"));

  const [existingPP] = await db.execute(sql`SELECT count(*) as cnt FROM project_papers`);
  const ppCount = Number((existingPP as any).cnt || 0);

  if (ppCount >= data.project_papers.length) {
    console.log(`Production already has ${ppCount} project papers, skipping seed.`);
    return;
  }

  console.log("Seeding production database...");

  if (data.project_papers?.length > 0) {
    for (const pp of data.project_papers) {
      try {
        await db.insert(projectPapers).values({
          id: pp.id,
          projectId: pp.projectId,
          title: pp.title,
          description: pp.description,
          authors: pp.authors,
          date: pp.date,
          type: pp.type,
          sourceDocumentId: pp.sourceDocumentId || null,
        }).onConflictDoNothing();
      } catch (e) {}
    }
    console.log(`Seeded ${data.project_papers.length} project papers.`);
  }

  if (data.literature_reviews?.length > 0) {
    for (const lr of data.literature_reviews) {
      try {
        await db.insert(literatureReviews).values({
          id: lr.id,
          projectId: lr.projectId,
          agentId: lr.agentId,
          researchQuestion: lr.researchQuestion,
          prompt: lr.prompt,
          contentHtml: lr.contentHtml,
          status: lr.status,
          createdAt: lr.createdAt ? new Date(lr.createdAt) : new Date(),
          completedAt: lr.completedAt ? new Date(lr.completedAt) : null,
        }).onConflictDoNothing();
      } catch (e) {}
    }
    console.log(`Seeded ${data.literature_reviews.length} literature reviews.`);
  }

  if (data.editorials?.length > 0) {
    for (const ed of data.editorials) {
      try {
        await db.insert(editorials).values({
          id: ed.id,
          title: ed.title,
          slug: ed.slug,
          tag: ed.tag,
          excerpt: ed.excerpt,
          contentHtml: ed.contentHtml,
          agentId: ed.agentId,
          status: ed.status,
          createdAt: ed.createdAt ? new Date(ed.createdAt) : new Date(),
          completedAt: ed.completedAt ? new Date(ed.completedAt) : null,
        }).onConflictDoNothing();
      } catch (e) {}
    }
    console.log(`Seeded ${data.editorials.length} editorials.`);
  }

  console.log("Production seed complete.");
}

seedProduction()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Production seed failed:", err);
    process.exit(1);
  });
