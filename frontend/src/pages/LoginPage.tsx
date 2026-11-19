import { useState } from 'react';
import { useAuth } from '../lib/auth';
import { ApiError } from '../lib/api';

const ACCOUNTS = [
  { email: 'uploader@cockpit.local', cando: 'uploads — cannot approve' },
  { email: 'approver@cockpit.local', cando: 'approves for SAP' },
  { email: 'ops@cockpit.local', cando: 'monitors failures' },
  { email: 'admin@cockpit.local', cando: 'administrator' },
];

/** It genuinely is a sequence, so it is numbered. */
const STEPS = [
  { what: 'Upload the customer’s purchase order as a PDF' },
  { what: 'Check the details read from it' },
  { what: 'A second person approves it', hot: true },
  { what: 'SAP creates the Sales Order and returns its number' },
];

export function LoginPage() {
  const { login } = useAuth();
  const [email, setEmail] = useState('uploader@cockpit.local');
  const [password, setPassword] = useState('cockpit123');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(email, password);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not sign in. Check the API is running.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <aside className="login-left">
        <div>
          <img className="login-logo" src="/millennium-logo.png" alt="Millennium Semiconductors" />
          <div className="login-product">
            <span className="brand-name">Business Command Centre</span>
            <span className="brand-sub">S/4HANA</span>
          </div>
        </div>

        <div>
          <h1>
            From customer PO to <em>SAP Sales Order</em>
          </h1>
          <p className="lede">
            Upload a purchase order, check the details read from it, and approve. The Sales Order
            is then created in SAP S/4HANA.
          </p>

          <ol className="steps">
            {STEPS.map((s, i) => (
              <li key={s.what} className={`step ${s.hot ? 'hot' : ''}`}>
                <span className="no">{String(i + 1).padStart(2, '0')}</span>
                <span className="what">{s.what}</span>
              </li>
            ))}
          </ol>
        </div>

        <p className="cap login-foot">
          <span>Millennium Semiconductors</span>
          <a href="https://www.millenniumsemi.com/" target="_blank" rel="noreferrer">millenniumsemi.com</a>
        </p>
      </aside>

      <div className="login-right">
        <form className="login-form" onSubmit={submit}>
          <h2>Sign in</h2>

          <div className="fieldrow" style={{ gridTemplateColumns: '1fr' }}>
            <div className="body">
              <label htmlFor="email">Email</label>
              <input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoComplete="username"
              />
            </div>
          </div>
          <div className="fieldrow" style={{ gridTemplateColumns: '1fr' }}>
            <div className="body">
              <label htmlFor="password">Password</label>
              <input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                autoComplete="current-password"
              />
            </div>
          </div>

          {error && <div className="err" role="alert">{error}</div>}

          <button className="primary" type="submit" disabled={busy} style={{ width: '100%', marginTop: 16 }}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>

          <div className="accounts">
            <p className="cap" style={{ marginBottom: 6 }}>
              Seeded accounts — password <span className="mono">cockpit123</span>. The uploader cannot
              approve their own uploads.
            </p>
            {ACCOUNTS.map((a) => (
              <button
                key={a.email}
                type="button"
                className="account"
                aria-pressed={email === a.email}
                onClick={() => setEmail(a.email)}
              >
                <span className="mail">{a.email}</span>
                <span className="cando">{a.cando}</span>
              </button>
            ))}
          </div>
        </form>
      </div>
    </div>
  );
}
