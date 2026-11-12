import { generateKeyPairSync, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { z } from "zod";
import {
  clientProducts,
  identityConfiguration,
  identityPath,
  type ClientProduct,
  type IdentityConfig,
} from "./config.js";

export const productionOrigins = {
  portal: "https://portal.onesa.eu",
  ai: "https://platform.onesa.eu",
  drone: "https://drone.onesa.eu",
  robot: "https://robot.onesa.eu",
  mobile: "https://mobile.onesa.eu",
  farmer: "https://farmer.onesa.eu",
  logistics: "https://logistics.onesa.eu",
  pasofi: "https://pasofi.mobile.onesa.eu",
  factory: "https://factory.onesa.eu",
} as const;
type Origins = Record<Exclude<keyof typeof productionOrigins, "factory">, string> & { factory?: string };
export const qualifiedClientProducts = clientProducts.filter(product => product !== "factory");

const callbacks: Record<ClientProduct, string> = {
  ai: "/api/v1/auth/onesa/callback",
  drone: "/api/v1/auth/identity/callback",
  robot: "/api/v1/auth/identity/callback",
  mobile: "/api/v1/auth/onesa/callback",
  farmer: "/auth/onesa/callback",
  logistics: "/api/auth/onesa/callback",
  pasofi: "/onesa-callback.html",
  factory: "/api/auth/onesa/callback",
};
const credential = () => randomBytes(48).toString("base64url");

function stagingOrigins(value: unknown, includeFactory: boolean): Origins {
  const httpsOrigin = z.string().refine((value) => {
    try {
      const origin = new URL(value);
      return (
        origin.protocol === "https:" &&
        origin.origin === value &&
        !origin.hostname.includes("*")
      );
    } catch {
      return false;
    }
  });
  const result = z
    .record(z.enum(["portal", ...(includeFactory ? clientProducts : qualifiedClientProducts)]), httpsOrigin)
    .parse(value);
  const values = Object.values(result);
  if (
    new Set(values).size !== values.length ||
    values.some((origin) =>
      Object.values<string>(productionOrigins).includes(origin),
    )
  ) {
    throw Error(
      "Staging origins must be distinct from each other and from production",
    );
  }
  return result;
}

const custody = z
  .object({
    ONESA_IDENTITY_ENABLED: z.literal("true"),
    ONESA_IDENTITY_CONFIG_B64: z.string(),
  })
  .strict();

async function existingConfiguration(path: string, origin: string) {
  // Open once, reject links and check this same descriptor before reading credentials.
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const info = await file.stat();
    if (
      !info.isFile() ||
      info.mode & 0o077 ||
      info.uid !== process.getuid?.() ||
      info.size > 70000
    ) {
      throw Error("Issuer input must be a private, owner-held regular file");
    }
    const env = custody.parse(JSON.parse(await file.readFile("utf8")));
    const config = identityConfiguration(env, origin);
    if (!config) throw Error("Issuer input rejected");
    return config;
  } finally {
    await file.close();
  }
}

function initialize(issuer: string): IdentityConfig {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 3072 });
  const key = privateKey.export({ format: "jwk" }) as Record<string, string>;
  return {
    issuer,
    clients: [],
    cookieKeys: [credential()],
    jwks: {
      keys: [
        {
          ...key,
          alg: "RS256",
          use: "sig",
          kid: randomBytes(16).toString("hex"),
        },
      ],
    },
  };
}

function completeConfiguration(config: IdentityConfig, origins: Origins, includeFactory: boolean) {
  if (!includeFactory && config.clients.some(client => client.product === "factory"))
    throw Error("Existing Factory registration requires explicit Factory preparation");
  for (const product of includeFactory ? clientProducts : qualifiedClientProducts) {
    const origin = origins[product];
    if (!origin) throw Error("Missing selected product origin");
    const redirectUri = origin + callbacks[product];
    const registered = config.clients.find(
      (client) => client.product === product,
    );
    if (registered) {
      const secret = registered.clientSecret;
      if (
        secret.includes("\0") ||
        secret.includes("\n") ||
        secret.includes("\r") ||
        (product === "mobile" && secret.trim() !== secret) ||
        (product === "drone" && registered.clientId.length > 100)
      ) {
        throw Error(
          "Existing registration cannot be installed without changing its credential",
        );
      }
      if (
        registered.redirectUri !== redirectUri ||
        new URL(registered.applicationUrl).origin !== origin
      ) {
        throw Error(
          "Existing registration does not match the selected environment and callback",
        );
      }
    } else {
      config.clients.push({
        product,
        clientId: "onesa_" + product + "_" + randomBytes(16).toString("hex"),
        clientSecret: credential(),
        redirectUri,
        applicationUrl: origin,
      });
    }
  }
  const env = {
    ONESA_IDENTITY_ENABLED: "true",
    ONESA_IDENTITY_CONFIG_B64: Buffer.from(JSON.stringify(config)).toString(
      "base64",
    ),
  };
  if (!identityConfiguration(env, origins.portal))
    throw Error("Invalid completed issuer configuration");
  return env;
}

