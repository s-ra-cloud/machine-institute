import express, { type Request, Response, NextFunction } from "express";
import cookieParser from "cookie-parser";
import { registerRoutes } from "./routes";
import { serveStatic } from "./static";
import { seedDatabase } from "./seed";
import { setupAuth } from "./auth";
import { db } from "./db";
import { researchEvents, literatureReviews, editorials, ethicsReports } from "@shared/schema";
import { inArray, sql, eq, or } from "drizzle-orm";
import { createServer } from "http";

const app = express();
const httpServer = createServer(app);

declare module "http" {
  interface IncomingMessage {
    rawBody: unknown;
  }
}

app.use(cookieParser());

// Body limit raised from the 100kb default because generation endpoints
// (peer reviews, ethics reports, editorials, literature reviews) accept
// 1–3 full system prompts in the same payload. The peer-review POST in
// particular carries prompt1+prompt2+prompt3 (each many KB) and was
// crossing the 100kb default, which made Express return its default HTML
// 413 page — the client then surfaced it as the cryptic
// `Unexpected token '<', "<!doctype "... is not valid JSON` error
// because the request never reached the route handler.
app.use(
  express.json({
    limit: "10mb",
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);

app.use(express.urlencoded({ extended: false, limit: "10mb" }));

export function log(message: string, source = "express") {
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });

  console.log(`${formattedTime} [${source}] ${message}`);
}

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  let capturedJsonResponse: Record<string, any> | undefined = undefined;

  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      if (capturedJsonResponse) {
        logLine += ` :: ${JSON.stringify(capturedJsonResponse)}`;
      }

      log(logLine);
    }
  });

  next();
});

(async () => {
  setupAuth(app);
  await registerRoutes(httpServer, app);

  try {
    await seedDatabase();
  } catch (err) {
    console.error("Seed failed (non-fatal):", err);
  }

  try {
    await db.execute(sql`ALTER TABLE literature_reviews ADD COLUMN IF NOT EXISTS content_markdown TEXT`);
  } catch (err) {
    console.error("Schema migration (content_markdown) failed (non-fatal):", err);
  }

  try {
    await db.execute(sql`ALTER TYPE peer_review_persona ADD VALUE IF NOT EXISTS 'rR'`);
  } catch (err) {
    console.error("Schema migration (peer_review_persona += rR) failed (non-fatal):", err);
  }

  try {
    const stuckLRs = await db
      .update(literatureReviews)
      .set({ status: "failed", contentHtml: "<p>Generation interrupted by server restart. Please try again.</p>" })
      .where(eq(literatureReviews.status, "generating"))
      .returning({ id: literatureReviews.id });
    if (stuckLRs.length > 0) {
      console.log(`Marked ${stuckLRs.length} stuck literature review(s) as failed on startup.`);
    }
    const stuckEDs = await db
      .update(editorials)
      .set({ status: "failed" })
      .where(eq(editorials.status, "generating"))
      .returning({ id: editorials.id });
    if (stuckEDs.length > 0) {
      console.log(`Marked ${stuckEDs.length} stuck editorial(s) as failed on startup.`);
    }
    const stuckERs = await db
      .update(ethicsReports)
      .set({ status: "failed", contentHtml: "<p>Generation interrupted by server restart. Please try again.</p>" })
      .where(or(eq(ethicsReports.status, "generating"), eq(ethicsReports.status, "pending")))
      .returning({ id: ethicsReports.id });
    if (stuckERs.length > 0) {
      console.log(`Marked ${stuckERs.length} stuck ethics report(s) as failed on startup.`);
    }
  } catch (err) {
    console.error("Stuck generation cleanup failed (non-fatal):", err);
  }

  try {
    const BAD_SOURCES = ["Sacha Raoult", "LiteratureReview"];
    const purged = await db.delete(researchEvents).where(inArray(researchEvents.source, BAD_SOURCES)).returning({ id: researchEvents.id });
    if (purged.length > 0) {
      console.log(`Purged ${purged.length} research event(s) with non-convention source names.`);
    }
  } catch (err) {
    console.error("Research event source purge failed (non-fatal):", err);
  }

  try {
    const updated = await db
      .update(researchEvents)
      .set({ message: sql`replace(${researchEvents.message}, 'Retrieved from Future Science', 'Published on Future Science')` })
      .where(eq(researchEvents.phase, "publication-sync"))
      .returning({ id: researchEvents.id });
    if (updated.length > 0) {
      console.log(`Updated ${updated.length} publication sync event(s) to new wording.`);
    }
  } catch (err) {
    console.error("Research event wording update failed (non-fatal):", err);
  }

  app.use((err: any, _req: Request, res: Response, next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";

    console.error("Internal Server Error:", err);

    if (res.headersSent) {
      return next(err);
    }

    return res.status(status).json({ message });
  });

  // importantly only setup vite in development and after
  // setting up all the other routes so the catch-all route
  // doesn't interfere with the other routes
  if (process.env.NODE_ENV === "production") {
    serveStatic(app);
  } else {
    const { setupVite } = await import("./vite");
    await setupVite(httpServer, app);
  }

  // ALWAYS serve the app on the port specified in the environment variable PORT
  // Other ports are firewalled. Default to 5000 if not specified.
  // this serves both the API and the client.
  // It is the only port that is not firewalled.
  const port = parseInt(process.env.PORT || "5000", 10);
  httpServer.listen(
    {
      port,
      host: "0.0.0.0",
      reusePort: true,
    },
    () => {
      log(`serving on port ${port}`);
    },
  );
})();
