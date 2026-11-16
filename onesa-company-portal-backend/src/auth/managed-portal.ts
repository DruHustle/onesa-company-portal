import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import * as oidc from "openid-client";
import { createRemoteJWKSet, customFetch, jwtVerify } from "jose";
import { z } from "zod";
import { db, transaction } from "../services/db.js";
import { decrypt, encrypt, hash, token } from "./crypto.js";
import { failedProof } from "./managed-operation.js";
import { setSessionCookie } from "./session-cookie.js";
import { env } from "../config/env.js";
import { HttpError } from "../services/workflows.js";
import { roles } from "../access/roles.js";

const prefix = "/api/v1/auth/managed";
const cookieName = "onesa_portal_login";
const ns = "https://onesa.eu/claims/";
const cookieOptions = {
  path: prefix,
  httpOnly: true,
  sameSite: "lax" as const,
  secure: true,
};
const unavailable = () =>
  new HttpError(
    503,
    "IDENTITY_UNAVAILABLE",
    "Onesa sign-in is temporarily unavailable. Return to the Portal and try again.",
  );
const denied = () =>
  new HttpError(
    403,
    "PORTAL_ACCESS",
    "An approved Portal role and recent MFA are required.",
  );
const legacyStaffCredentials = new Set([
  "login",
  "startMfaEnrollment",
  "verifyMfaEnrollment",
  "regenerateRecoveryCodes",
  "changeOwnPassword",
  "requestPasswordReset",
  "resetPassword",
  "requestAdminSignInLink",
  "verifyAdminSignInLink",
]);
export function legacyStaffCredentialOperation(id?: string) {
  return id !== undefined && legacyStaffCredentials.has(id);
}
export function managedPortalEnabled() {
  return process.env.ONESA_IDENTITY_PORTAL_LOGIN === "managed";
}

