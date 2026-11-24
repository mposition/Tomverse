export const IMAGE_WORKSPACE_QUERY = "new";
export const IMAGE_WORKSPACE_VALUE = "image";
export const IMAGE_WORKSPACE_WEB_PATH = `/chat?${IMAGE_WORKSPACE_QUERY}=${IMAGE_WORKSPACE_VALUE}`;

export function requestsImageWorkspace(search: Pick<URLSearchParams, "getAll">): boolean {
  const values = search.getAll(IMAGE_WORKSPACE_QUERY);
  return values.length === 1 && values[0] === IMAGE_WORKSPACE_VALUE;
}
