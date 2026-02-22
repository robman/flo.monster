import type { BudgetStatus } from '@flo-monster/core';

export type ResetOption = { type: 'all' } | { type: 'agent'; agentId: string; agentName: string };

export interface CostDisplayCallbacks {
  onResetRequest?: (options: ResetOption[]) => void;
  getAgentList?: () => Array<{ id: string; name: string }>;
}

export class CostDisplay {
  private container: HTMLElement;
  private tokensEl: HTMLElement;
  private costEl: HTMLElement;
  private budgetEl: HTMLElement;
  private callbacks: CostDisplayCallbacks;

  constructor(container: HTMLElement, callbacks: CostDisplayCallbacks = {}) {
    this.container = container;
    this.callbacks = callbacks;

    this.tokensEl = document.createElement('span');
    this.tokensEl.className = 'status-bar__item';
    this.tokensEl.textContent = '0 in / 0 out';

    this.costEl = document.createElement('span');
    this.costEl.className = 'status-bar__item status-bar__item--clickable';
    this.costEl.textContent = 'Cost: $0.00';
    this.costEl.title = 'Click to reset costs';
    this.costEl.style.cursor = 'pointer';
    this.costEl.addEventListener('click', () => this.showResetMenu());

    this.budgetEl = document.createElement('span');
    this.budgetEl.className = 'status-bar__item';
    this.budgetEl.style.display = 'none';

    container.appendChild(this.tokensEl);
    container.appendChild(this.costEl);
    container.appendChild(this.budgetEl);
  }

  private showResetMenu(): void {
    if (!this.callbacks.onResetRequest || !this.callbacks.getAgentList) return;

    const agents = this.callbacks.getAgentList();
    const options: ResetOption[] = [{ type: 'all' }];
    for (const agent of agents) {
      options.push({ type: 'agent', agentId: agent.id, agentName: agent.name });
    }

    this.callbacks.onResetRequest(options);
  }

  update(status: BudgetStatus): void {
    const { usage, cost, budget, remaining, overBudget } = status;

    this.tokensEl.textContent = `${this.formatNumber(usage.input_tokens)} in / ${this.formatNumber(usage.output_tokens)} out`;
    this.costEl.textContent = `Cost: $${cost.totalCost.toFixed(4)}`;

    if (budget.maxTokens !== undefined || budget.maxCostUsd !== undefined) {
      this.budgetEl.style.display = '';
      const parts: string[] = [];
      if (remaining.tokens !== undefined) {
        parts.push(`${this.formatNumber(remaining.tokens)} tokens left`);
      }
      if (remaining.costUsd !== undefined) {
        parts.push(`$${remaining.costUsd.toFixed(4)} left`);
      }
      this.budgetEl.textContent = parts.join(' | ');

      if (overBudget) {
        this.budgetEl.className = 'status-bar__item budget--critical';
        this.costEl.className = 'status-bar__item status-bar__item--clickable budget--critical';
      } else if (budget.maxCostUsd !== undefined && remaining.costUsd !== undefined) {
        const utilization = 1 - (remaining.costUsd / budget.maxCostUsd);
        if (utilization > 0.9) {
          this.budgetEl.className = 'status-bar__item budget--critical';
          this.costEl.className = 'status-bar__item status-bar__item--clickable budget--critical';
        } else if (utilization > 0.75) {
          this.budgetEl.className = 'status-bar__item budget--high';
          this.costEl.className = 'status-bar__item status-bar__item--clickable budget--high';
        } else if (utilization > 0.5) {
          this.budgetEl.className = 'status-bar__item budget--medium';
          this.costEl.className = 'status-bar__item status-bar__item--clickable budget--medium';
        } else {
          this.budgetEl.className = 'status-bar__item';
          this.costEl.className = 'status-bar__item status-bar__item--clickable';
        }
      } else {
        this.budgetEl.className = 'status-bar__item';
        this.costEl.className = 'status-bar__item status-bar__item--clickable';
      }
    } else {
      this.budgetEl.style.display = 'none';
      this.costEl.className = 'status-bar__item status-bar__item--clickable';
    }
  }

  private formatNumber(n: number): string {
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
    if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
    return String(n);
  }
}
