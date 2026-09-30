"use client";

import { useEffect, useState } from "react";

interface Expense {
  id: string;
  category: string;
  title: string;
  amount_minor: number;
  expense_date: string;
}

export default function ExpensesPage() {
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [formData, setFormData] = useState({
    category: "upstream_bandwidth",
    title: "",
    amount_minor: "",
    expense_date: new Date().toISOString().slice(0, 10),
  });

  const loadData = () => {
    setLoading(true);
    fetch("/api/expenses")
      .then((r) => r.json())
      .then((d) => setExpenses(d.expenses ?? []))
      .finally(() => setLoading(false));
  };

  useEffect(() => { loadData(); }, []);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    const res = await fetch("/api/expenses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...formData,
        amount_minor: Math.round(parseFloat(formData.amount_minor) * 100),
      }),
    });
    if (res.ok) {
      setShowAdd(false);
      setFormData({
        category: "upstream_bandwidth",
        title: "",
        amount_minor: "",
        expense_date: new Date().toISOString().slice(0, 10),
      });
      loadData();
    }
  };

  const totalMinor = expenses.reduce((a, b) => a + (b.amount_minor || 0), 0);

  return (
    <div className="p-8 max-w-7xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Operating Expenses</h1>
          <p className="text-sm text-muted-foreground">Track upstream bandwidth costs, power, mast rent, and overheads.</p>
        </div>
        <button
          onClick={() => setShowAdd(!showAdd)}
          className="px-3 py-1.5 text-xs font-semibold rounded bg-primary text-primary-foreground"
        >
          {showAdd ? "Cancel" : "Record Expense"}
        </button>
      </div>

      <div className="p-4 border rounded bg-card max-w-sm">
        <p className="text-xs uppercase text-muted-foreground">Total Expenses Recorded</p>
        <p className="text-2xl font-bold mt-1">KSh {(totalMinor / 100).toLocaleString()}</p>
      </div>

      {showAdd && (
        <form onSubmit={handleCreate} className="p-4 border rounded bg-card space-y-4 max-w-xl">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-muted-foreground block mb-1">Category</label>
              <select
                value={formData.category}
                onChange={(e) => setFormData({ ...formData, category: e.target.value })}
                className="w-full text-sm border rounded p-1.5 bg-background"
              >
                <option value="upstream_bandwidth">Upstream Bandwidth</option>
                <option value="rent">Mast / Tower Rent</option>
                <option value="power">Power / Electricity</option>
                <option value="transport">Transport / Fuel</option>
                <option value="maintenance">Maintenance</option>
                <option value="salaries">Salaries</option>
                <option value="other">Other</option>
              </select>
            </div>
            <div>
              <label className="text-xs text-muted-foreground block mb-1">Amount (KSh)</label>
              <input
                required
                type="number"
                step="0.01"
                placeholder="0.00"
                value={formData.amount_minor}
                onChange={(e) => setFormData({ ...formData, amount_minor: e.target.value })}
                className="w-full text-sm border rounded p-1.5 bg-background"
              />
            </div>
          </div>
          <div>
            <label className="text-xs text-muted-foreground block mb-1">Title</label>
            <input
              required
              placeholder="e.g. Upstream Transit"
              value={formData.title}
              onChange={(e) => setFormData({ ...formData, title: e.target.value })}
              className="w-full text-sm border rounded p-1.5 bg-background"
            />
          </div>
          <button type="submit" className="px-4 py-1.5 text-xs font-semibold rounded bg-primary text-primary-foreground">
            Save Expense
          </button>
        </form>
      )}

      {loading ? (
        <p className="text-sm text-muted-foreground">Loading expenses...</p>
      ) : (
        <div className="card-flush overflow-x-auto">
          <table className="table min-w-[720px]">
            <thead className="bg-muted text-left text-xs uppercase text-muted-foreground">
              <tr>
                <th className="p-3">Date</th>
                <th className="p-3">Category</th>
                <th className="p-3">Title</th>
                <th className="p-3 text-right">Amount</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {expenses.length === 0 ? (
                <tr>
                  <td colSpan={4} className="p-4 text-center text-muted-foreground">
                    No expenses logged yet.
                  </td>
                </tr>
              ) : (
                expenses.map((ex) => (
                  <tr key={ex.id}>
                    <td className="p-3 font-mono text-xs">{ex.expense_date}</td>
                    <td className="p-3 capitalize font-medium text-xs">{ex.category.replace("_", " ")}</td>
                    <td className="p-3">{ex.title}</td>
                    <td className="p-3 text-right font-medium">KSh {(ex.amount_minor / 100).toLocaleString()}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
