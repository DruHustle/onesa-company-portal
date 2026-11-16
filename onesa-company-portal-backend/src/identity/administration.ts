/** An activated managed login always delegates global account administration. Legacy deployments can migrate administration separately. */
export function externalIdentityAdministration() {
  return process.env.ONESA_IDENTITY_PORTAL_LOGIN === "managed" || process.env.ONESA_IDENTITY_ADMINISTRATION === "external";
}

const retiredOperations = new Set([
  "listUsers", "createUser", "updateUser",
  "listAccessRequests", "reviewAccessRequest",
  "listEngineeringMemberships", "saveEngineeringMembership",
  "listOnesaAccounts", "setOnesaMemberStatus", "setOnesaProductAccess", "setOnesaAdministrator",
  "requestAccessRegistration", "confirmAccessRegistration", "enrollOnesaAdministratorForDocs",
  "registerOnesaAccount", "confirmOnesaAccount", "requestOnesaProductAccess",
]);

export function delegatedAccountOperation(operationId?: string) {
  return operationId !== undefined && retiredOperations.has(operationId);
}
