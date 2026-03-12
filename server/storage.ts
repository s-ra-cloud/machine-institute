import { type User, type InsertUser, type Paper, type InsertPaper, type ResearchEvent, type InsertResearchEvent, type LiteratureReview, type InsertLiteratureReview, type ProjectPaper, type InsertProjectPaper, type EditorialRecord, type InsertEditorial, type AgentMember, type InsertAgentMember, users, papers, researchEvents, literatureReviews, projectPapers, syncMetadata, editorials, agentMembers } from "@shared/schema";
import { db } from "./db";
import { eq, desc, gte, inArray, or } from "drizzle-orm";

export interface IStorage {
  getUser(id: string): Promise<User | undefined>;
  getUserByUsername(username: string): Promise<User | undefined>;
  createUser(user: InsertUser): Promise<User>;

  createPaper(paper: InsertPaper & { slug: string }): Promise<Paper>;
  getPaperById(id: string): Promise<Paper | undefined>;
  getPaperBySlug(slug: string): Promise<Paper | undefined>;
  getAllPapers(): Promise<Paper[]>;
  getPapersByType(type: string): Promise<Paper[]>;

  createResearchEvent(event: InsertResearchEvent): Promise<ResearchEvent>;
  createResearchEvents(events: InsertResearchEvent[]): Promise<ResearchEvent[]>;
  getRecentEvents(limit: number): Promise<ResearchEvent[]>;
  getActiveEvents(minutesAgo: number): Promise<ResearchEvent[]>;

  createLiteratureReview(review: InsertLiteratureReview): Promise<LiteratureReview>;
  getLiteratureReviewById(id: string): Promise<LiteratureReview | undefined>;
  getLiteratureReviewsByProject(projectId: string): Promise<LiteratureReview[]>;
  getAllLiteratureReviews(): Promise<LiteratureReview[]>;
  updateLiteratureReview(id: string, updates: Partial<LiteratureReview>): Promise<LiteratureReview>;

  getProjectPapers(projectId: string): Promise<ProjectPaper[]>;
  getAllProjectPapers(): Promise<ProjectPaper[]>;
  createProjectPaper(paper: InsertProjectPaper): Promise<ProjectPaper>;
  createProjectPapers(papers: InsertProjectPaper[]): Promise<ProjectPaper[]>;
  getProjectPapersBySourceDocIds(docIds: string[]): Promise<ProjectPaper[]>;

  createEditorial(editorial: InsertEditorial): Promise<EditorialRecord>;
  getEditorialById(id: string): Promise<EditorialRecord | undefined>;
  getEditorialBySlug(slug: string): Promise<EditorialRecord | undefined>;
  getAllEditorials(): Promise<EditorialRecord[]>;
  updateEditorial(id: string, updates: Partial<EditorialRecord>): Promise<EditorialRecord>;

  getAllAgentMembers(): Promise<AgentMember[]>;
  getAgentMemberById(id: string): Promise<AgentMember | undefined>;
  createAgentMember(member: InsertAgentMember): Promise<AgentMember>;
  createAgentMembers(members: InsertAgentMember[]): Promise<AgentMember[]>;
  upsertAgentMembers(members: InsertAgentMember[]): Promise<AgentMember[]>;
  updateProjectPaperUrl(sourceDocumentId: string, url: string): Promise<void>;

  getLastSyncTime(key: string): Promise<Date | null>;
  setLastSyncTime(key: string, time: Date): Promise<void>;
}

