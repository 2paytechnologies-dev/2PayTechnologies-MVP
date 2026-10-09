/**
 * 2Pay algorithmic orchestration fee:
 *
 *   F_t = B_base + (α · V_t) + (β · R_t) + (γ · T_t) − δ(C_t)
 *
 *   B_base  fixed base fee per orchestration (ETB)
 *   V_t     transaction value (ETB)
 *   R_t     AI Watchdog risk score of the node, 0–100 (mean of its events in the last hour)
 *   T_t     network-traffic pressure: seconds by which the node's mean initiation latency exceeds the 2.0s target
 *   C_t     node loyalty: settled taps in the trailing window
 *   δ(C_t)  loyalty credit = min(creditCap, δ · C_t)
 *
 * The result is rounded to 0.01 ETB and never drops below `floor`.
 */
export interface FeeParams {
  base: number;
  alpha: number;
  beta: number;
  gamma: number;
  delta: number;
  creditCap: number;
  floor: number;
}

export const FEE_PARAMS: FeeParams = {
  base: 0.1,
  alpha: 0.004,
  beta: 0.003,
  gamma: 0.05,
  delta: 0.0005,
  creditCap: 0.15,
  floor: 0.25,
};

export const LATENCY_TARGET_S = 2.0;

export interface FeeInputs {
  /** V_t */ volume: number;
  /** R_t */ risk: number;
  /** T_t */ traffic: number;
  /** C_t */ credit: number;
}

export interface FeeBreakdown {
  base: number;
  volumeTerm: number;
  riskTerm: number;
  trafficTerm: number;
  creditTerm: number;
  raw: number;
  fee: number;
  floored: boolean;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export function feeBreakdown(inputs: FeeInputs, p: FeeParams = FEE_PARAMS): FeeBreakdown {
  const volumeTerm = p.alpha * Math.max(0, inputs.volume);
  const riskTerm = p.beta * Math.min(100, Math.max(0, inputs.risk));
  const trafficTerm = p.gamma * Math.max(0, inputs.traffic);
  const creditTerm = Math.min(p.creditCap, p.delta * Math.max(0, inputs.credit));
  const raw = p.base + volumeTerm + riskTerm + trafficTerm - creditTerm;
  const fee = round2(Math.max(p.floor, raw));
  return { base: p.base, volumeTerm, riskTerm, trafficTerm, creditTerm, raw, fee, floored: raw < p.floor };
}

/** Neutral-node fee (no risk, no congestion, no loyalty credit). */
export const computeFee = (amount: number) => feeBreakdown({ volume: amount, risk: 0, traffic: 0, credit: 0 }).fee;
