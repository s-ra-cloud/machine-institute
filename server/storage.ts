import { type User, type InsertUser, type Paper, type InsertPaper, users, papers } from "@shared/schema";
import { db } from "./db";
import { eq, desc } from "drizzle-orm";

export interface IStorage {
  getUser(id: string): Promise<User | undefined>;
  getUserByUsername(username: string): Promise<User | undefined>;
  createUser(user: InsertUser): Promise<User>;

  createPaper(paper: InsertPaper & { slug: string }): Promise<Paper>;
  getPaperById(id: string): Promise<Paper | undefined>;
  getPaperBySlug(slug: string): Promise<Paper | undefined>;
  getAllPapers(): Promise<Paper[]>;
  getPapersByType(type: string): Promise<Paper[]>;
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
}

export const storage = new DatabaseStorage();