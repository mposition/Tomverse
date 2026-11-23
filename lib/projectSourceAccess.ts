import "server-only";

import { retrieveKnowledgeContext } from "@/lib/assistantKnowledgeRetrieval";
import { searchConversationMessages } from "@/lib/conversationSearch";
import { prisma } from "@/lib/prisma";
import { resolveConversationProjectScope } from "@/lib/projectWorkspaceService";

/**
 * One access path for project sources, used by the person (the workspace
 * search box, the reference picker, a citation click) and by the model
 * (project_search / project_read). Every read re-checks owner, project
 * membership and lock against the database; a stored location or receipt is
 * an address, never a grant.
 */

export type ProjectSourceLocation =
    | { kind: "message"; messageId: string; conversationId: string }
    | { kind: "imported"; externalMessageId: string; conversationId: string }
    | { kind: "material"; fileId: string; ordinal: number };

export type ProjectSearchHit = {
    ref: string;
    location: ProjectSourceLocation;
    title: string;
    role: string | null;
    snippet: string;
};

export type ProjectSearchAnswer = {
    status: "ok" | "partial" | "empty";
    hits: ProjectSearchHit[];
    /** Which halves could not finish; reported, never hidden. */
    incomplete: Array<"imported_sources" | "materials">;
};

export const encodeProjectRef = (location: ProjectSourceLocation): string =>
    location.kind === "message"
        ? `m:${location.messageId}`
        : location.kind === "imported"
          ? `x:${location.externalMessageId}:${location.conversationId}`
          : `f:${location.fileId}:${location.ordinal}`;

export function decodeProjectRef(ref: string): ProjectSourceLocation | null {
    if (typeof ref !== "string" || ref.length > 200) return null;
    const parts = ref.split(":");
    const id = /^[A-Za-z0-9_-]{1,80}$/;
    if (parts[0] === "m" && parts.length === 2 && id.test(parts[1])) {
        return { kind: "message", messageId: parts[1], conversationId: "" };
    }
    if (parts[0] === "x" && parts.length === 3 && id.test(parts[1]) && id.test(parts[2])) {
        return { kind: "imported", externalMessageId: parts[1], conversationId: parts[2] };
    }
    if (parts[0] === "f" && parts.length === 3 && id.test(parts[1]) && /^\d{1,6}$/.test(parts[2])) {
        return { kind: "material", fileId: parts[1], ordinal: Number(parts[2]) };
    }
    return null;
}

/** The project's processed material files, decided by the server. */
export type ProjectReceiptSource = {
    ref: string;
    kind: ProjectSourceLocation["kind"];
    title: string;
    via: "context" | "tool";
};

/**
 * What an answer was given, for the owner-only receipt: the references the
 * user picked for this question that were included, the material excerpts
 * retrieved into context, and what the model read with the project tools.
 * A picked reference that was unavailable was not given, so it is not listed.
 */
export function projectReceiptSources(input: {
    references: ReadonlyArray<{ ref: string; status: "included" | "unavailable"; title: string | null }>;
    materials: ReadonlyArray<{ fileId: string; ordinal: number; fileName: string }>;
    tools: ReadonlyArray<{ ref: string; location: ProjectSourceLocation; title: string }>;
}): ProjectReceiptSource[] {
    const sources: ProjectReceiptSource[] = [];
    for (const source of input.references) {
        const location = source.status === "included" ? decodeProjectRef(source.ref) : null;
        if (location) sources.push({ ref: source.ref, kind: location.kind, title: source.title ?? "", via: "context" });
    }
    for (const source of input.materials) {
        sources.push({ ref: `f:${source.fileId}:${source.ordinal}`, kind: "material", title: source.fileName, via: "context" });
    }
    for (const source of input.tools) {
        sources.push({ ref: source.ref, kind: source.location.kind, title: source.title, via: "tool" });
    }
    return sources;
}

export async function readyProjectMaterialIds(userId: string, projectId: string) {
    const rows = await prisma.assistantKnowledgeFile.findMany({
        where: { userId, projectId, processingStatus: "ready", importId: null },
        select: { id: true, digest: true },
        orderBy: { createdAt: "asc" },
    });
    return rows;
}

/**
 * Searches one project's conversations, bridged imported sources and
 * materials. The conversation half is the account search with the project
 * applied inside its queries; locked conversations are never searched here
 * (the request carries no unlock grant), so a lock always wins.
 */
