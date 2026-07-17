import { Loader2 } from "lucide-react";

export default function AdminLoading() {
  return (
    <div className="flex min-h-72 items-center justify-center rounded-2xl border border-zinc-800 bg-zinc-950/70 text-sm text-zinc-500">
      <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Loading Admin workspace
    </div>
  );
}
