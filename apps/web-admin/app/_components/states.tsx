/**
 * Honest empty, error and degraded states.
 *
 * The rule this file encodes: an operations dashboard must never let a
 * failure look like good news. "0 orders today" and "we could not reach the
 * order service" render identically if you are careless, and during an
 * incident that difference is the whole job.
 */

export function ErrorPanel({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="alarm critical" role="alert">
      <strong>{title}</strong>
      <div style={{ marginTop: 6, fontSize: 13, opacity: 0.9 }}>{detail}</div>
    </div>
  );
}

/**
 * Shown when SOME upstreams answered and some did not. The figures on screen
 * are real but incomplete, and the operator has to know which.
 */
export function DegradedBanner({ upstreams }: { upstreams: string[] }) {
  return (
    <div className="alarm warning" role="status">
      <strong>Partial data.</strong>{' '}
      {upstreams.join(', ')} did not respond. Figures below are incomplete —
      do not act on them as though they were a full picture.
    </div>
  );
}

export function EmptyState({ message }: { message: string }) {
  return (
    <p className="sub" style={{ padding: '24px 0' }}>
      {message}
    </p>
  );
}

export function SignInPrompt() {
  return (
    <>
      <h1>Sign in required</h1>
      <p className="sub">
        This dashboard needs a staff session. Sign in through the Besonc admin
        login to continue.
      </p>
    </>
  );
}
