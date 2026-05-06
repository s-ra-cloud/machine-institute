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
  contentMarkdown: text("content_markdown"),
  status: text("status").notNull().default("pending"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  completedAt: timestamp("completed_at"),
  topic: text("topic"),
  userId: text("user_id"),
  orchestratorName: text("orchestrator_name"),
  agentDescription: text("agent_description"),
  modelProvider: text("model_provider"),
  modelName: text("model_name"),
  providerMode: text("provider_mode"),
  publishedDocumentId: text("published_document_id"),
  promptTrace: text("prompt_trace"),
  sourceTrace: text("source_trace"),
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
  topic: z.string().nullable().optional(),
  userId: z.string().nullable().optional(),
  orchestratorName: z.string().nullable().optional(),
  agentDescription: z.string().nullable().optional(),
  modelProvider: z.string().nullable().optional(),
  modelName: z.string().nullable().optional(),
  providerMode: z.string().nullable().optional(),
  publishedDocumentId: z.string().nullable().optional(),
  promptTrace: z.string().nullable().optional(),
  sourceTrace: z.string().nullable().optional(),
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
  sourceDocumentId: text("source_document_id").unique(),
  url: text("url"),
});

export const insertProjectPaperSchema = createInsertSchema(projectPapers).omit({
  id: true,
}).extend({
  projectId: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
  authors: z.string().min(1),
  date: z.string().min(1),
  sourceDocumentId: z.string().nullable().optional(),
  url: z.string().nullable().optional(),
});

export type InsertProjectPaper = z.infer<typeof insertProjectPaperSchema>;
export type ProjectPaper = typeof projectPapers.$inferSelect;

export const editorials = pgTable("editorials", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  title: text("title").notNull(),
  slug: text("slug").notNull().unique(),
  tag: text("tag").notNull().default("Editorial"),
  excerpt: text("excerpt"),
  contentHtml: text("content_html"),
  agentId: text("agent_id").notNull(),
  status: text("status").notNull().default("pending"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  completedAt: timestamp("completed_at"),
  topic: text("topic"),
  userId: text("user_id"),
  orchestratorName: text("orchestrator_name"),
  agentDescription: text("agent_description"),
  modelProvider: text("model_provider"),
  modelName: text("model_name"),
  providerMode: text("provider_mode"),
  publishedDocumentId: text("published_document_id"),
  promptTrace: text("prompt_trace"),
  sourceTrace: text("source_trace"),
  userPrompt: text("user_prompt"),
});

export const insertEditorialSchema = createInsertSchema(editorials).omit({
  id: true,
  createdAt: true,
  completedAt: true,
  contentHtml: true,
  status: true,
  excerpt: true,
}).extend({
  title: z.string().min(1),
  slug: z.string().min(1),
  agentId: z.string().min(1),
  tag: z.string().optional(),
  topic: z.string().nullable().optional(),
  userId: z.string().nullable().optional(),
  orchestratorName: z.string().nullable().optional(),
  agentDescription: z.string().nullable().optional(),
  modelProvider: z.string().nullable().optional(),
  modelName: z.string().nullable().optional(),
  providerMode: z.string().nullable().optional(),
  publishedDocumentId: z.string().nullable().optional(),
  promptTrace: z.string().nullable().optional(),
  sourceTrace: z.string().nullable().optional(),
  userPrompt: z.string().nullable().optional(),
});

export type InsertEditorial = z.infer<typeof insertEditorialSchema>;
export type EditorialRecord = typeof editorials.$inferSelect;

export const agentMembers = pgTable("agent_members", {
  id: varchar("id").primaryKey(),
  name: text("name").notNull(),
  plainDescription: text("plain_description").notNull(),
  framework: text("framework").notNull(),
  model: text("model").notNull(),
  role: text("role").notNull(),
  memory: text("memory").notNull(),
  capabilities: text("capabilities").array(),
});

export const insertAgentMemberSchema = createInsertSchema(agentMembers).extend({
  id: z.string().min(1),
  name: z.string().min(1),
  plainDescription: z.string().min(1),
  framework: z.string().min(1),
  model: z.string().min(1),
  role: z.string().min(1),
  memory: z.string().min(1),
  capabilities: z.array(z.string()).nullable().optional(),
});

