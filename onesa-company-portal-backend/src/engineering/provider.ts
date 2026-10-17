import Provider, { type Configuration } from "oidc-provider";
import { db } from "../services/db.js";
import { EngineeringIdentityAdapter } from "./adapter.js";
import {
  engineeringEmailAllowed,
  type EngineeringIdentityConfig,
} from "./config.js";
/** A fixed confidential Access client; documentation identities confer no Portal role. */
export function createEngineeringProvider(config: EngineeringIdentityConfig) {
  const options: Configuration = {
    adapter: EngineeringIdentityAdapter,
    clients: [
      {
        client_id: config.clientId,
        client_secret: config.clientSecret,
        redirect_uris: [config.redirectUri],
        response_types: ["code"],
        grant_types: ["authorization_code"],
        token_endpoint_auth_method: "client_secret_basic",
        id_token_signed_response_alg: "RS256",
      },
    ],
    jwks: config.jwks,
    responseTypes: ["code"],
    scopes: ["openid", "email", "profile"],
    // Access identifies the approved email from the signed ID token, not userinfo.
    conformIdTokenClaims: false,
    claims: {
      openid: ["sub"],
      email: ["email", "email_verified"],
      profile: [],
    },
    cookies: {
      keys: config.cookieKeys,
      names: {
        session: "onesa_engineering_session",
        interaction: "onesa_engineering_interaction",
        resume: "onesa_engineering_resume",
      },
      long: { httpOnly: true, secure: true, sameSite: "lax" },
      short: { httpOnly: true, secure: true, sameSite: "lax" },
    },
    ttl: {
      AccessToken: 300,
      AuthorizationCode: 60,
      IdToken: 300,
      Interaction: 600,
      Session: 28800,
      Grant: 28800,
    },
    pkce: { required: () => true },
    features: {
      devInteractions: { enabled: false },
      registration: { enabled: false },
      introspection: { enabled: false },
      revocation: { enabled: false },
      rpInitiatedLogout: { enabled: false },
    },
    interactions: {
      url: (_context, interaction) =>
        new URL("/engineering/sign-in/" + interaction.uid, config.issuer).href,
    },
    issueRefreshToken: () => false,
    findAccount: async (_context, id) => {
      if (
        !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
          id,
        )
      )
        return undefined;
      const row = (
        await db.query(
          "SELECT id,email FROM engineering_memberships WHERE id=$1 AND enabled",
          [id],
        )
      ).rows[0];
      if (!row || !engineeringEmailAllowed(row.email, config.externalEmails))
        return undefined;
      return {
        accountId: row.id,
        claims: async () => ({
          sub: row.id,
          email: row.email,
          email_verified: true,
        }),
      };
    },
    renderError: async (context) => {
      context.type = "text/plain";
      context.body =
        "Engineering sign-in could not be completed. Return to the Onesa Portal and try again.";
    },
  };
  const provider = new Provider(config.issuer, options);
  provider.proxy = true;
  return provider;
}
