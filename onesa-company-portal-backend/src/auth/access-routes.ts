import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { db, transaction } from "../services/db.js";
import { HttpError, normalize, enqueue } from "../services/workflows.js";
import { env } from "../config/env.js";
import { encrypt, hash } from "./crypto.js";
import { reauthenticate } from "./reauthenticate.js";
import type { Role } from "../access/roles.js";
import * as C from "../api/contracts.js";
import {
  engineeringEmailAllowed,
  engineeringIdentityConfiguration,
} from "../engineering/config.js";
import {
  accessConfiguration,
  confirmRegistration,
  consumeAdminLink,
  provisionAccess,
  requestAdminLink,
  requestRegistration,
} from "./access.js";

type Guard = (
  roles: readonly Role[],
) => (request: FastifyRequest) => Promise<void>;
type Limits = {
  limit: (key: string, max: number, seconds: number) => Promise<void>;
  address: (request: FastifyRequest) => string;
};
export async function registerAccess(
  app: FastifyInstance,
  allow: Guard,
  limits: Limits,
) {
  const api = app.withTypeProvider<ZodTypeProvider>(),
    config = accessConfiguration();
  const errors = {
    400: C.error,
    401: C.error,
    403: C.error,
    404: C.error,
    409: C.error,
    429: C.error,
    500: C.error,
    503: C.error,
  };
  const meta = (operationId: string) => ({
    operationId,
    tags: ["Access registration"],
    security: [],
    description:
      "INTERNAL Portal access. Email verification does not grant authorization. New registrations require owner approval; existing explicitly approved addresses retain that decision.",
  });
  const origin = async (req: FastifyRequest) => {
    if (!config)
      throw new HttpError(
        503,
        "ACCESS_UNAVAILABLE",
        "Registration and email-link sign-in are not available yet.",
      );
    if (req.headers.origin !== env.PUBLIC_ORIGIN)
      throw new HttpError(403, "ORIGIN", "Use the Onesa Portal.");
    await limits.limit("access-ip:" + limits.address(req), 20, 900);
  };
  api.post(
    "/api/v1/access/register",
    {
      logLevel: "silent",
      preHandler: origin,
      schema: {
        ...meta("requestAccessRegistration"),
        body: z.object({
          email: z.email().max(254),
          audience: z.enum(["admin", "engineering"]),
          name: z.string().trim().min(1).max(120),
        }),
        response: { 202: z.object({ ok: z.literal(true) }), ...errors },
      },
    },
    async (req, reply) => {
      const email = req.body.email.toLowerCase();
      await limits.limit(
        "access-registration-ip:" + limits.address(req),
        5,
        900,
      );
      await limits.limit("access-registration-email:" + hash(email), 3, 3600);
      await requestRegistration(
        config!,
        email,
        req.body.audience,
        req.body.name,
      );
      reply.code(202);
      return { ok: true as const };
    },
  );
  api.post(
    "/api/v1/access/confirm",
    {
      logLevel: "silent",
      preHandler: origin,
      schema: {
        ...meta("confirmAccessRegistration"),
        body: z.object({
          token: z.string().regex(/^[a-f0-9]{64}$/),
          password: z.string().min(14).max(256),
        }),
        response: {
          200: z.object({
            status: z.enum(["pending", "approved"]),
            audience: z.enum(["admin", "engineering"]),
          }),
          ...errors,
        },
      },
    },
    async (req) => {
      await limits.limit("access-confirm:" + limits.address(req), 10, 900);
      const engineering = engineeringIdentityConfiguration(
        process.env,
        env.PUBLIC_ORIGIN,
      );
      return confirmRegistration(
        config!,
        req.body.token,
        req.body.password,
        engineering?.externalEmails ?? [],
      );
    },
  );
  api.post(
    "/api/v1/access/link",
    {
      logLevel: "silent",
      preHandler: origin,
      schema: {
        ...meta("requestAdminSignInLink"),
        body: z.object({ email: z.email().max(254) }),
        response: { 202: z.object({ ok: z.literal(true) }), ...errors },
      },
    },
    async (req, reply) => {
      const email = req.body.email.toLowerCase();
      await limits.limit("access-link-ip:" + limits.address(req), 5, 900);
      await limits.limit("access-link-email:" + hash(email), 3, 3600);
      await requestAdminLink(email);
      reply.code(202);
      return { ok: true as const };
    },
  );
  api.post(
    "/api/v1/access/link/verify",
    {
      logLevel: "silent",
      preHandler: origin,
      schema: {
        ...meta("verifyAdminSignInLink"),
        body: z.object({
          token: z.string().regex(/^[a-f0-9]{64}$/),
          code: z.string().min(6).max(64),
        }),
        response: {
          200: z.object({ user: C.user, csrf: z.string() }),
          ...errors,
        },
      },
    },
    async (req, reply) => {
      const result = await consumeAdminLink(req.body.token, req.body.code);
      reply.setCookie("onesa_session", result.session, {
        httpOnly: true,
        secure: env.NODE_ENV === "production",
        sameSite: "strict",
        path: "/",
        maxAge: 28800,
      });
      return {
        user: normalize<z.infer<typeof C.user>>(result.user),
        csrf: result.csrf,
      };
    },
  );
  const item = z.object({
    id: z.uuid(),
    email: z.email(),
    audience: z.enum(["admin", "engineering"]),
    display_name: z.string(),
    state: z.enum(["pending", "approved", "rejected"]),
    revision: z.number().int(),
    created_at: z.string(),
    email_verified_at: z.string(),
    review_note: z.string(),
  });
  api.get(
    "/api/v1/admin/access/requests",
    {
      preHandler: allow(["owner"]),
      schema: {
        ...meta("listAccessRequests"),
        security: [{ sessionCookie: [] }],
        response: {
          200: z.object({ items: z.array(item), configured: z.boolean() }),
          ...errors,
        },
      },
    },
    async () => ({
      configured: config !== null,
      items: normalize<z.infer<typeof item>[]>(
        (
          await db.query(
            "SELECT id,email,audience,display_name,state,revision,created_at,email_verified_at,review_note FROM access_registrations WHERE state<>'unverified' ORDER BY created_at DESC LIMIT 200",
          )
        ).rows,
      ),
    }),
  );
  api.post(
    "/api/v1/admin/access/requests/:id/review",
    {
      preHandler: allow(["owner"]),
      schema: {
        ...meta("reviewAccessRequest"),
        security: [{ sessionCookie: [] }],
        params: z.object({ id: z.uuid() }),
        body: z.object({
          decision: z.enum(["approve", "reject"]),
          expectedRevision: z.number().int().positive(),
          evidence: z.string().min(10).max(2000),
          role: z
            .enum(["administrator", "editor", "business", "hr", "viewer"])
            .default("viewer"),
          password: z.string().max(256),
          code: z.string().min(6).max(64),
        }),
        response: { 200: z.object({ ok: z.literal(true) }), ...errors },
      },
    },
    async (req) => {
      if (!config)
        throw new HttpError(
          503,
          "ACCESS_UNAVAILABLE",
          "Access registration is not configured.",
        );
      await limits.limit("access-review:" + req.actor!.id, 10, 900);
      await transaction(async (c) => {
        if (
          (await reauthenticate(
            c,
            {
              userId: req.actor!.id,
              token: req.cookies.onesa_session!,
              csrf: req.actor!.csrf,
            },
            req.body,
          )) !== "owner"
        )
          throw new HttpError(403, "FORBIDDEN", "Owner access is required.");
        const r = (
          await c.query(
            "SELECT * FROM access_registrations WHERE id=$1 FOR UPDATE",
            [req.params.id],
          )
        ).rows[0];
        if (
          !r ||
          r.state !== "pending" ||
          !r.email_verified_at ||
          r.revision !== req.body.expectedRevision
        )
          throw new HttpError(
            409,
            "ACCESS_REVIEW",
            "The request changed or has already been reviewed.",
          );
        if (req.body.decision === "approve") {
          const engineering = engineeringIdentityConfiguration(
            process.env,
            env.PUBLIC_ORIGIN,
          );
          if (
            r.audience === "engineering" &&
            (!engineering ||
              !engineeringEmailAllowed(r.email, engineering.externalEmails))
          )
            throw new HttpError(
              409,
              "ACCESS_EMAIL_POLICY",
              "Verify the exact-email Docs access policy and eligible address before approval.",
            );
          await provisionAccess(
            c,
            r,
            req.actor!.id,
            req.body.evidence,
            req.body.role,
          );
        } else {
          await c.query(
            "UPDATE access_registrations SET state='rejected',password_hash=NULL,reviewed_by=$2,review_note=$3,revision=revision+1,updated_at=now() WHERE id=$1",
            [r.id, req.actor!.id, req.body.evidence],
          );
          await c.query(
            "INSERT INTO audit(actor_id,action,record_id) VALUES($1,'access.registration_rejected',$2)",
            [req.actor!.id, r.id],
          );
        }
        await enqueue(c, "access-decision:" + r.id, {
          to: r.email,
          subject: "Your Onesa access request",
          encryptedText: encrypt(
            req.body.decision === "approve"
              ? (r.audience === "admin"
                  ? "Your administrator access has been approved. Set up your authenticator, then sign in:\n" + env.PUBLIC_ORIGIN + "/access/setup-authenticator"
                  : "Your Engineering Docs access has been approved. Sign in through Onesa Portal:\n" + env.PUBLIC_ORIGIN + "/engineering")
              : "Your access request has not been approved. Contact Onesa if you need clarification.",
          ),
        });
      });
      return { ok: true as const };
    },
  );
}
