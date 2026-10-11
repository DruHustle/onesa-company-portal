# Main protection activation and recovery

**Prepared only — NOT ENFORCED as of 2026-10-10T21:30:44+02:00.** GitHub rejected both writes with its Pro-plan requirement. No upgrade or visibility change is authorized by this configuration.

The owner selected GitHub Free. Use [the Free operating plan](../FREE_GITHUB_PLAN.md) for current work. The following procedure is a future reference only; do not upgrade, change visibility or repeatedly attempt activation under the current blocked eligibility.

## Future activation by an authorized administrator

1. Verify repository `DruHustle/onesa-company-portal`, default main, admin permission, current plan eligibility, collaborators and current remote workflows. Publish the check-name disambiguation described in the report through a reviewed PR before enforcing checks.
2. Read `gh api repos/DruHustle/onesa-company-portal/rulesets?includes_parents=true`, `gh api repos/DruHustle/onesa-company-portal/branches/main/protection` and `gh api repos/DruHustle/onesa-company-portal/rules/branches/main`. A 403 is a blocker, not an empty result. An eligible branch-protection 404 can mean no rule. Inspect all existing ruleset details; amend an applicable rule rather than creating a conflicting duplicate. Never weaken existing meaningful security checks.
3. Confirm every context in `main.ruleset.json` appears uniquely in recent PR check runs from GitHub Actions app 15368 and runs on every relevant PR. Recheck current team size; use the prepared zero-approval count only while no independent reviewer exists. Inspect merge methods and ensure a normal PR can merge with no bypass.
4. If no applicable protection exists, from the repository root use the prepared request:

```sh
gh api --method POST repos/DruHustle/onesa-company-portal/rulesets --input docs/development/branch-protection/main.ruleset.json
```

If repository rulesets are unsupported but classic protection is eligible and no equivalent rule exists, use the fallback **instead**:

```sh
gh api --method PUT repos/DruHustle/onesa-company-portal/branches/main/protection --input docs/development/branch-protection/main.branch-protection.json
```

5. Read back the returned ruleset ID and its `enforcement`, target, conditions, every rule, required contexts/source IDs and empty bypass list. Check effective branch rules and `branches/main` protection. For classic protection, read every corresponding field including enforce_admins and bypass allowances. Save evidence in the report; a successful write alone is insufficient.
6. Open a temporary benign PR without production deployment actions. Observe it blocked while mandatory checks are pending. Use a deliberate harmless failing scaffold/test assertion on the temporary feature branch, verify the required failure prevents merge, then remove it with a normal follow-up commit. Record merge eligibility after all checks pass. Change main only through a separately authorized legitimate PR, synchronize the temporary PR, and confirm checks rerun and strict synchronization works. Do not attempt a force push or deletion. Do not merge test code.
7. Close the temporary PR without merging. Update enforcement classification only after effective-rule/readback and mergeability evidence agree. Do not delete branches as part of this task.

## Emergency recovery

Ordinary Codex work must use PRs and may never invoke emergency bypass. An authorized administrator should record the incident privately (reason, affected revision, rule ID, previous JSON and time), export the actual current rule, and change only the misconfigured parameter through GitHub settings or the matching update API. Preserve all unaffected security gates. If temporary disablement is unavoidable for recovery, time-limit it, restrict repository write access during the incident where practical and document every action. Avoid a permanent all-admin/App bypass. Restore the original policy promptly, reread effective rules, rerun CI and record restoration evidence and independent incident review when a reviewer is available. Never recover by force-pushing/deleting main, changing visibility, silently upgrading billing or modifying credentials.
