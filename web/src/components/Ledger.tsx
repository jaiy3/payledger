import type { Account, Entry } from "../api";
import { formatKobo, shortId } from "../money";

const time = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

/**
 * The journal: every entry with its postings. Debits (money out of an account)
 * and credits (money in) are shown side by side, and each entry's total is shown
 * so the reader can see it is always zero.
 */
export function Ledger({ entries, accounts }: { entries: Entry[]; accounts: Account[] }) {
  const names = new Map(accounts.map((a) => [a.id, a.name]));

  return (
    <section className="panel ledger" aria-labelledby="ledger-title">
      <div className="panel-head">
        <h2 id="ledger-title">Journal</h2>
        <p className="hint">Newest first. Every entry's postings sum to zero.</p>
      </div>
      <div className="legend" aria-hidden="true">
        <span>Account</span>
        <span className="num">Debit (out)</span>
        <span className="num">Credit (in)</span>
        <span className="num">Balance after</span>
      </div>
      {entries.length === 0 ? (
        <p className="hint">No entries yet.</p>
      ) : (
        <div className="journal">
          {entries.map((entry) => {
            const total = entry.postings.reduce((sum, p) => sum + p.amount, 0);
            return (
              <table key={entry.id} className="entry">
                <caption>
                  <span className={`tag tag-${entry.type}`}>{entry.type === "transfer" ? "Transfer" : "Deposit"}</span>
                  <span className="entry-desc">{entry.description}</span>
                  <span className="entry-meta mono" title={entry.id}>
                    {time.format(new Date(entry.created_at))} {shortId(entry.id)}
                  </span>
                </caption>
                <thead className="sr-only">
                  <tr>
                    <th scope="col">Account</th>
                    <th scope="col">Debit</th>
                    <th scope="col">Credit</th>
                    <th scope="col">Balance after</th>
                  </tr>
                </thead>
                <tbody>
                  {entry.postings.map((p, i) => (
                    <tr key={i}>
                      <th scope="row">{names.get(p.account_id) ?? shortId(p.account_id)}</th>
                      <td className="num debit">{p.amount < 0 ? formatKobo(-p.amount) : ""}</td>
                      <td className="num credit">{p.amount > 0 ? formatKobo(p.amount) : ""}</td>
                      <td className="num muted">{formatKobo(p.balance_after)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <th scope="row">Entry total</th>
                    <td className="num" colSpan={2}>
                      <span className={total === 0 ? "zero" : "nonzero"}>{formatKobo(total)}</span>
                    </td>
                    <td />
                  </tr>
                </tfoot>
              </table>
            );
          })}
        </div>
      )}
    </section>
  );
}
