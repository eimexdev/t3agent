import { ProviderInstanceId } from "@t3tools/contracts";

export type ProductMode = "t3code" | "t3agent";

export function resolveProductMode(value: string | undefined): ProductMode {
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "t3agent"
    ? "t3agent"
    : "t3code";
}

export const PRODUCT_MODE = resolveProductMode(import.meta.env.VITE_T3_AGENT_MODE);
export const IS_T3_AGENT_MODE = PRODUCT_MODE === "t3agent";
export const T3_AGENT_PROVIDER_INSTANCE_ID = ProviderInstanceId.make("hermes");

type ProviderBackedThread = {
  readonly modelSelection: { readonly instanceId: ProviderInstanceId };
  readonly session: { readonly providerInstanceId?: ProviderInstanceId | undefined } | null;
};

export function isT3AgentProviderInstance(instanceId: ProviderInstanceId): boolean {
  return instanceId === T3_AGENT_PROVIDER_INSTANCE_ID;
}

export function isT3AgentThread(thread: ProviderBackedThread): boolean {
  return (
    isT3AgentProviderInstance(thread.modelSelection.instanceId) ||
    (thread.session?.providerInstanceId !== undefined &&
      isT3AgentProviderInstance(thread.session.providerInstanceId))
  );
}

export function selectProductModeThreads<T extends ProviderBackedThread>(
  threads: ReadonlyArray<T>,
  productMode: ProductMode = PRODUCT_MODE,
): ReadonlyArray<T> {
  return productMode === "t3agent" ? threads.filter(isT3AgentThread) : threads;
}
