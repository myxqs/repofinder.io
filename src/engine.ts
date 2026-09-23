}
export function normalizeUrl(input: string): string {
    const s = input.trim();
    const value = /^https?:\/\//i.test(s) ? s : `https://${s}`;
    const url = new URL(value);
    if (!/^https?:$/.test(url.protocol))
        throw new InputError("Only http and https websites are supported.");
    if (!isPublicHostname(url.hostname))
        throw new InputError("Private or local network addresses are not supported.");
    url.username = "";
    url.password = "";
    url.hash = "";
    return url.pathname === "/" && !url.search ? url.origin : url.toString();
}
async function fetchSite(input: string): Promise<{
    host: string;
    title: string;
    text: string;
}> {
    const url = normalizeUrl(input);
    let res: Response;
    try {
        res = await fetchPublicPage(url);
    }
    catch {
        throw new Error("Could not reach that website.");
    }
    if (!res.ok)
        throw new Error(`Could not fetch that website (${res.status}).`);
    const contentType = res.headers.get("content-type") || "";
    if (!contentType.toLowerCase().includes("text/html")) {
        throw new Error("That address did not return an HTML page.");
    }
    const html = await res.text();
    const title = (html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] ?? "").trim();
    const desc = (html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i)?.[1] ?? "").trim();
    const body = htmlToText(html);
    const text = [desc, body].filter(Boolean).join("\n").slice(0, 5000);
    return { host: new URL(url).host.replace(/^www\./, ""), title, text };
}
async function fetchPublicPage(start: string): Promise<Response> {
    let current = new URL(start);
    for (let redirects = 0; redirects <= 3; redirects++) {
        if (!isPublicHostname(current.hostname))
            throw new Error("blocked host");
        const response = await fetch(current.toString(), {
            headers: { "User-Agent": "repofinder (https://repofinder.io)", Accept: "text/html" },
            redirect: "manual",
        });
        if (![301, 302, 303, 307, 308].includes(response.status))
            return response;
        const location = response.headers.get("location");
        if (!location)
            return response;
        current = new URL(location, current);
        if (!/^https?:$/.test(current.protocol))
            throw new Error("blocked protocol");
    }
    throw new Error("too many redirects");
}
export function isPublicHostname(hostname: string): boolean {
    const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (host === "localhost" ||
        host.endsWith(".localhost") ||
        host.endsWith(".local") ||
        host.endsWith(".internal") ||
        host.includes(":"))
        return false;
    const match = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (!match)
        return true;
    const octets = match.slice(1).map(Number);
    if (octets.some((part) => part > 255))
        return false;
    const [a, b] = octets;
    return !(a === 0 ||
        a === 10 ||
        a === 127 ||
        (a === 169 && b === 254) ||
        (a === 172 && b! >= 16 && b! <= 31) ||
        (a === 192 && b === 168) ||
        a! >= 224);
}
export function htmlToText(html: string): string {
    return html
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/\s+/g, " ")
        .trim();
}
export function clamp(n: number): number {
    if (typeof n !== "number" || Number.isNaN(n))
        return 3;
    return Math.max(1, Math.min(5, Math.round(n)));
}
// Human-readable age of the last push, shown to the ranker as a maintenance
// signal so it can avoid recommending abandoned repos.
function relativeAge(iso: string | null): string {
    if (!iso)
        return "unknown";
    const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
    if (days < 30)
        return "this month";
    if (days < 365)
        return `${Math.floor(days / 30)}mo ago`;
    return `${(days / 365).toFixed(1).replace(/\.0$/, "")}y ago`;
}
