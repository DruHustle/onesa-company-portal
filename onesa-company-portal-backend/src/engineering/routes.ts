import {
  requestEngineeringLink,
  consumeEngineeringLink,
  engineeringPasswordAccount,
  engineeringLinkResendSeconds,
} from "../auth/access.js";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type { IncomingMessage } from "node:http";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { env } from "../config/env.js";
import { db, transaction, inTransaction } from "../services/db.js";
import { HttpError } from "../services/workflows.js";
import { reauthenticate } from "../auth/reauthenticate.js";
import { onesaSession } from "../auth/onesa-session.js";
import { lockAccountSession, type AccountSession } from "../identity/accounts.js";
import { engineeringCentralAccount, engineeringLinkChoice, engineeringProofSession, linkedEngineeringSession, sharedEngineeringEnabled } from "./onesa-account.js";
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
          200: z.object({ csrf: proof, emailSent: z.boolean(), linkResendSeconds: z.number().int().min(0).max(30), linkEmail: z.email().optional(), onesaAccount: z.object({email:z.email()}).optional(), onesaLink:z.object({email:z.email()}).optional(), onesaSignInPath:z.string().optional(), onesaReauthRequired:z.literal(true).optional() }),
          ...errors,
        },
      },
    },
    async (req, reply) => {
      await limits.limit("engineering-details:" + limits.address(req), 60, 900);
      const details = await interaction(req, reply);
      const { config } = configured();
      const session = await approvedOnesaSession(req, details);
      const linkChoice = await engineeringLinkChoice(req, config.externalEmails);
      const linked = sharedEngineeringEnabled() ? await linkedEngineeringSession(req, config.externalEmails) : null;
      const reauthRequired = Boolean(linked && !(await centralSessionFresh(details,linked.session)));
      const cookie = req.cookies[engineeringHandoffCookie];
      let linkEmail: string | undefined;
      if (cookie) {
        try { linkEmail = (await readEngineeringHandoff(cookie, env.PUBLIC_ORIGIN, config.externalEmails)).email; }
        catch (error) { reply.clearCookie(engineeringHandoffCookie, engineeringHandoffOptions); throw error; }
      }
      return {
        csrf: interactionProof(config, req.params.uid),
        emailSent: await challengeExists(req.params.uid),
        linkResendSeconds: await engineeringLinkResendSeconds(req.params.uid),
        ...(linkEmail ? { linkEmail } : {}),
        ...(session ? { onesaAccount: {email:session.email} } : {}),
        ...(linkChoice ? { onesaLink:linkChoice } : {}),
        ...(reauthRequired ? {onesaReauthRequired:true as const} : {}),
        ...(sharedEngineeringEnabled() ? { onesaSignInPath:"/account?returnTo="+encodeURIComponent("/engineering/sign-in/"+req.params.uid) } : {}),
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
    const details = await interaction(req, reply);
    const { config } = configured();
    if (!proofValid(config, (req.params as { uid: string }).uid, csrf))
      throw new HttpError(
        403,
        "ENGINEERING_PROOF",
        "Refresh the sign-in page.",
      );
    return {...configured(), details};
  };
  async function approvedOnesaSession(req: FastifyRequest, details: Awaited<ReturnType<NonNullable<typeof provider>["interactionDetails"]>>) {
    if (sharedEngineeringEnabled()) {
      const linked = config ? await linkedEngineeringSession(req, config.externalEmails) : null;
      if (!linked || !(await centralSessionFresh(details, linked.session))) return null;
      return {id:linked.session.account.id,email:linked.session.account.email,authenticated_at:new Date(linked.session.authenticatedAt*1000),membershipId:linked.membershipId,central:linked.session};
    }
    const session = await onesaSession(req);
    if (!session || !config || !engineeringEmailAllowed(session.email, config.externalEmails)) return null;
    // A forced reauthentication cannot be satisfied by a previously established session.
    if (String(details.params.prompt ?? "").split(" ").includes("login")) return null;
    const authenticatedAt = new Date(session.authenticated_at).getTime();
    if (!Number.isFinite(authenticatedAt) || authenticatedAt > Date.now()) return null;
    if (details.params.max_age !== undefined) {
      const maxAge = Number(details.params.max_age);
      if (!Number.isFinite(maxAge) || maxAge < 0 || (Date.now() - authenticatedAt) / 1000 >= maxAge) return null;
    }
    const membership = (await db.query<{id:string}>("SELECT m.id FROM engineering_memberships m WHERE m.email=$1 AND m.enabled AND NOT EXISTS(SELECT 1 FROM identity_engineering_links l WHERE l.membership_id=m.id)", [session.email])).rows[0];
    return membership ? {...session, membershipId:membership.id,central:null} : null;
  }
  async function centralSessionFresh(details: Awaited<ReturnType<NonNullable<typeof provider>["interactionDetails"]>>, session:AccountSession) {
    const now=Math.floor(Date.now()/1000),auth=session.authenticatedAt;
    if(!Number.isInteger(auth)||auth>now)return false;
    const forced=String(details.params.prompt??"").split(" ").includes("login");
    const maxAge=details.params.max_age===undefined?null:Number(details.params.max_age);
    if(maxAge!==null&&(!Number.isFinite(maxAge)||maxAge<0))return false;
    if(forced||maxAge===0){
      if(session.source!=="account")return false;
      // Compare actual proof and interaction times on one clock, never rounded JWT seconds.
      return Boolean((await db.query(
        "SELECT 1 FROM identity_sessions s JOIN engineering_identity_records i ON i.model='Interaction' AND i.id=$3 WHERE s.token_hash=$1 AND s.user_id=$2 AND s.expires_at>now() AND i.expires_at>now() AND s.authenticated_at>i.created_at",
        [session.sourceHash,session.account.id,details.uid],
      )).rowCount);
    }
    return maxAge===null||now-auth<maxAge;
  }
  api.post("/api/v1/engineering-sign-in/:uid/session", {
    logLevel: "silent",
    schema: {...meta("engineeringPortalSessionSignIn"), params, body:z.object({csrf:proof,rememberBrowser:z.boolean().default(false)}), response:{200:z.object({continuePath:z.string()}),...errors}},
  }, async (req, reply) => {
    const {details} = await verifiedInteraction(req,reply,req.body.csrf);
    await limits.limit("engineering-session:"+limits.address(req),10,900);
    return transaction(c=>inTransaction(c,async()=>{
      const linked=sharedEngineeringEnabled()&&config?await linkedEngineeringSession(req,config.externalEmails):null;
      if(linked&&!(await centralSessionFresh(details,linked.session)))throw new HttpError(403,"ONESA_REAUTH_REQUIRED","Sign in again to your Onesa account to confirm this request.");
      const session=await approvedOnesaSession(req,details);
      if(!session)throw new HttpError(401,"ONESA_SESSION_REQUIRED","Sign in to your approved Onesa account to continue. Engineering membership is required.");
      return finish(req,reply,session.membershipId,"mfa",Math.floor(new Date(session.authenticated_at).getTime()/1000),req.body.rememberBrowser,session.central);
    }));
  });
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
        body: z.object({ csrf: proof, code: z.string().regex(/^\d{6}$/), rememberBrowser: z.boolean().default(false) }),
        response: { 200: z.object({ continuePath: z.string() }), ...errors },
      },
    },
    async (req, reply) => {
      const { config } = await verifiedInteraction(req, reply, req.body.csrf);
      await limits.limit("engineering-code:" + limits.address(req), 30, 900);
      return finishProof(req, reply, () => consumeEngineeringChallenge(
        config, req.params.uid, req.body.code,
      ), "otp", req.body.rememberBrowser);
    },
  );
  async function finish(
    req: FastifyRequest,
    reply: FastifyReply,
    accountId: string,
    method = "otp",
    authenticatedAt?: number,
    rememberBrowser = false,
    central: AccountSession | null = null,
  ) {
    const { config, provider } = configured();
    const sourceExpires=central?await lockAccountSession(db,central):null;
    const membership=(await db.query("SELECT enabled FROM engineering_memberships WHERE id=$1 FOR SHARE",[accountId])).rows[0];
    if(!membership?.enabled)throw new HttpError(403,"ENGINEERING_ACCOUNT_PROOF","Engineering membership is required.");
    if(central){
      method=central.amr.includes("otp")?"mfa":"pwd";
      authenticatedAt=central.authenticatedAt;
    }
    const grant = new provider.Grant({ accountId, clientId: config.clientId });
    grant.addOIDCScope("openid email profile");
    const grantId = await grant.save();
    if(central)await db.query(
      "INSERT INTO identity_grant_sessions(grant_id,user_id,source_token_hash,source_kind,authenticated_at,amr,expires_at) VALUES($1,$2,$3,$4,to_timestamp($5),$6,$7)",
      [grantId,central.account.id,central.sourceHash,central.source,central.authenticatedAt,central.amr,sourceExpires],
    );
    const next = new URL(
      await provider.interactionResult(
        req.raw,
        reply.raw,
        { login: { accountId, remember: rememberBrowser, amr: [method], ...(authenticatedAt ? {ts:authenticatedAt} : {}) }, consent: { grantId } },
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
  async function finishProof(req:FastifyRequest,reply:FastifyReply,proofAccount:()=>Promise<string>,method:string,rememberBrowser:boolean,linkRequested=false){
    return transaction(c=>inTransaction(c,async()=>{
      // Keep account-before-membership ordering, including concurrent link redemption.
      const source=await engineeringCentralAccount(req);
      if(source)await lockAccountSession(c,source);
      const accountId=await proofAccount();
      const {config}=configured();
      const central=await engineeringProofSession(req,c,accountId,config.externalEmails,linkRequested);
      if(central&&!(await centralSessionFresh(await interaction(req,reply),central)))throw new HttpError(403,"ONESA_REAUTH_REQUIRED","Sign in again to your Onesa account to confirm this request.");
      return finish(req,reply,accountId,method,undefined,rememberBrowser,central);
    }));
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
          body: body.extend({rememberBrowser:z.boolean().default(false),...(action==="link"?{}:{linkOnesaAccount:z.boolean().default(false)})}),
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
          rememberBrowser: boolean;
          linkOnesaAccount?: boolean;
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
          return finishProof(
            req,
            reply,
            () => engineeringPasswordAccount(
              email,
              input.password!,
              config.externalEmails,
            ),
            "pwd",
            input.rememberBrowser,input.linkOnesaAccount,
          );
        }
        if (action === "handoff-verify") {
          const cookie = req.cookies[engineeringHandoffCookie];
          if (!cookie) throw new HttpError(401, "ACCESS_LINK", "Open your latest sign-in email link again.");
          let target:Awaited<ReturnType<typeof readEngineeringHandoff>>;
          try {target=await readEngineeringHandoff(cookie, env.PUBLIC_ORIGIN, config.externalEmails);}
          catch(error){reply.clearCookie(engineeringHandoffCookie, engineeringHandoffOptions);throw error;}
          // Keep the original bounded proof while central sign-in/freshness is recovered.
          const result=await finishProof(req, reply, () => consumeEngineeringLink(target.token, target.interaction, config.externalEmails), "email_link", input.rememberBrowser,input.linkOnesaAccount);
          reply.clearCookie(engineeringHandoffCookie, engineeringHandoffOptions);
          return result;
        }
        return finishProof(
          req,
          reply,
          () => consumeEngineeringLink(
            input.token!,
            req.params.uid,
            config.externalEmails,
          ),
          "email_link",
          input.rememberBrowser,input.linkOnesaAccount,
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
