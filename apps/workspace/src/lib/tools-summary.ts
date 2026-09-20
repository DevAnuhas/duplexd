export type ToolSummary = {
  name: string;
  description: string;
  parameterCount: number;
};

export type ToolsSummaryResult =
  | { ok: true; rows: ToolSummary[] }
  | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A read-only summary, not another tool validator or serializer. The original
 * textarea is submitted verbatim and the existing server validator decides
 * what can be saved. Never include the JSON parser's input-bearing exception
 * in a message: a malformed document must remain safe to display.
 */
export function summarizeTools(json: string): ToolsSummaryResult {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return { ok: false, error: 'Tools must be valid JSON. Check the syntax and try again.' };
  }

  if (!Array.isArray(value)) {
    return { ok: false, error: 'Tools must be a JSON array.' };
  }

  const rows: ToolSummary[] = [];
  for (const [index, entry] of value.entries()) {
    const tool = isRecord(entry)
      ? entry.type === 'function'
        ? entry.function
        : entry
      : null;

    if (
      !isRecord(tool) ||
      typeof tool.name !== 'string' ||
      typeof tool.description !== 'string' ||
      !isRecord(tool.parameters) ||
      (tool.parameters.properties !== undefined && !isRecord(tool.parameters.properties))
    ) {
      return {
        ok: false,
        error: `Tool ${index + 1} needs a name, description, and parameters object with valid properties.`,
      };
    }

    rows.push({
      name: tool.name,
      description: tool.description,
      parameterCount: Object.keys(tool.parameters.properties ?? {}).length,
    });
  }

  return { ok: true, rows };
}
