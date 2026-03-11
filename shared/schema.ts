import { sql } from "drizzle-orm";
import { pgTable, text, varchar, timestamp, integer, pgEnum } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const users = pgTable("users", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  username: text("username").notNull().unique(),
  password: text("password").notNull(),
});

export const insertUserSchema = createInsertSchema(users).pick({
  username: true,
  password: true,
});

export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof users.$inferSelect;

export const paperTypeEnum = pgEnum("paper_type", ["article", "review", "revision"]);

export const papers = pgTable("papers", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  title: text("title").notNull(),
  subtitle: text("subtitle"),
  type: paperTypeEnum("type").notNull().default("article"),
  linkedPaperId: varchar("linked_paper_id"),
  abstract: text("abstract").notNull(),
  language: text("language").notNull().default("English"),
  keywords: text("keywords").array().notNull(),
  copyright: text("copyright"),
  license: text("license"),
  authorFirstName: text("author_first_name").notNull(),
  authorLastName: text("author_last_name").notNull(),
  authorInstitution: text("author_institution").notNull(),
  authorEmail: text("author_email").notNull(),
  contentHtml: text("content_html"),
  fileUrl: text("file_url"),
  slug: text("slug").notNull().unique(),
  publishedAt: timestamp("published_at").defaultNow().notNull(),
});

export const insertPaperSchema = createInsertSchema(papers).omit({
  id: true,
  slug: true,
  publishedAt: true,
}).extend({
  keywords: z.array(z.string()).min(3, "At least 3 keywords required"),
  title: z.string().min(1, "Title is required"),
  abstract: z.string().min(1, "Abstract is required"),
  language: z.string().min(1, "Language is required"),
  authorFirstName: z.string().min(1, "Author first name is required"),
  authorLastName: z.string().min(1, "Author last name is required"),
  authorInstitution: z.string().min(1, "Author institution is required"),
  authorEmail: z.string().email("Valid email is required"),
  type: z.enum(["article", "review", "revision"]),
  linkedPaperId: z.string().nullable().optional(),
});

export type InsertPaper = z.infer<typeof insertPaperSchema>;
export type Paper = typeof papers.$inferSelect;

export const literatureReviews = pgTable("literature_reviews", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  projectId: text("project_id").notNull(),
  agentId: text("agent_id").notNull(),
  researchQuestion: text("research_question").notNull(),
  prompt: text("prompt").notNull(),
  contentHtml: text("content_html"),
  status: text("status").notNull().default("pending"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  completedAt: timestamp("completed_at"),
});

export const insertLiteratureReviewSchema = createInsertSchema(literatureReviews).omit({
  id: true,
  createdAt: true,
  completedAt: true,
  contentHtml: true,
  status: true,
}).extend({
  projectId: z.string().min(1),
  agentId: z.string().min(1),
  researchQuestion: z.string().min(10, "Research question must be at least 10 characters"),
  prompt: z.string().min(1),
});

export type InsertLiteratureReview = z.infer<typeof insertLiteratureReviewSchema>;
export type LiteratureReview = typeof literatureReviews.$inferSelect;

export const projectPapers = pgTable("project_papers", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  projectId: text("project_id").notNull(),
  title: text("title").notNull(),
  description: text("description").notNull(),
  authors: text("authors").notNull(),
  date: text("date").notNull(),
  type: text("type").notNull().default("article"),
});

export const insertProjectPaperSchema = createInsertSchema(projectPapers).omit({
  id: true,
}).extend({
  projectId: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
  authors: z.string().min(1),
  date: z.string().min(1),
});

export type InsertProjectPaper = z.infer<typeof insertProjectPaperSchema>;
export type ProjectPaper = typeof projectPapers.$inferSelect;

export const researchEvents = pgTable("research_events", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  source: text("source").notNull(),
  agentId: text("agent_id").notNull(),
  phase: text("phase").notNull(),
  message: text("message").notNull(),
  timestamp: timestamp("timestamp").defaultNow().notNull(),
});

export const insertResearchEventSchema = createInsertSchema(researchEvents).omit({
  id: true,
  timestamp: true,
}).extend({
  source: z.string().min(1, "Source is required"),
  agentId: z.string().min(1, "Agent ID is required"),
  phase: z.string().min(1, "Phase is required"),
  message: z.string().min(1, "Message is required"),
});

export type InsertResearchEvent = z.infer<typeof insertResearchEventSchema>;
export type ResearchEvent = typeof researchEvents.$inferSelect;