import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type { IncomingMessage } from "node:http";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { db, transaction, inTransaction } from "../services/db.js";
import { env } from "../config/env.js";
import { error } from "../api/contracts.js";
import { HttpError, enqueue } from "../services/workflows.js";
import {
  decrypt,
  encrypt,
  hash,
  passwordHash,
  passwordValid,
  token,
  validStep,
} from "../auth/crypto.js";
import {
  setSessionCookie,
  clearSessionCookies,
} from "../auth/session-cookie.js";
import { reauthenticate } from "../auth/reauthenticate.js";
import { type Role } from "../access/roles.js";
import {
  accountCookie,
  accountAccess,
  currentAccount,
  identityAccount,
  isGlobalAdmin,
  requireAccount,
  revokeAccountIdentity,
  lockAccountSession,
  liveGrantSession,
  type AccountSession,
} from "./accounts.js";
import {
  identityConfiguration,
  identityPath,
  products,
  mobileRoles,
  defaultProductRole,
  validProductRole,
  productRequiresMfa,
  type IdentityClient,
  type Product,
} from "./config.js";
import { createIdentityProvider } from "./provider.js";
import { catalogProducts, identityCatalog } from "./catalog.js";

type Guard = (
  roles: readonly Role[],
) => (request: FastifyRequest) => Promise<void>;
type Limits = {
  limit: (key: string, max: number, seconds: number) => Promise<void>;
  address: (request: FastifyRequest) => string;
};
const failures = {
  400: error,
  401: error,
  403: error,
  404: error,
  409: error,
  429: error,
  500: error,
  503: error,
};
const proof = z.string().regex(/^[a-f0-9]{64}$/);
const uid = z.string().regex(/^[A-Za-z0-9_-]{8,128}$/);
const product = z.enum(products);
const stepUp = z.object({
  password: z.string().min(1).max(256),
  code: z.string().min(6).max(64),
});
const credentials = z.object({
  email: z.email().max(254),
  password: z.string().min(1).max(256),
  code: z.string().max(64).default(""),
  rememberBrowser: z.boolean().default(false),
});
const accountSchema = z.object({
  id: z.uuid(),
  email: z.email(),
  name: z.string(),
  globalAdmin: z.boolean(),
  owner: z.boolean(),
  portalAccess: z.boolean(),
  emailVerified: z.boolean(),
  mfaEnrolled: z.boolean(),
});
const accessSchema = z.object({
  product,
  role: z.string(),
  status: z.enum(["pending", "active", "revoked", "rejected"]),
  revision: z.number().int(),
});
const membershipSchema = z.object({
  tenant_id: z.uuid(),
  role: z.enum(["viewer", "operator", "admin"]),
  label: z.string().min(1).max(120),
});
const applicationSchema = z.object({ product, url: z.url() });
const catalogSchema = z.object({ product: z.enum(catalogProducts), name: z.string(), connected: z.boolean() });
const sessionSchema = z.object({
  account: accountSchema,
  csrf: proof,
  access: z.array(accessSchema),
  memberships: z.array(membershipSchema),
  applications: z.array(applicationSchema),
  catalog: z.array(catalogSchema),
});
const dummyPassword = passwordHash("unusable-shared-account-timing-fixture");
const cookieOptions = () => ({
  path: "/",
  httpOnly: true,
  sameSite: "lax" as const,
  secure: env.NODE_ENV === "production",
});
const safeAccount = (account: AccountSession["account"]) => ({
  id: account.id,
  email: account.email,
  name: account.display_name,
  globalAdmin: isGlobalAdmin(account.role),
  owner: account.role === "owner",
  portalAccess: account.role !== "member",
  emailVerified: Boolean(account.email_verified_at),
  mfaEnrolled: account.mfa_enrolled,
});
function same(a: string, b: string) {
  const left = Buffer.from(a),
    right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export async function registerIdentity(
  app: FastifyInstance,
  allow: Guard,
  limits: Limits,
) {
  const api = app.withTypeProvider<ZodTypeProvider>();
  const config = identityConfiguration(process.env, env.PUBLIC_ORIGIN);
  const provider = config ? createIdentityProvider(config) : null;
  const configured = () => {
    if (!config || !provider)
      throw new HttpError(
        503,
        "IDENTITY_UNAVAILABLE",
        "Shared Onesa sign-in is not available yet.",
      );
    return { config, provider };
  };
  // Existing three products retain their behavior; Mobile is opt-in per client.
  const requireMobileConfigured = (selected: string) => {
    const { config } = configured();
    if (
      selected === "mobile" &&
      !config.clients.some((client) => client.product === "mobile")
    )
      throw new HttpError(
        503,
        "PRODUCT_UNAVAILABLE",
        "This product is not configured for shared sign-in.",
      );
  };
  const meta = (operationId: string, authenticated = false) => ({
    operationId,
    tags: ["Onesa account"],
    security: authenticated
      ? ([{ identityAccountCookie: [] }, { sessionCookie: [] }] as Record<
          string,
          string[]
        >[])
      : [],
    description:
      "Shared identity and explicit product access. No product data or physical-control permission is granted by registration.",
  });
  async function snapshot(session: AccountSession) {
    const { access, memberships } = await accountAccess(session.account);
    return {
      account: safeAccount(session.account),
      csrf: session.csrf,
      access,
      memberships,
      catalog: identityCatalog(config),
      applications:
        config?.clients.map((c) => ({
          product: c.product,
          url: c.applicationUrl,
        })) ?? [],
    };
  }
  function clientAuthentication(req: FastifyRequest): IdentityClient {
    const { config } = configured();
    const header = req.headers.authorization;
    if (
      !header ||
      header.length > 2048 ||
      !/^Basic [A-Za-z0-9+/]+={0,2}$/.test(header)
    )
      throw new HttpError(
        401,
        "IDENTITY_CLIENT",
        "Client authentication required.",
      );
    let id = "",
      secret = "";
    try {
      const raw = Buffer.from(header.slice(6), "base64").toString("utf8"),
        index = raw.indexOf(":");
      if (index < 1) throw Error();
      id = decodeURIComponent(raw.slice(0, index).replaceAll("+", " "));
      secret = decodeURIComponent(raw.slice(index + 1).replaceAll("+", " "));
    } catch {
      throw new HttpError(
        401,
        "IDENTITY_CLIENT",
        "Client authentication required.",
      );
    }
    const client = config.clients.find((c) => c.clientId === id);
    if (!client || !same(hash(secret), hash(client.clientSecret)))
      throw new HttpError(
        401,
        "IDENTITY_CLIENT",
        "Client authentication required.",
      );
    return client;
  }
  // The authenticated assertion endpoint is separate from browser OIDC routes.
  // It resolves live grants; no app treats an unchecked ID token as identity evidence.
  api.post(
    identityPath + "/session",
    {
      logLevel: "silent",
      bodyLimit: 4096,
      schema: {
        ...meta("validateOnesaIdentity"),
        security: [{ identityClient: [] }],
        body: z.object({ token: z.string().min(16).max(2048) }).strict(),
        response: {
          200: z.discriminatedUnion("active", [
            z.object({ active: z.literal(false) }),
            z.object({
              active: z.literal(true),
              iss: z.url(),
              aud: z.string(),
              sub: z.uuid(),
              email: z.email(),
              email_verified: z.literal(true),
              name: z.string().min(1).max(200),
              exp: z.number().int(),
              auth_time: z.number().int(),
              amr: z.array(z.string()),
              onesa_roles: z.array(z.literal("global_admin")),
              onesa_applications: z.array(product),
              onesa_product_roles: z.object({
                ai: z.enum(["user", "admin"]).optional(),
                drone: z.enum(["viewer", "operator", "admin"]).optional(),
                robot: z.enum(["viewer", "operator", "admin"]).optional(),
                mobile: z.enum(mobileRoles).optional(),
              }),
              onesa_memberships: z.array(
                membershipSchema
                  .omit({ label: true })
                  .extend({ product: z.literal("drone") }),
              ),
            }),
          ]),
          ...failures,
        },
      },
    },
    async (req) => {
      const client = clientAuthentication(req),
        { provider, config } = configured();
      await limits.limit(
        "identity-session:" + client.clientId + ":" + limits.address(req),
        3000,
        60,
      );
      const accessToken = await provider.AccessToken.find(req.body.token);
      if (
        !accessToken ||
        accessToken.isExpired ||
        accessToken.clientId !== client.clientId ||
        !accessToken.accountId ||
        !accessToken.grantId ||
        !accessToken.sessionUid
      )
        return { active: false as const };
      const [grant, session, account, source] = await Promise.all([
        provider.Grant.find(accessToken.grantId),
        provider.Session.findByUid(accessToken.sessionUid),
        identityAccount(accessToken.accountId),
        liveGrantSession(accessToken.grantId, accessToken.accountId),
      ]);
      const extra = accessToken.extra as
        { auth_time?: number; amr?: string[] } | undefined;
      const now = Math.floor(Date.now() / 1000);
      if (
        !grant ||
        grant.isExpired ||
        grant.accountId !== accessToken.accountId ||
        grant.clientId !== client.clientId ||
        !session ||
        session.accountId !== accessToken.accountId ||
        session.grantIdFor(client.clientId) !== accessToken.grantId ||
        !account?.email_verified_at ||
        !source ||
        source.authenticatedAt !== extra?.auth_time ||
        !Number.isInteger(extra?.auth_time) ||
        extra!.auth_time! > now ||
        now - extra!.auth_time! >= 28800 ||
        !Array.isArray(extra?.amr) ||
        JSON.stringify(extra.amr) !== JSON.stringify(source.amr)
      )
        return { active: false as const };
      if (
        isGlobalAdmin(account.role) &&
        !extra!.amr!.some((method) => method === "otp" || method === "mfa")
      )
        return { active: false as const };
      const {
        onesa_roles,
        onesa_applications,
        onesa_product_roles,
        onesa_memberships,
      } = await accountAccess(account);
      // Legacy consumers reject unknown product names. Mobile receives the expanded
      // vocabulary; existing product assertions retain their three-product contract.
      const claims = {
        onesa_roles,
        onesa_applications:
          client.product === "mobile"
            ? onesa_applications
            : onesa_applications.filter((name) => name !== "mobile"),
        onesa_product_roles:
          client.product === "mobile"
            ? onesa_product_roles
            : Object.fromEntries(
                Object.entries(onesa_product_roles).filter(
                  ([name]) => name !== "mobile",
                ),
              ),
        onesa_memberships,
      };
      if (!claims.onesa_applications.includes(client.product))
        return { active: false as const };
      if (
        productRequiresMfa(
          client.product,
          claims.onesa_product_roles[client.product],
        ) &&
        !source.amr.includes("otp")
      )
        return { active: false as const };
      return {
        active: true as const,
        iss: config.issuer,
        aud: client.clientId,
        sub: account.id,
        email: account.email,
        email_verified: true as const,
        name: account.display_name,
        exp: Math.min(
          accessToken.exp!,
          extra!.auth_time! + 28800,
          source.expiresAt,
        ),
        auth_time: extra!.auth_time,
        amr: extra!.amr,
        ...claims,
      };
    },
  );
  api.post(
    identityPath + "/revoke",
    {
      logLevel: "silent",
      bodyLimit: 4096,
      schema: {
        ...meta("revokeOnesaIdentity"),
        security: [{ identityClient: [] }],
        body: z
          .object({
            token: z.string().min(16).max(2048),
            all_sessions: z.boolean().default(false),
          })
          .strict(),
        response: {
          200: z.object({
            ok: z.literal(true),
            all_sessions_revoked: z.boolean(),
          }),
          ...failures,
        },
      },
    },
    async (req) => {
      const client = clientAuthentication(req),
        { provider } = configured();
      await limits.limit(
        "identity-revoke:" + client.clientId + ":" + limits.address(req),
        60,
        60,
      );
      const accessToken = await provider.AccessToken.find(req.body.token);
      let allSessionsRevoked = false;
      if (
        accessToken &&
        !accessToken.isExpired &&
        accessToken.clientId === client.clientId
      ) {
        if (
          req.body.all_sessions &&
          accessToken.accountId &&
          accessToken.grantId
        )
          allSessionsRevoked = await transaction(async (c) => {
            await c.query(
              "SELECT id FROM users WHERE id=$1 FOR NO KEY UPDATE",
              [accessToken.accountId],
            );
            // Provider adapters use this transaction's connection: concurrent
            // revocations must not exhaust the pool while holding account locks.
            const [currentToken, grant, session] = await inTransaction(c, () =>
              Promise.all([
                provider.AccessToken.find(req.body.token),
                provider.Grant.find(accessToken.grantId!),
                accessToken.sessionUid
                  ? provider.Session.findByUid(accessToken.sessionUid)
                  : undefined,
              ]),
            );
            if (
              !currentToken ||
              currentToken.isExpired ||
              currentToken.accountId !== accessToken.accountId ||
              currentToken.grantId !== accessToken.grantId ||
              currentToken.clientId !== client.clientId ||
              !grant ||
              grant.isExpired ||
              grant.accountId !== accessToken.accountId ||
              grant.clientId !== client.clientId ||
              !session ||
              session.accountId !== accessToken.accountId ||
              session.grantIdFor(client.clientId) !== accessToken.grantId
            )
              return false;
            if (
              !(await liveGrantSession(
                accessToken.grantId!,
                accessToken.accountId!,
                c,
              ))
            )
              return false;
            await revokeAccountIdentity(c, accessToken.accountId!);
            await c.query("DELETE FROM sessions WHERE user_id=$1", [
              accessToken.accountId,
            ]);
            await c.query(
              "INSERT INTO audit(actor_id,action) VALUES($1,'identity.signed_out_everywhere')",
              [accessToken.accountId],
            );
            return true;
          });
        else await accessToken.destroy();
      }
      return { ok: true as const, all_sessions_revoked: allSessionsRevoked };
    },
  );

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
            length > 16384
          )
            throw new HttpError(
              400,
              "IDENTITY_PROTOCOL",
              "Invalid sign-in request.",
            );
          if (
            !env.PROXY_SHARED_KEY ||
            req.headers["x-portal-proxy-key"] !== env.PROXY_SHARED_KEY
          )
            throw new HttpError(
              403,
              "IDENTITY_PROXY",
              "Use Onesa account sign-in.",
            );
          await limits.limit(
            "identity-protocol:" + limits.address(req),
            240,
            900,
          );
          const raw = req.raw as IncomingMessage & { originalUrl?: string };
          raw.originalUrl = raw.url;
          raw.url = req.url.slice(identityPath.length);
          raw.headers.host = new URL(config.issuer).host;
          delete raw.headers.forwarded;
          delete raw.headers["x-forwarded-for"];
          raw.headers["x-forwarded-host"] = new URL(config.issuer).host;
          raw.headers["x-forwarded-proto"] = "https";
          reply.hijack();
          callback(raw, reply.raw);
        },
      },
      async () => undefined,
    );
    provider.on("server_error", () =>
      app.log.error(
        { event: "onesa_identity_error", category: "provider_error" },
        "Onesa sign-in failed",
      ),
    );
  }

  api.get(
    "/api/v1/account/config",
    {
      schema: {
        ...meta("onesaAccountConfiguration"),
        response: {
          200: z.object({
            enabled: z.boolean(),
            applications: z.array(applicationSchema),
            catalog: z.array(catalogSchema),
          }),
          ...failures,
        },
      },
    },
    async () => ({
      enabled: Boolean(config),
      catalog: identityCatalog(config),
      applications:
        config?.clients.map((c) => ({
          product: c.product,
          url: c.applicationUrl,
        })) ?? [],
    }),
  );
  api.get(
    "/api/v1/account/me",
    {
      schema: {
        ...meta("onesaAccount", true),
        response: { 200: sessionSchema, ...failures },
      },
    },
    async (req) => {
      configured();
      return snapshot(await requireAccount(req));
    },
  );

  api.post(
    "/api/v1/account/register",
    {
      logLevel: "silent",
      schema: {
        ...meta("registerOnesaAccount"),
        body: z
          .object({
            email: z.email().max(254),
            name: z.string().trim().min(1).max(200),
            products: z.array(product).min(1).max(4),
          })
          .strict(),
        response: { 202: z.object({ ok: z.literal(true) }), ...failures },
      },
    },
    async (req, reply) => {
      configured();
      for (const requested of req.body.products)
        requireMobileConfigured(requested);
      const email = req.body.email.toLowerCase();
      await limits.limit(
        "identity-registration-ip:" + limits.address(req),
        10,
        3600,
      );
      await limits.limit("identity-registration-email:" + hash(email), 3, 3600);
      await transaction(async (c) => {
        await c.query(
          "SELECT pg_advisory_xact_lock(hashtextextended('identity-register:'||$1,0))",
          [email],
        );
        const existing = (
          await c.query("SELECT id,disabled FROM users WHERE email=$1", [email])
        ).rows[0];
        if (existing?.disabled) return;
        const raw = token();
        await c.query(
          "UPDATE identity_registration_links SET consumed_at=now() WHERE email=$1 AND consumed_at IS NULL",
          [email],
        );
        await c.query(
          "INSERT INTO identity_registration_links(token_hash,email,display_name,products,existing_user_id,expires_at) VALUES($1,$2,$3,$4,$5,now()+interval '15 minutes')",
          [
            hash(raw),
            email,
            req.body.name,
            JSON.stringify([...new Set(req.body.products)]),
            existing?.id ?? null,
          ],
        );
        await enqueue(c, "identity-registration:" + hash(raw), {
          to: email,
          subject: "Verify your Onesa account",
          encryptedText: encrypt(
            "Verify your email for your single Onesa account:\n" +
              env.PUBLIC_ORIGIN +
              "/account/confirm#access-link=" +
              raw +
              "\nThis one-use link expires in 15 minutes. Confirm with your existing Onesa password if you already have an account. Product access is approved separately; this link grants no Administrator role. If you did not request it, ignore it.",
          ),
        });
      });
      reply.code(202);
      return { ok: true as const };
    },
  );
  api.post(
    "/api/v1/account/confirm",
    {
      logLevel: "silent",
      schema: {
        ...meta("confirmOnesaAccount"),
        body: z
          .object({ token: proof, password: z.string().min(1).max(256) })
          .strict(),
        response: { 200: z.object({ ok: z.literal(true) }), ...failures },
      },
    },
    async (req) => {
      configured();
      await limits.limit("identity-confirm:" + limits.address(req), 10, 900);
      await transaction(async (c) => {
        const target = (
          await c.query(
            "SELECT email FROM identity_registration_links WHERE token_hash=$1",
            [hash(req.body.token)],
          )
        ).rows[0];
        if (!target)
          throw new HttpError(
            401,
            "IDENTITY_LINK",
            "This verification link is invalid or expired.",
          );
        await c.query(
          "SELECT pg_advisory_xact_lock(hashtextextended('identity-register:'||$1,0))",
          [target.email],
        );
        const link = (
          await c.query(
            "SELECT * FROM identity_registration_links WHERE token_hash=$1 AND consumed_at IS NULL AND expires_at>now() FOR UPDATE",
            [hash(req.body.token)],
          )
        ).rows[0];
        if (!link)
          throw new HttpError(
            401,
            "IDENTITY_LINK",
            "This verification link is invalid or expired.",
          );
        let user = (
          await c.query("SELECT * FROM users WHERE email=$1 FOR UPDATE", [
            link.email,
          ])
        ).rows[0];
        if (user) {
          if (
            user.disabled ||
            user.id !== link.existing_user_id ||
            !passwordValid(req.body.password, user.password_hash)
          )
            throw new HttpError(
              401,
              "IDENTITY_LINK",
              "Confirm using your existing Onesa account password. No password has been changed.",
            );
        } else {
          if (link.existing_user_id || req.body.password.length < 14)
            throw new HttpError(
              400,
              "IDENTITY_PASSWORD",
              "Choose a password with at least 14 characters.",
            );
          user = (
            await c.query(
              "INSERT INTO users(id,email,password_hash,role) VALUES($1,$2,$3,'member') RETURNING *",
              [randomUUID(), link.email, passwordHash(req.body.password)],
            )
          ).rows[0];
        }
        await c.query(
          "INSERT INTO identity_profiles(user_id,display_name,email_verified_at) VALUES($1,$2,now()) ON CONFLICT(user_id) DO UPDATE SET email_verified_at=coalesce(identity_profiles.email_verified_at,EXCLUDED.email_verified_at)",
          [user.id, link.display_name],
        );
        for (const selected of link.products as string[])
          await c.query(
            "INSERT INTO identity_product_access(user_id,product,role) VALUES($1,$2,$3) ON CONFLICT(user_id,product) DO NOTHING",
            [user.id, selected, defaultProductRole(selected as Product)],
          );
        await c.query(
          "UPDATE identity_registration_links SET consumed_at=now() WHERE email=$1 AND consumed_at IS NULL",
          [link.email],
        );
        await c.query(
          "INSERT INTO audit(actor_id,action,request_id) VALUES($1,'identity.email_verified',$2)",
          [user.id, req.id],
        );
      });
      return { ok: true as const };
    },
  );

  async function authenticate(
    req: FastifyRequest,
    reply: FastifyReply,
    input: z.infer<typeof credentials>,
    mfaRequired: boolean,
  ): Promise<AccountSession> {
    const email = input.email.toLowerCase();
    await limits.limit("identity-login-ip:" + limits.address(req), 15, 900);
    await limits.limit("identity-login-email:" + hash(email), 10, 900);
    const candidate = (
      await db.query("SELECT * FROM users WHERE email=$1 AND NOT disabled", [
        email,
      ])
    ).rows[0];
    if (
      !passwordValid(
        input.password,
        candidate?.password_hash ?? dummyPassword,
      ) ||
      !candidate
    )
      throw new HttpError(
        401,
        "CREDENTIALS",
        "Unable to sign in with these credentials.",
      );
    const previous = await currentAccount(req);
    const raw = token(),
      csrf = token();
    const result = await transaction(async (c) => {
      // A simultaneous A→B and B→A switch must acquire account locks in one order.
      await c.query(
        "SELECT id FROM users WHERE id=ANY($1::uuid[]) ORDER BY id FOR NO KEY UPDATE",
        [
          [
            ...new Set([
              candidate.id,
              ...(previous ? [previous.account.id] : []),
            ]),
          ],
        ],
      );
      const user = (
        await c.query(
          "SELECT * FROM users WHERE id=$1 AND NOT disabled FOR NO KEY UPDATE",
          [candidate.id],
        )
      ).rows[0];
      if (!user || user.password_hash !== candidate.password_hash)
        throw new HttpError(
          401,
          "CREDENTIALS",
          "Unable to sign in with these credentials.",
        );
      const account = await identityAccount(user.id, c);
      if (!account?.email_verified_at)
        throw new HttpError(
          403,
          "EMAIL_VERIFICATION_REQUIRED",
          "Verify your Onesa account email before continuing. Your existing password will be retained.",
        );
      const accessRoles = (await accountAccess(account, c)).onesa_product_roles;
      const needsMfa =
        mfaRequired ||
        account.role !== "member" ||
        account.mfa_enrolled ||
        Object.entries(accessRoles).some(([product, role]) =>
          productRequiresMfa(product, role),
        );
      const amr = ["pwd"];
      if (needsMfa) {
        if (!user.mfa_secret)
          throw new HttpError(
            403,
            "MFA_ENROLLMENT_REQUIRED",
            "Set up your Onesa authenticator before continuing.",
          );
        if (!input.code)
          throw new HttpError(
            401,
            "MFA_REQUIRED",
            "Enter your authenticator code or an unused recovery code.",
          );
        const step = validStep(
          decrypt(user.mfa_secret),
          input.code,
          Number(user.mfa_last_step),
        );
        if (step === null) {
          if (
            !(
              await c.query(
                "DELETE FROM mfa_recovery WHERE user_id=$1 AND code_hash=$2 RETURNING user_id",
                [user.id, hash(input.code)],
              )
            ).rowCount
          )
            throw new HttpError(
              401,
              "MFA",
              "Unable to confirm your authenticator code.",
            );
        } else
          await c.query("UPDATE users SET mfa_last_step=$1 WHERE id=$2", [
            step,
            user.id,
          ]);
        amr.push("otp");
      }
      if (previous) {
        if (previous.account.id === account.id) {
          // Rotate the browser credential while retaining other product sessions.
          // Their original authentication time, factors and expiry NEVER refresh.
          await c.query(
            "UPDATE identity_grant_sessions SET source_token_hash=$3,source_kind='account' WHERE source_token_hash=$1 AND user_id=$2",
            [previous.sourceHash, previous.account.id, hash(raw)],
          );
        } else {
          await c.query(
            "DELETE FROM identity_grant_sessions WHERE source_token_hash=$1 AND user_id=$2",
            [previous.sourceHash, previous.account.id],
          );
        }
        await c.query(
          "DELETE FROM identity_sessions WHERE token_hash=$1 AND user_id=$2",
          [previous.sourceHash, previous.account.id],
        );
        await c.query(
          "DELETE FROM sessions WHERE token_hash=$1 AND user_id=$2",
          [previous.sourceHash, previous.account.id],
        );
      }
      const authenticated = (await c.query(
        "INSERT INTO identity_sessions(token_hash,user_id,csrf,authenticated_at,amr,expires_at) VALUES($1,$2,$3,clock_timestamp(),$4,now()+interval '8 hours') RETURNING authenticated_at",
        [hash(raw), user.id, csrf, amr],
      )).rows[0];
      const authenticatedAt=Math.floor(new Date(authenticated.authenticated_at).getTime()/1000);
      if (account.role !== "member")
        await c.query(
          "INSERT INTO sessions(token_hash,user_id,csrf,expires_at) VALUES($1,$2,$3,now()+interval '8 hours')",
          [hash(raw), user.id, csrf],
        );
      await c.query(
        "INSERT INTO audit(actor_id,action,request_id) VALUES($1,'identity.login',$2)",
        [user.id, req.id],
      );
      return {
        account,
        csrf,
        authenticatedAt,
        amr,
        source: "account" as const,
        sourceHash: hash(raw),
      };
    });
    reply.setCookie(accountCookie, raw, {
      ...cookieOptions(),
      ...(input.rememberBrowser ? { maxAge: 28800 } : {}),
    });
    reply.clearCookie("onesa_identity_session", { path: "/" });
    reply.clearCookie("onesa_identity_session.sig", { path: "/" });
    if (result.account.role === "member") clearSessionCookies(reply);
    if (result.account.role !== "member")
      setSessionCookie(
        reply,
        raw,
        input.rememberBrowser,
        result.authenticatedAt * 1000,
      );
    return result;
  }
  api.post(
    "/api/v1/account/login",
    {
      logLevel: "silent",
      schema: {
        ...meta("signInOnesaAccount"),
        body: credentials,
        response: { 200: sessionSchema, ...failures },
      },
    },
    async (req, reply) => {
      configured();
      return snapshot(await authenticate(req, reply, req.body, false));
    },
  );
  api.post(
    "/api/v1/account/logout",
    {
      schema: {
        ...meta("signOutOnesaAccount", true),
        body: z.object({}),
        response: { 200: z.object({ ok: z.literal(true) }), ...failures },
      },
    },
    async (req, reply) => {
      configured();
      const session = await requireAccount(req, true);
      await transaction(async (c) => {
        await lockAccountSession(c, session);
        await revokeAccountIdentity(c, session.account.id);
        await c.query("DELETE FROM sessions WHERE user_id=$1", [
          session.account.id,
        ]);
        await c.query(
          "INSERT INTO audit(actor_id,action,request_id) VALUES($1,'identity.signed_out_everywhere',$2)",
          [session.account.id, req.id],
        );
      });
      reply.clearCookie(accountCookie, cookieOptions());
      clearSessionCookies(reply);
      return { ok: true as const };
    },
  );
  api.post(
    "/api/v1/account/password/request",
    {
      logLevel: "silent",
      schema: {
        ...meta("requestOnesaPasswordReset"),
        body: z.object({ email: z.email().max(254) }),
        response: { 202: z.object({ ok: z.literal(true) }), ...failures },
      },
    },
    async (req, reply) => {
      configured();
      const email = req.body.email.toLowerCase();
      await limits.limit(
        "identity-password-reset-ip:" + limits.address(req),
        5,
        3600,
      );
      await limits.limit(
        "identity-password-reset-email:" + hash(email),
        3,
        3600,
      );
      await transaction(async (c) => {
        const user = (
          await c.query(
            "SELECT id,email FROM users WHERE email=$1 AND NOT disabled FOR NO KEY UPDATE",
            [email],
          )
        ).rows[0];
        if (!user) return;
        const raw = token();
        await c.query("DELETE FROM recovery_tokens WHERE user_id=$1", [
          user.id,
        ]);
        await c.query(
          "INSERT INTO recovery_tokens(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '30 minutes')",
          [hash(raw), user.id],
        );
        await enqueue(c, "identity-password-reset:" + hash(raw), {
          to: user.email,
          subject: "Reset your Onesa password",
          encryptedText: encrypt(
            "Reset the password for your single Onesa account:\n" +
              env.PUBLIC_ORIGIN +
              "/account/security#access-link=" +
              raw +
              "\nThis one-use link expires in 30 minutes. MFA remains required where enabled. Existing sessions will end after the password is changed. If you did not request this, ignore it.",
          ),
        });
      });
      reply.code(202);
      return { ok: true as const };
    },
  );
  api.post(
    "/api/v1/account/password/change",
    {
      logLevel: "silent",
      schema: {
        ...meta("changeOnesaPassword", true),
        body: z.object({
          currentPassword: z.string().min(1).max(256),
          password: z.string().min(14).max(256),
          code: z.string().max(64).default(""),
        }),
        response: { 200: z.object({ ok: z.literal(true) }), ...failures },
      },
    },
    async (req, reply) => {
      configured();
      const session = await requireAccount(req, true);
      await limits.limit(
        "identity-password-change:" + session.account.id,
        5,
        900,
      );
      if (req.body.currentPassword === req.body.password)
        throw new HttpError(
          400,
          "PASSWORD_UNCHANGED",
          "Choose a different password.",
        );
      await transaction(async (c) => {
        await lockAccountSession(c, session);
        const user = (
          await c.query(
            "SELECT * FROM users WHERE id=$1 AND NOT disabled FOR NO KEY UPDATE",
            [session.account.id],
          )
        ).rows[0];
        if (
          !user ||
          !passwordValid(req.body.currentPassword, user.password_hash)
        )
          throw new HttpError(
            403,
            "STEP_UP_FAILED",
            "Unable to confirm your credentials.",
          );
        if (user.mfa_secret) {
          const step = validStep(
            decrypt(user.mfa_secret),
            req.body.code,
            Number(user.mfa_last_step),
          );
          if (step === null) {
            if (
              !(
                await c.query(
                  "DELETE FROM mfa_recovery WHERE user_id=$1 AND code_hash=$2 RETURNING user_id",
                  [user.id, hash(req.body.code)],
                )
              ).rowCount
            )
              throw new HttpError(
                403,
                "STEP_UP_FAILED",
                "Confirm with a fresh authenticator or unused recovery code.",
              );
          } else
            await c.query("UPDATE users SET mfa_last_step=$1 WHERE id=$2", [
              step,
              user.id,
            ]);
        }
        await c.query("UPDATE users SET password_hash=$1 WHERE id=$2", [
          passwordHash(req.body.password),
          user.id,
        ]);
        await c.query("DELETE FROM sessions WHERE user_id=$1", [user.id]);
        await c.query("DELETE FROM recovery_tokens WHERE user_id=$1", [
          user.id,
        ]);
        await c.query(
          "INSERT INTO audit(actor_id,action,request_id) VALUES($1,'identity.password_changed',$2)",
          [user.id, req.id],
        );
      });
      reply.clearCookie(accountCookie, cookieOptions());
      clearSessionCookies(reply);
      return { ok: true as const };
    },
  );
  api.post(
    "/api/v1/account/products/:product/request",
    {
      schema: {
        ...meta("requestOnesaProductAccess", true),
        params: z.object({ product }),
        body: z.object({}),
        response: { 200: sessionSchema, ...failures },
      },
    },
    async (req) => {
      requireMobileConfigured(req.params.product);
      const session = await requireAccount(req, true);
      if (!session.account.email_verified_at)
        throw new HttpError(
          403,
          "EMAIL_VERIFICATION_REQUIRED",
          "Verify your email first.",
        );
      await limits.limit(
        "identity-product-request:" + session.account.id,
        10,
        3600,
      );
      await transaction(async (c) => {
        await lockAccountSession(c, session);
        await c.query(
          "INSERT INTO identity_product_access(user_id,product,role) VALUES($1,$2,$3) ON CONFLICT(user_id,product) DO UPDATE SET status='pending',revision=identity_product_access.revision+1,updated_at=now() WHERE identity_product_access.status IN ('rejected','revoked')",
          [
            session.account.id,
            req.params.product,
            defaultProductRole(req.params.product),
          ],
        );
        await c.query(
          "INSERT INTO audit(actor_id,action,record_id,request_id) VALUES($1,'identity.product_requested',$2,$3)",
          [session.account.id, req.params.product, req.id],
        );
      });
      return snapshot(session);
    },
  );

  const interactionParams = z.object({ uid });
  function interactionProof(id: string) {
    return createHmac("sha256", env.SESSION_KEY)
      .update("onesa:identity-interaction:v1:" + id)
      .digest("hex");
  }
  async function interaction(req: FastifyRequest, reply: FastifyReply) {
    const { provider, config } = configured();
    let details: Awaited<ReturnType<typeof provider.interactionDetails>>;
    try {
      details = await provider.interactionDetails(req.raw, reply.raw);
    } catch {
      throw new HttpError(
        401,
        "IDENTITY_INTERACTION",
        "This sign-in request expired or belongs to another browser. Return to your product and try again.",
      );
    }
    const client = config.clients.find(
      (c) => c.clientId === details.params.client_id,
    );
    if (
      details.uid !== (req.params as { uid: string }).uid ||
      !client ||
      !["login", "consent"].includes(details.prompt.name)
    )
      throw new HttpError(
        403,
        "IDENTITY_INTERACTION",
        "Invalid sign-in request.",
      );
    return { details, client };
  }
  const freshRequired = (params: Record<string, unknown>) =>
    String(params.prompt ?? "")
      .split(" ")
      .includes("login") || params.max_age !== undefined;
  const mfaRequired = (params: Record<string, unknown>) =>
    String(params.acr_values ?? "")
      .split(" ")
      .includes("urn:onesa:mfa");
  api.get(
    "/api/v1/account/interaction/:uid",
    {
      logLevel: "silent",
      schema: {
        ...meta("onesaSignInRequest"),
        params: interactionParams,
        response: {
          200: z.object({
            csrf: proof,
            product,
            freshRequired: z.boolean(),
            mfaRequired: z.boolean(),
            account: accountSchema.nullable(),
          }),
          ...failures,
        },
      },
    },
    async (req, reply) => {
      const { details, client } = await interaction(req, reply),
        session = await currentAccount(req);
      return {
        csrf: interactionProof(details.uid),
        product: client.product,
        freshRequired: freshRequired(details.params),
        mfaRequired: mfaRequired(details.params),
        account: session ? safeAccount(session.account) : null,
      };
    },
  );
  async function finish(
    req: FastifyRequest,
    reply: FastifyReply,
    session: AccountSession,
    client: IdentityClient,
  ) {
    const { provider, config } = configured(),
      { details } = await interaction(req, reply);
    if (!session.account.email_verified_at)
      throw new HttpError(
        403,
        "EMAIL_VERIFICATION_REQUIRED",
        "Verify your Onesa account email first.",
      );
    const access = await accountAccess(session.account);
    if (!access.onesa_applications.includes(client.product))
      throw new HttpError(
        403,
        "PRODUCT_ACCESS_REQUIRED",
        "Your account is ready. Request access to this product from your Onesa account.",
      );
    if (
      (isGlobalAdmin(session.account.role) ||
        productRequiresMfa(
          client.product,
          access.onesa_product_roles[client.product],
        ) ||
        mfaRequired(details.params)) &&
      !session.amr.includes("otp")
    )
      throw new HttpError(
        403,
        "MFA_REQUIRED",
        "Confirm your identity with your authenticator before continuing.",
      );
    const grant = new provider.Grant({
      accountId: session.account.id,
      clientId: client.clientId,
    });
    grant.addOIDCScope("openid email profile onesa");
    const grantId = await grant.save();
    try {
      await transaction(async (c) => {
        const expiresAt = await lockAccountSession(c, session);
        const current = await identityAccount(session.account.id, c);
        const currentAccess = current && (await accountAccess(current, c));
        if (
          !current?.email_verified_at ||
          !currentAccess!.onesa_applications.includes(client.product)
        )
          throw new HttpError(
            403,
            "PRODUCT_ACCESS_REQUIRED",
            "Product access changed. Return to your account.",
          );
        if (
          (isGlobalAdmin(current.role) ||
            productRequiresMfa(
              client.product,
              currentAccess!.onesa_product_roles[client.product],
            ) ||
            mfaRequired(details.params)) &&
          !session.amr.includes("otp")
        )
          throw new HttpError(
            403,
            "MFA_REQUIRED",
            "Confirm your identity with your authenticator.",
          );
        await c.query(
          "INSERT INTO identity_grant_sessions(grant_id,user_id,source_token_hash,source_kind,authenticated_at,amr,expires_at) VALUES($1,$2,$3,$4,to_timestamp($5),$6,$7)",
          [
            grantId,
            session.account.id,
            session.sourceHash,
            session.source,
            session.authenticatedAt,
            session.amr,
            expiresAt,
          ],
        );
      });
    } catch (error) {
      await grant.destroy();
      throw error;
    }
    const next = new URL(
      await provider.interactionResult(
        req.raw,
        reply.raw,
        {
          login: {
            accountId: session.account.id,
            ts: session.authenticatedAt,
            amr: session.amr,
            acr: session.amr.includes("otp")
              ? "urn:onesa:mfa"
              : "urn:onesa:password",
            remember: true,
          },
          consent: { grantId },
        },
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
        "IDENTITY_CONTINUE",
        "Sign-in could not be completed.",
      );
    return { continuePath: next.pathname, issuer: config.issuer };
  }
  api.post(
    "/api/v1/account/interaction/:uid/continue",
    {
      logLevel: "silent",
      schema: {
        ...meta("continueOnesaSignIn", true),
        params: interactionParams,
        body: z.object({ csrf: proof }),
        response: {
          200: z.object({ continuePath: z.string(), issuer: z.string() }),
          ...failures,
        },
      },
    },
    async (req, reply) => {
      const { details, client } = await interaction(req, reply);
      if (!same(req.body.csrf, interactionProof(details.uid)))
        throw new HttpError(403, "CSRF", "Refresh this sign-in request.");
      if (freshRequired(details.params))
        throw new HttpError(
          403,
          "REAUTH_REQUIRED",
          "Confirm your password and authenticator to continue.",
        );
      return finish(req, reply, await requireAccount(req), client);
    },
  );
  api.post(
    "/api/v1/account/interaction/:uid/login",
    {
      logLevel: "silent",
      schema: {
        ...meta("authenticateOnesaSignIn"),
        params: interactionParams,
        body: credentials.extend({ csrf: proof }),
        response: {
          200: z.object({ continuePath: z.string(), issuer: z.string() }),
          ...failures,
        },
      },
    },
    async (req, reply) => {
      const { details, client } = await interaction(req, reply);
      if (!same(req.body.csrf, interactionProof(details.uid)))
        throw new HttpError(403, "CSRF", "Refresh this sign-in request.");
      return finish(
        req,
        reply,
        await authenticate(req, reply, req.body, mfaRequired(details.params)),
        client,
      );
    },
  );

  const admin = allow(["administrator"]);
  api.get(
    "/api/v1/admin/identity/accounts",
    {
      preHandler: admin,
      schema: {
        ...meta("listOnesaAccounts", true),
        querystring: z.object({
          search: z.string().max(254).default(""),
          page: z.coerce.number().int().min(1).default(1),
        }),
        response: {
          200: z.object({
            items: z.array(
              z.object({
                account: accountSchema,
                access: z.array(accessSchema),
                memberships: z.array(membershipSchema),
              }),
            ),
            page: z.number(),
            hasMore: z.boolean(),
          }),
          ...failures,
        },
      },
    },
    async (req) => {
      configured();
      const rows = (
        await db.query(
          "SELECT u.id FROM users u WHERE NOT u.disabled AND u.email ILIKE $1 ORDER BY u.email,u.id OFFSET $2 LIMIT 51",
          ["%" + req.query.search + "%", (req.query.page - 1) * 50],
        )
      ).rows;
      const items = [];
      for (const row of rows.slice(0, 50)) {
        const account = (await identityAccount(row.id))!;
        const { access, memberships } = await accountAccess(account);
        items.push({ account: safeAccount(account), access, memberships });
      }
      return { items, page: req.query.page, hasMore: rows.length > 50 };
    },
  );
  api.put(
    "/api/v1/admin/identity/accounts/:id/products/:product",
    {
      preHandler: admin,
      schema: {
        ...meta("setOnesaProductAccess", true),
        params: z.object({ id: z.uuid(), product }),
        body: z
          .object({
            role: z.enum(["user", "viewer", "operator", ...mobileRoles]),
            status: z.enum(["active", "revoked", "rejected"]),
            expectedRevision: z.number().int().min(0),
            memberships: z.array(membershipSchema).max(50).default([]),
            stepUp,
          })
          .strict(),
        response: { 200: z.object({ ok: z.literal(true) }), ...failures },
      },
    },
    async (req) => {
      configured();
      await limits.limit("identity-admin-change:" + req.actor!.id, 20, 900);
      const input = req.body,
        selected = req.params.product;
      requireMobileConfigured(selected);
      if (
        !validProductRole(selected, input.role) ||
        (selected !== "drone" && input.memberships.length) ||
        new Set(input.memberships.map((m) => m.tenant_id)).size !==
          input.memberships.length
      )
        throw new HttpError(
          400,
          "PRODUCT_ROLE",
          "Choose a valid product role and workspace membership.",
        );
      await transaction(async (c) => {
        const actorRole = await reauthenticate(
          c,
          {
            userId: req.actor!.id,
            token: req.cookies.onesa_session!,
            csrf: req.actor!.csrf,
          },
          input.stepUp,
        );
        if (!isGlobalAdmin(actorRole))
          throw new HttpError(
            403,
            "FORBIDDEN",
            "Administrator access is required.",
          );
        await c.query(
          "SELECT pg_advisory_xact_lock(hashtextextended('identity-product:'||$1||':'||$2,0))",
          [req.params.id, selected],
        );
        const target = await identityAccount(req.params.id, c);
        if (!target?.email_verified_at)
          throw new HttpError(
            409,
            "IDENTITY_ACCOUNT",
            "The account must verify its email first.",
          );
        const old = (
          await c.query(
            "SELECT revision FROM identity_product_access WHERE user_id=$1 AND product=$2 FOR UPDATE",
            [target.id, selected],
          )
        ).rows[0];
        if ((old?.revision ?? 0) !== input.expectedRevision)
          throw new HttpError(
            409,
            "IDENTITY_REVISION",
            "Access changed. Refresh before saving.",
          );
        if (
          selected === "drone" &&
          input.status === "active" &&
          !isGlobalAdmin(target.role) &&
          !input.memberships.length
        )
          throw new HttpError(
            400,
            "WORKSPACE_REQUIRED",
            "Choose at least one existing Drone workspace.",
          );
        await c.query(
          "INSERT INTO identity_product_access(user_id,product,role,status,reviewed_by) VALUES($1,$2,$3,$4,$5) ON CONFLICT(user_id,product) DO UPDATE SET role=EXCLUDED.role,status=EXCLUDED.status,reviewed_by=EXCLUDED.reviewed_by,revision=identity_product_access.revision+1,updated_at=now()",
          [target.id, selected, input.role, input.status, req.actor!.id],
        );
        if (selected === "drone") {
          await c.query(
            "DELETE FROM identity_drone_memberships WHERE user_id=$1",
            [target.id],
          );
          for (const membership of input.memberships)
            await c.query(
              "INSERT INTO identity_drone_memberships(user_id,tenant_id,role,label) VALUES($1,$2,$3,$4)",
              [
                target.id,
                membership.tenant_id,
                membership.role,
                membership.label,
              ],
            );
        }
        await c.query(
          "INSERT INTO audit(actor_id,action,record_id,request_id) VALUES($1,'identity.product_access_changed',$2,$3)",
          [req.actor!.id, target.id + ":" + selected, req.id],
        );
      });
      return { ok: true as const };
    },
  );
  api.put(
    "/api/v1/admin/identity/accounts/:id/administrator",
    {
      preHandler: allow(["owner"]),
      schema: {
        ...meta("setOnesaAdministrator", true),
        params: z.object({ id: z.uuid() }),
        body: z.object({ administrator: z.boolean(), stepUp }).strict(),
        response: { 200: z.object({ ok: z.literal(true) }), ...failures },
      },
    },
    async (req) => {
      configured();
      await limits.limit("identity-admin-role:" + req.actor!.id, 10, 900);
      await transaction(async (c) => {
        if (
          (await reauthenticate(
            c,
            {
              userId: req.actor!.id,
              token: req.cookies.onesa_session!,
              csrf: req.actor!.csrf,
            },
            req.body.stepUp,
          )) !== "owner"
        )
          throw new HttpError(
            403,
            "FORBIDDEN",
            "Owner access is required to assign an Onesa Administrator.",
          );
        const target = (
          await c.query(
            "SELECT role FROM users WHERE id=$1 AND NOT disabled FOR UPDATE",
            [req.params.id],
          )
        ).rows[0];
        if (
          !target ||
          target.role === "owner" ||
          req.params.id === req.actor!.id
        )
          throw new HttpError(
            409,
            "IDENTITY_ROLE",
            "Owner access must be managed through the existing ownership controls.",
          );
        const account = await identityAccount(req.params.id, c);
        if (!account?.email_verified_at)
          throw new HttpError(
            409,
            "IDENTITY_ACCOUNT",
            "The account must verify its email first.",
          );
        await c.query("UPDATE users SET role=$1 WHERE id=$2", [
          req.body.administrator ? "administrator" : "member",
          req.params.id,
        ]);
        await c.query("DELETE FROM sessions WHERE user_id=$1", [req.params.id]);
        await c.query(
          "INSERT INTO audit(actor_id,action,record_id,request_id) VALUES($1,'identity.administrator_changed',$2,$3)",
          [req.actor!.id, req.params.id, req.id],
        );
      });
      return { ok: true as const };
    },
  );
}
