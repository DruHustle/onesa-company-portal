import Provider, { interactionPolicy, type Configuration } from "oidc-provider";
import { IdentityAdapter } from "./adapter.js";
import { identityAccount, liveGrantSession } from "./accounts.js";
import type { IdentityConfig } from "./config.js";

/** One established protocol implementation, explicitly configured confidential product clients. */
export function createIdentityProvider(config: IdentityConfig) {
  const policy = interactionPolicy.base();
  const farmer = config.clients.find((client) => client.product === "farmer");
  if (farmer) {
    // An issuer cookie can outlive the Portal session that authorized its Farmer grant.
    // Prompt before issuing another code with that expired source.
    policy.get("login")!.checks.add(new interactionPolicy.Check(
      "farmer_source_session_expired", "Fresh Portal authentication is required for Smart Farmer",
      async ({ oidc }) => {
        if (oidc.client?.clientId !== farmer.clientId || !oidc.session?.accountId) return false;
        const grant = oidc.session.grantIdFor(farmer.clientId);
        return grant ? !(await liveGrantSession(grant, oidc.session.accountId)) : false;
      },
    ));
  }
  const options: Configuration = {
    adapter: IdentityAdapter,
    clients: config.clients.map((client) => ({
      client_id: client.clientId,
      client_secret: client.clientSecret,
      redirect_uris: [client.redirectUri],
      response_types: ["code"],
      grant_types: ["authorization_code"],
      token_endpoint_auth_method: "client_secret_basic",
      id_token_signed_response_alg: "RS256",
    })),
    jwks: config.jwks,
    responseTypes: ["code"],
    scopes: ["openid", "email", "profile", "onesa"],
    claims: {
      openid: ["sub"],
      email: ["email", "email_verified"],
      profile: ["name"],
    },
    cookies: {
      keys: config.cookieKeys,
      names: {
        session: "onesa_identity_session",
        interaction: "onesa_identity_interaction",
        resume: "onesa_identity_resume",
      },
      long: { httpOnly: true, secure: true, sameSite: "lax" },
      short: { httpOnly: true, secure: true, sameSite: "lax" },
    },
    ttl: {
      AccessToken: 28800,
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
      policy,
      url: (_ctx, interaction) =>
        new URL("/account/sign-in/" + interaction.uid, config.issuer).href,
    },
    issueRefreshToken: () => false,
    extraTokenClaims: (ctx, token) => {
      const code = ctx.oidc.entities.AuthorizationCode;
      // Source authentication evidence survives code exchange. Issuance time is never step-up proof.
      if (
        !code ||
        !("accountId" in token) ||
        code.accountId !== token.accountId ||
        !code.authTime ||
        !code.sessionUid
      )
        throw Error("Identity source authentication missing");
      return {
        auth_time: code.authTime,
        amr: code.amr ?? [],
        nonce: code.nonce ?? null,
      };
    },
    findAccount: async (_ctx, id) => {
      if (!/^[a-f0-9-]{36}$/i.test(id)) return undefined;
      const account = await identityAccount(id);
      if (!account?.email_verified_at) return undefined;
      return {
        accountId: account.id,
        claims: async () => ({
          sub: account.id,
          email: account.email,
          email_verified: true,
          name: account.display_name,
        }),
      };
    },
    renderError: async (context) => {
      context.type = "text/plain";
      context.body =
        "Onesa sign-in could not be completed. Return to the application and try again.";
    },
  };
  const provider = new Provider(config.issuer, options);
  provider.proxy = true;
  // The HTML prompt and its API have distinct paths. Bind both signed
  // interaction cookies to this request's API subtree; keep resume/session
  // cookies at the paths chosen by the provider.
  provider.use(async (ctx, next) => {
    await next();
    const headers = ctx.res.getHeader("set-cookie");
    if (!Array.isArray(headers)) return;
    const prefix = provider.cookieName("interaction");
    ctx.res.setHeader("set-cookie", headers.map((cookie) => {
      if (!cookie.startsWith(prefix + "=") && !cookie.startsWith(prefix + ".sig=")) return cookie;
      return cookie.replace(/(;\s*path=)\/account\/sign-in\/([A-Za-z0-9_-]{8,128})(?=;|$)/i,
        "$1/api/v1/account/interaction/$2");
    }));
  });
  return provider;
}
