'use client';

import { useState } from 'react';

import {
  cacheReadShare, completeTo, featureRows, historyTotals, modelName, resetDay, resetsIn, shareLabel, shareUsed, tokenCount, tokenShort, usageLevel, usd, usdLimit, wholePercent,
  type UsageLevel,
} from '@/lib/ai/usage';
import { useAiAccount, useAiUsage } from '@/lib/api/hooks/useAiUsage';
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
const requests = (n: number) => `${tokenCount(n)} ${n === 1 ? 'request' : 'requests'}`;

/** One figure of the Claude account, as a card of the Claude Console: what it is, the figure, and what it is of. */
function AccountTile({ label, value, note, share = null }: { label: string; value: string; note: string; share?: number | null }) {
  return (
    <div className="space-y-1 border-b border-r border-border bg-muted/40 px-4 py-3 last:border-r-0 xl:border-b-0">
      <p className="text-[9px] uppercase tracking-wider text-muted-foreground/50">{label}</p>
      <p className="text-xl font-bold tabular-nums leading-none text-primary">{value}</p>
      <p className="text-[10px] text-muted-foreground">{note}</p>
      {share !== null && (
        <div className="mt-1 h-1 overflow-hidden rounded-full bg-muted">
          {/* A trace of spend is still drawn, so "some" never looks like "none". */}
          <div className="h-full rounded-full" style={{ width: `${share > 0 ? Math.max(share, 1.5) : 0}%`, background: LEVEL_FILL[usageLevel(share)] }} />
        </div>
      )}
    </div>
  );
}

// ─── Component ─────────────────────────────────────────────────────────────────

/**
 * The organization's AI usage, in the tokens the Claude API reported for each call (GET /ai-usage-totals): today against the daily
 * allowance, by feature, and over the last 30 days. Nothing here is estimated or converted.
 *
 * Above that, the Anthropic account's own figures, as the Claude Console shows them (GET /ai-account-totals): the spend this month
 * against the account's limit, and the last seven days' tokens, cache share and models. They are the whole account's, every
 * organization together, and every signed-in person sees them (owner's decision, 2026-11-28). They are Anthropic's reports, a few
 * hours behind at most; with no Admin API key on the server the bar shows the organization's tokens alone.
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
  const { data: account, isError: accountError } = useAiAccount();
  /** The Claude account's figures, once the server has an Admin API key to read them with. */
  const claude = account?.configured ? account : null;
  const spendShare = claude?.month.limitUsd ? shareUsed(claude.month.spendUsd, claude.month.limitUsd) : null;
  const cacheShare = claude ? cacheReadShare(claude.week) : null;
  const complete = claude ? completeTo(claude.asOf, new Date()) : null;
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

        {/* The Claude account's spend this month against its limit; until the server can read it, today's tokens against the daily allowance. */}
        {claude ? (
          <div className="hidden md:flex items-center gap-2.5 flex-1 max-w-xs">
            <div className="flex-1 h-1.5 rounded-full overflow-hidden bg-muted">
              <div
                className="h-full rounded-full transition-all duration-700"
                style={{ width: `${spendShare !== null && claude.month.spendUsd > 0 ? Math.max(spendShare, 1.5) : 0}%`, background: LEVEL_FILL[usageLevel(spendShare ?? 0)] }}
              />
            </div>
            <span className="text-[10px] tabular-nums text-muted-foreground whitespace-nowrap">
              {claude.month.limitUsd ? `${usd(claude.month.spendUsd)} / ${usdLimit(claude.month.limitUsd)} this month` : `${usd(claude.month.spendUsd)} this month`}
            </span>
          </div>
        ) : (
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
        )}

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

            {/* The Claude account, as the Claude Console shows it. Not shown at all while the server has no Admin API key to read it with
                (GET /ai-account-totals answers configured: false), nor before the first answer. */}
            {(claude !== null || accountError) && (
              <section aria-label="Claude account" className="mb-5">
                <p className="mb-3 text-[9px] uppercase tracking-widest text-muted-foreground/50">Claude account · every organization together</p>
                {claude ? (
                  <>
                    <div className="grid grid-cols-2 overflow-hidden rounded-lg border border-border xl:grid-cols-4">
                      <AccountTile label="Spend this month" value={usd(claude.month.spendUsd)} share={spendShare}
                        note={claude.month.limitUsd && spendShare !== null
                          ? `${wholePercent(spendShare)} of ${usdLimit(claude.month.limitUsd)} limit · resets ${resetDay(claude.month.resetsAt)}`
                          : `No spend limit known · resets ${resetDay(claude.month.resetsAt)}`} />
                      <AccountTile label="Token volume" value={tokenShort(claude.week.tokens)} note={`last 7 days · ${requests(claude.week.requests)}`} />
                      <AccountTile label="Prompt caching" value={cacheShare === null ? '—' : wholePercent(cacheShare)} note="of input tokens read from the cache · last 7 days" />
                      <AccountTile label="Spend, last 7 days" value={usd(claude.week.spendUsd)} note={`${tokenCount(claude.week.outputTokens)} output tokens`} />
                    </div>
                    {claude.week.models.length > 0 && (
                      <table className="mt-3 w-full text-[11px] tabular-nums">
                        <caption className="sr-only">The last 7 days by model</caption>
                        <thead>
                          <tr className="text-left text-[9px] uppercase tracking-wider text-muted-foreground/50">
                            <th scope="col" className="py-1 font-normal">Model · last 7 days</th>
                            <th scope="col" className="py-1 text-right font-normal">Tokens</th>
                            <th scope="col" className="py-1 text-right font-normal">Requests</th>
                            <th scope="col" className="py-1 text-right font-normal">Spend</th>
                          </tr>
                        </thead>
                        <tbody>
                          {claude.week.models.map(model => (
                            <tr key={model.model} className="border-t border-border">
                              <th scope="row" className="py-1.5 text-left font-medium text-foreground">{modelName(model.model)}</th>
                              <td className="py-1.5 text-right text-muted-foreground">{tokenCount(model.tokens)}</td>
                              <td className="py-1.5 text-right text-muted-foreground">{tokenCount(model.requests)}</td>
                              <td className="py-1.5 text-right text-foreground">{usd(model.spendUsd)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                    <p className="mt-3 text-[10px] text-muted-foreground/70">
                      From Anthropic's own usage and cost reports for the whole account{complete ? `, complete to ${complete}` : ''}. They run up to a few hours behind, and show spend before credits.
                    </p>
                  </>
                ) : (
                  <p className="rounded-lg border border-border bg-muted/40 px-4 py-3 text-[11px] text-muted-foreground">
                    The Claude account's figures are not available right now. They are tried again every few minutes.
                  </p>
                )}
              </section>
            )}

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
