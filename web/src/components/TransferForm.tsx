import { useState } from "react";
import { call, newKey, type Account, type ApiResult } from "../api";
import { feeFor, formatKobo, parseNaira, shortId } from "../money";

type Outcome = { label: string; result: ApiResult<{ id?: string; error?: { code: string; message: string } }> };

export function TransferForm({ accounts, onDone }: { accounts: Account[]; onDone: () => Promise<void> }) {
  const [fromChoice, setFrom] = useState("");
  const [toChoice, setTo] = useState("");
  const [amount, setAmount] = useState("2,500");
  const [key, setKey] = useState(newKey);
  const [busy, setBusy] = useState(false);
  const [outcomes, setOutcomes] = useState<Outcome[]>([]);

  const has = (id: string) => accounts.some((a) => a.id === id);
  const from = has(fromChoice) ? fromChoice : accounts[0]?.id ?? "";
  const to = has(toChoice) ? toChoice : accounts.find((a) => a.id !== from)?.id ?? "";

  const kobo = parseNaira(amount);
  const fee = kobo ? feeFor(kobo) : 0;
  const valid = Boolean(kobo && from && to && from !== to);

  const send = async (times: 1 | 2) => {
    if (!valid) return;
    setBusy(true);
    const body = { from_account_id: from, to_account_id: to, amount: kobo, description: "Dashboard transfer" };
    const results: Outcome[] = [];
    for (let i = 0; i < times; i++) {
      const result = await call<{ id?: string; error?: { code: string; message: string } }>("POST", "/v1/transfers", {
        body,
        idempotencyKey: key,
      });
      results.push({ label: times === 2 ? (i === 0 ? "First request" : "Retry, same key") : "Request", result });
    }
    setOutcomes(results);
    setKey(newKey());
    await onDone();
    setBusy(false);
  };

  return (
    <section className="panel" aria-labelledby="transfer-title">
      <h2 id="transfer-title">Send a transfer</h2>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void send(1);
        }}
      >
        <div className="field-pair">
          <label>
            From
            <select value={from} onChange={(e) => setFrom(e.target.value)}>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </select>
          </label>
          <label>
            To
            <select value={to} onChange={(e) => setTo(e.target.value)}>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </select>
          </label>
        </div>
        <label>
          Amount (₦)
          <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} aria-invalid={!kobo} />
        </label>
        <p className="hint">
          {kobo ? (
            <>Fee {formatKobo(fee)} (0.5%, capped at ₦100). Sender pays {formatKobo(kobo + fee)}.</>
          ) : (
            "Enter an amount with up to two decimal places."
          )}
          {from && from === to && " Pick two different accounts."}
        </p>
        <div className="keybox">
          <span>Idempotency key</span>
          <code>{key}</code>
          <button type="button" className="link-btn" onClick={() => setKey(newKey())}>New key</button>
        </div>
        <div className="btn-row">
          <button className="btn-primary" disabled={!valid || busy}>Send transfer</button>
          <button type="button" className="btn-secondary" disabled={!valid || busy} onClick={() => send(2)}>
            Send twice with the same key
          </button>
        </div>
      </form>

      {outcomes.length > 0 && (
        <ol className="outcomes" aria-live="polite">
          {outcomes.map(({ label, result }, i) => (
            <li key={i} className={result.ok ? "ok" : "fail"}>
              <span className="outcome-label">{label}</span>
              <span className="mono">HTTP {result.status}</span>
              <span>
                {result.ok
                  ? result.replayed
                    ? `Replayed entry ${shortId(result.body.id ?? "")}. No money moved.`
                    : `Created entry ${shortId(result.body.id ?? "")}.`
                  : result.body.error?.message ?? "Failed"}
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
