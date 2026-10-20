"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useLanguage } from "@/components/LanguageProvider";
import { discardResponseBody } from "@/lib/discardResponseBody";
import { isImageAssetUrlExpired } from "@/lib/imageAssetPayload";
import { getImageModel } from "@/lib/imageModelRegistry";

/**
 * The picture a Tomverse Chat image turn answered with (lib/chatImageTurn.ts),
 * shown in the conversation where a text answer would be.
 *
 * Polls the group (GET /api/images/groups/[groupId]) until every model's
 * current attempt has finished, then stops. Signed URLs are never kept past
 * a reload (docs/policy/image-generation.md §9.2): an expired one is fetched
 * again the moment the picture is asked for.
 */

const POLL_INTERVAL_MS = 4_000;

type GroupAsset = { role: string; url: string; urlExpiresAt?: string };
type GroupGeneration = {
  generationId: string;
  status: string;
  modelId: string | null;
  prompt: string;
  assets: GroupAsset[];
};
type GroupTarget = { targetId: string; modelId: string; currentGenerationId: string | null };
type GroupView = {
  status: string;
  targets: GroupTarget[];
  generations: GroupGeneration[];
};

const isGroupView = (value: unknown): value is GroupView =>
  typeof value === "object" &&
  value !== null &&
  Array.isArray((value as GroupView).targets) &&
  Array.isArray((value as GroupView).generations);

export function ChatImageTurnCard({ groupId }: { groupId: string }) {
  const { t } = useLanguage();
  const [group, setGroup] = useState<GroupView | null>(null);
  const [readFailed, setReadFailed] = useState(false);
  const inFlightRef = useRef(false);
  const [retryingTargetIds, setRetryingTargetIds] = useState<string[]>([]);
  // Why a retry was refused, by target, so a refusal is not mistaken for the
  // original failure showing again.
  const [retryErrors, setRetryErrors] = useState<Record<string, string>>({});

  const refresh = useCallback(async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    try {
      const response = await fetch(`/api/images/groups/${encodeURIComponent(groupId)}`, {
        cache: "no-store",
      });
      if (!response.ok) {
        await discardResponseBody(response);
        // A refused poll is "no update" unless there is nothing to show yet.
        setReadFailed(true);
        return;
      }
      const data: unknown = await response.json();
      if (isGroupView(data)) {
        setGroup(data);
        setReadFailed(false);
      }
    } catch {
      setReadFailed(true);
    } finally {
      inFlightRef.current = false;
    }
  }, [groupId]);

  useEffect(() => {
    queueMicrotask(() => void refresh());
  }, [refresh]);

  // One failed model, run again on the user's press: a new attempt under the
  // same target (POST /api/images/targets/[id]/retry), charged like the first.
  const retry = async (targetId: string) => {
    if (retryingTargetIds.includes(targetId)) return;
    setRetryingTargetIds((current) => [...current, targetId]);
    setRetryErrors((current) =>
      Object.fromEntries(Object.entries(current).filter(([id]) => id !== targetId))
    );
    try {
      const response = await fetch(`/api/images/targets/${encodeURIComponent(targetId)}/retry`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ retryIdempotencyKey: crypto.randomUUID() }),
      });
      if (response.ok) {
        await discardResponseBody(response);
      } else {
        const data: unknown = await response.json().catch(() => null);
        const message = (data as { error?: unknown } | null)?.error;
        setRetryErrors((current) => ({
          ...current,
          [targetId]: typeof message === "string" ? message : t("chat.imageTurnFailed"),
        }));
      }
    } catch {
      setRetryErrors((current) => ({ ...current, [targetId]: t("chat.imageTurnFailed") }));
    } finally {
      setRetryingTargetIds((current) => current.filter((id) => id !== targetId));
      void refresh();
    }
  };

  const inProgress = !group || group.status === "in_progress";
  useEffect(() => {
    if (!inProgress) return;
    const timer = window.setInterval(() => void refresh(), POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [inProgress, refresh]);

  const current = (group?.targets ?? []).map((target) => ({
    target,
    generation:
      group?.generations.find(
        (generation) => generation.generationId === target.currentGenerationId
      ) ?? null,
  }));

  if (!group) {
    return (
      <p data-testid="chat-image-turn-pending" className="text-sm text-zinc-500 dark:text-zinc-400">
        {readFailed ? t("chat.imageTurnFailed") : t("chat.imageTurnGenerating")}
      </p>
    );
  }

  return (
    <div
      data-testid="chat-image-turn"
      className={`grid gap-3 ${current.length > 1 ? "sm:grid-cols-2" : ""}`}
    >
      {current.map(({ target, generation }) => {
        const modelName = getImageModel(target.modelId)?.name ?? target.modelId;
        const asset =
          generation?.assets.find((entry) => entry.role === "original") ??
          generation?.assets[0];
        return (
          <figure key={target.targetId} className="min-w-0">
            {generation?.status === "succeeded" && asset ? (
              // eslint-disable-next-line @next/next/no-img-element -- signed, short-lived R2 URL; the optimizer would cache a link that expires
              <img
                src={asset.url}
                alt={generation.prompt}
                className="w-full max-w-md rounded-xl border border-zinc-200 dark:border-zinc-700"
                onError={() => {
                  if (isImageAssetUrlExpired(asset.urlExpiresAt ?? null, Date.now())) void refresh();
                }}
              />
            ) : generation?.status === "failed" ? (
              <div
                data-testid="chat-image-turn-failed"
                className="rounded-xl border border-zinc-200 p-4 text-sm text-zinc-500 dark:border-zinc-700 dark:text-zinc-400"
              >
                <p>{t("chat.imageTurnFailed")}</p>
                <button
                  type="button"
                  data-testid="chat-image-turn-retry"
                  disabled={retryingTargetIds.includes(target.targetId)}
                  onClick={() => void retry(target.targetId)}
                  className="mt-3 min-h-11 rounded-xl border border-zinc-300 px-4 text-sm font-semibold text-zinc-700 disabled:opacity-50 dark:border-zinc-600 dark:text-zinc-200"
                >
                  {t("chat.imageTurnRetry")}
                </button>
                {retryErrors[target.targetId] ? (
                  <p role="status" className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
                    {retryErrors[target.targetId]}
                  </p>
                ) : null}
              </div>
            ) : (
              <div
                data-testid="chat-image-turn-generating"
                className="flex aspect-square w-full max-w-md items-center justify-center rounded-xl border border-dashed border-zinc-300 text-sm text-zinc-500 dark:border-zinc-700 dark:text-zinc-400"
              >
                {t("chat.imageTurnGenerating")}
              </div>
            )}
            <figcaption className="mt-1 text-[11px] font-semibold text-zinc-500 dark:text-zinc-400">
              {modelName}
            </figcaption>
          </figure>
        );
      })}
    </div>
  );
}
