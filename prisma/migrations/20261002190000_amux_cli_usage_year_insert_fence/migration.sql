-- Dark v25 provider-year insertion fence. The aggregate finalizer must acquire
-- the same transaction advisory lock BEFORE reading receipts, then publish its
-- immutable seal in that transaction. This migration enables no collector,
-- finalizer, purge, Admin reader, switch, or runtime scheduling by itself.
-- Existing receipt rows, if any, retain their immutable timestamps and bytes.
-- The current receipt does not attest an actual provider: every receipt belongs
-- to actualProviderUnknown. The two-int advisory key is year-wide, not a
-- provider-specific lock. A new attested-provider path needs a separate gate.
CREATE OR REPLACE FUNCTION amux_cli_usage_set_recorded_at() RETURNS trigger
LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog AS $$
DECLARE
  usage_year INTEGER;
  year_sealed BOOLEAN;
BEGIN
  -- VOLATILE function plus READ COMMITTED is required: after an advisory-lock
  -- wait, the seal SELECT must see a seal committed during that wait.
  IF pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'AMUX CLI usage insertion requires READ COMMITTED'
      USING ERRCODE = 'AX006';
  END IF;
  NEW."recordedAt" := clock_timestamp();
  usage_year := EXTRACT(YEAR FROM NEW."recordedAt" AT TIME ZONE 'UTC')::INTEGER;
  -- 0x414D5558 is AMUX. Shared xact locks allow concurrent receipts, while
  -- the future finalizer takes the exclusive lock BEFORE its first read.
  -- Both lock modes are held through COMMIT across a UTC year boundary.
  PERFORM pg_catalog.pg_advisory_xact_lock_shared(1095587160, usage_year);
  EXECUTE pg_catalog.format(
    'SELECT EXISTS (SELECT 1 FROM %I."AmuxCliUsageAggregateFinalization" WHERE "year" = $1 AND "providerScopeKey" = ''actualProviderUnknown'')',
    TG_TABLE_SCHEMA
  ) INTO year_sealed USING usage_year;
  IF year_sealed THEN
    RAISE EXCEPTION 'AMUX CLI usage year has an immutable finalization'
      USING ERRCODE = 'AX005';
  END IF;
  RETURN NEW;
END;
$$;
