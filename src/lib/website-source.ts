/** Canonical display/matching key; the backend validates every installation. */
export function websiteSourceRef(input: string): string | null {
  try {
    const url = new URL(input.trim());
    if (url.protocol !== "https:" || !["skills.sh", "www.skills.sh"].includes(url.hostname)
      || url.username || url.password || url.port) return null;
    const match = /^\/site\/([a-z\d](?:[a-z\d.-]*[a-z\d])?)\/([a-z\d](?:[a-z\d.-]*[a-z\d])?)$/i.exec(url.pathname);
    return match ? `https://skills.sh/site/${new URL(`https://${match[1]}/`).hostname}/${match[2]}` : null;
  } catch {
    return null;
  }
}

export function isWebsiteMarketSource(source: string): boolean {
  return source.startsWith("site/") || !source.includes("/");
}

export function marketSourceRef(source: string, skill: string): string {
  const ref = `${source}/${skill}`;
  const domain = source.replace(/^site\//, "");
  return isWebsiteMarketSource(source) ? websiteSourceRef(`https://skills.sh/site/${domain}/${skill}`) ?? ref : ref;
}
