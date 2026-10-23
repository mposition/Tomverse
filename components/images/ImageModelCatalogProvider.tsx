"use client";

import { createContext, useContext, useMemo, type ReactNode } from "react";
import {
  findImageModel,
  findImageModelPrice,
  IMAGE_MODEL_REGISTRY,
  type ImageModelOptionPrice,
  type ImageModelProfile,
} from "@/lib/imageModelRegistry";

/**
 * The image catalogue the server priced this page with, handed to client
 * components through React context instead of a module global.
 *
 * A module global written during render is shared between server requests
 * (one request could read another's catalogue) and does not reset when the
 * input goes away. Context is scoped to the rendered tree, so neither can
 * happen. Without a provider the code seed is served, which is also what the
 * server falls back to when the database cannot be read.
 */
type ImageModelCatalogValue = {
  models: readonly ImageModelProfile[];
  enabledModels: readonly ImageModelProfile[];
  getModel: (modelId: string) => ImageModelProfile | null;
  getPrice: (
    modelId: string,
    quality: string,
    size: string
  ) => ImageModelOptionPrice | null;
};

const buildValue = (
  models: readonly ImageModelProfile[]
): ImageModelCatalogValue => ({
  models,
  enabledModels: models.filter((model) => model.disabledReason === null),
  getModel: (modelId) => findImageModel(models, modelId),
  getPrice: (modelId, quality, size) =>
    findImageModelPrice(models, modelId, quality, size),
});

const ImageModelCatalogContext = createContext<ImageModelCatalogValue>(
  buildValue(IMAGE_MODEL_REGISTRY)
);

export function ImageModelCatalogProvider({
  models,
  children,
}: {
  /** Undefined (image generation off, or no server copy) serves the code seed. */
  models?: readonly ImageModelProfile[];
  children: ReactNode;
}) {
  const value = useMemo(
    () => buildValue(models ?? IMAGE_MODEL_REGISTRY),
    [models]
  );
  return (
    <ImageModelCatalogContext.Provider value={value}>
      {children}
    </ImageModelCatalogContext.Provider>
  );
}

export const useImageModelCatalog = () => useContext(ImageModelCatalogContext);
