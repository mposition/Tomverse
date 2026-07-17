export type InfrastructureStatus =
  | "healthy"
  | "warning"
  | "unconfigured"
  | "error";

export type RailwayUsageMeasurement = {
  measurement: string;
  estimatedValue: number;
  unit: string;
  estimatedCostMicroUsd: number | null;
  projectId: string | null;
};

export type RailwayInfrastructureSnapshot = {
  status: InfrastructureStatus;
  message: string;
  tokenConfigured: boolean;
  scope: "workspace" | "project" | "none";
  projectedMonthCostMicroUsd: number | null;
  configuredCreditMicroUsd: number | null;
  projectedBalanceMicroUsd: number | null;
  creditNote: string | null;
  warningReasons: Array<{
    code: string;
    detail: string;
  }>;
  measurements: RailwayUsageMeasurement[];
  apiRateLimit: {
    limit: number | null;
    remaining: number | null;
    resetAt: string | null;
  };
  checkedAt: string;
};

export type R2InfrastructureSnapshot = {
  status: InfrastructureStatus;
  message: string;
  bucketName: string | null;
  objectCredentialsConfigured: boolean;
  analyticsTokenConfigured: boolean;
  storageBytes: number | null;
  metadataBytes: number | null;
  objectCount: number | null;
  pendingUploads: number | null;
  classAOperations: number | null;
  classBOperations: number | null;
  unclassifiedOperations: number | null;
  storageAllowancePercent: number | null;
  classAAllowancePercent: number | null;
  classBAllowancePercent: number | null;
  checkedAt: string;
};

export type DatabaseInfrastructureSnapshot = {
  status: "healthy" | "warning" | "error";
  message: string;
  activeSessions: number;
  conversations: number;
  messages: number;
  usageBuckets: number;
  providerErrors24h: number;
  providerErrorsPendingCleanup: number;
  checkedAt: string;
};

export type PrismaUsageInfrastructureSnapshot = {
  status: InfrastructureStatus;
  message: string;
  tokenConfigured: boolean;
  databaseIdConfigured: boolean;
  operationsUsed: number | null;
  operationsLimit: number;
  operationsAllowancePercent: number | null;
  storageGiB: number | null;
  periodStart: string | null;
  periodEnd: string | null;
  checkedAt: string;
};

export type InfrastructureDashboard = {
  generatedAt: string;
  railway: RailwayInfrastructureSnapshot;
  r2: R2InfrastructureSnapshot;
  database: DatabaseInfrastructureSnapshot;
  prismaUsage: PrismaUsageInfrastructureSnapshot;
};
