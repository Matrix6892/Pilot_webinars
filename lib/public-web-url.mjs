export function isSearchResultUrl(value) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLocaleLowerCase();
    const pathParts = url.pathname
      .toLocaleLowerCase()
      .split("/")
      .filter(Boolean);
    return (
      pathParts.includes("search") ||
      host.startsWith("search.") ||
      host.includes(".google.") ||
      host === "google.com" ||
      host.endsWith(".bing.com") ||
      host === "bing.com" ||
      host.endsWith(".duckduckgo.com") ||
      host === "duckduckgo.com" ||
      host.startsWith("yandex.") ||
      host.includes(".yandex.")
    );
  } catch {
    return false;
  }
}
