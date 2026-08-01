-- Database objects the test harness cannot get from `prisma db push`.
--
-- scripts/run-db-integration-tests.mjs builds the test database with
-- `prisma db push`, which materialises schema.prisma and nothing else. That is
-- deliberate: the migration history does not replay onto an empty database
-- (`20260709120000_align_model_defaults` fails with "relation UserSettings
-- does not exist"), so `prisma migrate deploy` is not an option here today.
--
-- The cost of that choice is every object Prisma's schema language cannot
-- express. Those live only in raw migration SQL, so `db push` silently omits
-- them and any test asserting the *database* enforces a rule passes vacuously
-- or fails outright -- which is how "an account cannot hold two changes in
-- flight at once" failed: it expects the database to reject the second
-- reservation, and the constraint doing the rejecting was never created.
--
-- Everything here must be idempotent, and must match its migration exactly.
-- tests/prismaTestExtras.test.mjs fails if a migration adds a partial unique
-- index that is not mirrored here, so this cannot quietly fall behind.

-- 20260801180000_add_plan_change_request
-- One in-flight change per account. A second confirm cannot create a competing
-- reservation, whatever the application layer does. Partial (`WHERE status =
-- 'pending'`), which @@unique cannot express.
CREATE UNIQUE INDEX IF NOT EXISTS "PlanChangeRequest_userId_active_key"
    ON "PlanChangeRequest"("userId")
    WHERE "status" = 'pending';