export async function searchProjectSources(input: {
    userId: string;
    projectId: string;
    query: string;
    excludeConversationId?: string;
    requestUrl?: string;
}): Promise<ProjectSearchAnswer> {
    const query = input.query.normalize("NFC").trim();
    if (!query) return { status: "empty", hits: [], incomplete: [] };
    const project = await prisma.conversationProject.findFirst({
        where: { id: input.projectId, userId: input.userId },
        select: { id: true },
    });
    if (!project) return { status: "empty", hits: [], incomplete: [] };

    const incomplete: ProjectSearchAnswer["incomplete"] = [];
    const hits: ProjectSearchHit[] = [];
    // A request without cookies holds no unlock grant: locked sources are out.
    const grantless = new Request(input.requestUrl ?? "http://tomverse.internal/project-search");
    const [conversationAnswer, materials] = await Promise.all([
        searchConversationMessages({
            request: grantless,
            userId: input.userId,
            query,
            displayTimeZone: "UTC",
            projectId: input.projectId,
            excludeConversationId: input.excludeConversationId,
        }).catch(() => null),
        readyProjectMaterialIds(input.userId, input.projectId)
            .then((files) =>
                retrieveKnowledgeContext({
                    userId: input.userId,
                    fileIds: files.map((file) => file.id),
                    query,
                    container: { projectId: input.projectId },
                    semantic: "allow",
                })
            )
            .catch(() => null),
    ]);
    if (!conversationAnswer) {
        incomplete.push("imported_sources");
    } else {
        if (conversationAnswer.sourceSearch === "timed_out") incomplete.push("imported_sources");
        for (const result of conversationAnswer.results) {
            const location: ProjectSourceLocation = result.kind === "native"
                ? { kind: "message", messageId: result.id, conversationId: result.conversationId }
                : { kind: "imported", externalMessageId: result.externalMessageId, conversationId: result.conversationId };
            hits.push({
                ref: encodeProjectRef(location),
                location,
                title: result.conversationTitle,
                role: result.role,
                snippet: result.snippet,
            });
        }
    }
    if (!materials) {
        incomplete.push("materials");
    } else {
        for (const chunk of materials.chunks) {
            const location: ProjectSourceLocation = { kind: "material", fileId: chunk.fileId, ordinal: chunk.ordinal };
            hits.push({
                ref: encodeProjectRef(location),
                location,
                title: chunk.fileName,
                role: null,
                snippet: chunk.content.slice(0, 400),
            });
        }
    }
    return {
        status: incomplete.length > 0 ? "partial" : hits.length === 0 ? "empty" : "ok",
        hits,
        incomplete,
    };
}

export type ProjectSourceRead =
    | { status: "ok"; location: ProjectSourceLocation; title: string; role: string | null; content: string; createdAt: string | null }
    | { status: "unavailable"; reason: "not_found" | "locked" | "outside_project" };

/** Reads one location in full, re-checking access now. */
export async function readProjectSource(input: {
    userId: string;
    projectId: string;
    location: ProjectSourceLocation;
}): Promise<ProjectSourceRead> {
    const { userId, projectId, location } = input;
    if (location.kind === "message") {
        const row = await prisma.message.findFirst({
            where: { id: location.messageId, conversation: { userId } },
            select: {
                id: true, role: true, content: true, createdAt: true,
                conversation: { select: { id: true, title: true, projectId: true, password: true } },
            },
        });
        if (!row) return { status: "unavailable", reason: "not_found" };
        if (row.conversation.projectId !== projectId) return { status: "unavailable", reason: "outside_project" };
        if (row.conversation.password !== null) return { status: "unavailable", reason: "locked" };
        return {
            status: "ok",
            location: { kind: "message", messageId: row.id, conversationId: row.conversation.id },
            title: row.conversation.title,
            role: row.role,
            content: row.content,
            createdAt: row.createdAt.toISOString(),
        };
    }
    if (location.kind === "imported") {
        const target = await prisma.conversation.findFirst({
            where: { id: location.conversationId, userId },
            select: {
                projectId: true, password: true, title: true,
                continuationBridge: { select: { userId: true, externalConversationId: true } },
            },
        });
        if (!target || !target.continuationBridge || target.continuationBridge.userId !== userId) {
            return { status: "unavailable", reason: "not_found" };
        }
        if (target.projectId !== projectId) return { status: "unavailable", reason: "outside_project" };
        if (target.password !== null) return { status: "unavailable", reason: "locked" };
        const message = await prisma.externalMessage.findFirst({
            where: {
                id: location.externalMessageId,
                userId,
                externalConversationId: target.continuationBridge.externalConversationId ?? "__none__",
            },
            select: { role: true, content: true, sourceTimestamp: true, conversation: { select: { password: true, title: true } } },
        });
        if (!message) return { status: "unavailable", reason: "not_found" };
        if (message.conversation.password !== null) return { status: "unavailable", reason: "locked" };
        return {
            status: "ok",
            location,
            title: target.title,
            role: message.role,
            content: message.content,
            createdAt: message.sourceTimestamp?.toISOString() ?? null,
        };
    }
    const chunk = await prisma.assistantKnowledgeChunk.findFirst({
        where: {
            userId,
            fileId: location.fileId,
            ordinal: location.ordinal,
            file: { projectId, processingStatus: "ready" },
        },
        select: { content: true, file: { select: { name: true, createdAt: true } } },
    });
    if (!chunk) return { status: "unavailable", reason: "not_found" };
    return {
        status: "ok",
        location,
        title: chunk.file.name,
        role: null,
        content: chunk.content,
        createdAt: chunk.file.createdAt.toISOString(),
    };
}

/** For the model and the UI: is this conversation still answering inside this project's context? */
export async function projectScopeStillCurrent(input: {
    userId: string;
    conversationId: string;
    projectId: string;
    revision: number;
}) {
    const scope = await resolveConversationProjectScope(input.userId, input.conversationId);
    return Boolean(scope && scope.projectId === input.projectId && scope.revision === input.revision &&
        scope.contextEnabled && !scope.archived);
}
