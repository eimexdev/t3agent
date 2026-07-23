const MODEL_SLUG_SEPARATOR = "::";

export function encodeHermesModelSlug(provider: string, model: string): string {
  return `${provider}${MODEL_SLUG_SEPARATOR}${model}`;
}

export function decodeHermesModelSlug(
  value: string,
): { readonly provider: string; readonly model: string } | undefined {
  const separatorIndex = value.indexOf(MODEL_SLUG_SEPARATOR);
  if (separatorIndex <= 0 || separatorIndex >= value.length - MODEL_SLUG_SEPARATOR.length) {
    return undefined;
  }
  return {
    provider: value.slice(0, separatorIndex),
    model: value.slice(separatorIndex + MODEL_SLUG_SEPARATOR.length),
  };
}
