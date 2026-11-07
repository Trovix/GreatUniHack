const URL_PATTERN = /\bhttps?:\/\/[^\s<>"']+/gi;
export function redactSourceText(text: string): string {
  // Navigation URLs are not necessary to understand a lecture and may contain credentials.
  return text.replace(URL_PATTERN, '[source URL withheld]');
}

export function redactForReport(value: unknown, secrets: readonly string[] = []): unknown {
  const walk = (item: unknown): unknown => {
    if (typeof item === 'string') {
      let result = redactSourceText(item);
      for (const secret of secrets) if (secret) result = result.split(secret).join('[secret withheld]');
      return result;
    }
    if (Array.isArray(item)) return item.map(walk);
    if (item && typeof item === 'object') {
      return Object.fromEntries(Object.entries(item).map(([key, child]) => [key,
        /^(authorization|xi-api-key|apiKey|api_key|token|password|secret|cookie|set-cookie)$/i.test(key)
          ? '[secret withheld]' : walk(child),
      ]));
    }
    return item;
  };
  return walk(value);
}
