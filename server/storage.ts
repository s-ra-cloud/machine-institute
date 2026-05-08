import { type User, type InsertUser, type Paper, type InsertPaper, type ResearchEvent, type InsertResearchEvent, type LiteratureReview, type InsertLiteratureReview, type ProjectPaper, type InsertProjectPaper, type EditorialRecord, type InsertEditorial, type AgentMember, type InsertAgentMember, type UserRateLimit, type UserApiKey, type EthicsReport, type InsertEthicsReport, users, papers, researchEvents, literatureReviews, projectPapers, syncMetadata, editorials, agentMembers, userRateLimits, userApiKeys, ethicsReports } from "@shared/schema";
import { db } from "./db";
import { eq, desc, gte, lt, lte, inArray, and, notInArray, ne } from "drizzle-orm";

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
  getEventsSince(since: Date): Promise<ResearchEvent[]>;
  getEventsBefore(before: Date, limit: number): Promise<ResearchEvent[]>;
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
  deleteAllProjectPapers(): Promise<number>;
  deleteProjectPapersNotInSourceDocIds(projectId: string, keepDocIds: string[]): Promise<number>;

  createEditorial(editorial: InsertEditorial): Promise<EditorialRecord>;
  getEditorialById(id: string): Promise<EditorialRecord | undefined>;
  getEditorialBySlug(slug: string): Promise<EditorialRecord | undefined>;
  getAllEditorials(): Promise<EditorialRecord[]>;
  deleteAllEditorials(): Promise<void>;
  deleteAllLiteratureReviews(): Promise<void>;
  updateEditorial(id: string, updates: Partial<EditorialRecord>): Promise<EditorialRecord>;

  getAllAgentMembers(): Promise<AgentMember[]>;
  getAgentMemberById(id: string): Promise<AgentMember | undefined>;
  createAgentMember(member: InsertAgentMember): Promise<AgentMember>;
  createAgentMembers(members: InsertAgentMember[]): Promise<AgentMember[]>;
  upsertAgentMembers(members: InsertAgentMember[]): Promise<AgentMember[]>;
  deleteAgentMembersNotIn(keepIds: string[]): Promise<number>;
  updateProjectPaperUrl(sourceDocumentId: string, url: string): Promise<void>;

  getLastSyncTime(key: string): Promise<Date | null>;
  setLastSyncTime(key: string, time: Date): Promise<void>;

  getUserRateLimit(userId: string, resourceType: string): Promise<UserRateLimit | null>;
  incrementUserRateLimit(userId: string, resourceType: string, windowMs: number): Promise<UserRateLimit>;
  checkAndIncrementRateLimit(userId: string, resourceType: string, maxCount: number, windowMs: number): Promise<{ allowed: boolean; currentCount: number; limit: number }>;

  storeUserApiKeyRecord(userId: string, provider: string, keyHash: string, expiresAt: Date): Promise<UserApiKey>;
  getUserApiKeyRecord(userId: string, provider: string): Promise<UserApiKey | null>;
  deleteExpiredApiKeys(): Promise<void>;

  createEthicsReport(report: InsertEthicsReport): Promise<EthicsReport>;
  getEthicsReportById(id: string): Promise<EthicsReport | undefined>;
  getEthicsReportsByProject(projectId: string): Promise<EthicsReport[]>;
  getCompletedEthicsReportsByJournal(journalId: string): Promise<EthicsReport[]>;
  getAllEthicsReports(): Promise<EthicsReport[]>;
  updateEthicsReport(id: string, updates: Partial<EthicsReport>): Promise<EthicsReport>;
  deleteAllEthicsReports(): Promise<void>;
  deleteEthicsReport(id: string): Promise<void>;
  deleteLiteratureReview(id: string): Promise<void>;
  resetAuditLockForJournal(journalId: string): Promise<number>;
  getAuditedPaperIdsForJournal(journalId: string): Promise<string[]>;
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

  async getEventsSince(since: Date): Promise<ResearchEvent[]> {
    return db.select().from(researchEvents).where(gte(researchEvents.timestamp, since)).orderBy(desc(researchEvents.timestamp));
  }

  async getEventsBefore(before: Date, limit: number = 200): Promise<ResearchEvent[]> {
    return db.select().from(researchEvents).where(lt(researchEvents.timestamp, before)).orderBy(desc(researchEvents.timestamp)).limit(limit);
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

  async deleteAllProjectPapers(): Promise<number> {
    const deleted = await db.delete(projectPapers).returning({ id: projectPapers.id });
    return deleted.length;
  }

  async deleteProjectPapersNotInSourceDocIds(projectId: string, keepDocIds: string[]): Promise<number> {
    if (keepDocIds.length === 0) {
      const deleted = await db.delete(projectPapers)
        .where(eq(projectPapers.projectId, projectId))
        .returning({ id: projectPapers.id });
      return deleted.length;
    }
    const deleted = await db.delete(projectPapers)
      .where(and(
        eq(projectPapers.projectId, projectId),
        notInArray(projectPapers.sourceDocumentId, keepDocIds),
      ))
      .returning({ id: projectPapers.id });
    return deleted.length;
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

  async deleteAllEditorials(): Promise<void> {
    await db.delete(editorials);
  }

  async deleteAllLiteratureReviews(): Promise<void> {
    await db.delete(literatureReviews);
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
            role: member.role,
            model: member.model,
            memory: member.memory,
          },
        })
        .returning();
      results.push(result);
    }
    return results;
  }

  async deleteAgentMembersNotIn(keepIds: string[]): Promise<number> {
    if (keepIds.length === 0) {
      const deleted = await db.delete(agentMembers).returning({ id: agentMembers.id });
      return deleted.length;
    }
    const deleted = await db.delete(agentMembers)
      .where(notInArray(agentMembers.id, keepIds))
      .returning({ id: agentMembers.id });
    return deleted.length;
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

  async getUserRateLimit(userId: string, resourceType: string): Promise<UserRateLimit | null> {
    const [row] = await db.select().from(userRateLimits)
      .where(and(eq(userRateLimits.userId, userId), eq(userRateLimits.resourceType, resourceType)));
    return row ?? null;
  }

  async incrementUserRateLimit(userId: string, resourceType: string, windowMs: number): Promise<UserRateLimit> {
    return await db.transaction(async (tx) => {
      const [existing] = await tx.select().from(userRateLimits)
        .where(and(eq(userRateLimits.userId, userId), eq(userRateLimits.resourceType, resourceType)));

      if (existing) {
        const elapsed = Date.now() - existing.windowStart.getTime();
        if (elapsed >= windowMs) {
          const [updated] = await tx.update(userRateLimits)
            .set({ count: 1, windowStart: new Date() })
            .where(eq(userRateLimits.id, existing.id))
            .returning();
          return updated;
        }
        const [updated] = await tx.update(userRateLimits)
          .set({ count: existing.count + 1 })
          .where(eq(userRateLimits.id, existing.id))
          .returning();
        return updated;
      }

      const [created] = await tx.insert(userRateLimits)
        .values({ userId, resourceType, count: 1, windowStart: new Date() })
        .returning();
      return created;
    });
  }

  async checkAndIncrementRateLimit(userId: string, resourceType: string, maxCount: number, windowMs: number): Promise<{ allowed: boolean; currentCount: number; limit: number }> {
    return await db.transaction(async (tx) => {
      const [existing] = await tx.select().from(userRateLimits)
        .where(and(eq(userRateLimits.userId, userId), eq(userRateLimits.resourceType, resourceType)));

      if (!existing) {
        await tx.insert(userRateLimits)
          .values({ userId, resourceType, count: 1, windowStart: new Date() });
        return { allowed: true, currentCount: 1, limit: maxCount };
      }

      const elapsed = Date.now() - existing.windowStart.getTime();
      if (elapsed >= windowMs) {
        await tx.update(userRateLimits)
          .set({ count: 1, windowStart: new Date() })
          .where(eq(userRateLimits.id, existing.id));
        return { allowed: true, currentCount: 1, limit: maxCount };
      }

      if (existing.count >= maxCount) {
        return { allowed: false, currentCount: existing.count, limit: maxCount };
      }

      await tx.update(userRateLimits)
        .set({ count: existing.count + 1 })
        .where(eq(userRateLimits.id, existing.id));
      return { allowed: true, currentCount: existing.count + 1, limit: maxCount };
    });
  }

  async storeUserApiKeyRecord(userId: string, provider: string, keyHash: string, expiresAt: Date): Promise<UserApiKey> {
    const existing = await this.getUserApiKeyRecord(userId, provider);
    if (existing) {
      const [updated] = await db.update(userApiKeys)
        .set({ keyHash, expiresAt, createdAt: new Date() })
        .where(eq(userApiKeys.id, existing.id))
        .returning();
      return updated;
    }
    const [created] = await db.insert(userApiKeys)
      .values({ userId, provider, keyHash, expiresAt })
      .returning();
    return created;
  }

  async getUserApiKeyRecord(userId: string, provider: string): Promise<UserApiKey | null> {
    const [row] = await db.select().from(userApiKeys)
      .where(and(
        eq(userApiKeys.userId, userId),
        eq(userApiKeys.provider, provider),
        gte(userApiKeys.expiresAt, new Date()),
      ));
    return row ?? null;
  }

  async deleteExpiredApiKeys(): Promise<void> {
    await db.delete(userApiKeys).where(lte(userApiKeys.expiresAt, new Date()));
  }

  async createEthicsReport(report: InsertEthicsReport): Promise<EthicsReport> {
    const [created] = await db.insert(ethicsReports).values(report).returning();
    return created;
  }

  async getEthicsReportById(id: string): Promise<EthicsReport | undefined> {
    const [row] = await db.select().from(ethicsReports).where(eq(ethicsReports.id, id));
    return row;
  }

  async getEthicsReportsByProject(projectId: string): Promise<EthicsReport[]> {
    return db.select().from(ethicsReports).where(eq(ethicsReports.projectId, projectId)).orderBy(desc(ethicsReports.createdAt));
  }

  async getCompletedEthicsReportsByJournal(journalId: string): Promise<EthicsReport[]> {
    return db.select().from(ethicsReports)
      .where(and(eq(ethicsReports.journalId, journalId), eq(ethicsReports.status, "completed")))
      .orderBy(desc(ethicsReports.createdAt));
  }

  async getAllEthicsReports(): Promise<EthicsReport[]> {
    return db.select().from(ethicsReports).orderBy(desc(ethicsReports.createdAt));
  }

  async updateEthicsReport(id: string, updates: Partial<EthicsReport>): Promise<EthicsReport> {
    const [updated] = await db.update(ethicsReports).set(updates).where(eq(ethicsReports.id, id)).returning();
    return updated;
  }

  async deleteAllEthicsReports(): Promise<void> {
    await db.delete(ethicsReports);
  }

  async deleteEthicsReport(id: string): Promise<void> {
    await db.delete(ethicsReports).where(eq(ethicsReports.id, id));
  }

  async deleteLiteratureReview(id: string): Promise<void> {
    await db.delete(literatureReviews).where(eq(literatureReviews.id, id));
  }

  async resetAuditLockForJournal(journalId: string): Promise<number> {
    const updated = await db.update(ethicsReports)
      .set({ auditedPaperIds: [] as string[] })
      .where(eq(ethicsReports.journalId, journalId))
      .returning({ id: ethicsReports.id });
    return updated.length;
  }

  async getAuditedPaperIdsForJournal(journalId: string): Promise<string[]> {
    // Include ALL non-failed reports (pending, generating, completed) so the lock is held atomically
    // from the moment a report is created — preventing concurrent duplicate audits of the same paper.
    const rows = await db.select({ ids: ethicsReports.auditedPaperIds })
      .from(ethicsReports)
      .where(and(eq(ethicsReports.journalId, journalId), ne(ethicsReports.status, "failed")));
    const set = new Set<string>();
    for (const r of rows) for (const id of (r.ids || [])) set.add(id);
    return Array.from(set);
  }
}

export const storage = new DatabaseStorage();
