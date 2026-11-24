-- Keep the mobile labels and add one coarse label for Tomverse Desktop.
ALTER TABLE "MobileDevice" DROP CONSTRAINT "MobileDevice_platform_check";
ALTER TABLE "MobileDevice" ADD CONSTRAINT "MobileDevice_platform_check"
  CHECK ("platform" IN ('ios', 'android', 'desktop'));