export class DatabaseStorage implements IStorage {
  async getUser(id: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.id, id));
    return user;
  }

  async getUserByUsername(username: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.username, username));
    return user;
  }

  async createUser(insertUser: InsertUser): Promise<User> {
    const [user] = await db.insert(users).values(insertUser).returning();
    return user;
  }

  async createPaper(paper: InsertPaper & { slug: string }): Promise<Paper> {
    const [created] = await db.insert(papers).values(paper).returning();
    return created;
  }

  async getPaperById(id: string): Promise<Paper | undefined> {
    const [paper] = await db.select().from(papers).where(eq(papers.id, id));
    return paper;
  }

  async getPaperBySlug(slug: string): Promise<Paper | undefined> {
    const [paper] = await db.select().from(papers).where(eq(papers.slug, slug));
    return paper;
  }

  async getAllPapers(): Promise<Paper[]> {
    return db.select().from(papers).orderBy(desc(papers.publishedAt));
  }

  async getPapersByType(type: string): Promise<Paper[]> {
    return db.select().from(papers).where(eq(papers.type, type as any)).orderBy(desc(papers.publishedAt));
  }

  async createResearchEvent(event: InsertResearchEvent): Promise<ResearchEvent> {
    const [created] = await db.insert(researchEvents).values(event).returning();
    return created;
  }

  async createResearchEvents(events: InsertResearchEvent[]): Promise<ResearchEvent[]> {
    return db.insert(researchEvents).values(events).returning();
  }

  async getRecentEvents(limit: number = 20): Promise<ResearchEvent[]> {
    return db.select().from(researchEvents).orderBy(desc(researchEvents.timestamp)).limit(limit);
  }

  async getActiveEvents(minutesAgo: number = 10): Promise<ResearchEvent[]> {
    const cutoff = new Date(Date.now() - minutesAgo * 60 * 1000);
    return db.select().from(researchEvents).where(gte(researchEvents.timestamp, cutoff)).orderBy(desc(researchEvents.timestamp));
  }

  async createLiteratureReview(review: InsertLiteratureReview): Promise<LiteratureReview> {
    const [created] = await db.insert(literatureReviews).values(review).returning();
    return created;
  }

  async getLiteratureReviewById(id: string): Promise<LiteratureReview | undefined> {
    const [review] = await db.select().from(literatureReviews).where(eq(literatureReviews.id, id));
    return review;
  }

  async getLiteratureReviewsByProject(projectId: string): Promise<LiteratureReview[]> {
    return db.select().from(literatureReviews).where(eq(literatureReviews.projectId, projectId)).orderBy(desc(literatureReviews.createdAt));
  }

  async getAllLiteratureReviews(): Promise<LiteratureReview[]> {
    return db.select().from(literatureReviews).orderBy(desc(literatureReviews.createdAt));
  }

  async updateLiteratureReview(id: string, updates: Partial<LiteratureReview>): Promise<LiteratureReview> {
    const [updated] = await db.update(literatureReviews).set(updates).where(eq(literatureReviews.id, id)).returning();
    return updated;
  }

  async getProjectPapers(projectId: string): Promise<ProjectPaper[]> {
    return db.select().from(projectPapers).where(eq(projectPapers.projectId, projectId)).orderBy(desc(projectPapers.date));
  }

  async getAllProjectPapers(): Promise<ProjectPaper[]> {
    return db.select().from(projectPapers).orderBy(desc(projectPapers.date));
  }

  async createProjectPaper(paper: InsertProjectPaper): Promise<ProjectPaper> {
    const [created] = await db.insert(projectPapers).values(paper).returning();
    return created;
  }

  async createProjectPapers(papersData: InsertProjectPaper[]): Promise<ProjectPaper[]> {
    if (papersData.length === 0) return [];
    return db.insert(projectPapers).values(papersData).onConflictDoNothing().returning();
  }

  async getProjectPapersBySourceDocIds(docIds: string[]): Promise<ProjectPaper[]> {
    if (docIds.length === 0) return [];
    return db.select().from(projectPapers).where(inArray(projectPapers.sourceDocumentId, docIds));
  }

  async createEditorial(editorial: InsertEditorial): Promise<EditorialRecord> {
    const [created] = await db.insert(editorials).values(editorial).returning();
    return created;
  }

  async getEditorialById(id: string): Promise<EditorialRecord | undefined> {
    const [editorial] = await db.select().from(editorials).where(eq(editorials.id, id));
    return editorial;
  }

  async getEditorialBySlug(slug: string): Promise<EditorialRecord | undefined> {
    const [editorial] = await db.select().from(editorials).where(eq(editorials.slug, slug));
    return editorial;
  }

  async getAllEditorials(): Promise<EditorialRecord[]> {
    return db.select().from(editorials).orderBy(desc(editorials.createdAt));
  }

  async updateEditorial(id: string, updates: Partial<EditorialRecord>): Promise<EditorialRecord> {
    const [updated] = await db.update(editorials).set(updates).where(eq(editorials.id, id)).returning();
    return updated;
  }

  async getAllAgentMembers(): Promise<AgentMember[]> {
    return db.select().from(agentMembers);
  }

  async getAgentMemberById(id: string): Promise<AgentMember | undefined> {
    const [member] = await db.select().from(agentMembers).where(eq(agentMembers.id, id));
    return member;
  }

  async createAgentMember(member: InsertAgentMember): Promise<AgentMember> {
    const [created] = await db.insert(agentMembers).values(member).returning();
    return created;
  }

  async createAgentMembers(members: InsertAgentMember[]): Promise<AgentMember[]> {
    if (members.length === 0) return [];
    return db.insert(agentMembers).values(members).onConflictDoNothing().returning();
  }

  async upsertAgentMembers(members: InsertAgentMember[]): Promise<AgentMember[]> {
    if (members.length === 0) return [];
    const results: AgentMember[] = [];
    for (const member of members) {
      const [result] = await db.insert(agentMembers).values(member)
        .onConflictDoUpdate({
          target: agentMembers.id,
          set: {
            plainDescription: member.plainDescription,
            framework: member.framework,
          },
        })
        .returning();
      results.push(result);
    }
    return results;
  }

  async updateProjectPaperUrl(sourceDocumentId: string, url: string): Promise<void> {
    await db.update(projectPapers).set({ url }).where(eq(projectPapers.sourceDocumentId, sourceDocumentId));
  }

  async getLastSyncTime(key: string): Promise<Date | null> {
    const [row] = await db.select().from(syncMetadata).where(eq(syncMetadata.key, key));
    return row?.lastSyncedAt ?? null;
  }

  async setLastSyncTime(key: string, time: Date): Promise<void> {
    const [existing] = await db.select().from(syncMetadata).where(eq(syncMetadata.key, key));
    if (existing) {
      await db.update(syncMetadata).set({ lastSyncedAt: time }).where(eq(syncMetadata.key, key));
    } else {
      await db.insert(syncMetadata).values({ key, lastSyncedAt: time });
    }
  }
}

export const storage = new DatabaseStorage();