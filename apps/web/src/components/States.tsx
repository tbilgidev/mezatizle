import { AlertCircle, Inbox, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

export function LoadingState({
  label = "Yükleniyor…",
  className,
}: {
  label?: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-3 rounded-2xl border border-dashed border-line bg-panel/60 px-4 py-3 text-fog",
        className,
      )}
      role="status"
    >
      <Loader2 className="h-4 w-4 animate-spin text-mint" aria-hidden />
      <span>{label}</span>
    </div>
  );
}

export function EmptyState({
  title,
  hint,
  className,
}: {
  title: string;
  hint?: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "rounded-2xl border border-dashed border-line bg-panel/50 px-5 py-8 text-center",
        className,
      )}
    >
      <div className="mx-auto mb-3 grid h-11 w-11 place-items-center rounded-xl bg-mint/10 text-mint">
        <Inbox className="h-5 w-5" aria-hidden />
      </div>
      <strong className="block font-display text-base text-paper">{title}</strong>
      {hint ? <p className="mt-1 text-sm text-fog">{hint}</p> : null}
    </div>
  );
}

export function ErrorState({
  message,
  className,
}: {
  message: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex items-start gap-3 rounded-2xl border border-rose/30 bg-rose/10 px-4 py-3 text-rose",
        className,
      )}
      role="alert"
    >
      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <span className="text-sm">{message}</span>
    </div>
  );
}

export function PageHeader({
  title,
  lead,
  actions,
}: {
  title: string;
  lead?: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4 animate-rise">
      <div>
        <h1 className="font-display text-[clamp(1.85rem,3.2vw,2.55rem)] font-extrabold tracking-tight text-paper leading-[1.05]">
          {title}
        </h1>
        {lead ? <p className="mt-2 max-w-[52ch] text-[1.02rem] text-fog">{lead}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
    </div>
  );
}
