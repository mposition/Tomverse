type ChatHeaderProps = {
  title?: string;
  modelLabel?: string;
  onModelSelect?: () => void;
};

export function ChatHeader({
  title = "새 채팅",
  modelLabel = "기본 모델: GPT",
  onModelSelect,
}: ChatHeaderProps) {
  return (
    <header className="flex h-16 items-center justify-between border-b border-zinc-800 px-4 md:px-6">
      <div>
        <h2 className="font-semibold">{title}</h2>
        <p className="text-xs text-zinc-500">{modelLabel}</p>
      </div>

      <button
        onClick={onModelSelect}
        className="rounded-lg border border-zinc-700 px-3 py-2 text-sm hover:bg-zinc-900"
      >
        모델 선택
      </button>
    </header>
  );
}
