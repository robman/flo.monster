import type { NetworkPolicy } from '@flo-monster/core';

export function checkNetworkPolicy(url: string, policy?: NetworkPolicy): void {
  if (!policy) return;
  const effectiveMode = policy.mode ?? 'allow-all';
  if (effectiveMode === 'allow-all') return;

  const parsedUrl = new URL(url);
  const matchesDomain = (domain: string) =>
    parsedUrl.hostname === domain || parsedUrl.hostname.endsWith('.' + domain);

  if (effectiveMode === 'allowlist') {
    const allowed = policy.allowedDomains?.some(matchesDomain) ?? false;
    if (!allowed) throw new Error(`Domain ${parsedUrl.hostname} not allowed by network policy`);
  } else if (effectiveMode === 'blocklist') {
    const blocked = policy.blockedDomains?.some(matchesDomain) ?? false;
    if (blocked) throw new Error(`Domain ${parsedUrl.hostname} blocked by network policy`);
  }
}
