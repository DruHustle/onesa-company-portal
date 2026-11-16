# Company billing commissioning checklist

Use this checklist to review the outcome of a billing commissioning exercise. The [Portal repository](https://github.com/DruHustle/onesa-portal) is the canonical source for this component.

- Record the candidate revision, build and purpose of the test.
- Confirm that the designated billing owner has authorized the test environment and approved the commercial inputs.
- Exercise the purchase flow with synthetic data in the provider's test environment. Verify that the account shows the correct result after confirmation.
- Exercise declined and repeated payment events. Confirm that retries preserve the original transaction and that the resulting account state matches the observed provider result.
- Record the operator's acceptance or the outstanding defect, and link the restricted evidence to the release record.

The billing owner authorizes live activation separately. Ask the billing owner for the approved commissioning and recovery procedures. [Onesa Internal Documents](https://docs.internal.onesa.eu) is the designated location for restricted operations guidance.
