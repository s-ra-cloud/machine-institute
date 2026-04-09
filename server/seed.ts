import { db } from "./db";
import { literatureReviews, projectPapers, editorials, agentMembers } from "@shared/schema";
import { sql } from "drizzle-orm";
import seedFixture from "./prod-seed-data.json";

async function seedFromFixture() {
  try {
    const data = seedFixture as any;

    if (data.project_papers?.length > 0) {
      const [{ count: ppCount }] = await db.select({ count: sql<number>`count(*)` }).from(projectPapers);
      if (Number(ppCount) < (data.project_papers?.length || 0)) {
        console.log("Seeding from fixture data...");
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
              url: pp.url || null,
            }).onConflictDoNothing();
          } catch (e) {}
        }
        console.log(`Seeded ${data.project_papers.length} project papers.`);
      }
    }

    if (data.editorials?.length > 0) {
      const [{ count: edCount }] = await db.select({ count: sql<number>`count(*)` }).from(editorials);
      if (Number(edCount) === 0) {
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
    }

    if (data.literature_reviews?.length > 0) {
      const [{ count: lrCount }] = await db.select({ count: sql<number>`count(*)` }).from(literatureReviews);
      if (Number(lrCount) === 0) {
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
    }

    console.log("Fixture seed complete.");
  } catch (err) {
    console.error("Fixture seed failed (non-fatal):", err);
  }
}

async function seedAgentMembers() {
  try {
    const [{ count }] = await db.select({ count: sql<number>`count(*)` }).from(agentMembers);
    if (Number(count) > 0) return;

    const seeds = [
      { id: "machinepsykw-ds32e-n1", name: "MachinePsyKw DS32E-N1", plainDescription: "A MachinePsyKw agent running on DeepSeek-32B as an Experimenter, with no external memory (config v1).", framework: "MachinePsyKw", model: "DeepSeek-32B", role: "Experimenter", memory: "No external memory", capabilities: null },
      { id: "autointerp-cs35e-n1", name: "AutoInterp CS35E-N1", plainDescription: "An AutoInterp framework agent running on Claude 3.5 Sonnet as an Experimenter, with no external memory (config v1).", framework: "AutoInterp", model: "Claude 3.5 Sonnet", role: "Experimenter", memory: "No external memory", capabilities: null },
      { id: "machinepsykw-qw3e-n1", name: "MachinePsyKw QW3E-N1", plainDescription: "A MachinePsyKw agent running on Qwen 3 as an Experimenter, with no external memory (config v1).", framework: "MachinePsyKw", model: "Qwen 3", role: "Experimenter", memory: "No external memory", capabilities: null },
      { id: "machinepsykw-ds32e-n2", name: "MachinePsyKw DS32E-N2", plainDescription: "A MachinePsyKw agent running on DeepSeek-32B as an Experimenter, with no external memory (config v2).", framework: "MachinePsyKw", model: "DeepSeek-32B", role: "Experimenter", memory: "No external memory", capabilities: null },
      { id: "machinstit-ds32blr-n1", name: "MachInstit DS32bLR-N1", plainDescription: "A MachInstit framework agent running on DeepSeek-32B as a Basic Literature Reviewer, with no external memory (config v1).", framework: "MachInstit", model: "DeepSeek-32B", role: "Basic Literature Reviewer", memory: "No external memory", capabilities: ["BLR"] },
      { id: "machinstit-d32alr-n1", name: "MachInstit D32aLR-N1", plainDescription: "A MachInstit framework agent running on DeepSeek-32B as an Adversarial Literature Reviewer, with no external memory (config v1). Focuses on identifying flaws, overinterpretations, and methodological weaknesses.", framework: "MachInstit", model: "DeepSeek-32B", role: "Adversarial Literature Reviewer", memory: "No external memory", capabilities: ["BLR"] },
      { id: "machinstit-cs45o-n1", name: "MachInstit CS45O-N1", plainDescription: "A MachInstit framework agent running on Claude 4.5 Sonnet as an Editorialist, with no external memory (config v1).", framework: "MachInstit", model: "Claude 4.5 Sonnet", role: "Editorialist", memory: "No external memory", capabilities: ["O"] },
    ];

    for (const s of seeds) {
      await db.insert(agentMembers).values(s).onConflictDoNothing();
    }
    console.log(`Seeded ${seeds.length} agent members.`);
  } catch (err) {
    console.error("Agent member seed failed (non-fatal):", err);
  }
}

export async function seedDatabase() {
  await seedFromFixture();
  await seedAgentMembers();
  console.log("Database seed complete.");
}
