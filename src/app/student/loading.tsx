// Learner-area loading state: the shell's own frame (indigo sidebar, top
// bar) with content placeholders, so moving between learner pages never
// flashes a blank page. Streamed before the page's <main id="main">, so it
// is not a main landmark itself; it holds no data and no controls.
export default function Loading() {
  return (
    <div className="academy ln-shell" role="status" aria-live="polite">
      <span className="ln-sr">Loading your academy…</span>
      <aside className="sidebar" aria-hidden="true" />
      <div className="academy-content" aria-hidden="true">
        <div className="topbar" />
        <div className="workspace ln-skeleton">
          <div className="ln-skeleton__row">
            <div className="ln-skeleton__block" style={{ height: 260 }} />
            <div className="ln-skeleton__block" style={{ height: 260 }} />
          </div>
          <div className="ln-skeleton__block" style={{ height: 88 }} />
          <div className="ln-skeleton__block" style={{ height: 320 }} />
        </div>
      </div>
    </div>
  );
}
