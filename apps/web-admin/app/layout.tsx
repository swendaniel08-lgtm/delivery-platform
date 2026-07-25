import './globals.css';
import { visibleNav, type Principal } from '../lib/rbac';

export const metadata = { title: 'Besonc Admin' };

/** Replaced by the real session in Sprint 15; shape is already correct. */
const currentUser: Principal = { id: 'admin-1', role: 'ops_manager', zones: ['accra-osu'] };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const nav = visibleNav(currentUser);
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
              Signed in as<br /><strong style={{ color: 'var(--text)' }}>{currentUser.role}</strong>
            </div>
          </aside>
          <main className="main">{children}</main>
        </div>
      </body>
    </html>
  );
}