function bindings(
  config: IdentityConfig,
  origins: Origins,
  destination: string,
) {
  const files: Record<string, string> = {};
  function environment(name: string, env: Record<string, string>) {
    files[name + ".env.json"] = JSON.stringify(env, null, 2) + "\n";
  }
  environment("portal-frontend", {
    ONESA_IDENTITY_CALLBACKS_JSON: JSON.stringify(
      config.clients.map((client) => client.redirectUri),
    ),
  });
  for (const {
    product,
    clientId,
    clientSecret,
    redirectUri,
  } of config.clients) {
    if (product === "pasofi") {
      // The deployed Compose overlay reads the secret from this exact file, under PAMOFI_SECRETS_DIR.
      files.pasofi_onesa_client_secret = clientSecret;
      environment("pasofi", {
        PASOFI_ONESA_ISSUER: config.issuer,
        PASOFI_ONESA_CLIENT_ID: clientId,
        PASOFI_ONESA_REDIRECT_URI: redirectUri,
      });
    } else if (product === "mobile") {
      files.mobile_onesa_client_secret = clientSecret;
      environment(product, {
        MOBILE_PUBLIC_ORIGIN: origins.mobile,
        MOBILE_ONESA_ISSUER: config.issuer,
        MOBILE_ONESA_CLIENT_ID: clientId,
        MOBILE_ONESA_SECRET_FILE: join(
          destination,
          "mobile_onesa_client_secret",
        ),
      });
    } else {
      const env: Record<string, string> = {
        ONESA_IDENTITY_ENABLED: "true",
        ONESA_IDENTITY_ISSUER: config.issuer,
        ONESA_IDENTITY_CLIENT_ID: clientId,
        ONESA_IDENTITY_CLIENT_SECRET: clientSecret,
      };
      if (product === "ai")
        Object.assign(env, {
          ONESA_PUBLIC_ORIGIN: origins.ai,
          ONESA_IDENTITY_CALLBACK_URL: redirectUri,
        });
      if (product === "drone")
        Object.assign(env, {
          APP_ORIGIN: origins.drone,
          ONESA_IDENTITY_CALLBACK: redirectUri,
        });
      if (product === "robot")
        Object.assign(env, {
          ROBOT_PUBLIC_ORIGIN: origins.robot,
          ONESA_IDENTITY_CALLBACK_URL: redirectUri,
        });
      if (product === "farmer") env.WEB_ORIGIN = origins.farmer;
      if (product === "logistics" || product === "factory")
        env.ONESA_IDENTITY_REDIRECT_URI = redirectUri;
      environment(product, env);
    }
  }
  return files;
}

async function publish(destination: string, files: Record<string, string>) {
  if (!isAbsolute(destination)) throw Error("Output path must be absolute");
  const parent = await lstat(dirname(destination));
  if (
    !parent.isDirectory() ||
    parent.mode & 0o077 ||
    parent.uid !== process.getuid?.()
  ) {
    throw Error("Use a private, owner-held output parent directory");
  }
  const pending = destination + ".preparing";
  await mkdir(pending, { mode: 0o700 });
  try {
    try {
      await lstat(destination);
      throw Error("Destination already exists");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    for (const [name, value] of Object.entries(files)) {
      await writeFile(pending + "/" + name, value, { flag: "wx", mode: 0o600 });
    }
    await rename(pending, destination);
  } catch (error) {
    await rm(pending, { recursive: true, force: true });
    throw error;
  }
}

export async function prepareIdentityRelease(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      environment: { type: "string" },
      "staging-origins": { type: "string" },
      existing: { type: "string" },
      initialize: { type: "boolean" },
      "include-factory": { type: "boolean" },
      output: { type: "string" },
    },
  });
  if (!values.output || Boolean(values.existing) === Boolean(values.initialize))
    throw Error("Select one issuer input and an output");
  let origins: Origins;
  if (values.environment === "production" && !values["staging-origins"])
    origins = productionOrigins;
  else if (values.environment === "staging" && values["staging-origins"]) {
    origins = stagingOrigins(
      JSON.parse(await readFile(values["staging-origins"], "utf8")),
      Boolean(values["include-factory"]),
    );
  } else throw Error("Select production or supply explicit staging origins");
  const config = values.existing
    ? await existingConfiguration(values.existing, origins.portal)
    : initialize(origins.portal + identityPath);
  const issuerEnv = completeConfiguration(config, origins, Boolean(values["include-factory"]));
  await publish(values.output, {
    "portal-issuer.env.json": JSON.stringify(issuerEnv, null, 2) + "\n",
    ...bindings(config, origins, values.output),
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    await prepareIdentityRelease(process.argv.slice(2));
    console.log(
      "Prepared the Portal issuer, frontend callbacks and selected private product bindings.",
    );
  } catch {
    // Parse, filesystem and validation errors may contain private input. Keep them out of release logs.
    console.error(
      "Identity preparation failed. Check the arguments, environment origins, protected input and new output path.",
    );
    process.exitCode = 1;
  }
}
