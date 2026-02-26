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