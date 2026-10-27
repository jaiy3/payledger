import { useEffect, useState } from "react";
import { call, newKey, type Account, type Reconciliation } from "../api";
import { feeFor, formatKobo, parseNaira } from "../money";

type Run = {
  results: number[];
  before: number;
  after: number;
  expectedMax: number;
  balanced: boolean | null;
  ms: number;
};

const COUNT = 20;

export function StressTest({ accounts, onDone }: { accounts: Account[]; onDone: () => Promise<void> }) {
  const [from, setFrom] = useState("");
  const [amount, setAmount] = useState("1,000");
  const [busy, setBusy] = useState(false);
  const [run, setRun] = useState<Run | null>(null);

  useEffect(() => {
    if (!from && accounts[1]) setFrom(accounts[1].id);
  }, [accounts, from]);

  const sender = accounts.find((a) => a.id === from);
  const receiver = accounts.find((a) => a.id !== from);
  const kobo = parseNaira(amount);

  const fire = async () => {
    if (!sender || !receiver || !kobo) return;
    setBusy(true);
    const before = sender.balance;
    const started = performance.now();

    // All requests leave the browser together; each has its own idempotency key.
    const results = await Promise.all(
      Array.from({ length: COUNT }, () =>
        call("POST", "/v1/transfers", {
          body: { from_account_id: sender.id, to_account_id: receiver.id, amount: kobo, description: "Concurrency test" },
          idempotencyKey: newKey(),
        }).then((r) => r.status)
      )
    );
    const ms = Math.round(performance.now() - started);

    const [after, recon] = await Promise.all([
      call<Account>("GET", `/v1/accounts/${sender.id}`),
      call<Reconciliation>("GET", "/v1/reconciliation"),
    ]);
    setRun({
      results,
      before,
      after: after.body.balance,
      expectedMax: Math.min(COUNT, Math.floor(before / (kobo + feeFor(kobo)))),
      balanced: recon.ok ? recon.body.balanced : null,
      ms,
    });
    await onDone();
    setBusy(false);
  };

  const succeeded = run?.results.filter((s) => s === 201).length ?? 0;
  const rejected = run?.results.filter((s) => s === 422).length ?? 0;

  return (
    <section className="panel" aria-labelledby="stress-title">
      <h2 id="stress-title">Fire {COUNT} transfers at once</h2>
      <p className="hint">
        Send more than the balance can cover, all at the same moment. Without row locking, several requests would read
        the same balance and overdraw the account.
      </p>
      <div className="field-pair">
        <label>
          From
          <select value={from} onChange={(e) => setFrom(e.target.value)}>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>{a.name} ({formatKobo(a.balance)})</option>
            ))}
          </select>
        </label>
        <label>
          Each (₦)
          <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} aria-invalid={!kobo} />
        </label>
      </div>
      <button className="btn-primary" onClick={fire} disabled={busy || !kobo || !sender || accounts.length < 2}>
        {busy ? "Sending…" : `Fire ${COUNT} transfers`}
      </button>

      {run && (
        <div className="stress-result" aria-live="polite">
          <div className="dots" role="img" aria-label={`${succeeded} succeeded, ${rejected} rejected`}>
            {run.results.map((status, i) => (
              <span key={i} className={status === 201 ? "dot ok" : status === 422 ? "dot no" : "dot err"} title={`HTTP ${status}`} />
            ))}
          </div>
          <p>
            <strong>{succeeded}</strong> succeeded and <strong>{rejected}</strong> were refused for insufficient funds,
            in {run.ms} ms. The balance could cover {run.expectedMax}.
          </p>
          <p>
            Balance went from {formatKobo(run.before)} to <strong>{formatKobo(run.after)}</strong>
            {run.after >= 0 ? ", never below zero." : "."}{" "}
            {run.balanced === true && "Reconciliation still balances."}
            {run.balanced === false && "Reconciliation found a mismatch."}
          </p>
        </div>
      )}
    </section>
  );
}
