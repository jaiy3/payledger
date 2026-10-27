import { useCallback, useEffect, useRef, useState } from "react";
import {
  call,
  createSandbox,
  currentKey,
  ensureSandbox,
  type Account,
  type Delivery,
  type Endpoint,
  type Entry,
  type Reconciliation,
} from "./api";
import { Accounts } from "./components/Accounts";
import { Ledger } from "./components/Ledger";
import { ReconciliationPanel } from "./components/ReconciliationPanel";
import { StressTest } from "./components/StressTest";
import { TransferForm } from "./components/TransferForm";
import { Webhooks } from "./components/Webhooks";

export type LedgerData = {
  accounts: Account[];
  entries: Entry[];
  deliveries: Delivery[];
  endpoint: Endpoint | null;
  reconciliation: Reconciliation | null;
};

const empty: LedgerData = { accounts: [], entries: [], deliveries: [], endpoint: null, reconciliation: null };

export default function App() {
  const [data, setData] = useState<LedgerData>(empty);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  const refreshing = useRef(false);

  const refresh = useCallback(async () => {
    if (refreshing.current) return;
    refreshing.current = true;
    try {
      const [accounts, entries, deliveries, endpoints, reconciliation] = await Promise.all([
        call<{ data: Account[] }>("GET", "/v1/accounts"),
        call<{ data: Entry[] }>("GET", "/v1/entries?limit=30"),
        call<{ data: Delivery[] }>("GET", "/v1/webhooks/deliveries?limit=40"),
        call<{ data: Endpoint[] }>("GET", "/v1/webhooks/endpoints"),
        call<Reconciliation>("GET", "/v1/reconciliation"),
      ]);
      if (accounts.status === 401) {
        await createSandbox();
        return;
      }
      setData({
        accounts: accounts.body.data ?? [],
        entries: entries.body.data ?? [],
        deliveries: deliveries.body.data ?? [],
        endpoint: endpoints.body.data?.[0] ?? null,
        reconciliation: reconciliation.ok ? reconciliation.body : null,
      });
    } finally {
      refreshing.current = false;
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    ensureSandbox()
      .then(refresh)
      .then(() => !cancelled && setStatus("ready"))
      .catch((err: Error) => {
        if (cancelled) return;
        setError(err.message);
        setStatus("error");
      });
    return () => {
      cancelled = true;
    };
  }, [refresh]);

  // Webhook retries happen in the background, so keep polling while the tab is visible.
  useEffect(() => {
    if (status !== "ready") return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, 2500);
    return () => clearInterval(timer);
  }, [status, refresh]);

  const reset = async () => {
    setStatus("loading");
    await createSandbox();
    await refresh();
    setStatus("ready");
  };

  const customers = data.accounts.filter((a) => a.type === "customer");

  return (
    <>
      <header className="topbar">
        <div className="wrap topbar-row">
          <a className="brand" href="/">
            <img src="/favicon.svg" alt="" width="24" height="24" />
            PayLedger
          </a>
          <nav className="topnav">
            <a href="/docs">API docs</a>
            <a href="https://github.com/jaiy3/payledger">Source</a>
            <button className="btn-quiet" onClick={reset} disabled={status === "loading"}>
              New sandbox
            </button>
          </nav>
        </div>
      </header>

      <main className="wrap">
        <section className="intro">
          <h1>A payments ledger you can try to break.</h1>
          <p>
            This sandbox is yours. Move money, retry the same request, fire transfers at the same moment, make the
            webhook receiver flaky, then check whether the books still balance. Every action below is a real call to
            the PayLedger API.
          </p>
          {currentKey() && (
            <p className="keyline">
              Your sandbox key starts with <code>{currentKey()!.slice(0, 12)}</code>. Use it with the{" "}
              <a href="/docs">API docs</a> to call the same endpoints yourself.
            </p>
          )}
        </section>

        {status === "error" && (
          <div className="notice error" role="alert">
            Couldn't start a sandbox: {error}. Refresh to try again.
          </div>
        )}
        {status === "loading" && data.accounts.length === 0 && <div className="notice">Opening your sandbox…</div>}

        {data.accounts.length > 0 && (
          <>
            <Accounts accounts={data.accounts} onChange={refresh} />

            <div className="grid-main">
              <div className="col-actions">
                <TransferForm accounts={customers} onDone={refresh} />
                <StressTest accounts={customers} onDone={refresh} />
              </div>
              <Ledger entries={data.entries} accounts={data.accounts} />
            </div>

            <div className="grid-bottom">
              <ReconciliationPanel report={data.reconciliation} />
              <Webhooks deliveries={data.deliveries} endpoint={data.endpoint} onChange={refresh} />
            </div>
          </>
        )}
      </main>

      <footer className="wrap footer">
        Built by <a href="https://jaiyeadeboye.vercel.app">Jaiye Adeboye</a> with Node.js, TypeScript, PostgreSQL and
        React. Sandboxes are deleted after 7 days.
      </footer>
    </>
  );
}
