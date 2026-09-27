-- A published manifest entry must name its pin.
--
-- 20260923390000 gave RoutingIdentityManifestEntry.versionPinStrength and
-- allowVersionDrift database defaults. The Prisma model does not. An insert
-- that omitted the pin would have stored strong / false, and the entry is
-- immutable, so that omission could not be corrected.
--
-- ModelDeployment keeps its defaults. Those rows can predate the column, and
-- the default is what stops an old placement drifting by omission.
--
-- No row is written. Both tables stay dark.
--
-- Rollback: set the two entry defaults back to 'strong' and false, only while
-- no published entry relies on an omitted pin failing the insert.

ALTER TABLE "RoutingIdentityManifestEntry" ALTER COLUMN "versionPinStrength" DROP DEFAULT;
ALTER TABLE "RoutingIdentityManifestEntry" ALTER COLUMN "allowVersionDrift" DROP DEFAULT;
