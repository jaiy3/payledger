import { useState, type FormEvent } from "react";
import { call, newKey, type Account } from "../api";
import { formatKobo } from "../money";

const roleNote: Record<Account["type"], string> = {
  customer: "Customer wallet",
  settlement: "Money entering from outside. It goes negative as deposits arrive.",
  fees: "Transfer fees collected",
};

export function Accounts({ accounts, onChange }: { accounts: Account[]; onChange: () => Promise<void> }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [message, setMessage] = useState("");

  const topUp = async (account: Account) => {
    setBusy(account.id);
    const res = await call("POST", "/v1/deposits", {
      body: { account_id: account.id, amount: 1_000_000, description: "Top-up from dashboard" },
      idempotencyKey: newKey(),
    });
    setMessage(res.ok ? `Deposited ₦10,000.00 into ${account.name}.` : "Deposit failed.");
    await onChange();
    setBusy(null);
  };

  const create = async (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim()) return;
    setBusy("new");
    const res = await call<{ error?: { message: string } }>("POST", "/v1/accounts", { body: { name: name.trim() } });
    setMessage(res.ok ? `Opened an account for ${name.trim()}.` : res.body.error?.message ?? "Couldn't open the account.");
    if (res.ok) setName("");
    await onChange();
    setBusy(null);
  };

  return (
    <section className="panel accounts" aria-labelledby="accounts-title">
      <div className="panel-head">
        <h2 id="accounts-title">Accounts</h2>
        <form className="inline-form" onSubmit={create}>
          <label className="sr-only" htmlFor="new-account">New account name</label>
          <input id="new-account" placeholder="New account name" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
          <button className="btn-secondary" disabled={busy === "new" || !name.trim()}>Open account</button>
        </form>
      </div>
      <div className="account-row">
        {accounts.map((account) => (
          <article key={account.id} className={`account account-${account.type}`}>
            <h3>{account.name}</h3>
            <p className="amount">{formatKobo(account.balance)}</p>
            <p className="account-note">{roleNote[account.type]}</p>
            {account.type === "customer" && (
              <button className="link-btn" onClick={() => topUp(account)} disabled={busy === account.id}>
                {busy === account.id ? "Depositing…" : "Deposit ₦10,000"}
              </button>
            )}
          </article>
        ))}
      </div>
      <p className="status-line" aria-live="polite">{message}</p>
    </section>
  );
}
