import { type User, type InsertUser, type Paper, type InsertPaper, type ResearchEvent, type InsertResearchEvent, users, papers, researchEvents } from "@shared/schema";
import { db } from "./db";
import { eq, desc, gte } from "drizzle-orm";

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
}

export const storage = new DatabaseStorage();