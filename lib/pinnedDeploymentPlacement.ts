/**
 * The only runtime writer for a stored deployment row.
 *
 * The id comes back from the insert. This module does not accept one, and it
 * does not invent an upstream deployment: the row is stored only when its
 * provider, endpoint and model name are the ones the existing client already
 * calls. The credential stays in the environment the client already reads.
 * The deployment and endpoint tables stay dark to every other file.
 */

import { AVAILABLE_MODELS } from "@/lib/models";
import { PROVIDER_API_CONFIGURATION } from "@/lib/modelRegistryShared";

export type LivePlacementClaim = {
    logicalModelId: string;
    gatewayProvider: string;
    servingProvider: string | null;
    endpointUrl: string;
    upstreamDeploymentName: string;
};

export type LiveCatalogueModel = {
    id: string;
    provider: string;
    apiModel: string;
    enabled: boolean;
    contextWindowTokens?: number;
};

export type MatchedLivePlacement = {
    logicalModelId: string;
    provider: string;
    upstreamDeploymentName: string;
    endpointUrl: string;
    contextWindowTokens: number | null;
};

const sameText = (left: string | null, right: string) =>
    typeof left === "string" && left.length > 0 && left === right;

/**
 * A stored row matches the live call only when every field is the catalogue's
 * field. The comparison does not trim or rewrite a URL: a different spelling
 * is a different target.
 */
export const matchLivePlacement = (
    claim: LivePlacementClaim,
    catalogue: readonly LiveCatalogueModel[] = AVAILABLE_MODELS,
    endpoints: Readonly<Record<string, { baseUrl: string }>> = PROVIDER_API_CONFIGURATION
): { ok: true } & MatchedLivePlacement | { ok: false; reason: "deployment_mismatch" } => {
    const model = catalogue.find((entry) => entry.id === claim.logicalModelId);
    const endpoint = model ? endpoints[model.provider] : undefined;
    if (!model?.enabled || !endpoint) return { ok: false, reason: "deployment_mismatch" };
    if (!sameText(claim.gatewayProvider, model.provider)) {
        return { ok: false, reason: "deployment_mismatch" };
    }
    if (!sameText(claim.servingProvider, model.provider)) {
        return { ok: false, reason: "deployment_mismatch" };
    }
    if (!sameText(claim.endpointUrl, endpoint.baseUrl)) {
        return { ok: false, reason: "deployment_mismatch" };
    }
    if (!sameText(claim.upstreamDeploymentName, model.apiModel)) {
        return { ok: false, reason: "deployment_mismatch" };
    }
    return {
        ok: true,
        logicalModelId: model.id,
        provider: model.provider,
        upstreamDeploymentName: model.apiModel,
        endpointUrl: endpoint.baseUrl,
        contextWindowTokens: model.contextWindowTokens ?? null,
    };
};

type EndpointRow = {
    id: string;
    gatewayProvider: string;
    servingProvider: string | null;
    endpointUrl: string | null;
};

type DeploymentRow = {
    id: string;
    logicalModelId: string;
    upstreamDeploymentName: string;
    providerEndpointId: string;
};

export type PlacementDb = {
    providerEndpoint: {
        create(args: {
            data: {
                gatewayProvider: string;
                servingProvider: string;
                endpointUrl: string;
                residencyClass: "unproven";
                enabled: false;
            };
            select: { id: true };
        }): Promise<{ id: string }>;
        findUnique(args: {
            where: { id: string };
            select: {
                id: true;
                gatewayProvider: true;
                servingProvider: true;
                endpointUrl: true;
            };
        }): Promise<EndpointRow | null>;
    };
    modelDeployment: {
        create(args: {
            data: {
                logicalModelId: string;
                providerEndpointId: string;
                upstreamDeploymentName: string;
                enabled: false;
            };
            select: { id: true };
        }): Promise<{ id: string }>;
        findUnique(args: {
            where: { id: string };
            select: {
                id: true;
                logicalModelId: true;
                upstreamDeploymentName: true;
                providerEndpointId: true;
            };
        }): Promise<DeploymentRow | null>;
    };
};

export const placementWriteData = (matched: MatchedLivePlacement, endpointId: string) => ({
    endpoint: {
        gatewayProvider: matched.provider,
        servingProvider: matched.provider,
        endpointUrl: matched.endpointUrl,
        residencyClass: "unproven" as const,
        enabled: false as const,
    },
    deployment: {
        logicalModelId: matched.logicalModelId,
        providerEndpointId: endpointId,
        upstreamDeploymentName: matched.upstreamDeploymentName,
        enabled: false as const,
    },
});

/**
 * Inserts the endpoint and the deployment, then returns the deployment id
 * the database returned. The claim has no id field, and neither write copies
 * one in from the caller.
 */
export const createLivePlacement = async (
    db: PlacementDb,
    claim: LivePlacementClaim
): Promise<
    | { ok: true; deploymentId: string }
    | { ok: false; reason: "deployment_mismatch" }
> => {
    const matched = matchLivePlacement(claim);
    if (!matched.ok) return matched;
    const endpoint = await db.providerEndpoint.create({
        data: placementWriteData(matched, "").endpoint,
        select: { id: true },
    });
    if (!endpoint.id) return { ok: false, reason: "deployment_mismatch" };
    const deployment = await db.modelDeployment.create({
        data: placementWriteData(matched, endpoint.id).deployment,
        select: { id: true },
    });
    if (!deployment.id) return { ok: false, reason: "deployment_mismatch" };
    return { ok: true, deploymentId: deployment.id };
};

export const readStoredPlacement = async (
    db: PlacementDb,
    deploymentId: string
): Promise<{ deploymentId: string; claim: LivePlacementClaim } | null> => {
    if (deploymentId.length === 0 || deploymentId !== deploymentId.trim()) return null;
    const deployment = await db.modelDeployment.findUnique({
        where: { id: deploymentId },
        select: {
            id: true,
            logicalModelId: true,
            upstreamDeploymentName: true,
            providerEndpointId: true,
        },
    });
    if (!deployment?.id || !deployment.providerEndpointId) return null;
    const endpoint = await db.providerEndpoint.findUnique({
        where: { id: deployment.providerEndpointId },
        select: {
            id: true,
            gatewayProvider: true,
            servingProvider: true,
            endpointUrl: true,
        },
    });
    if (!endpoint?.endpointUrl) return null;
    return {
        deploymentId: deployment.id,
        claim: {
            logicalModelId: deployment.logicalModelId,
            gatewayProvider: endpoint.gatewayProvider,
            servingProvider: endpoint.servingProvider,
            endpointUrl: endpoint.endpointUrl,
            upstreamDeploymentName: deployment.upstreamDeploymentName,
        },
    };
};
