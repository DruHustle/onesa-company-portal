/** Every deployed Portal delegates global account administration to Onesa Identity. Only isolated test runs may exercise the legacy local administration routes. */
export function externalIdentityAdministration() {
  return process.env.NODE_ENV !== "test" || process.env.ONESA_IDENTITY_ADMINISTRATION === "external";
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
