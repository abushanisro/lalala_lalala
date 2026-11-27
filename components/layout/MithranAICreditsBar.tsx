'use client';

import { useState } from 'react';

import { featureRows, historyTotals, resetsIn, shareLabel, shareUsed, tokenCount, tokenShort, usageLevel, type UsageLevel } from '@/lib/ai/usage';
import { useAiUsage } from '@/lib/api/hooks/useAiUsage';
import { useVaveProjects } from '@/lib/api/hooks/useVave';
import { useAuth } from '@/lib/providers/auth';

// ─── Org name from email domain ────────────────────────────────────────────────

const CC_SLDS = new Set(['co', 'com', 'net', 'org', 'gov', 'edu']);

function orgFromEmail(email: string): string {
  const domain = email.split('@')[1] ?? '';
  const parts  = domain.split('.');
  const sld    = parts[parts.length - 2] ?? '';
  const company = (
    parts.length >= 3 && CC_SLDS.has(sld)
      ? parts[parts.length - 3]
      : sld || parts[0]
  ) ?? '';
  return company.charAt(0).toUpperCase() + company.slice(1);
}

// ─── How full an allowance is, in colour ───────────────────────────────────────

const LEVEL_FILL: Record<UsageLevel, string> = {
  ok: 'linear-gradient(90deg, hsl(var(--primary)), hsl(173 66% 50%))',
  high: 'hsl(38 92% 50%)',
  critical: 'hsl(0 72% 51%)',
};
const LEVEL_TEXT: Record<UsageLevel, string> = { ok: 'hsl(140 60% 50%)', high: 'hsl(38 92% 50%)', critical: 'hsl(0 72% 51%)' };

const calls = (n: number) => `${tokenCount(n)} ${n === 1 ? 'call' : 'calls'}`;

// ─── Component ─────────────────────────────────────────────────────────────────

/**
 * The organization's AI usage, in the tokens the Claude API reported for each call (GET /ai-usage-totals): today against the daily
 * allowance, by feature, and over the last 30 days. Nothing here is estimated or converted.
 */
