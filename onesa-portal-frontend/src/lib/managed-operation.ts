export type OwnerProof = { password: string; code: string } | { managed: true; receipt?: string };
export const completionMessage = "onesa-portal-operation-verified";

export function operationChallenge(value: string | null): string | null {
  return value !== null && /^[a-f0-9]{64}$/.test(value) ? value : null;
}

/** Keep the user's original operation in memory, including revision, targets and generated IDs. */
export async function submitOwnerOperation<T extends object, R>(
  body: T,
  proof: OwnerProof,
  send: (input: T & { stepUp: OwnerProof }) => Promise<R>,
  getChallenge: (failure: unknown) => string | null,
  verify: (challenge: string) => Promise<void>,
): Promise<R> {
  try {
    return await send({ ...body, stepUp: proof });
  } catch (failure) {
    const challenge = "managed" in proof && !proof.receipt && operationChallenge(getChallenge(failure));
    if (!challenge) throw failure;
    await verify(challenge);
    return send({ ...body, stepUp: { managed: true, receipt: challenge } });
  }
}

export function verifiedPopupMessage(event: MessageEvent, popup: Window | null, origin: string) {
  return popup !== null && event.source === popup && event.origin === origin && event.data === completionMessage;
}
