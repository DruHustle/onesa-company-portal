import { errors, type Adapter, type AdapterPayload } from "oidc-provider";
import { db } from "../services/db.js";
import { encrypt, decrypt } from "../auth/crypto.js";
import { liveGrantSession } from "../identity/accounts.js";
const allowed = new Set([
  "Client",
  "Session",
  "Interaction",
  "Grant",
  "AuthorizationCode",
  "AccessToken",
  "ClientCredentials",
  "ReplayDetection",
  "PushedAuthorizationRequest",
]);
export class EngineeringIdentityAdapter implements Adapter {
  constructor(private model: string) {
    if (!allowed.has(model)) throw Error("Unsupported identity model");
  }
  async upsert(id: string, payload: AdapterPayload, expiresIn = 600) {
    if (this.model === "Client") throw Error("Clients require fixed configuration");
    if (!Number.isInteger(expiresIn) || expiresIn < 1 || expiresIn > 28800)
      throw Error("Identity lifetime rejected");
    const encrypted = encrypt(
      JSON.stringify({ model: this.model, id, payload }),
    );
    await db.query(
      "INSERT INTO engineering_identity_records(model,id,encrypted_payload,uid,grant_id,account_id,expires_at) VALUES($1,$2,$3,$4,$5,$6,now()+$7*interval '1 second') ON CONFLICT(model,id) DO UPDATE SET encrypted_payload=EXCLUDED.encrypted_payload,uid=EXCLUDED.uid,grant_id=EXCLUDED.grant_id,account_id=EXCLUDED.account_id,expires_at=EXCLUDED.expires_at",
      [
        this.model,
        id,
        encrypted,
        payload.uid ?? null,
        payload.grantId ?? null,
        payload.accountId ?? null,
        expiresIn,
      ],
    );
  }
  private async load(
    field: "id" | "uid",
    value: string,
  ): Promise<AdapterPayload | undefined> {
    // Unknown clients must remain invalid_client; dynamic/persisted clients are disabled.
    if (this.model === "Client") return undefined;
    const rows = (
      await db.query(
        `SELECT id,encrypted_payload,consumed_at FROM engineering_identity_records WHERE model=$1 AND ${field}=$2 AND expires_at>now() LIMIT 2`,
        [this.model, value],
      )
    ).rows;
    if (rows.length !== 1) return undefined;
    const row = rows[0],
      parsed = JSON.parse(decrypt(row.encrypted_payload)) as {
        model: string;
        id: string;
        payload: AdapterPayload;
      };
    if (parsed.model !== this.model || parsed.id !== row.id)
      throw Error("Identity record binding rejected");
    if (parsed.payload.accountId) {
      const link = (await db.query(
        "SELECT l.user_id FROM identity_engineering_links l JOIN engineering_memberships m ON m.id=l.membership_id JOIN users u ON u.id=l.user_id JOIN identity_profiles p ON p.user_id=u.id WHERE l.membership_id=$1 AND m.enabled AND NOT u.disabled AND u.email=m.email AND p.email_verified_at IS NOT NULL",
        [parsed.payload.accountId],
      )).rows[0];
      const linked = link || (await db.query("SELECT user_id FROM identity_engineering_links WHERE membership_id=$1", [parsed.payload.accountId])).rows[0];
      if (linked) {
        if (!link || process.env.ONESA_IDENTITY_ENABLED !== "true") return undefined;
        const authorizations = parsed.payload.authorizations;
        const grants = this.model === "Grant" ? [row.id] : typeof parsed.payload.grantId === "string" ? [parsed.payload.grantId] :
          this.model === "Session" && authorizations && typeof authorizations === "object" ?
            Object.values(authorizations).map((value: unknown) => value && typeof value === "object" && "grantId" in value ? value.grantId : undefined) : [];
        if (!grants.length || grants.length > 1 || typeof grants[0] !== "string" || !(await liveGrantSession(grants[0], link.user_id))) return undefined;
      }
    }
    return {
      ...parsed.payload,
      ...(row.consumed_at === null
        ? {}
        : { consumed: Number(row.consumed_at) }),
    };
  }
  find(id: string) {
    return this.load("id", id);
  }
  findByUid(uid: string) {
    return this.load("uid", uid);
  }
  async findByUserCode() {
    return undefined;
  }
  async consume(id: string) {
    const result = await db.query(
      "UPDATE engineering_identity_records SET consumed_at=extract(epoch FROM now())::bigint WHERE model=$1 AND id=$2 AND consumed_at IS NULL AND expires_at>now() RETURNING id",
      [this.model, id],
    );
    if (result.rowCount !== 1)
      throw new errors.InvalidGrant(
        "Identity artifact already consumed or expired",
      );
  }
  async destroy(id: string) {
    await db.query(
      "DELETE FROM engineering_identity_records WHERE model=$1 AND id=$2",
      [this.model, id],
    );
  }
  async revokeByGrantId(grantId: string) {
    await db.query(
      "DELETE FROM engineering_identity_records WHERE grant_id=$1",
      [grantId],
    );
  }
}
