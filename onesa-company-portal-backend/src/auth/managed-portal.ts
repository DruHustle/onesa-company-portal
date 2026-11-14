import type { FastifyInstance } from "fastify";
import * as oidc from "openid-client";
import { createRemoteJWKSet, customFetch, jwtVerify } from "jose";
import { z } from "zod";
import { db, transaction } from "../services/db.js";
import { decrypt, encrypt, hash, token } from "./crypto.js";
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
type Flow = { state: string; nonce: string; verifier: string };
type Principal = {
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
        acr_values:
          "http://schemas.openid.net/pape/policies/2007/06/multi-factor",
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
      return portalClaims(payload, result.claims()?.sub ?? "", config.clientId);
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
  app.get(
    prefix + "/start",
    { schema: { hide: true }, logLevel: "silent" },
    async (req, reply) => {
      await admission(req);
      const flow = {
        state: oidc.randomState(),
        nonce: oidc.randomNonce(),
        verifier: oidc.randomPKCECodeVerifier(),
      };
      const browser = token(),
        destination = portalReturnPath((req.query as { next?: string }).next);
      let location: string;
      try {
        location = await client.authorize(flow);
      } catch {
        return reply.redirect(
          prefix + "/retry?next=" + encodeURIComponent(destination),
          303,
        );
      }
      await transaction(async (c) => {
        await c.query(
          "DELETE FROM portal_login_transactions WHERE expires_at<now()",
        );
        await c.query(
          "INSERT INTO portal_login_transactions(browser_hash,state,nonce,encrypted_verifier,return_path,expires_at) VALUES($1,$2,$3,$4,$5,now()+interval '10 minutes')",
          [
            hash(browser),
            flow.state,
            flow.nonce,
            encrypt(flow.verifier),
            destination,
          ],
        );
      });
      reply.setCookie(cookieName, browser, { ...cookieOptions, maxAge: 600 });
      return reply.redirect(location, 303);
    },
  );
  app.get(
    prefix + "/callback",
    { schema: { hide: true }, logLevel: "silent" },
    async (req, reply) => {
      const cookie = req.cookies[cookieName],
        query = req.query as { state?: string };
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
      if (!row) throw denied();
      reply.clearCookie(cookieName, cookieOptions);
      let principal: Principal;
      try {
        const url = new URL(config.callback);
        url.search = new URL(req.raw.url!, "https://portal.invalid").search;
        principal = await client.redeem(url, {
          state: row.state,
          nonce: row.nonce,
          verifier: decrypt(row.encrypted_verifier),
        });
      } catch (error) {
        if (error instanceof HttpError && error.status === 403) throw error;
        // The retry target is a previously validated Portal path retained server-side.
        return reply.redirect(
          prefix + "/retry?next=" + encodeURIComponent(row.return_path),
          303,
        );
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
          "INSERT INTO sessions(token_hash,user_id,csrf,expires_at,managed_expires_at,managed_role) VALUES($1,$2,$3,to_timestamp($4),to_timestamp($4),$5)",
          [hash(session), principal.id, csrf, principal.expires, user.role],
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
