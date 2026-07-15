const DAY_IN_MILLISECONDS = 24 * 60 * 60 * 1000;

export const MODEL_FINDER_SNOOZE_DAYS = 3;

export const getModelFinderReappearsAt = (
  dismissedAt: Date | null | undefined
) =>
  dismissedAt
    ? new Date(
        dismissedAt.getTime() +
          MODEL_FINDER_SNOOZE_DAYS * DAY_IN_MILLISECONDS
      )
    : null;

export const shouldAutoShowModelFinder = ({
  completedAt,
  dismissedAt,
  now = new Date(),
}: {
  completedAt: Date | null | undefined;
  dismissedAt: Date | null | undefined;
  now?: Date;
}) => {
  if (completedAt) return false;
  const reappearsAt = getModelFinderReappearsAt(dismissedAt);
  return !reappearsAt || reappearsAt.getTime() <= now.getTime();
};
