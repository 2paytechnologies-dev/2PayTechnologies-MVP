"use client";

import { useState } from "react";
import { Landmark, Plus, Smartphone, Trash2 } from "lucide-react";
import { BANKS, MAX_SAVED, WALLETS, type SettlementKind } from "@/lib/constants";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export interface AccountRow {
  id: string;
  institution: string;
  /** Shown in the list: masked for saved rows, derived from the typed number for new ones. */
  masked: string;
}

interface Props {
  kind: SettlementKind;
  rows: AccountRow[];
  activeId: string | null;
  onAdd: (institution: string, accountNumber: string) => string | null;
  onRemove: (id: string) => void;
  onActivate: (id: string) => void;
}

const COPY = {
  bank: { title: "Bank accounts", icon: Landmark, list: BANKS, placeholder: "Select a bank", numberLabel: "Account number", numberHint: "6–20 digits", inputMode: "numeric" as const },
  wallet: { title: "Digital wallets", icon: Smartphone, list: WALLETS, placeholder: "Select a wallet", numberLabel: "Phone number", numberHint: "e.g. 0911223344", inputMode: "tel" as const },
};

export function AccountSection({ kind, rows, activeId, onAdd, onRemove, onActivate }: Props) {
  const c = COPY[kind];
  const Icon = c.icon;
  const [institution, setInstitution] = useState("");
  const [number, setNumber] = useState("");
  const [error, setError] = useState<string | null>(null);
  const full = rows.length >= MAX_SAVED;

  const add = () => {
    const err = onAdd(institution, number);
    setError(err);
    if (!err) {
      setInstitution("");
      setNumber("");
    }
  };

  return (
    <section className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-lg font-semibold">
          <Icon className="h-5 w-5 text-brand" /> {c.title}
        </h2>
        <span className="text-xs text-slate-400">
          {rows.length} / {MAX_SAVED} saved
        </span>
      </div>

      {rows.length === 0 ? (
        <p className="mb-4 rounded-lg border border-dashed border-slate-700 p-4 text-sm text-slate-500">
          No {kind === "bank" ? "banks" : "wallets"} saved yet. Add one below to start receiving through it.
        </p>
      ) : (
        <>
          <p className="mb-2 text-xs text-slate-400">Select the one {kind} that receives incoming payments.</p>
          <RadioGroup value={activeId ?? ""} onValueChange={onActivate} className="mb-4" aria-label={`Active ${kind}`}>
            {rows.map((r) => {
              const active = r.id === activeId;
              return (
                <div key={r.id} className={`flex items-center gap-3 rounded-xl border p-3 ${active ? "border-brand bg-brand/10" : "border-slate-800 bg-slate-950"}`}>
                  <RadioGroupItem value={r.id} id={`${kind}-${r.id}`} />
                  <label htmlFor={`${kind}-${r.id}`} className="min-w-0 flex-1 cursor-pointer">
                    <div className="truncate font-medium">{r.institution}</div>
                    <div className="font-mono text-xs text-slate-400">{r.masked}</div>
                  </label>
                  {active && <span className="rounded-full bg-brand/20 px-2 py-0.5 text-xs font-semibold text-brand">Active</span>}
                  <Button variant="destructive" size="icon" onClick={() => onRemove(r.id)} aria-label={`Remove ${r.institution}`}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              );
            })}
          </RadioGroup>
        </>
      )}

      <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
        <Select value={institution} onValueChange={setInstitution} disabled={full}>
          <SelectTrigger aria-label={`${kind} institution`}>
            <SelectValue placeholder={full ? `Limit of ${MAX_SAVED} reached` : c.placeholder} />
          </SelectTrigger>
          <SelectContent>
            {c.list.map((name) => (
              <SelectItem key={name} value={name}>
                {name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          value={number}
          onChange={(e) => setNumber(e.target.value)}
          inputMode={c.inputMode}
          placeholder={`${c.numberLabel} (${c.numberHint})`}
          aria-label={c.numberLabel}
          disabled={full}
          maxLength={24}
          onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), add())}
        />
        <Button variant="outline" onClick={add} disabled={full || !institution || !number.trim()}>
          <Plus className="h-4 w-4" /> Add
        </Button>
      </div>
      {error && <p className="mt-2 text-sm text-rose-300">{error}</p>}
    </section>
  );
}
