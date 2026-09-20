CREATE TABLE "AmuxWorkerRuntime" (
    "workerName" TEXT NOT NULL,
    "instanceId" TEXT NOT NULL,
    "generation" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'starting',
    "dispatchReady" BOOLEAN NOT NULL DEFAULT false,
    "heartbeatAt" TIMESTAMP(3) NOT NULL,
    "leaseExpiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AmuxWorkerRuntime_pkey"
        PRIMARY KEY ("workerName"),

    CONSTRAINT "AmuxWorkerRuntime_generation_check"
        CHECK ("generation" >= 1),

    CONSTRAINT "AmuxWorkerRuntime_status_check"
        CHECK (
          "status" IN (
            'starting',
            'idle',
            'busy',
            'error',
            'stopped'
          )
        ),

    CONSTRAINT "AmuxWorkerRuntime_dispatch_ready_check"
        CHECK (
          NOT "dispatchReady"
          OR "status" = 'idle'
        )
);

CREATE INDEX "AmuxWorkerRuntime_leaseExpiresAt_idx"
    ON "AmuxWorkerRuntime"("leaseExpiresAt");

CREATE INDEX "AmuxWorkerRuntime_status_dispatchReady_leaseExpiresAt_idx"
    ON "AmuxWorkerRuntime"(
      "status",
      "dispatchReady",
      "leaseExpiresAt"
    );

CREATE INDEX "AmuxWorkerRuntime_instanceId_generation_idx"
    ON "AmuxWorkerRuntime"(
      "instanceId",
      "generation"
    );
