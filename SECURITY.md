# Security policy

minshop handles checkout, payment webhooks, and merchant credentials, so
security reports get priority over everything else.

## Reporting a vulnerability

Use GitHub's private reporting:
[Report a vulnerability](https://github.com/ddyy/minshop/security/advisories/new).
That opens a private advisory only the maintainer can see, keeps the whole
thread in one place, and credits you if the report leads to a fix. If you'd
rather not use GitHub, email **dev@daniel-yang.com**.

Either way, include a description, steps to reproduce, and the impact you
believe it has. Please don't open a public issue for anything exploitable.
You'll get an acknowledgment within 72 hours and a fix or a plan before any
public disclosure. Reports that include a working proof of concept
against a local or demo store are the fastest to act on.

Please don't test against stores you don't own. The
[live demo](https://demo.minshop.dev/) uses test payments only, but it's a
shared instance; spin up your own with `npm create minshop@latest` instead.

## Supported versions

The `main` branch and the latest tagged release. There are no backports; fixes
ship as a new release.

## Scope notes

- Provider credentials (Stripe, Shippo, email, Lightning) are stored in D1
  encrypted under `SECRETS_KEK` and are write-only from Admin. Anything that
  lets them be read back is in scope and severe.
- The demo payment rail is intentionally fake and places test orders; that's
  a feature, not a finding.
- Vulnerabilities in upstream dependencies (Astro, wrangler, provider SDKs)
  are best reported upstream, but a note here is welcome if minshop's usage
  makes them exploitable.
