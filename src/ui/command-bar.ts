/**
 * Top command bar.
 *
 * Doubles as the AI prompt box and a command palette: typing `/` or a known
 * verb surfaces editor commands, anything else is treated as a natural-language
 * building request routed to the AI assistant.
 *
 * AI results are never applied directly — the assistant stages a preview and
 * this bar renders the accept/reject card.
 */

import type { AiAssistant, AiProposal } from '../ai/assistant';
import type { Editor } from '../edit/editor';
import { EXAMPLE_PROMPTS } from '../ai/parser';
import { clear, el } from './dom';

export interface Command {
  id: string;
  label: string;
  hint?: string;
  run: () => void;
}

export class CommandBar {
  readonly root: HTMLElement;
  private input: HTMLInputElement;
  private inputRow: HTMLElement;
  private suggestions: HTMLElement;
  private proposalCard: HTMLElement;
  private editor: Editor;
  private assistant: AiAssistant;
  private commands: Command[];
  private activeIndex = 0;
  private visibleSuggestions: Array<{ label: string; kind: string; run: () => void }> = [];
  private busy = false;

  constructor(editor: Editor, assistant: AiAssistant, commands: Command[]) {
    this.editor = editor;
    this.assistant = assistant;
    this.commands = commands;

    this.input = el('input', {
      id: 'command-input',
      class: 'grow',
      attrs: {
        type: 'text',
        placeholder: 'Ask the AI to build something, or type a command…',
        spellcheck: 'false',
        autocomplete: 'off',
      },
      on: {
        focus: () => this.showSuggestions(),
        input: () => this.showSuggestions(),
        blur: () => setTimeout(() => this.hideSuggestions(), 160),
        keydown: (e) => this.onKeyDown(e),
      },
    });

    this.inputRow = el('div', { class: 'command-input-row' }, [
      el('span', { class: 'command-icon', text: '✦' }),
      this.input,
      el('span', { class: 'command-hint', text: 'Ctrl K' }),
    ]);

    this.suggestions = el('div', { class: 'command-suggestions panel' });
    this.proposalCard = el('div', { class: 'proposal panel' });

    this.root = el('div', { id: 'command-bar' }, [this.inputRow, this.suggestions, this.proposalCard]);

    document.addEventListener('webworld:focus-command', () => this.focus());
    document.addEventListener('webworld:escape', () => {
      this.hideSuggestions();
      if (this.assistant.pending) this.rejectProposal();
    });

    assistant.events.on('thinking', () => this.setBusy(true));
    assistant.events.on('proposal', ({ proposal }) => {
      this.setBusy(false);
      this.showProposal(proposal);
    });
    assistant.events.on('error', ({ message }) => {
      this.setBusy(false);
      this.editor.notify(message, 'error');
    });
    assistant.events.on('applied', () => this.hideProposal());
    assistant.events.on('rejected', () => this.hideProposal());
  }

  focus(): void {
    this.input.focus();
    this.input.select();
  }

  private setBusy(busy: boolean): void {
    this.busy = busy;
    this.inputRow.classList.toggle('busy', busy);
    this.input.placeholder = busy ? 'Planning…' : 'Ask the AI to build something, or type a command…';
  }

  // ------------------------------------------------------------ suggestions

