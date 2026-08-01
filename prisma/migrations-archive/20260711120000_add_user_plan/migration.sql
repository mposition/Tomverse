ALTER TABLE "User"
    ADD COLUMN "plan" TEXT NOT NULL DEFAULT 'Free';

ALTER TABLE "User"
    ADD CONSTRAINT "User_plan_check" CHECK ("plan" IN ('Free', 'Pro', 'Max'));
