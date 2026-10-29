import type { RunResult } from './runner.ts';

type Block = {
  type: string;
  id: string;
  name: string;
  input: Record<string, unknown>;
  tool_use_id: string;
  content: string | { type: string; text?: string }[];
  is_error?: boolean;
};
type Event = {
  type: string;
  subtype?: string;
  tools?: string[];
  message?: { content?: Block[] };
  tool_use_result?: unknown;
  permission_denials?: { tool_use_id: string; tool_name: string; tool_input: Record<string, unknown> }[];
  total_cost_usd?: number;
};

export function parseStream(jsonl: string): RunResult {
  const result: RunResult = { calls: [], results: [], tools: [], denials: [], subtype: '', exitCode: null };
  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue;
    const event: Event = JSON.parse(line);
    if (event.type === 'system' && event.subtype === 'init') result.tools = event.tools ?? [];
    if (event.type === 'assistant') {
      for (const block of event.message?.content ?? []) {
        if (block.type === 'tool_use') result.calls.push({ id: block.id, name: block.name, input: block.input });
      }
    }
    if (event.type === 'user') {
      for (const block of event.message?.content ?? []) {
        if (block.type !== 'tool_result') continue;
        const text = typeof block.content === 'string' ? block.content
          : (block.content ?? []).filter((part) => part.type === 'text').map((part) => part.text ?? '').join('\n');
        result.results.push({ toolUseId: block.tool_use_id, text, isError: block.is_error === true,
          ...('tool_use_result' in event ? { structured: event.tool_use_result } : {}),
        });
      }
    }
    if (event.type === 'result') {
      result.subtype = event.subtype ?? '';
      result.denials = (event.permission_denials ?? []).map((denial) => ({
        id: denial.tool_use_id, name: denial.tool_name, input: denial.tool_input,
      }));
      if (event.total_cost_usd !== undefined) result.costUsd = event.total_cost_usd;
    }
  }
  return result;
}
