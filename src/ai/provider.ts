/**
 * Optional remote LLM provider.
 *
 * WebWorld works fully offline with the local rule parser. If a user configures
 * an endpoint, prompts are additionally sent to a chat-completions compatible
 * API which is asked to return the *same* `AiPlan` JSON. The response is then
 * validated against the local schema, so a model can only trigger operations
 * the editor already implements — it can never inject arbitrary behaviour.
 */

import { AI_SYSTEM_PROMPT, OPERATION_NAMES, type AiOperation, type AiPlan } from './intents';

export interface ProviderConfig {
  enabled: boolean;
  /** Any OpenAI-compatible /chat/completions endpoint. */
  endpoint: string;
  apiKey: string;
  model: string;
}

const STORAGE_KEY = 'webworld.ai.provider';

export const defaultProviderConfig: ProviderConfig = {
  enabled: false,
  endpoint: 'https://api.openai.com/v1/chat/completions',
  apiKey: '',
  model: 'gpt-4o-mini',
};

export function loadProviderConfig(): ProviderConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return { ...defaultProviderConfig, ...JSON.parse(raw) };
  } catch {
    /* ignore */
  }
  return { ...defaultProviderConfig };
}

export function saveProviderConfig(config: ProviderConfig): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
  } catch {
    /* ignore */
  }
}

const OPS = new Set<string>(OPERATION_NAMES);

/** Rejects anything that isn't a known operation with sane numeric bounds. */
export function validatePlan(input: unknown): AiPlan | null {
  if (!input || typeof input !== 'object') return null;
  const raw = input as { summary?: unknown; operations?: unknown };
  if (!Array.isArray(raw.operations)) return null;

  const operations: AiOperation[] = [];
  for (const entry of raw.operations) {
    if (!entry || typeof entry !== 'object') continue;
    const op = (entry as { op?: unknown }).op;
    if (typeof op !== 'string' || !OPS.has(op)) continue;
    const clean: Record<string, unknown> = { op };
    for (const [key, value] of Object.entries(entry as Record<string, unknown>)) {
      if (key === 'op') continue;
      if (typeof value === 'number') {
        if (!Number.isFinite(value)) continue;
        clean[key] = Math.max(-1e6, Math.min(1e6, value));
      } else if (typeof value === 'string' || typeof value === 'boolean') {
        clean[key] = value;
      } else if (value && typeof value === 'object') {
        clean[key] = value;
      }
    }
    operations.push(clean as unknown as AiOperation);
  }
  if (operations.length === 0) return null;

  return {
    summary: typeof raw.summary === 'string' ? raw.summary : 'AI plan',
    operations,
    source: 'remote',
    confidence: 0.9,
  };
}

export async function requestRemotePlan(
  prompt: string,
  config: ProviderConfig,
  signal?: AbortSignal,
): Promise<AiPlan | null> {
  if (!config.enabled || !config.endpoint) return null;

  const response = await fetch(config.endpoint, {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: config.model,
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: AI_SYSTEM_PROMPT },
        { role: 'user', content: prompt },
      ],
    }),
  });

  if (!response.ok) throw new Error(`AI provider returned HTTP ${response.status}`);
  const body = await response.json();
  const content: string | undefined = body?.choices?.[0]?.message?.content;
  if (!content) return null;

  try {
    return validatePlan(JSON.parse(content));
  } catch {
    // Some models wrap JSON in prose/markdown — salvage the first object.
    const match = /\{[\s\S]*\}/.exec(content);
    if (!match) return null;
    try {
      return validatePlan(JSON.parse(match[0]));
    } catch {
      return null;
    }
  }
}
