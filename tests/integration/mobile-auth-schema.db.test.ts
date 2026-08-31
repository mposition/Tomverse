import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, test } from "node:test";
import { prisma } from "@/lib/prisma";

/**
 * What the database refuses about mobile bearer authentication, regardless of
 * what the code writing to it believed.
 *
 * .github/audits/2026-08-31-native-mobile-auth-n2-design-approval.md section 6,
 * approved 2026-08-31. The decision modules beside these tables are pure and
 * already tested; this file is about the half that still holds when a second
 * writer, a retry, or a future code path gets it wrong.
 *
 * Four things are settled here:
 *   - deleting the account takes every device, family, rotation, outstanding
 *     login grant and audit row with it;
 *   - deleting one device ends that device's sessions and no others;
 *   - an audit row cannot name somebody's device or family without naming the
 *     account, so nothing that identifies a person can outlive that cascade;
 *   - the closed lists are closed: a platform, a revocation reason or an event
 *     name outside the approved set is refused at write time rather than read
 *     back later as a state nobody can explain.
 */

const resetMobileAuthData = async () => {
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "MobileAuthEvent",
      "MobileRefreshRotation",
      "MobileTokenFamily",
      "MobileLoginGrant",
      "MobileDevice"
    RESTART IDENTITY CASCADE
  `);
};

const createUser = () =>
  prisma.user.create({
    data: { email: `mobile-auth-${randomUUID()}@example.test` },
  });

const createDevice = (userId: string, label = "Phone") =>
  prisma.mobileDevice.create({
    data: { userId, label, platform: "ios", appVersion: "1.0.0" },
  });

const createFamily = (userId: string, deviceId: string) =>
  prisma.mobileTokenFamily.create({
    data: {
      userId,
      deviceId,
      absoluteExpiresAt: new Date(Date.now() + 180 * 86_400_000),
    },
  });

const createRotation = (familyId: string) =>
  prisma.mobileRefreshRotation.create({
    data: {
      id: `rot_${randomUUID()}`,
      familyId,
      secretDigest: `digest_${randomUUID()}`,
      pepperKid: "pepper-1",
      expiresAt: new Date(Date.now() + 30 * 86_400_000),
    },
  });

beforeEach(resetMobileAuthData);
after(async () => {
  await resetMobileAuthData();
  await prisma.$disconnect();
});

test("deleting the account takes every mobile auth row with it", async () => {
  const user = await createUser();
  const device = await createDevice(user.id);
  const family = await createFamily(user.id, device.id);
  await createRotation(family.id);
  await prisma.mobileLoginGrant.create({
    data: {
      userId: user.id,
      secretDigest: `grant_${randomUUID()}`,
      clientBindingDigest: `binding_${randomUUID()}`,
      expiresAt: new Date(Date.now() + 60_000),
    },
  });
  await prisma.mobileAuthEvent.create({
    data: {
      event: "mobile_auth.exchanged",
      userId: user.id,
      deviceId: device.id,
      familyId: family.id,
    },
  });

  await prisma.user.delete({ where: { id: user.id } });

  assert.equal(await prisma.mobileDevice.count(), 0);
  assert.equal(await prisma.mobileTokenFamily.count(), 0);
  // The one with no user column of its own: it is reached only through the
  // family, so this is the assertion that the two-step cascade actually runs.
  assert.equal(await prisma.mobileRefreshRotation.count(), 0);
  assert.equal(await prisma.mobileLoginGrant.count(), 0);
  assert.equal(await prisma.mobileAuthEvent.count(), 0);
});

test("removing one device ends its sessions and leaves the other device's alone", async () => {
  const user = await createUser();
  const phone = await createDevice(user.id, "Phone");
  const tablet = await createDevice(user.id, "Tablet");
  const phoneFamily = await createFamily(user.id, phone.id);
  const tabletFamily = await createFamily(user.id, tablet.id);
  await createRotation(phoneFamily.id);
  await createRotation(tabletFamily.id);

  await prisma.mobileDevice.delete({ where: { id: phone.id } });

  const families = await prisma.mobileTokenFamily.findMany();
  assert.deepEqual(
    families.map((family) => family.id),
    [tabletFamily.id]
  );
  const rotations = await prisma.mobileRefreshRotation.findMany();
  assert.deepEqual(
    rotations.map((rotation) => rotation.familyId),
    [tabletFamily.id]
  );
});

test("an audit row may name nobody, but may not name a device without an account", async () => {
  const user = await createUser();
  const device = await createDevice(user.id);

  // A refusal that resolved to no account at all: legitimate, and the reason
  // `userId` is nullable in the first place.
  await prisma.mobileAuthEvent.create({
    data: { event: "mobile_auth.refresh_rejected", reason: "unknown_record" },
  });

  await assert.rejects(
    prisma.mobileAuthEvent.create({
      data: { event: "mobile_auth.logged_out", deviceId: device.id },
    }),
    /MobileAuthEvent_subject_identifier_check/
  );
  await assert.rejects(
    prisma.mobileAuthEvent.create({
      data: { event: "mobile_auth.family_revoked", familyId: "some-family" },
    }),
    /MobileAuthEvent_subject_identifier_check/
  );

  assert.equal(await prisma.mobileAuthEvent.count(), 1);
});

test("an account-less refusal survives the account's deletion, naming nothing", async () => {
  // The other half of the constraint above. A row that names nobody is not
  // reached by the cascade, and that is correct rather than a leak: it carries
  // an event name, a reason and a timestamp, and identifies no one.
  const user = await createUser();
  await prisma.mobileAuthEvent.create({
    data: { event: "mobile_auth.refresh_rejected", reason: "unknown_record" },
  });
  await prisma.mobileAuthEvent.create({
    data: { event: "mobile_auth.exchanged", userId: user.id },
  });

  await prisma.user.delete({ where: { id: user.id } });

  const remaining = await prisma.mobileAuthEvent.findMany();
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0]?.userId, null);
  assert.equal(remaining[0]?.deviceId, null);
  assert.equal(remaining[0]?.familyId, null);
});

test("the closed lists are closed", async () => {
  const user = await createUser();

  await assert.rejects(
    prisma.mobileDevice.create({
      data: { userId: user.id, label: "Laptop", platform: "web" },
    }),
    /MobileDevice_platform_check/
  );

  const device = await createDevice(user.id);
  await assert.rejects(
    prisma.mobileDevice.update({
      where: { id: device.id },
      data: { revokedAt: new Date(), revokedReason: "account_deleted" },
    }),
    /MobileDevice_revokedReason_check/
  );

  const family = await createFamily(user.id, device.id);
  await assert.rejects(
    prisma.mobileTokenFamily.update({
      where: { id: family.id },
      data: { revokedAt: new Date(), revokedReason: "expired" },
    }),
    /MobileTokenFamily_revokedReason_check/
  );

  await assert.rejects(
    prisma.mobileAuthEvent.create({
      data: { event: "mobile_auth.made_up", userId: user.id },
    }),
    /MobileAuthEvent_event_check/
  );
});

test("one refresh secret digest cannot be stored twice", async () => {
  // The digest is unique, not the id: the id is the front half of the presented
  // token and is deliberately not a secret, so a collision there would be a
  // generation bug, while a collision here would mean two live families could
  // be advanced by one secret.
  const user = await createUser();
  const device = await createDevice(user.id);
  const first = await createFamily(user.id, device.id);
  const second = await createFamily(user.id, device.id);
  const digest = `digest_${randomUUID()}`;

  await prisma.mobileRefreshRotation.create({
    data: {
      id: `rot_${randomUUID()}`,
      familyId: first.id,
      secretDigest: digest,
      pepperKid: "pepper-1",
      expiresAt: new Date(Date.now() + 30 * 86_400_000),
    },
  });

  await assert.rejects(
    prisma.mobileRefreshRotation.create({
      data: {
        id: `rot_${randomUUID()}`,
        familyId: second.id,
        secretDigest: digest,
        pepperKid: "pepper-1",
        expiresAt: new Date(Date.now() + 30 * 86_400_000),
      },
    }),
    /secretDigest/
  );
});
