/**
 * The console's one card. A section of a page is a tile: a title, an optional
 * one-line description, an optional action on the right, and its content.
 *
 * Use a tile only for a real grouping; a list inside a tile separates its rows
 * with a top border, not with more cards.
 */
export function AdminTile({
  title,
  description,
  action,
  children,
  className = "",
  as: Tag = "section",
  ...rest
}: {
  title?: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
  as?: "section" | "div" | "article";
} & Omit<React.HTMLAttributes<HTMLElement>, "title">) {
  return (
    <Tag
      {...rest}
      className={`flex min-w-0 flex-col gap-3 rounded-2xl border border-zinc-800 bg-zinc-900 p-5 ${className}`}
    >
      {title || description || action ? (
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            {title ? <h2 className="text-base font-bold text-white">{title}</h2> : null}
            {description ? (
              <p className="mt-0.5 text-sm text-zinc-400">{description}</p>
            ) : null}
          </div>
          {action ? <div className="flex shrink-0 items-center gap-2">{action}</div> : null}
        </div>
      ) : null}
      {children}
    </Tag>
  );
}
