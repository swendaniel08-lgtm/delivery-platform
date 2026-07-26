import './globals.css';
import { visibleNav } from '../lib/rbac';
import { getSession } from '../lib/session';

export const metadata = { title: 'Besonc Admin' };

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // The nav is built from the REAL signed-in role. It is a convenience, not a
  // boundary: bff-admin re-checks every call and admin-svc re-checks after
  // that, so hiding a link prevents an accident, not an attacker.
  const session = await getSession().catch(() => null);
  const nav = session ? visibleNav(session.principal) : [];
  return (
    <html lang="en">
      <body>
        <div className="shell">
          <aside className="side">
            <div className="brand">BESONC</div>
            <nav className="nav">
              {nav.map((i) => <a key={i.href} href={i.href}>{i.label}</a>)}
            </nav>
            <div style={{ padding: '20px', color: 'var(--muted)', fontSize: 12 }}>
              {session
                ? <>Signed in as<br /><strong style={{ color: 'var(--text)' }}>{session.principal.role}</strong></>
                : <>Not signed in</>}
            </div>
          </aside>
          <main className="main">{children}</main>
        </div>
      </body>
    </html>
  );
}
