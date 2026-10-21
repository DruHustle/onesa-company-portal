import {
  requestEngineeringLink,
  consumeEngineeringLink,
  engineeringPasswordAccount,
} from "../auth/access.js";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type { IncomingMessage } from "node:http";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { env } from "../config/env.js";
import { db, transaction } from "../services/db.js";
import { HttpError } from "../services/workflows.js";
import { reauthenticate } from "../auth/reauthenticate.js";
import type { Role } from "../access/roles.js";
import { error } from "../api/contracts.js";
import { createEngineeringProvider } from "./provider.js";
import { engineeringHandoffCookie, engineeringHandoffOptions, prepareEngineeringHandoff, readEngineeringHandoff } from "./link-handoff.js";
import {
  engineeringIdentityConfiguration,
  engineeringEmailAllowed,
  identityPath,
} from "./config.js";
import {
  interactionProof,
  proofValid,
  emailRateKey,
  beginEngineeringChallenge,
  consumeEngineeringChallenge,
  challengeExists,
} from "./challenges.js";
type Guard = (
  roles: readonly Role[],
) => (request: FastifyRequest) => Promise<void>;
type Limits = {
  limit: (key: string, max: number, seconds: number) => Promise<void>;
  address: (request: FastifyRequest) => string;
};
const uid = z.string().regex(/^[A-Za-z0-9_-]{8,128}$/),
  proof = z.string().regex(/^[a-f0-9]{64}$/);
