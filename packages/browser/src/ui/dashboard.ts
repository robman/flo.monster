import type { AgentContainer } from '../agent/agent-container.js';
import type { AgentManager } from '../shell/agent-manager.js';
import type { HubAgentProxy } from '../shell/hub-agent-proxy.js';
import { AgentCard } from './agent-card.js';
import type { AgentCardCallbacks } from './agent-card.js';
import { HubAgentCard } from './hub-agent-card.js';
import type { HubAgentCardCallbacks } from './hub-agent-card.js';

export class Dashboard {
  private container: HTMLElement;
  private gridEl: HTMLElement;
  private cards = new Map<string, AgentCard>();
  private hubCards = new Map<string, HubAgentCard>();
  private agentManager: AgentManager;
  private onAgentSelect: (agentId: string) => void;
  private onNewAgent: () => void;
  private cardCallbacks: Partial<AgentCardCallbacks>;
  private unsubscribers: (() => void)[] = [];
  private _offline = false;

  constructor(
    container: HTMLElement,
    agentManager: AgentManager,
    onAgentSelect: (agentId: string) => void,
    onNewAgent: () => void,
    cardCallbacks?: Partial<AgentCardCallbacks>,
  ) {
    this.container = container;
    this.agentManager = agentManager;
    this.onAgentSelect = onAgentSelect;
    this.onNewAgent = onNewAgent;
    this.cardCallbacks = cardCallbacks || {};

    // Create grid
    this.gridEl = document.createElement('div');
    this.gridEl.className = 'dashboard-grid';

    // Add existing agents
    for (const agent of agentManager.getAllAgents()) {
      this.addCard(agent);
    }

    // Always add the "New Agent" card at the end
    this.appendNewAgentCard();

    container.appendChild(this.gridEl);

    // Subscribe to agent events
    this.unsubscribers.push(
      agentManager.onAgentCreated((agent) => {
        this.addCard(agent);
        this.refreshNewAgentCard();
      }),
      agentManager.onAgentTerminated((agentId) => {
        this.removeCard(agentId);
      }),
    );
  }

  private addCard(agent: AgentContainer): void {
    const card = new AgentCard(agent, { onSelect: this.onAgentSelect, ...this.cardCallbacks });
    this.cards.set(agent.id, card);
    if (this._offline) {
      card.setDisabled(true);
    }
    // Insert before the "new agent" card
    const newAgentCard = this.gridEl.querySelector('.agent-card--new');
    if (newAgentCard) {
      this.gridEl.insertBefore(card.getElement(), newAgentCard);
    } else {
      this.gridEl.appendChild(card.getElement());
    }
  }

  private removeCard(agentId: string): void {
    const card = this.cards.get(agentId);
    if (card) {
      card.dispose();
      this.cards.delete(agentId);
    }
  }

  private appendNewAgentCard(): void {
    const newCard = document.createElement('div');
    newCard.className = 'agent-card agent-card--new';
    newCard.innerHTML = `
      <div class="agent-card__new-icon">+</div>
      <div class="agent-card__new-label">New Agent</div>
    `;
    newCard.addEventListener('click', () => this.onNewAgent());
    this.gridEl.appendChild(newCard);
  }

  private refreshNewAgentCard(): void {
    // Ensure "New Agent" card is always last
    const newCard = this.gridEl.querySelector('.agent-card--new');
    if (newCard) {
      this.gridEl.appendChild(newCard);
    }
  }

  /**
   * Get a card by agent ID
   */
  getCard(agentId: string): AgentCard | undefined {
    return this.cards.get(agentId);
  }

  /**
   * Update the displayed cost for an agent card
   */
  updateAgentCost(agentId: string, cost: number): void {
    const card = this.cards.get(agentId);
    if (card) {
      card.updateCost(cost);
    }
  }

  addHubAgentCard(proxy: HubAgentProxy, callbacks: HubAgentCardCallbacks, hubName: string): void {
    const card = new HubAgentCard(proxy, callbacks, hubName);
    this.hubCards.set(proxy.hubAgentId, card);
    if (this._offline) {
      card.setDisabled(true);
    }
    // Insert before the "new agent" card
    const newAgentCard = this.gridEl.querySelector('.agent-card--new');
    if (newAgentCard) {
      this.gridEl.insertBefore(card.getElement(), newAgentCard);
    } else {
      this.gridEl.appendChild(card.getElement());
    }
  }

  removeHubAgentCard(hubAgentId: string): void {
    const card = this.hubCards.get(hubAgentId);
    if (card) {
      card.dispose();
      this.hubCards.delete(hubAgentId);
    }
  }

  removeAllHubAgentCards(): void {
    for (const card of this.hubCards.values()) {
      card.dispose();
    }
    this.hubCards.clear();
  }

  setOffline(offline: boolean): void {
    this._offline = offline;
    // Disable/enable all card action buttons
    for (const card of this.cards.values()) {
      card.setDisabled(offline);
    }
    for (const card of this.hubCards.values()) {
      card.setDisabled(offline);
    }
    // Disable/enable the New Agent card
    const newAgentCard = this.gridEl.querySelector('.agent-card--new') as HTMLElement | null;
    if (newAgentCard) {
      newAgentCard.classList.toggle('agent-card--disabled', offline);
      newAgentCard.style.pointerEvents = offline ? 'none' : '';
    }
  }

  unmount(): void {
    for (const unsub of this.unsubscribers) unsub();
    this.unsubscribers = [];
    for (const card of this.cards.values()) card.dispose();
    this.cards.clear();
    for (const card of this.hubCards.values()) card.dispose();
    this.hubCards.clear();
    this.gridEl.remove();
  }
}
