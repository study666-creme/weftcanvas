import {
  agentModelCatalogSchema,
  agentModelIdSchema,
  type AgentModelCatalog,
} from "@weftcanvas/contracts";

const MAX_MODEL_COUNT = 64;
const MAX_MODELS_ENV_LENGTH = MAX_MODEL_COUNT * 128 + MAX_MODEL_COUNT - 1;
const MODEL_LABELS = [
  { id: "gpt-5.6-sol", label: "GPT-5.6 Sol" },
  { id: "gpt-5.6-terra", label: "GPT-5.6 Terra" },
  { id: "gpt-5.6-luna", label: "GPT-5.6 Luna" },
  { id: "gpt-5.5", label: "GPT-5.5" },
  { id: "gpt-5.4", label: "GPT-5.4" },
  { id: "gpt-5.4-mini", label: "GPT-5.4 Mini" },
  { id: "gpt-5", label: "GPT-5" },
  { id: "gpt-5-mini", label: "GPT-5 Mini" },
] as const;

/**
 * Model allowlist for one Agent runtime.
 *
 * `OPENAI_MODELS` may be:
 *  - unset or `*`  → open mode: any syntactically valid model id is forwarded to
 *    the upstream. Canvas API is the authority: it only hands over model ids that
 *    the published platform catalog actually exposes (see AgentService).
 *  - a comma list  → strict mode: only the listed ids are accepted.
 */
export class AgentModelRegistry {
  private readonly catalog: AgentModelCatalog;
  private readonly ids: ReadonlySet<string> | null;

  constructor(defaultModelIdValue: string, configuredModels: string | undefined) {
    const defaultModelId = agentModelIdSchema.parse(defaultModelIdValue);
    if (configuredModels === undefined || configuredModels.trim() === "*") {
      this.catalog = agentModelCatalogSchema.parse({
        defaultModelId,
        models: [{ id: defaultModelId, label: modelLabel(defaultModelId) }],
      });
      this.ids = null;
      return;
    }
    const source = configuredModels;
    if (source.length > MAX_MODELS_ENV_LENGTH) {
      throw new Error(`OPENAI_MODELS must not exceed ${MAX_MODELS_ENV_LENGTH} characters`);
    }

    const ids = source.split(",").map((value) => agentModelIdSchema.parse(value));
    this.catalog = agentModelCatalogSchema.parse({
      defaultModelId,
      models: ids.map((id) => ({ id, label: modelLabel(id) })),
    });
    this.ids = new Set(ids);
  }

  getCatalog(): AgentModelCatalog {
    return structuredClone(this.catalog);
  }

  allows(modelId: string) {
    const parsed = agentModelIdSchema.safeParse(modelId);
    if (!parsed.success) return false;
    return this.ids === null || this.ids.has(parsed.data);
  }
}

function modelLabel(id: string) {
  return MODEL_LABELS.find((model) => model.id === id)?.label ?? id;
}
