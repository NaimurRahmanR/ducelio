// Shown while an admin workspace's governed reads are in flight.
export default function Loading() {
  return (
    <div className="ac-app">
      <div className="ac-sidebar" aria-hidden="true" />
      <div className="ac-body">
        <main className="ac-content" aria-busy="true">
          <p role="status" className="ac-muted">
            Loading the latest records…
          </p>
          <div className="ac-skeleton" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
        </main>
      </div>
    </div>
  );
}
