-- Credential bindings and quota scopes, added dark.
--
-- Same condition as the identity tables before them: nothing reads or writes
-- these, `npm run check:dark-tables` holds that, and the routing change that
-- uses them is approved separately.
--
-- A credential is deliberately not part of deployment identity. One deployment
-- is reachable by several credentials -- Tomverse's own and an account's -- and
-- folding the credential in would split the quality, version and health samples
-- by key count. That is a measurement problem wearing a modelling decision: one
-- row of DeepInfra/DeepSeek would become four populations, each too thin to
-- judge.
--
-- BYOK ownership is the account, so there is no workspace entity. A scope that
-- would have pointed at one points at "User" instead.
--
-- The secret is never here. `secretRef` names where it lives.
--
-- ---------------------------------------------------------------------------
-- Why QuotaScope is shaped this way
-- ---------------------------------------------------------------------------
--
-- A single `(scopeKind, scopeId)` pair of strings was the first design and was
-- rejected in review, correctly: nothing would stop a scope id that matched no
-- row, and a limit counted against nothing is indistinguishable from no limit
-- until somebody spends against it. So each kind names its own typed columns,
-- with a foreign key, and a CHECK says which columns that kind requires and
-- which it forbids.
--
-- The partial unique indexes are the other half. CHECKs and foreign keys still
-- allow the same (endpoint, credential) scope to exist twice, and two rows for
-- one scope are two budgets for one thing.
--
-- Rollback: drop the three tables in child-first order. No existing row is read
-- or written, and the two back-relations added to "User" are Prisma-side only.

CREATE TABLE "ProviderRegistryEntry" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProviderRegistryEntry_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CredentialBinding" (
    "id" TEXT NOT NULL,
    "providerEndpointId" TEXT NOT NULL,
    "secretRef" TEXT NOT NULL,
    "billingOwner" TEXT NOT NULL,
    "accountId" TEXT,
    "providerBudgetAccountId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'disabled',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CredentialBinding_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "CredentialBinding"
    ADD CONSTRAINT "CredentialBinding_billingOwner_check"
    CHECK ("billingOwner" IN ('tomverse', 'account'));

ALTER TABLE "CredentialBinding"
    ADD CONSTRAINT "CredentialBinding_status_check"
    CHECK ("status" IN ('disabled', 'active', 'revoked'));

-- An account-funded binding names the account; a Tomverse-funded one does not.
-- Without this, "who is paying for this call" has two possible answers and the
-- settlement takes whichever column happens to be set.
ALTER TABLE "CredentialBinding"
    ADD CONSTRAINT "CredentialBinding_billing_owner_account_check"
    CHECK (
        ("billingOwner" = 'account' AND "accountId" IS NOT NULL)
        OR ("billingOwner" = 'tomverse' AND "accountId" IS NULL)
    );

-- A Tomverse-funded binding spends against a Tomverse provider budget; an
-- account-funded one does not spend against one at all. The separate namespace
-- is the point: an account's own spend must not draw down an allowance
-- Tomverse funded.
ALTER TABLE "CredentialBinding"
    ADD CONSTRAINT "CredentialBinding_budget_account_check"
    CHECK (
        ("billingOwner" = 'tomverse' AND "providerBudgetAccountId" IS NOT NULL)
        OR ("billingOwner" = 'account' AND "providerBudgetAccountId" IS NULL)
    );

CREATE INDEX "CredentialBinding_providerEndpointId_status_idx"
    ON "CredentialBinding"("providerEndpointId", "status");
CREATE INDEX "CredentialBinding_accountId_idx" ON "CredentialBinding"("accountId");

ALTER TABLE "CredentialBinding"
    ADD CONSTRAINT "CredentialBinding_providerEndpointId_fkey"
    FOREIGN KEY ("providerEndpointId") REFERENCES "ProviderEndpoint"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Cascade, matching how the rest of the schema treats account deletion: a
