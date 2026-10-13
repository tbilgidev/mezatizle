export function LoadingState({ label = "Yükleniyor…" }: { label?: string }) {
  return (
    <div className="loading-box" role="status">
      <span className="spinner" aria-hidden />
      <span>{label}</span>
    </div>
  );
}

export function EmptyState({
  title,
  hint,
}: {
  title: string;
  hint?: string;
}) {
  return (
    <div className="empty-box">
      <strong style={{ display: "block", color: "var(--ink)", marginBottom: 4 }}>
        {title}
      </strong>
      {hint ? <span>{hint}</span> : null}
    </div>
  );
}

export function ErrorState({ message }: { message: string }) {
  return (
    <div className="err-box" role="alert">
      {message}
    </div>
  );
}
