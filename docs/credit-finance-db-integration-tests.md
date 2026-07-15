# Credit and finance DB integration tests

The financial integration suite runs the production credit reservation, settlement,
reconciliation, Stripe credit purchase, refund, debt, and dispute recovery code against
a real PostgreSQL database.

## Safety requirement

Never point this suite at development, staging, or production data. The runner truncates
financial test data and users between scenarios. `TEST_DATABASE_URL` must point to a
dedicated database or schema whose name contains `test`, `testing`, or `ci`, for example:

```text
postgresql://postgres:password@127.0.0.1:5432/tomverse_test
```

The runner refuses a URL identical to `DATABASE_URL` or `DIRECT_DATABASE_URL`. It applies
all Prisma migrations before running the tests.

## Run locally

PowerShell:

```powershell
$env:TEST_DATABASE_URL="postgresql://postgres:password@127.0.0.1:5432/tomverse_test"
npm run test:db:integration
```

## CI

The `Credit Finance DB Integration` GitHub Actions workflow provisions an ephemeral
PostgreSQL 16 service and runs this suite for every pull request. Configure that check as
a required branch-protection check before paid launch. It does not use the application
database or any Railway database secret.

The suite covers:

- durable reservation creation and idempotent settlement;
- expired reservation reconciliation and refund;
- partial cancellation settlement and unused-credit refund;
- chargeback debt and account hold creation;
- debt-first offset on a later purchase;
- dispute-win restoration;
- concurrent reservation serialization without negative balances.