-- person deleting their account takes their own credential binding with them.
--
-- Which is why the scope below cascades from the binding rather than
-- restricting it. A restricting scope would make a quota row able to refuse an
-- account deletion, and operational bookkeeping does not get to outrank that.
-- A scope has no meaning without the binding it counts against, the same way a
-- routing attempt has none without its run.
ALTER TABLE "CredentialBinding"
    ADD CONSTRAINT "CredentialBinding_accountId_fkey"
    FOREIGN KEY ("accountId") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "QuotaScope" (
    "id" TEXT NOT NULL,
    "scopeKind" TEXT NOT NULL,
    "credentialBindingId" TEXT,
    "providerEndpointId" TEXT,
    "modelDeploymentId" TEXT,
    "accountId" TEXT,
    "providerId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "QuotaScope_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "QuotaScope"
    ADD CONSTRAINT "QuotaScope_scopeKind_check"
    CHECK ("scopeKind" IN (
        'credential',
        'endpoint_credential',
        'deployment_credential',
        'account',
        'provider'
    ));

-- Exactly the columns the kind needs, and none of the others. A row that is a
-- `provider` scope carrying a credential id is two scopes wearing one row, and
-- whichever reader looked first would decide which.
ALTER TABLE "QuotaScope"
    ADD CONSTRAINT "QuotaScope_shape_check"
    CHECK (
        ("scopeKind" = 'credential'
            AND "credentialBindingId" IS NOT NULL
            AND "providerEndpointId" IS NULL
            AND "modelDeploymentId" IS NULL
            AND "accountId" IS NULL
            AND "providerId" IS NULL)
        OR ("scopeKind" = 'endpoint_credential'
            AND "credentialBindingId" IS NOT NULL
            AND "providerEndpointId" IS NOT NULL
            AND "modelDeploymentId" IS NULL
            AND "accountId" IS NULL
            AND "providerId" IS NULL)
        OR ("scopeKind" = 'deployment_credential'
            AND "credentialBindingId" IS NOT NULL
            AND "providerEndpointId" IS NULL
            AND "modelDeploymentId" IS NOT NULL
            AND "accountId" IS NULL
            AND "providerId" IS NULL)
        OR ("scopeKind" = 'account'
            AND "credentialBindingId" IS NULL
            AND "providerEndpointId" IS NULL
            AND "modelDeploymentId" IS NULL
            AND "accountId" IS NOT NULL
            AND "providerId" IS NULL)
        OR ("scopeKind" = 'provider'
            AND "credentialBindingId" IS NULL
            AND "providerEndpointId" IS NULL
            AND "modelDeploymentId" IS NULL
            AND "accountId" IS NULL
            AND "providerId" IS NOT NULL)
    );

-- One scope per thing. The CHECK above says a row has the right shape; these
-- say there is only one of it. Two rows for one scope are two budgets for one
-- thing, and the one that runs out first is whichever the reader found.
CREATE UNIQUE INDEX "QuotaScope_credential_key"
    ON "QuotaScope"("credentialBindingId")
    WHERE "scopeKind" = 'credential';
CREATE UNIQUE INDEX "QuotaScope_endpoint_credential_key"
    ON "QuotaScope"("providerEndpointId", "credentialBindingId")
    WHERE "scopeKind" = 'endpoint_credential';
CREATE UNIQUE INDEX "QuotaScope_deployment_credential_key"
    ON "QuotaScope"("modelDeploymentId", "credentialBindingId")
    WHERE "scopeKind" = 'deployment_credential';
CREATE UNIQUE INDEX "QuotaScope_account_key"
    ON "QuotaScope"("accountId")
    WHERE "scopeKind" = 'account';
CREATE UNIQUE INDEX "QuotaScope_provider_key"
    ON "QuotaScope"("providerId")
    WHERE "scopeKind" = 'provider';

CREATE INDEX "QuotaScope_scopeKind_idx" ON "QuotaScope"("scopeKind");

ALTER TABLE "QuotaScope"
    ADD CONSTRAINT "QuotaScope_credentialBindingId_fkey"
    FOREIGN KEY ("credentialBindingId") REFERENCES "CredentialBinding"("id")
    ON DELETE CASCADE ON UPDATE RESTRICT;

ALTER TABLE "QuotaScope"
    ADD CONSTRAINT "QuotaScope_providerEndpointId_fkey"
    FOREIGN KEY ("providerEndpointId") REFERENCES "ProviderEndpoint"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "QuotaScope"
    ADD CONSTRAINT "QuotaScope_modelDeploymentId_fkey"
    FOREIGN KEY ("modelDeploymentId") REFERENCES "ModelDeployment"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "QuotaScope"
    ADD CONSTRAINT "QuotaScope_accountId_fkey"
    FOREIGN KEY ("accountId") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "QuotaScope"
    ADD CONSTRAINT "QuotaScope_providerId_fkey"
    FOREIGN KEY ("providerId") REFERENCES "ProviderRegistryEntry"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT;

-- ---------------------------------------------------------------------------
-- Two rules a CHECK cannot hold
-- ---------------------------------------------------------------------------
--
-- A PostgreSQL CHECK sees one row. These both need another.

-- A `deployment_credential` scope pairs a credential with a placement, and the
-- two have to be on the same endpoint. Nothing above says so: the shape rule
-- forbids the scope from carrying an endpoint id of its own, so the mismatch
-- is invisible to every constraint here. That admits a limit on a pair that
-- cannot happen, which is the failure the typed columns exist to prevent,
-- arrived at from the other side.
CREATE OR REPLACE FUNCTION "quota_scope_pairs_one_endpoint"()
RETURNS TRIGGER AS $$
DECLARE
    binding_endpoint TEXT;
    deployment_endpoint TEXT;
BEGIN
    IF NEW."scopeKind" <> 'deployment_credential' THEN
        RETURN NEW;
    END IF;

    SELECT "providerEndpointId" INTO binding_endpoint
        FROM "CredentialBinding" WHERE "id" = NEW."credentialBindingId";
    SELECT "providerEndpointId" INTO deployment_endpoint
        FROM "ModelDeployment" WHERE "id" = NEW."modelDeploymentId";

    IF binding_endpoint IS DISTINCT FROM deployment_endpoint THEN
        RAISE EXCEPTION
            'QuotaScope pairs a credential on endpoint % with a deployment on endpoint %',
            binding_endpoint, deployment_endpoint
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "quota_scope_pairs_one_endpoint_trigger"
    BEFORE INSERT OR UPDATE ON "QuotaScope"
    FOR EACH ROW
    EXECUTE FUNCTION "quota_scope_pairs_one_endpoint"();

-- What a scope counts against cannot change. An attempt records the scope id
-- it spent under; repointing the row afterwards moves spend that already
-- happened onto a different thing, and nothing in the record would show it.
CREATE OR REPLACE FUNCTION "quota_scope_target_is_immutable"()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW."scopeKind" IS DISTINCT FROM OLD."scopeKind"
        OR NEW."credentialBindingId" IS DISTINCT FROM OLD."credentialBindingId"
        OR NEW."providerEndpointId" IS DISTINCT FROM OLD."providerEndpointId"
        OR NEW."modelDeploymentId" IS DISTINCT FROM OLD."modelDeploymentId"
        OR NEW."accountId" IS DISTINCT FROM OLD."accountId"
        OR NEW."providerId" IS DISTINCT FROM OLD."providerId"
    THEN
        RAISE EXCEPTION
            'QuotaScope % cannot be repointed; create a new scope', OLD."id"
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "quota_scope_target_is_immutable_trigger"
    BEFORE UPDATE ON "QuotaScope"
    FOR EACH ROW
    EXECUTE FUNCTION "quota_scope_target_is_immutable"();
