# Automated release qualification

Review the checks for the candidate commit in the [Portal repository](https://github.com/DruHustle/onesa-portal). Each result should identify the revision, the component that was tested, the workflow run and its outcome. A failed or missing required check leaves the candidate unqualified.

Staging qualification exercises the affected user workflows in an isolated environment. Record the observed result against the same candidate. If a test fails, keep the failure record, correct the cause and qualify the revised candidate. Production acceptance also requires a check against the component actually serving users.

See the [release checklist](../../RELEASE_CHECKLIST.md) for acceptance requirements and the [deployment reference](DEPLOYMENT.md#primary-release-path) for the release sequence. Ask the release owner for the approved qualification procedure and access to the evidence record. [Onesa Internal Documents](https://docs.internal.onesa.eu) is the designated location for restricted operations guidance.
