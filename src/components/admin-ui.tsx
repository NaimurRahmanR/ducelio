import Link from "next/link";
import type { ReactNode } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Circle,
  Clock3,
  Lock,
  XCircle,
} from "lucide-react";
import type {
  LifecycleStage,
  StageState,
} from "@/domain/admin-course-lifecycle";

// Presentation primitives for the admin control centre. None fetches data
// or decides authority; each renders exactly the values it is given.

export function Panel({
  title,
  description,
  actions,
  children,
  id,
  className = "",
}: {
  title?: string;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  id?: string;
  className?: string;
}) {
  return (
    <section
      className={`ac-panel ${className}`}
      aria-labelledby={title && id ? `${id}-title` : undefined}
      id={id}
    >
      {(title || actions) && (
        <div className="ac-panel-head">
          <div>
            {title && <h2 id={id ? `${id}-title` : undefined}>{title}</h2>}
            {description && <p className="ac-muted">{description}</p>}
          </div>
          {actions && <div className="ac-panel-actions">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

export function StatCard({
  label,
  value,
  detail,
  href,
  tone = "default",
}: {
  label: string;
  value: ReactNode;
  detail?: ReactNode;
  href?: string;
  tone?: "default" | "attention" | "good";
}) {
  const body = (
    <>
      <span className="ac-stat-label">{label}</span>
      <strong className="ac-stat-value">{value}</strong>
      {detail && <span className="ac-stat-detail">{detail}</span>}
    </>
  );
  return href ? (
    <Link href={href} className={`ac-stat ac-stat-${tone}`}>
      {body}
    </Link>
  ) : (
    <div className={`ac-stat ac-stat-${tone}`}>{body}</div>
  );
}

// Shown wherever a governed read failed: the value is unknown, never zero.
export function Unavailable({
  what,
  message,
}: {
  what: string;
  message?: string;
}) {
  return (
    <p className="ac-unavailable" role="status">
      <AlertTriangle size={15} aria-hidden="true" />{" "}
      {message ??
        `${what} could not be loaded from the governed service. No value is shown rather than a guess.`}
    </p>
  );
}

export function Empty({
  title,
  children,
  action,
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="ac-empty">
      <strong>{title}</strong>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}

// A single-series horizontal bar chart: one hue, direct value labels, a
// title on every bar for hover, and the same numbers readable as text.
export function BarList({
  label,
  items,
  unit = "",
}: {
  label: string;
  items: { label: string; value: number; href?: string }[];
  unit?: string;
}) {
  const max = Math.max(1, ...items.map((i) => i.value));
  return (
    <figure className="ac-bars" aria-label={label}>
      <ul>
        {items.map((item) => {
          const width = (item.value / max) * 100;
          const text = `${item.label}: ${item.value}${unit}`;
          const row = (
            <>
              <span className="ac-bar-label">{item.label}</span>
              <span className="ac-bar-track" title={text}>
                <span
                  className="ac-bar-fill"
                  style={{
                    width: `${item.value === 0 ? 0 : Math.max(width, 2)}%`,
                  }}
                />
              </span>
              <span className="ac-bar-value">
                {item.value}
                {unit}
              </span>
            </>
          );
          return (
            <li key={item.label}>
              {item.href ? (
                <Link href={item.href} className="ac-bar-row" aria-label={text}>
                  {row}
                </Link>
              ) : (
                <span className="ac-bar-row">{row}</span>
              )}
            </li>
          );
        })}
      </ul>
    </figure>
  );
}

const STATE_META: Record<
  StageState,
  { label: string; icon: typeof Circle; className: string }
> = {
  complete: { label: "Complete", icon: CheckCircle2, className: "complete" },
  action: { label: "Action needed", icon: Clock3, className: "action" },
  approval: { label: "Awaiting approval", icon: Clock3, className: "approval" },
  blocked: { label: "Blocked", icon: Lock, className: "blocked" },
  attention: {
    label: "Needs attention",
    icon: XCircle,
    className: "attention",
  },
};

export function StatePill({ state }: { state: StageState }) {
  const meta = STATE_META[state];
  const Icon = meta.icon;
  return (
    <span className={`ac-pill ac-pill-${meta.className}`}>
      <Icon size={13} aria-hidden="true" /> {meta.label}
    </span>
  );
}

export function Pill({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "good" | "warn" | "bad" | "brand";
}) {
  return <span className={`ac-pill ac-pill-${tone}`}>{children}</span>;
}

// The eight-stage course lifecycle as an ordered list.
export function LifecycleStepper({
  stages,
  compact = false,
}: {
  stages: LifecycleStage[];
  compact?: boolean;
}) {
  return (
    <ol
      className={compact ? "ac-stepper ac-stepper-compact" : "ac-stepper"}
      aria-label="Course lifecycle"
    >
      {stages.map((s, i) => {
        const meta = STATE_META[s.state];
        const Icon = meta.icon;
        return (
          <li key={s.id} className={`ac-step ac-step-${meta.className}`}>
            <span className="ac-step-marker" aria-hidden="true">
              <Icon size={compact ? 14 : 16} />
            </span>
            <span className="ac-step-body">
              <span className="ac-step-title">
                <span className="ac-step-number">{i + 1}.</span> {s.label}
                <span className="sr-only">: {meta.label}</span>
              </span>
              {!compact && (
                <>
                  <span className="ac-step-state">{meta.label}</span>
                  <span className="ac-step-summary">{s.summary}</span>
                  {s.next && (
                    <Link href={s.next.href} className="ac-step-next">
                      {s.next.label} →
                    </Link>
                  )}
                </>
              )}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

// Link-based tabs: each tab is a real URL, so the server renders it, the
// browser history works and nothing depends on client JavaScript.
export function LinkTabs({
  label,
  tabs,
  active,
}: {
  label: string;
  tabs: { id: string; label: string; href: string }[];
  active: string;
}) {
  return (
    <nav className="ac-tabs" aria-label={label}>
      {tabs.map((t) => (
        <Link
          key={t.id}
          href={t.href}
          className={t.id === active ? "ac-tab active" : "ac-tab"}
          aria-current={t.id === active ? "page" : undefined}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}

export function DataTable({
  caption,
  columns,
  rows,
  empty,
}: {
  caption: string;
  columns: string[];
  rows: ReactNode[][];
  empty?: ReactNode;
}) {
  if (rows.length === 0)
    return <>{empty ?? <Empty title="Nothing to show" />}</>;
  return (
    <div className="ac-table-wrap">
      <table className="ac-table">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c} scope="col">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>
              {row.map((cell, j) => (
                <td key={j} data-label={columns[j]}>
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// Technical identifiers stay behind an explicit disclosure.
export function Advanced({ children }: { children: ReactNode }) {
  return (
    <details className="ac-advanced">
      <summary>Advanced details</summary>
      <div>{children}</div>
    </details>
  );
}
