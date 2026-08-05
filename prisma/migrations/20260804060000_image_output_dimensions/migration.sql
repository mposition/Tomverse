-- Records the pixel dimensions of the bytes a provider actually returned.
--
-- Additive and nullable on purpose. `size` stays exactly as written on every
-- existing row: those are financial-audit records and policy section 12.1
-- forbids rewriting them. NULL here means "nobody measured this one", which
-- is true of every generation created before this column existed, and is a
-- different statement from any number we could have back-filled by inferring
-- dimensions from the requested size -- an inference that is wrong for any
-- provider whose tier does not map to those pixels.
ALTER TABLE "ImageGeneration"
  ADD COLUMN "outputWidth" INTEGER,
  ADD COLUMN "outputHeight" INTEGER;