const errors = {
  400: error,
  401: error,
  403: error,
  404: error,
  409: error,
  429: error,
  500: error,
  503: error,
};
const member = z.object({
  id: z.string().uuid(),
  email: z.email(),
  enabled: z.boolean(),
  access_policy_evidence: z.string(),
  approved_at: z.string(),
  revision: z.number().int(),
});
export async function registerEngineeringIdentity(
  app: FastifyInstance,
  allow: Guard,
  limits: Limits,
) {
  const api = app.withTypeProvider<ZodTypeProvider>(),
    config = engineeringIdentityConfiguration(process.env, env.PUBLIC_ORIGIN),
    provider = config ? createEngineeringProvider(config) : null;
  const configured = () => {
    if (!config || !provider)
      throw new HttpError(
        503,
        "ENGINEERING_SIGN_IN_UNAVAILABLE",
        "Engineering sign-in is not available yet.",
      );
    return { config, provider };
  };
  const meta = (operationId: string) => ({
    operationId,
    tags: ["Engineering access"],
    security: [],
    description:
      "INTERNAL documentation identity. No Portal administrator role is granted. Cookie-bound interaction and same-origin proof required.",
    hide: false,
  });
  async function interaction(req: FastifyRequest, reply: FastifyReply) {
    const { provider, config } = configured();
    let details: Awaited<ReturnType<typeof provider.interactionDetails>>;
    try {
      details = await provider.interactionDetails(req.raw, reply.raw);
    } catch {
      throw new HttpError(
        401,
        "ENGINEERING_INTERACTION",
        "Sign-in request is not active in this browser. Open your latest email link or return to Engineering Docs.",
      );
    }
    const requested = (req.params as { uid: string }).uid;
    if (
      details.uid !== requested ||
      details.params.client_id !== config.clientId ||
      !["login", "consent"].includes(details.prompt.name)
    )
      throw new HttpError(
        403,
        "ENGINEERING_INTERACTION",
        "Sign-in request is not active in this browser. Open your latest email link or return to Engineering Docs.",
      );
    return details;
  }
  if (provider && config) {
    const callback = provider.callback();
    api.all(
      identityPath + "/*",
      {
        logLevel: "silent",
        schema: { hide: true },
        onRequest: async (req, reply) => {
          const relative = req.url.slice(identityPath.length).split("?")[0],
            length = Number(req.headers["content-length"] || 0);
          if (
            !/^\/(?:\.well-known\/openid-configuration|jwks|auth(?:\/[A-Za-z0-9_-]{8,128})?|token|me)$/.test(
              relative,
            ) ||
            req.url.length > 8192 ||
            !Number.isInteger(length) ||
            length > 57344
          )
            throw new HttpError(
              400,
              "ENGINEERING_PROTOCOL",
              "Invalid sign-in request",
            );
          if (
            !env.PROXY_SHARED_KEY ||
            req.headers["x-portal-proxy-key"] !== env.PROXY_SHARED_KEY
          )
            throw new HttpError(
              403,
              "ENGINEERING_PROXY",
              "Use the Onesa Portal sign-in.",
            );
          const category = relative.startsWith("/auth")
            ? "auth"
            : relative === "/token"
              ? "token"
              : "read";
          await limits.limit(
            "engineering-protocol:" + category + ":" + limits.address(req),
            category === "auth" ? 30 : category === "token" ? 60 : 120,
            900,
          );
          const raw = req.raw as IncomingMessage & { originalUrl?: string };
          raw.originalUrl = raw.url;
          raw.url = req.url.slice(identityPath.length);
          raw.headers.host = new URL(config.issuer).host;
          delete raw.headers.forwarded;
          raw.headers["x-forwarded-host"] = new URL(config.issuer).host;
          raw.headers["x-forwarded-proto"] = "https";
          delete raw.headers["x-forwarded-for"];
          reply.hijack();
          callback(raw, reply.raw);
        },
      },
      async () => undefined,
    );
    provider.on("server_error", () =>
      app.log.error(
        { event: "engineering_identity_error", category: "provider_error" },
        "Engineering sign-in failed",
      ),
    );
  }
  const params = z.object({ uid });
  api.get(
    "/api/v1/engineering-sign-in/:uid/details",
    {
      logLevel: "silent",
      schema: {
        ...meta("engineeringSignInDetails"),
        params,
        response: {
          200: z.object({ csrf: proof, emailSent: z.boolean(), linkEmail: z.email().optional() }),
          ...errors,
        },
      },
    },
    async (req, reply) => {
      await limits.limit("engineering-details:" + limits.address(req), 60, 900);
      await interaction(req, reply);
      const { config } = configured();
      const cookie = req.cookies[engineeringHandoffCookie];
      let linkEmail: string | undefined;
      if (cookie) {
        try { linkEmail = (await readEngineeringHandoff(cookie, env.PUBLIC_ORIGIN, config.externalEmails)).email; }
        catch (error) { reply.clearCookie(engineeringHandoffCookie, engineeringHandoffOptions); throw error; }
      }
      return {
        csrf: interactionProof(config, req.params.uid),
        emailSent: await challengeExists(req.params.uid),
        ...(linkEmail ? { linkEmail } : {}),
      };
    },
  );
  api.post("/api/v1/engineering-sign-in/:uid/link-prepare", {
    logLevel: "silent",
    schema: { ...meta("prepareEngineeringSignInLink"), params,
      body: z.object({ token: z.string().regex(/^[a-f0-9]{64}$/) }),
      response: { 200: z.object({ continuePath: z.literal("/engineering") }), ...errors } },
  }, async (req, reply) => {
    const { config } = configured();
    if (req.headers.origin !== env.PUBLIC_ORIGIN || !env.PROXY_SHARED_KEY || req.headers["x-portal-proxy-key"] !== env.PROXY_SHARED_KEY)
      throw new HttpError(403, "ORIGIN", "Open the sign-in link on Onesa Portal.");
    await limits.limit("engineering-link-prepare:" + limits.address(req), 10, 900);
    const value = await prepareEngineeringHandoff(req.body.token, req.params.uid, env.PUBLIC_ORIGIN, config.externalEmails);
    reply.setCookie(engineeringHandoffCookie, value.cookie, { ...engineeringHandoffOptions, maxAge: value.maxAge });
    // Re-enter Access through the fixed canonical destination. This browser gets
    // its own fresh OIDC state/PKCE and interaction cookie; no old cookie is copied.
    return { continuePath: "/engineering" as const };
  });
  const verifiedInteraction = async (
    req: FastifyRequest,
    reply: FastifyReply,
    csrf: string,
  ) => {
    if (req.headers.origin !== env.PUBLIC_ORIGIN)
      throw new HttpError(403, "ORIGIN", "Use the Onesa Portal sign-in.");
    await interaction(req, reply);
    const { config } = configured();
    if (!proofValid(config, (req.params as { uid: string }).uid, csrf))
      throw new HttpError(
        403,
        "ENGINEERING_PROOF",
        "Refresh the sign-in page.",
      );
    return configured();
  };
  api.post(
    "/api/v1/engineering-sign-in/:uid/start",
    {
      logLevel: "silent",
      schema: {
        ...meta("engineeringSignInStart"),
        params,
        body: z.object({ csrf: proof, email: z.email().max(254) }),
        response: { 200: z.object({ ok: z.literal(true) }), ...errors },
      },
    },
    async (req, reply) => {
      const { config } = await verifiedInteraction(req, reply, req.body.csrf),
        email = req.body.email.toLowerCase();
      await limits.limit(
        "engineering-start-ip:" + limits.address(req),
        10,
        900,
      );
      await limits.limit(
        "engineering-start-email:" + emailRateKey(config, email),
        3,
        900,
      );
      await beginEngineeringChallenge(config, req.params.uid, email);
      return { ok: true as const };
    },
  );
  api.post(
    "/api/v1/engineering-sign-in/:uid/verify",
    {
      logLevel: "silent",
      schema: {
        ...meta("engineeringSignInVerify"),
        params,
        body: z.object({ csrf: proof, code: z.string().regex(/^\d{6}$/) }),
        response: { 200: z.object({ continuePath: z.string() }), ...errors },
      },
    },
    async (req, reply) => {
      const { config } = await verifiedInteraction(req, reply, req.body.csrf);
      await limits.limit("engineering-code:" + limits.address(req), 30, 900);
      const accountId = await consumeEngineeringChallenge(
        config,
        req.params.uid,
        req.body.code,
      );
      return finish(req, reply, accountId);
    },
  );
  async function finish(
    req: FastifyRequest,
    reply: FastifyReply,
    accountId: string,
    method = "otp",
  ) {
    const { config, provider } = configured();
    const grant = new provider.Grant({ accountId, clientId: config.clientId });
    grant.addOIDCScope("openid email profile");
    const grantId = await grant.save();
    const next = new URL(
      await provider.interactionResult(
        req.raw,
        reply.raw,
        { login: { accountId, amr: [method] }, consent: { grantId } },
        { mergeWithLastSubmission: false },
      ),
    );
    if (
      next.origin !== env.PUBLIC_ORIGIN ||
      !new RegExp("^" + identityPath + "/auth/[A-Za-z0-9_-]{8,128}$").test(
        next.pathname,
      ) ||
      next.search ||
      next.hash
    )
      throw new HttpError(
        500,
        "ENGINEERING_CONTINUE",
        "Sign-in could not be completed.",
      );
    return { continuePath: next.pathname };
  }
  for (const action of ["link", "link-verify", "handoff-verify", "password"] as const) {
    const body =
      action === "link"
        ? z.object({ csrf: proof, email: z.email().max(254) })
        : action === "handoff-verify"
          ? z.object({ csrf: proof })
        : action === "password"
          ? z.object({
              csrf: proof,
              email: z.email().max(254),
              password: z.string().min(1).max(256),
            })
          : z.object({
              csrf: proof,
              token: z.string().regex(/^[a-f0-9]{64}$/),
            });
    api.post(
      identityPath.replace("engineering-identity", "engineering-sign-in") +
        "/:uid/" +
        action,
      {
        logLevel: "silent",
        schema: {
          ...meta(
            {
              link: "requestEngineeringSignInLink",
              "link-verify": "verifyEngineeringSignInLink",
              "handoff-verify": "verifyEngineeringLinkHandoff",
              password: "engineeringPasswordSignIn",
            }[action],
          ),
          params,
          body,
          response: {
            200: z.union([
              z.object({ ok: z.literal(true) }),
              z.object({ continuePath: z.string() }),
            ]),
            ...errors,
          },
        },
      },
      async (req, reply) => {
        const input = req.body as {
          csrf: string;
          email?: string;
          password?: string;
          token?: string;
        };
        const { config } = await verifiedInteraction(req, reply, input.csrf);
        await limits.limit(
          "engineering-access-ip:" + limits.address(req),
          10,
          900,
        );
        if (action === "link") {
          const email = input.email!.toLowerCase();
          await limits.limit(
            "engineering-link-email:" + emailRateKey(config, email),
            3,
            3600,
          );
          await requestEngineeringLink(
            email,
            req.params.uid,
            config.externalEmails,
          );
          return { ok: true as const };
        }
        if (action === "password") {
          const email = input.email!.toLowerCase();
          await limits.limit(
            "engineering-password-email:" + emailRateKey(config, email),
            5,
            900,
          );
          return finish(
            req,
            reply,
            await engineeringPasswordAccount(
              email,
              input.password!,
              config.externalEmails,
            ),
            "pwd",
          );
        }
        if (action === "handoff-verify") {
          const cookie = req.cookies[engineeringHandoffCookie];
          reply.clearCookie(engineeringHandoffCookie, engineeringHandoffOptions);
          if (!cookie) throw new HttpError(401, "ACCESS_LINK", "Open your latest sign-in email link again.");
          const target = await readEngineeringHandoff(cookie, env.PUBLIC_ORIGIN, config.externalEmails);
          return finish(req, reply, await consumeEngineeringLink(target.token, target.interaction, config.externalEmails), "email_link");
        }
        return finish(
          req,
          reply,
          await consumeEngineeringLink(
            input.token!,
            req.params.uid,
            config.externalEmails,
          ),
          "email_link",
        );
      },
    );
  }

  const owner = allow(["owner"]),
    ownerMeta = (operationId: string) => ({
      ...meta(operationId),
      security: [{ sessionCookie: [] }],
      description:
        "INTERNAL. Existing Portal owner and fresh owner reauthentication for changes. Engineering membership grants no Portal role; Cloudflare exact-email authorization remains independently required.",
    });
  api.get(
    "/api/v1/admin/engineering/memberships",
    {
      schema: {
        ...ownerMeta("listEngineeringMemberships"),
        response: {
          200: z.object({ items: z.array(member), configured: z.boolean() }),
          ...errors,
        },
      },
      preHandler: owner,
    },
    async () => ({
      items: (
        await db.query(
          "SELECT id,email,enabled,access_policy_evidence,approved_at,revision FROM engineering_memberships ORDER BY email",
        )
      ).rows.map((r) => ({
        ...r,
        approved_at: new Date(r.approved_at).toISOString(),
      })),
      configured: config !== null,
    }),
  );
  api.put(
    "/api/v1/admin/engineering/memberships",
    {
      schema: {
        ...ownerMeta("saveEngineeringMembership"),
        body: z.object({
          email: z.email().max(254),
          enabled: z.boolean(),
          evidence: z.string().min(10).max(2000),
          expectedRevision: z.number().int().min(0),
          password: z.string().max(256),
          code: z.string().min(6).max(64),
        }),
        response: { 200: member, ...errors },
      },
      preHandler: owner,
    },
    async (req) => {
      const email = req.body.email.toLowerCase();
      if (
        req.body.enabled &&
        (!config || !engineeringEmailAllowed(email, config.externalEmails))
      )
        throw new HttpError(
          400,
          "ENGINEERING_EMAIL",
          "Use an approved individual Onesa email or existing approved external member.",
        );
      await limits.limit("engineering-membership:" + req.actor!.id, 10, 900);
      return transaction(async (client) => {
        const role = await reauthenticate(
          client,
          {
            userId: req.actor!.id,
            token: req.cookies.onesa_session!,
            csrf: req.actor!.csrf,
          },
          req.body,
        );
        if (role !== "owner")
          throw new HttpError(403, "FORBIDDEN", "Owner access is required.");
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended('engineering-member:'||$1,0))",
          [email],
        );
        const old = (
          await client.query(
            "SELECT id,revision FROM engineering_memberships WHERE email=$1 FOR UPDATE",
            [email],
          )
        ).rows[0];
        if ((old?.revision ?? 0) !== req.body.expectedRevision)
          throw new HttpError(
            409,
            "ENGINEERING_REVISION",
            "Membership changed. Refresh before retrying.",
          );
        const r = (
          await client.query(
            "INSERT INTO engineering_memberships(id,email,enabled,access_policy_evidence,approved_by) VALUES($1,$2,$3,$4,$5) ON CONFLICT(email) DO UPDATE SET enabled=EXCLUDED.enabled,access_policy_evidence=EXCLUDED.access_policy_evidence,approved_by=EXCLUDED.approved_by,approved_at=now(),revision=engineering_memberships.revision+1 RETURNING id,email,enabled,access_policy_evidence,approved_at,revision",
            [
              old?.id ?? randomUUID(),
              email,
              req.body.enabled,
              req.body.evidence,
              req.actor!.id,
            ],
          )
        ).rows[0];
        if (!req.body.enabled) {
          await client.query(
            "DELETE FROM access_links WHERE membership_id=$1",
            [r.id],
          );
          await client.query(
            "DELETE FROM engineering_email_challenges WHERE membership_id=$1",
            [r.id],
          );
          await client.query(
            "DELETE FROM engineering_identity_records WHERE account_id=$1",
            [r.id],
          );
        }
        await client.query(
          "INSERT INTO audit(actor_id,action,record_id,request_id) VALUES($1,$2,$3,$4)",
          [
            req.actor!.id,
            req.body.enabled
              ? "engineering.member_enabled"
              : "engineering.member_disabled",
            r.id,
            req.id,
          ],
        );
        return { ...r, approved_at: new Date(r.approved_at).toISOString() };
      });
    },
  );
}
