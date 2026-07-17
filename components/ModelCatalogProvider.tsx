"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  AVAILABLE_MODELS,
  type AiModel,
} from "@/lib/models";

type ModelCatalogContextValue = {
  models: readonly AiModel[];
  enabledModels: readonly AiModel[];
  publicModels: readonly AiModel[];
  getModel: (modelId: string) => AiModel | undefined;
  getEnabledModel: (modelId: string) => AiModel | undefined;
  isEnabledModelId: (modelId: string) => boolean;
  reload: () => Promise<void>;
};

const STATIC_PUBLIC_MODELS: readonly AiModel[] = AVAILABLE_MODELS.filter(
  (model) => (model as AiModel).publiclyListed !== false
);

const fallbackValue = (): ModelCatalogContextValue => {
  const modelMap = new Map<string, AiModel>(
    AVAILABLE_MODELS.map((model) => [model.id, model])
  );
  return {
    models: AVAILABLE_MODELS,
    enabledModels: AVAILABLE_MODELS.filter((model) => model.enabled),
    publicModels: STATIC_PUBLIC_MODELS,
    getModel: (modelId) => modelMap.get(modelId),
    getEnabledModel: (modelId) => {
      const model = modelMap.get(modelId);
      return model?.enabled ? model : undefined;
    },
    isEnabledModelId: (modelId) => modelMap.get(modelId)?.enabled === true,
    reload: async () => undefined,
  };
};

const ModelCatalogContext = createContext<ModelCatalogContextValue>(fallbackValue());

export function ModelCatalogProvider({
  children,
  initialModels = STATIC_PUBLIC_MODELS,
}: {
  children: ReactNode;
  initialModels?: readonly AiModel[];
}) {
  const [models, setModels] = useState<readonly AiModel[]>(initialModels);

  const reload = useCallback(async () => {
    const response = await fetch("/api/models/catalog", { cache: "no-store" });
    const data = (await response.json().catch(() => null)) as
      | { models?: AiModel[] }
      | null;
    if (!response.ok || !Array.isArray(data?.models)) return;
    setModels(data.models);
  }, []);

  useEffect(() => {
    queueMicrotask(() => void reload());
    const handleRegistryUpdate = () => void reload();
    window.addEventListener("tomverse:model-registry-updated", handleRegistryUpdate);
    return () =>
      window.removeEventListener(
        "tomverse:model-registry-updated",
        handleRegistryUpdate
      );
  }, [reload]);

  const value = useMemo<ModelCatalogContextValue>(() => {
    const modelMap = new Map(models.map((model) => [model.id, model]));
    const enabledModels = models.filter(
      (model) => model.enabled && !model.catalogDeleted
    );
    const publicModels = models.filter(
      (model) => model.publiclyListed !== false && !model.catalogDeleted
    );
    return {
      models,
      enabledModels,
      publicModels,
      getModel: (modelId) => modelMap.get(modelId),
      getEnabledModel: (modelId) => {
        const model = modelMap.get(modelId);
        return model?.enabled && !model.catalogDeleted ? model : undefined;
      },
      isEnabledModelId: (modelId) => {
        const model = modelMap.get(modelId);
        return model?.enabled === true && !model.catalogDeleted;
      },
      reload,
    };
  }, [models, reload]);

  return (
    <ModelCatalogContext.Provider value={value}>
      {children}
    </ModelCatalogContext.Provider>
  );
}

export const useModelCatalog = () => useContext(ModelCatalogContext);
