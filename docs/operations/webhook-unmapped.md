# Runbook — `webhook:unmapped` (a Stripe subscription that matches no account)

**Owner:** the operator (sole merge/deploy authority — there is no on-call rotation and no second
human, per `docs/PR_WORKFLOW.md` §0).
**Written for:** #142 / #144. Closes the "defined owner and runbook step" acceptance criterion.
**Applies to:** production and staging Stripe accounts.

---

## 1. What the audit row means

A Stripe webhook arrived for a subscription whose owner could not be resolved:

- `subscription.metadata.solara_user_id` names no `users` row, **and**
- `users.stripe_customer_id` has no match, **and**
- no `account:delete` audit row proves the account was deleted (neither targeting the user id nor
  targeting the Stripe customer id).

Actions recorded on `audit_logs.target` = the **subscription id**:

| Action | Meaning | Money still moving? |
|---|---|---|
| `webhook:unmapped` | Nothing proved the account was deleted. **Quarantined for a human.** | **Possibly yes** |
| `webhook:unmapped_deletion_detected` | Deletion was proven, but the cancellation was not attempted/succeeded | **Yes** |
| `webhook:unmapped_cancelled` | Deletion was proven and Stripe confirmed the cancellation | No |

The distinction is deliberate: cancelling on "unmapped" alone is irreversible and would also cancel
subscriptions belonging to somebody else on the same Stripe account, or to a real user whose mapping
is merely mid-repair. **The code never cancels without proof of deletion. A human decides in the
two non-final states.**

## 2. Triage (run these in order)

```bash
# 1. Is the subscription still alive in Stripe? (status, customer, metadata)
stripe subscriptions retrieve "$SUB_ID"

# 2. Does an account claim it?
stripe customers retrieve "$CUSTOMER_ID" --expand subscriptions

# 3. What does our trail say? (read-only psql against the target environment)
select action, target, actor_id, created_at
from audit_logs
where target in ('<SUB_ID>', '<CUSTOMER_ID>', '<USER_ID_IF_KNOWN>')
order by created_at desc;
```

Then classify:

| Finding | Action |
|---|---|
| An `account:delete` row targets the customer id | The account **is** gone: cancel the subscription (`stripe subscriptions cancel "$SUB_ID"`), then confirm a `webhook:unmapped_cancelled` row appears on the next webhook, or record the manual cancellation in the PR/issue. |
| The user still exists but `metadata.solara_user_id` is missing/wrong | **Repair, do not cancel.** Re-link the subscription to the user and let the webhook re-apply it. |
| No user, no deletion evidence, subscription is a duplicate/test artefact | Cancel, and record *why* in the issue. |
| No user, no deletion evidence, subscription is a real customer's | **Stop and escalate to the operator before cancelling.** This is the case the quarantine exists for. |

## 3. What not to do

- **Do not cancel on `webhook:unmapped` alone.** It is not evidence of deletion; the code refuses for
  the same reason.
- **Do not delete a Stripe customer row to tidy up.** It cancels their subscriptions silently and is
  irreversible; `stripe customers del` is only used in checkout cleanup for a customer created
  seconds earlier for an account that no longer exists.
- **Do not "fix" an unmapped subscription by editing `metadata` only.** The next webhook will
  re-resolve, but the `subscriptions` row still has to be written for access and reporting.

## 4. Why this is a runbook and not automation

Automating "cancel anything unmapped" trades a rare manual step for a rare irreversible charge to
the wrong customer. Automating "cancel anything unmapped **and** proven deleted" is what the code
already does at the webhook. The remaining cases are exactly the ones that need a judgement call
about which human or customer the record belongs to — so the automation stops there on purpose, and
this document is the owner the acceptance criterion asks for.

## 5. Detection gap worth knowing

There is no sweeper reconciling Stripe against the database. An orphaned customer whose subscription
never fires another webhook stays invisible until someone looks. Filed as future work in
`docs/plan-142-account-deletion-hardening.md` §6.