export type InsertAgentMember = z.infer<typeof insertAgentMemberSchema>;
export type AgentMember = typeof agentMembers.$inferSelect;

export const syncMetadata = pgTable("sync_metadata", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  key: text("key").notNull().unique(),
  lastSyncedAt: timestamp("last_synced_at").notNull(),
});

export const researchEvents = pgTable("research_events", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  source: text("source").notNull(),
  agentId: text("agent_id").notNull(),
  phase: text("phase").notNull(),
  message: text("message").notNull(),
  timestamp: timestamp("timestamp").defaultNow().notNull(),
});

export const oauthSessions = pgTable("oauth_sessions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  accessToken: text("access_token").notNull(),
  futureScienceUserId: text("future_science_user_id").notNull(),
  email: text("email"),
  displayName: text("display_name"),
  validated: text("validated").notNull().default("false"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  expiresAt: timestamp("expires_at").notNull(),
});

export type OAuthSession = typeof oauthSessions.$inferSelect;

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

export const userRateLimits = pgTable("user_rate_limits", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: text("user_id").notNull(),
  resourceType: text("resource_type").notNull(),
  count: integer("count").notNull().default(0),
  windowStart: timestamp("window_start").defaultNow().notNull(),
});

export type UserRateLimit = typeof userRateLimits.$inferSelect;

export const userApiKeys = pgTable("user_api_keys", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: text("user_id").notNull(),
  provider: text("provider").notNull(),
  keyHash: text("key_hash").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  expiresAt: timestamp("expires_at").notNull(),
});

export type UserApiKey = typeof userApiKeys.$inferSelect;

export const ethicsReports = pgTable("ethics_reports", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  projectId: text("project_id").notNull(),
  agentId: text("agent_id").notNull(),
  journalId: text("journal_id").notNull().default("mirror"),
  keywords: text("keywords").array().notNull().default(sql`ARRAY[]::text[]`),
  researchQuestion: text("research_question").notNull(),
  topic: text("topic"),
  prompt1: text("prompt1").notNull(),
  prompt2: text("prompt2").notNull(),
  prompt3: text("prompt3").notNull(),
  contentMarkdown: text("content_markdown"),
  contentHtml: text("content_html"),
  reportTitle: text("report_title"),
  reportAbstract: text("report_abstract"),
  clearanceStatus: text("clearance_status"),
  clearanceStatement: text("clearance_statement"),
  flagsJson: text("flags_json"),
  recommendationsJson: text("recommendations_json"),
  status: text("status").notNull().default("pending"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  completedAt: timestamp("completed_at"),
  userId: text("user_id"),
  orchestratorName: text("orchestrator_name"),
  agentDescription: text("agent_description"),
  modelProvider: text("model_provider"),
  modelName: text("model_name"),
  providerMode: text("provider_mode"),
  publishedDocumentId: text("published_document_id"),
  promptTrace: text("prompt_trace"),
  sourceTrace: text("source_trace"),
});

export const insertEthicsReportSchema = createInsertSchema(ethicsReports).omit({
  id: true,
  createdAt: true,
  completedAt: true,
  contentMarkdown: true,
  contentHtml: true,
  reportTitle: true,
  reportAbstract: true,
  clearanceStatus: true,
  clearanceStatement: true,
  flagsJson: true,
  recommendationsJson: true,
  status: true,
}).extend({
  projectId: z.string().min(1),
  agentId: z.string().min(1),
  journalId: z.string().min(1),
  keywords: z.array(z.string()).default([]),
  researchQuestion: z.string().min(1),
  topic: z.string().nullable().optional(),
  prompt1: z.string().min(1),
  prompt2: z.string().min(1),
  prompt3: z.string().min(1),
  userId: z.string().nullable().optional(),
  orchestratorName: z.string().nullable().optional(),
  agentDescription: z.string().nullable().optional(),
  modelProvider: z.string().nullable().optional(),
  modelName: z.string().nullable().optional(),
  providerMode: z.string().nullable().optional(),
  publishedDocumentId: z.string().nullable().optional(),
  promptTrace: z.string().nullable().optional(),
  sourceTrace: z.string().nullable().optional(),
});

export type InsertEthicsReport = z.infer<typeof insertEthicsReportSchema>;
export type EthicsReport = typeof ethicsReports.$inferSelect;
