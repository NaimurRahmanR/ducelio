// Streamed in before a page's own <main id="main">, so it must not be a
// second main landmark or claim the skip-link target itself.
export default function Loading() {
  return (
    <div className="foundation" role="status">
      <p>Loading…</p>
    </div>
  );
}