export function portalReturnPath(value: unknown) {
  if (
    typeof value !== "string" ||
    value.length > 2048 ||
    /[\\\u0000-\u001f]/.test(value)
  )
    return "/admin";
  if (!/^\/admin(?:[?#]|$)/.test(value)) return "/admin";
  const parsed = new URL(value, "https://portal.invalid");
  if (
    parsed.origin !== "https://portal.invalid" ||
    parsed.pathname !== "/admin"
  )
    return "/admin";
  return parsed.pathname + parsed.search + parsed.hash;
}

export function managedConfig() {
  const issuer = z.url().parse(process.env.ONESA_IDENTITY_ISSUER);
  const url = new URL(issuer);
  if (
    url.protocol !== "https:" ||
    issuer !== url.origin + "/" ||
    !env.PUBLIC_ORIGIN.startsWith("https://")
  )
    throw Error(
      "Managed Portal login requires absolute HTTPS Portal and issuer origins",
    );
  return {
    issuer,
    clientId: z
      .string()
      .min(1)
      .max(200)
      .parse(process.env.ONESA_IDENTITY_PORTAL_CLIENT_ID),
    secret: z
      .string()
      .min(32)
      .parse(process.env.ONESA_IDENTITY_PORTAL_CLIENT_SECRET),
    audience: z
      .string()
      .min(1)
      .parse(process.env.ONESA_IDENTITY_PORTAL_AUDIENCE),
    callback: env.PUBLIC_ORIGIN + prefix + "/callback",
  };
}

export type PortalOIDCConfig = ReturnType<typeof managedConfig>;
type Flow = {
  state: string;
  nonce: string;
  verifier: string;
  operationStartedAt?: number;
};
const operationCookie = (state: string) =>
  "onesa_portal_operation_" + hash(state).slice(0, 24);
const operationAcr = "urn:onesa:authentication:operation-mfa";
type Principal = {
  subject: string;
  id: string;
  roles: string[];
  expires: number;
  mfaTime: number;
};
export interface PortalProvider {
  authorize(flow: Flow): Promise<string>;
  redeem(url: URL, flow: Flow): Promise<Principal>;
}

export function portalClaims(
  claims: Record<string, unknown>,
  subject: string,
  clientId: string,
  now = Math.floor(Date.now() / 1000),
): Principal {
  const id = z.uuid().safeParse(claims[ns + "user_id"]);
  const products = claims[ns + "products"],
    grantedRoles = claims[ns + "roles"],
    time = claims[ns + "mfa_time"],
    expires = claims.exp;
  if (
    !id.success ||
    !subject ||
    claims.sub !== subject ||
    (claims.azp !== undefined && claims.azp !== clientId) ||
    !Array.isArray(products) ||
    !products.includes("portal") ||
    !Array.isArray(grantedRoles) ||
    typeof time !== "number" ||
    !Number.isSafeInteger(time) ||
    time > now ||
    now - time >= 28800 ||
    typeof expires !== "number" ||
    !Number.isSafeInteger(expires) ||
    expires <= now
  )
    throw denied();
  return {
    subject,
    id: id.data,
    roles: grantedRoles.filter(
      (r): r is string =>
        typeof r === "string" && roles.includes(r as (typeof roles)[number]),
    ),
    expires: Math.min(expires, now + 300, time + 28800),
    mfaTime: time,
  };
}

export function portalProvider(
  config: PortalOIDCConfig,
  transport?: (
    url: string,
    options: { body?: unknown; method: string },
  ) => Promise<Response>,
): PortalProvider {
  let pending:
    | Promise<{
        client: oidc.Configuration;
        keys: ReturnType<typeof createRemoteJWKSet>;
      }>
    | undefined;
  function discover() {
    if (!pending)
      pending = oidc
        .discovery(
          new URL(config.issuer),
          config.clientId,
          {
            client_secret: config.secret,
            id_token_signed_response_alg: "RS256",
          },
          oidc.ClientSecretBasic(config.secret),
          {
            timeout: 5,
            execute: [oidc.enableNonRepudiationChecks],
            ...(transport ? { [oidc.customFetch]: transport } : {}),
          },
        )
        .then((client) => {
          const m = client.serverMetadata();
          if (
            m.issuer !== config.issuer ||
            ![m.authorization_endpoint, m.token_endpoint, m.jwks_uri].every(
              (endpoint) => {
                if (!endpoint) return false;
                const u = new URL(endpoint);
                return (
                  u.origin === new URL(config.issuer).origin &&
                  !u.username &&
                  !u.password &&
                  !u.hash
                );
              },
            )
          )
            throw unavailable();
          if (new URL(m.authorization_endpoint!).pathname !== "/authorize")
            throw unavailable();
          return {
            client,
            keys: createRemoteJWKSet(new URL(m.jwks_uri!), {
              timeoutDuration: 5000,
              ...(transport ? { [customFetch]: transport } : {}),
            }),
          };
        })
        .catch(() => {
          pending = undefined;
          throw unavailable();
        });
    return pending;
  }
  return {
    async authorize(flow) {
      const { client } = await discover();
      return oidc.buildAuthorizationUrl(client, {
        redirect_uri: config.callback,
        response_type: "code",
        scope: "openid",
        audience: config.audience,
        state: flow.state,
        nonce: flow.nonce,
        code_challenge: await oidc.calculatePKCECodeChallenge(flow.verifier),
        code_challenge_method: "S256",
        acr_values: [
          "http://schemas.openid.net/pape/policies/2007/06/multi-factor",
          ...(flow.operationStartedAt === undefined ? [] : [operationAcr]),
        ].join(" "),
        ...(flow.operationStartedAt === undefined
          ? {}
          : { prompt: "login", max_age: "0" }),
      }).href;
    },
    async redeem(url, flow) {
      const { client, keys } = await discover();
      const result = await oidc.authorizationCodeGrant(client, url, {
        expectedState: flow.state,
        expectedNonce: flow.nonce,
        pkceCodeVerifier: flow.verifier,
        idTokenExpected: true,
      });
      const { payload } = await jwtVerify(result.access_token, keys, {
        algorithms: ["RS256"],
        issuer: config.issuer,
        audience: config.audience,
        requiredClaims: ["sub", "iat", "exp"],
      });
      const idToken = result.claims();
      const principal = portalClaims(
        payload,
        idToken?.sub ?? "",
        config.clientId,
      );
      if (flow.operationStartedAt !== undefined) {
        const now = Math.floor(Date.now() / 1000);
        if (
          payload[ns + "operation_mfa_nonce"] !== flow.nonce ||
          principal.mfaTime < flow.operationStartedAt ||
          typeof idToken?.auth_time !== "number" ||
          !Number.isSafeInteger(idToken.auth_time) ||
          idToken.auth_time < flow.operationStartedAt ||
          idToken.auth_time > now
        )
          throw failedProof();
      }
      return principal;
    },
  };
}

export function registerManagedPortal(
  app: FastifyInstance,
  config: PortalOIDCConfig,
  client = portalProvider(config),
  admission: (
    request: import("fastify").FastifyRequest,
  ) => Promise<void> = async () => {},
) {
  async function begin(
    req: FastifyRequest,
    reply: FastifyReply,
    challenge?: string,
  ) {
    await admission(req);
    const browser = token();
    const destination = portalReturnPath((req.query as { next?: string }).next);
    const step = challenge !== undefined;
    if (
      step &&
      (!/^[0-9a-f]{64}$/.test(challenge) || !req.cookies.onesa_session)
    )
      throw failedProof();
    const flow: Flow = {
      state: oidc.randomState(),
      nonce: oidc.randomNonce(),
      verifier: oidc.randomPKCECodeVerifier(),
    };
    if (step) flow.operationStartedAt = Math.floor(Date.now() / 1000);
    let location: string;
    try {
      location = await client.authorize(flow);
    } catch {
      if (step) throw unavailable();
      return reply.redirect(
        prefix + "/retry?next=" + encodeURIComponent(destination),
        303,
      );
    }
    await transaction(async (c) => {
      await c.query(
        "DELETE FROM portal_login_transactions WHERE expires_at<now()",
      );
      const challengeHash = step ? hash(challenge) : null;
      if (step) {
        const started = await c.query(
          `UPDATE portal_operation_challenges SET started_at=to_timestamp($3)
           WHERE challenge_hash=$1 AND session_hash=$2 AND expires_at>now() AND started_at IS NULL`,
          [
            challengeHash,
            hash(req.cookies.onesa_session!),
            flow.operationStartedAt,
          ],
        );
        if (!started.rowCount) throw failedProof();
      }
      await c.query(
        `INSERT INTO portal_login_transactions(browser_hash,state,nonce,encrypted_verifier,return_path,expires_at,operation_challenge)
         VALUES($1,$2,$3,$4,$5,now()+interval '10 minutes',$6)`,
        [
          hash(browser),
          flow.state,
          flow.nonce,
          encrypt(flow.verifier),
          destination,
          challengeHash,
        ],
      );
    });
    reply.setCookie(step ? operationCookie(flow.state) : cookieName, browser, {
      ...cookieOptions,
      maxAge: 600,
    });
    return reply.redirect(location, 303);
  }
  app.get(
    prefix + "/start",
    { schema: { hide: true }, logLevel: "silent" },
    (req, reply) => begin(req, reply),
  );
  app.register(async (operation) => {
    operation.addContentTypeParser(
      "application/x-www-form-urlencoded",
      { parseAs: "string", bodyLimit: 96 },
      (_req, body, done) => done(null, body),
    );
    operation.post(
      prefix + "/step-up",
      { schema: { hide: true }, logLevel: "silent", bodyLimit: 96 },
      (req, reply) => {
        const match =
          typeof req.body === "string" &&
          /^challenge=([a-f0-9]{64})$/.exec(req.body);
        if (
          !match ||
          req.headers.origin !== env.PUBLIC_ORIGIN ||
          req.url.includes("?")
        )
          throw failedProof();
        return begin(req, reply, match[1]);
      },
    );
  });
  app.get(
    prefix + "/callback",
    { schema: { hide: true }, logLevel: "silent" },
    async (req, reply) => {
      const query = req.query as { state?: string };
      if (typeof query.state !== "string" || query.state.length > 256)
        throw denied();
      const stepCookie = operationCookie(query.state);
      const name = req.cookies[stepCookie] ? stepCookie : cookieName;
      const cookie = req.cookies[name];
      if (
        !cookie ||
        !/^[0-9a-f]{64}$/.test(cookie) ||
        typeof query.state !== "string"
      )
        throw denied();
      const row = (
        await db.query(
          "DELETE FROM portal_login_transactions WHERE browser_hash=$1 AND state=$2 AND expires_at>now() RETURNING *",
          [hash(cookie), query.state],
        )
      ).rows[0];
      if (!row || Boolean(row.operation_challenge) !== (name === stepCookie))
        throw denied();
      reply.clearCookie(name, cookieOptions);
      const operation = row.operation_challenge
        ? (
            await db.query(
              `SELECT extract(epoch FROM started_at)::bigint AS started FROM portal_operation_challenges
          WHERE challenge_hash=$1 AND expires_at>now() AND started_at IS NOT NULL AND verified_at IS NULL`,
              [row.operation_challenge],
            )
          ).rows[0]
        : null;
      if (row.operation_challenge && !operation) throw failedProof();
      let principal: Principal;
      try {
        const url = new URL(config.callback);
        url.search = new URL(req.raw.url!, "https://portal.invalid").search;
        principal = await client.redeem(url, {
          state: row.state,
          nonce: row.nonce,
          verifier: decrypt(row.encrypted_verifier),
          ...(operation
            ? { operationStartedAt: Number(operation.started) }
            : {}),
        });
      } catch (error) {
        if (error instanceof HttpError && error.status === 403) throw error;
        if (operation) throw unavailable();
        // The retry target is a previously validated Portal path retained server-side.
        return reply.redirect(
          prefix + "/retry?next=" + encodeURIComponent(row.return_path),
          303,
        );
      }
      if (operation) {
        await transaction(async (c) => {
          const verified = await c.query(
            `UPDATE portal_operation_challenges p
              SET verified_at=now(), expires_at=least(p.expires_at,to_timestamp($6),now()+interval '90 seconds')
              FROM sessions s JOIN users u ON u.id=s.user_id
              WHERE p.challenge_hash=$1 AND p.session_hash=s.token_hash AND p.expires_at>now()
              AND p.verified_at IS NULL AND NOT u.disabled AND u.id=$2 AND s.managed_subject=$3
              AND s.managed_issuer=$4 AND s.managed_role=u.role AND u.role=ANY($5::text[])
              AND s.expires_at>now() AND s.managed_expires_at>now() AND to_timestamp($6)>now()`,
            [
              row.operation_challenge,
              principal.id,
              principal.subject,
              config.issuer,
              principal.roles,
              principal.expires,
            ],
          );
          if (!verified.rowCount) throw failedProof();
        });
        return reply.redirect("/admin/step-up-complete", 303);
      }
      const session = token(),
        csrf = token();
      await transaction(async (c) => {
        const user = (
          await c.query(
            "SELECT role FROM users WHERE id=$1 AND NOT disabled FOR SHARE",
            [principal.id],
          )
        ).rows[0];
        if (
          !user ||
          !principal.roles.includes(user.role) ||
          principal.expires <= Date.now() / 1000
        )
          throw denied();
        await c.query(
          "INSERT INTO sessions(token_hash,user_id,csrf,expires_at,managed_expires_at,managed_role,managed_subject,managed_issuer) VALUES($1,$2,$3,to_timestamp($4),to_timestamp($4),$5,$6,$7)",
          [
            hash(session),
            principal.id,
            csrf,
            principal.expires,
            user.role,
            principal.subject,
            config.issuer,
          ],
        );
        await c.query(
          "INSERT INTO audit(actor_id,action,request_id) VALUES($1,'auth.managed_login',$2)",
          [principal.id, req.id],
        );
      });
      setSessionCookie(reply, session, false, principal.mfaTime * 1000);
      return reply.redirect(row.return_path, 303);
    },
  );
  app.get(
    prefix + "/retry",
    { schema: { hide: true }, logLevel: "silent" },
    async (req, reply) => {
      const next = portalReturnPath((req.query as { next?: string }).next);
      const target =
        prefix +
        "/start?next=" +
        encodeURIComponent(next).replaceAll("'", "%27");
      return reply
        .code(503)
        .header("referrer-policy", "no-referrer")
        .type("text/html; charset=utf-8")
        .send(
          '<!doctype html><html lang="en"><title>Onesa sign-in</title><main><h1>Sign-in could not finish</h1><a href="' +
            target +
            '">Retry sign-in to continue in Company Portal</a></main></html>',
        );
    },
  );
}