export function MithranAICreditsBar() {
  const [expanded, setExpanded] = useState(false);
  const { user } = useAuth();

  const orgName = user
    ? (user.user_metadata?.organization as string | undefined) ??
      (user.user_metadata?.org_name    as string | undefined) ??
      orgFromEmail(user.email ?? '')
    : '—';

  // ── Real data ────────────────────────────────────────────────────────────────
  const { data: usage, isError } = useAiUsage();
  const { data: vaveRaw } = useVaveProjects();

  const vaveProjects  = (vaveRaw as any[] | undefined) ?? [];
  const totalSavingsL = vaveProjects.reduce((s: number, p: any) => s + Number(p.totalSavings ?? 0), 0) / 100_000;

  // ── Derived numbers ──────────────────────────────────────────────────────────
  const used      = usage?.organization.tokens ?? 0;
  const limit     = usage?.organization.dailyLimit ?? 0;
  const share     = usage ? shareUsed(used, limit) : 0;
  const level     = usageLevel(share);
  const remaining = Math.max(limit - used, 0);
  const features  = usage ? featureRows(usage) : [];
  const month     = usage ? historyTotals(usage) : null;
  const ownShare  = usage ? shareUsed(usage.user.tokensEverywhere, usage.user.dailyLimit) : 0;

  return (
    <div className="relative w-full" style={{ zIndex: 30 }}>
      {/* ── Collapsed bar — full row is the click target ───────────────────────── */}
      <button
        onClick={() => setExpanded(v => !v)}
        aria-expanded={expanded}
        className="w-full flex items-center justify-between px-4 h-9 gap-6 border-b cursor-pointer bg-card border-border hover:bg-muted/30 transition-colors"
      >
        {/* Brand */}
        <div className="flex items-center gap-2.5 shrink-0">
          <span className="text-[10px] font-bold tracking-[0.18em] uppercase text-primary">
            EMITHRAN AI
          </span>
          <span className="text-[10px] text-muted-foreground/40">·</span>
          <span className="text-[10px] text-muted-foreground">{orgName}</span>
        </div>

        {/* Today's tokens against the daily allowance */}
        <div className="hidden md:flex items-center gap-2.5 flex-1 max-w-xs">
          <div className="flex-1 h-1.5 rounded-full overflow-hidden bg-muted">
            <div
              className="h-full rounded-full transition-all duration-700"
              // A trace of usage is still drawn, so "some" never looks like "none".
              style={{ width: `${used > 0 ? Math.max(share, 1.5) : 0}%`, background: LEVEL_FILL[level] }}
            />
          </div>
          <span className="text-[10px] tabular-nums text-muted-foreground whitespace-nowrap">
            {usage
              ? `${tokenCount(used)} / ${tokenShort(limit)} tokens today`
              : isError ? 'Token usage not available' : 'Reading token usage…'}
          </span>
        </div>

        {/* Right side */}
        <div className="flex items-center gap-3 shrink-0">
          {totalSavingsL > 0 && (
            <span className="hidden sm:block text-[10px] font-semibold tabular-nums text-green-500">
              ${totalSavingsL.toFixed(1)}L identified
            </span>
          )}
          <span className="text-[10px] text-muted-foreground/50 select-none">
            {expanded ? '▴' : '▾'}
          </span>
        </div>
      </button>

      {/* ── Expanded dropdown ── */}
      {expanded && (
        <div
          className="absolute left-0 right-0 top-full border-b border-border bg-card shadow-2xl"
          style={{ zIndex: 30 }}
        >
          <div className="px-6 py-5">

            {/* Today's tokens by feature */}
            <p className="text-[9px] uppercase tracking-widest text-muted-foreground/50 mb-3">
              Tokens today by feature
            </p>
            {usage ? (
              <div className={`grid grid-cols-2 ${features.length > 3 ? 'md:grid-cols-4' : 'md:grid-cols-3'} gap-0 border border-border rounded-lg overflow-hidden`}>
                {features.map(({ feature, label, tokens, calls: featureCalls, share: featureShare }, i) => (
                  <div
                    key={feature}
                    className={`px-4 py-3 space-y-1 bg-muted/40 ${i < features.length - 1 ? 'border-r border-border' : ''} ${features.length % 2 === 1 && i === features.length - 1 ? 'col-span-2 md:col-span-1' : ''}`}
                  >
                    <p className="text-[9px] uppercase tracking-wider text-muted-foreground/50">{label}</p>
                    <p className="text-xl font-bold tabular-nums leading-none text-primary">
                      {tokenCount(tokens)}
                      <span className="text-[10px] font-normal text-muted-foreground ml-1">tokens</span>
                    </p>
                    <p className="text-[10px] text-muted-foreground">{calls(featureCalls)}</p>

                    {/* Mini bar showing this feature's share of today */}
                    {used > 0 && (
                      <div className="h-1 rounded-full mt-1 overflow-hidden bg-muted">
                        <div
                          className="h-full rounded-full"
                          style={{ width: `${Math.round(featureShare)}%`, background: 'hsl(var(--primary) / 0.6)' }}
                        />
                      </div>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <p className="rounded-lg border border-border bg-muted/40 px-4 py-3 text-[11px] text-muted-foreground">
                {isError ? 'Token usage could not be read. It is tried again every few seconds.' : 'Reading token usage…'}
              </p>
            )}

            {/* Summary strip */}
            <div className="mt-4 grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-4">
              <div className="space-y-0.5">
                <p className="text-[9px] uppercase tracking-widest text-muted-foreground/50">Used today</p>
                <p className="text-base font-bold tabular-nums">
                  {usage ? tokenCount(used) : '—'}
                  <span className="text-[10px] font-normal text-muted-foreground ml-1">tokens{usage ? ` · ${shareLabel(share)}` : ''}</span>
                </p>
                {usage && (
                  <p className="text-[10px] tabular-nums text-muted-foreground">
                    {tokenCount(usage.organization.inputTokens)} in · {tokenCount(usage.organization.outputTokens)} out · {calls(usage.organization.calls)}
                  </p>
                )}
              </div>
              <div className="space-y-0.5">
                <p className="text-[9px] uppercase tracking-widest text-muted-foreground/50">Remaining today</p>
                <p className="text-base font-bold tabular-nums" style={{ color: LEVEL_TEXT[level] }}>
                  {usage ? tokenCount(remaining) : '—'}
                  <span className="text-[10px] font-normal text-muted-foreground ml-1">tokens</span>
                </p>
                {usage && <p className="text-[10px] text-muted-foreground">Starts again {resetsIn(usage.resetsAt, new Date())} (00:00 UTC)</p>}
              </div>
              <div className="space-y-0.5">
                <p className="text-[9px] uppercase tracking-widest text-muted-foreground/50">Your own today</p>
                <p className="text-base font-bold tabular-nums">
                  {usage ? tokenCount(usage.user.tokensEverywhere) : '—'}
                  <span className="text-[10px] font-normal text-muted-foreground ml-1">
                    {usage ? `of ${tokenShort(usage.user.dailyLimit)} · ${shareLabel(ownShare)}` : 'tokens'}
                  </span>
                </p>
              </div>
              <div className="space-y-0.5">
                <p className="text-[9px] uppercase tracking-widest text-muted-foreground/50">Last 30 days</p>
                <p className="text-base font-bold tabular-nums">
                  {month ? tokenCount(month.tokens) : '—'}
                  <span className="text-[10px] font-normal text-muted-foreground ml-1">tokens{month ? ` · ${calls(month.calls)}` : ''}</span>
                </p>
              </div>
              <div className="space-y-0.5">
                <p className="text-[9px] uppercase tracking-widest text-muted-foreground/50">Cost Savings</p>
                <p className="text-base font-bold tabular-nums" style={{ color: 'hsl(140 60% 50%)' }}>
                  {totalSavingsL > 0 ? `$${totalSavingsL.toFixed(1)}L` : '—'}
                </p>
              </div>
              <div className="space-y-0.5">
                <p className="text-[9px] uppercase tracking-widest text-muted-foreground/50">Organisation</p>
                <p className="text-base font-bold">{orgName}</p>
              </div>
            </div>

            <p className="mt-4 text-[10px] text-muted-foreground/70">
              Counted from the usage the Claude API reports for each call, input and output together. Updated after every AI answer.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
