-- The live invariant evaluation is much more expensive than the cheap health alias.
-- Older rows shared /api/health's latency baseline and filed a false regression.
UPDATE _amux_request_log
SET family = '/api/health/invariants'
WHERE family = '/api/health' AND path = '/api/health/invariants';