  private showSuggestions(): void {
    const query = this.input.value.trim().toLowerCase();
    this.visibleSuggestions = [];

    if (query.startsWith('/') || query.length === 0) {
      const q = query.replace(/^\//, '');
      for (const command of this.commands) {
        if (q && !command.label.toLowerCase().includes(q) && !command.id.includes(q)) continue;
        this.visibleSuggestions.push({
          label: command.label,
          kind: command.hint ?? 'command',
          run: () => {
            command.run();
            this.input.value = '';
            this.hideSuggestions();
          },
        });
      }
      if (query.length === 0) {
        for (const prompt of EXAMPLE_PROMPTS.slice(0, 6)) {
          this.visibleSuggestions.push({
            label: prompt,
            kind: 'ai',
            run: () => {
              this.input.value = prompt;
              this.submit();
            },
          });
        }
      }
    } else {
      const matching = this.commands.filter(
        (c) => c.label.toLowerCase().includes(query) || c.id.includes(query),
      );
      for (const command of matching.slice(0, 4)) {
        this.visibleSuggestions.push({
          label: command.label,
          kind: 'command',
          run: () => {
            command.run();
            this.input.value = '';
            this.hideSuggestions();
          },
        });
      }
      for (const prompt of this.assistant.history.filter((h) => h.toLowerCase().includes(query)).slice(0, 3)) {
        this.visibleSuggestions.push({
          label: prompt,
          kind: 'recent',
          run: () => {
            this.input.value = prompt;
            this.submit();
          },
        });
      }
      for (const prompt of EXAMPLE_PROMPTS.filter((p) => p.toLowerCase().includes(query)).slice(0, 4)) {
        this.visibleSuggestions.push({ label: prompt, kind: 'ai', run: () => { this.input.value = prompt; this.submit(); } });
      }
    }

    this.activeIndex = 0;
    this.renderSuggestions();
  }

  private renderSuggestions(): void {
    clear(this.suggestions);
    if (this.visibleSuggestions.length === 0) {
      this.suggestions.classList.remove('open');
      return;
    }
    this.suggestions.classList.add('open');
    this.visibleSuggestions.slice(0, 10).forEach((suggestion, index) => {
      this.suggestions.appendChild(
        el(
          'div',
          {
            class: `suggestion ${index === this.activeIndex ? 'active' : ''}`,
            on: { mousedown: (e) => { e.preventDefault(); suggestion.run(); } },
          },
          [
            el('span', { class: 'truncate', text: suggestion.label }),
            el('span', { class: 'kind', text: suggestion.kind }),
          ],
        ),
      );
    });
  }

  private hideSuggestions(): void {
    this.suggestions.classList.remove('open');
  }

  private onKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Enter') {
      event.preventDefault();
      const active = this.visibleSuggestions[this.activeIndex];
      if (this.suggestions.classList.contains('open') && active && this.input.value.startsWith('/')) {
        active.run();
      } else {
        this.submit();
      }
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      this.activeIndex = Math.min(this.visibleSuggestions.length - 1, this.activeIndex + 1);
      this.renderSuggestions();
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      this.activeIndex = Math.max(0, this.activeIndex - 1);
      this.renderSuggestions();
      return;
    }
    if (event.key === 'Tab' && this.visibleSuggestions[this.activeIndex]) {
      event.preventDefault();
      this.input.value = this.visibleSuggestions[this.activeIndex].label;
      return;
    }
    if (event.key === 'Escape') {
      this.hideSuggestions();
      this.input.blur();
    }
  }

  private async submit(): Promise<void> {
    const value = this.input.value.trim();
    if (!value || this.busy) return;

    if (value.startsWith('/')) {
      const q = value.slice(1).toLowerCase();
      const command = this.commands.find((c) => c.id === q || c.label.toLowerCase() === q)
        ?? this.commands.find((c) => c.label.toLowerCase().includes(q));
      if (command) {
        command.run();
        this.input.value = '';
        this.hideSuggestions();
      } else {
        this.editor.notify(`Unknown command "${value}"`, 'warn');
      }
      return;
    }

    this.hideSuggestions();
    await this.assistant.propose(value);
  }

  // --------------------------------------------------------------- proposal

  private showProposal(proposal: AiProposal): void {
    clear(this.proposalCard);
    const opsText = proposal.plan.operations
      .map((op, i) => `${i + 1}. ${JSON.stringify(op)}`)
      .join('\n');

    this.proposalCard.appendChild(el('h4', { text: `AI plan — ${proposal.plan.source === 'remote' ? 'model' : 'local planner'}` }));
    this.proposalCard.appendChild(el('div', { class: 'summary', text: proposal.plan.summary }));
    this.proposalCard.appendChild(
      el('div', { class: 'faint', style: { marginBottom: '8px' } }, [
        `${proposal.blocks.length.toLocaleString()} blocks${proposal.truncated ? ' (preview truncated)' : ''} · planned in ${proposal.ms.toFixed(0)}ms · confidence ${(proposal.plan.confidence * 100).toFixed(0)}%`,
      ]),
    );
    this.proposalCard.appendChild(el('div', { class: 'ops', text: opsText }));
    this.proposalCard.appendChild(
      el('div', { class: 'actions' }, [
        el('button', { text: 'Discard', on: { click: () => this.rejectProposal() } }),
        el('button', {
          class: 'primary',
          text: 'Apply',
          on: {
            click: () => {
              this.assistant.apply();
              this.input.value = '';
            },
          },
        }),
      ]),
    );
    this.proposalCard.classList.add('open');
  }

  private rejectProposal(): void {
    this.assistant.reject();
    this.hideProposal();
  }

  private hideProposal(): void {
    this.proposalCard.classList.remove('open');
    clear(this.proposalCard);
  }
}
