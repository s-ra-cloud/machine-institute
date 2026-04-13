import type { Express, Request, Response, NextFunction } from "express";
import { db } from "./db";
import { oauthSessions } from "@shared/schema";
import { eq } from "drizzle-orm";
import crypto from "crypto";

const FS_AUTHORIZE_URL = "https://future-science.org/api/v1/oauth/authorize";
const FS_TOKEN_URL = "https://future-science.org/api/v1/oauth/token";
const FS_USERINFO_URL = "https://future-science.org/api/v1/oauth/userinfo";

function getRedirectUri(req: Request): string {
  const protocol = req.headers["x-forwarded-proto"] || req.protocol;
  const host = req.headers["x-forwarded-host"] || req.get("host");
  return `${protocol}://${host}/api/auth/callback`;
}

export function setupAuth(app: Express) {
  app.get("/api/auth/login", (req: Request, res: Response) => {
    const state = crypto.randomBytes(16).toString("hex");
    const redirectUri = getRedirectUri(req);

    const params = new URLSearchParams({
      response_type: "code",
      client_id: process.env.OAUTH_CLIENT_ID || "machine-institute",
      redirect_uri: redirectUri,
      state,
      scope: "openid profile email",
    });

    res.cookie("oauth_state", state, {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      maxAge: 600_000,
    });

    res.redirect(`${FS_AUTHORIZE_URL}?${params.toString()}`);
  });

  app.get("/api/auth/callback", async (req: Request, res: Response) => {
    try {
      const { code, state } = req.query;
      const savedState = req.cookies?.oauth_state;

      if (!code || typeof code !== "string") {
        return res.redirect("/?auth_error=no_code");
      }

      if (state !== savedState) {
        return res.redirect("/?auth_error=state_mismatch");
      }

      res.clearCookie("oauth_state");

      const redirectUri = getRedirectUri(req);
      const tokenRes = await fetch(FS_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: redirectUri,
          client_id: process.env.OAUTH_CLIENT_ID || "machine-institute",
          client_secret: process.env.OAUTH_CLIENT_SECRET || "",
        }),
      });

      if (!tokenRes.ok) {
        console.error("Token exchange failed:", tokenRes.status, await tokenRes.text());
        return res.redirect("/?auth_error=token_failed");
      }

      const tokenData = await tokenRes.json();
      const accessToken = tokenData.access_token;

      if (!accessToken) {
        return res.redirect("/?auth_error=no_token");
      }

      const userInfoRes = await fetch(FS_USERINFO_URL, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      if (!userInfoRes.ok) {
        console.error("Userinfo failed:", userInfoRes.status, await userInfoRes.text());
        return res.redirect("/?auth_error=userinfo_failed");
      }

      const userInfo = await userInfoRes.json();

      const sessionId = crypto.randomBytes(32).toString("hex");
      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

      await db.insert(oauthSessions).values({
        id: sessionId,
        accessToken,
        futureScienceUserId: userInfo.sub || userInfo.id || "unknown",
        email: userInfo.email || null,
        displayName: userInfo.name || userInfo.display_name || null,
        validated: String(userInfo.validated === true || userInfo.validated === "true"),
        expiresAt,
      });

      res.cookie("session_id", sessionId, {
        httpOnly: true,
        secure: true,
        sameSite: "lax",
        maxAge: 24 * 60 * 60 * 1000,
        path: "/",
      });

      res.redirect("/");
    } catch (err) {
      console.error("OAuth callback error:", err);
      res.redirect("/?auth_error=server_error");
    }
  });

  app.get("/api/auth/me", async (req: Request, res: Response) => {
    try {
      const sessionId = req.cookies?.session_id;
      if (!sessionId) {
        return res.json({ authenticated: false });
      }

      const [session] = await db
        .select()
        .from(oauthSessions)
        .where(eq(oauthSessions.id, sessionId))
        .limit(1);

      if (!session || new Date(session.expiresAt) < new Date()) {
        if (session) {
          await db.delete(oauthSessions).where(eq(oauthSessions.id, sessionId));
        }
        res.clearCookie("session_id");
        return res.json({ authenticated: false });
      }

      return res.json({
        authenticated: true,
        validated: session.validated === "true",
        user: {
          id: session.futureScienceUserId,
          email: session.email,
          displayName: session.displayName,
        },
      });
    } catch (err) {
      console.error("Auth check error:", err);
      return res.json({ authenticated: false });
    }
  });

  app.post("/api/auth/logout", async (req: Request, res: Response) => {
    try {
      const sessionId = req.cookies?.session_id;
      if (sessionId) {
        await db.delete(oauthSessions).where(eq(oauthSessions.id, sessionId));
      }
      res.clearCookie("session_id");
      return res.json({ success: true });
    } catch (err) {
      console.error("Logout error:", err);
      return res.json({ success: true });
    }
  });
}

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const sessionId = req.cookies?.session_id;
  if (!sessionId) {
    return res.status(401).json({ error: "Authentication required" });
  }

  const [session] = await db
    .select()
    .from(oauthSessions)
    .where(eq(oauthSessions.id, sessionId))
    .limit(1);

  if (!session || new Date(session.expiresAt) < new Date()) {
    return res.status(401).json({ error: "Session expired" });
  }

  if (session.validated !== "true") {
    return res.status(403).json({ error: "Account not validated on Future Science" });
  }

  (req as any).user = {
    id: session.futureScienceUserId,
    email: session.email,
    displayName: session.displayName,
  };

  next();
}

const ADMIN_EMAIL = "sacharaoult@gmail.com";

export async function adminAuth(req: Request, res: Response, next: NextFunction) {
  const sessionId = req.cookies?.session_id;
  if (!sessionId) return res.status(401).json({ error: "Authentication required" });

  const [session] = await db
    .select()
    .from(oauthSessions)
    .where(eq(oauthSessions.id, sessionId))
    .limit(1);

  if (!session || new Date(session.expiresAt) < new Date()) {
    return res.status(401).json({ error: "Session expired" });
  }

  if (session.email !== ADMIN_EMAIL) {
    return res.status(403).json({ error: "Forbidden" });
  }

  (req as any).user = {
    id: session.futureScienceUserId,
    email: session.email,
    displayName: session.displayName,
  };

  next();
}

export async function optionalAuth(req: Request, _res: Response, next: NextFunction) {
  try {
    const sessionId = req.cookies?.session_id;
    if (!sessionId) return next();

    const [session] = await db
      .select()
      .from(oauthSessions)
      .where(eq(oauthSessions.id, sessionId))
      .limit(1);

    if (session && new Date(session.expiresAt) >= new Date() && session.validated === "true") {
      (req as any).user = {
        id: session.futureScienceUserId,
        email: session.email,
        displayName: session.displayName,
      };
    }
  } catch (err) {
    console.error("optionalAuth: session lookup failed:", err);
  }
  next();
}
