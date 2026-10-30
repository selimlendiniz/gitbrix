// Markdown from GitHub and GitLab (descriptions, comments, issues), shown
// as the web pages show it. Like the web pages, the service renders it
// (GitLab Flavored Markdown: #12, !4 and @name become links, code is
// highlighted) and the HTML it sends is shown, cleaned again here. Without
// it (an older answer, an error) the text is rendered here instead. Either
// way HTML is kept to what GitHub allows: no scripts, styles or event
// handlers. Links open in the browser; pictures are links (the app loads
// no outside images).

import { openUrl } from "@tauri-apps/plugin-opener";
import type { Element, Root } from "hast";
import { toJsxRuntime } from "hast-util-to-jsx-runtime";
import { ReactNode, useEffect, useMemo, useState } from "react";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
import ReactMarkdown, { Components } from "react-markdown";
import rehypeParse from "rehype-parse";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema, Options as Schema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import { unified } from "unified";

import { highlightLines, languageFor, Token } from "../diff/highlight";

/** The project's page from a request's or issue's address:
 * `https://gitlab.com/g/app/-/merge_requests/3` → `https://gitlab.com/g/app`,
 * `https://github.com/o/r/pull/3` → `https://github.com/o/r`. */
export function projectPage(url: string): string | null {
  const m = url.match(/^(https?:\/\/[^/]+\/.+?)(?:\/-\/|\/(?:pull|issues)\/\d+)/);
  return m ? m[1] : null;
}

/** Where a link in the text points, as an address the browser can open;
 * null for anchors and anything that isn't a web or mail address. */
export function resolveLink(href: string | undefined, project: string | null): string | null {
  if (!href) return null;
  if (/^(https?:|mailto:)/i.test(href)) return href;
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("#") || !project) return null;
  const origin = project.match(/^https?:\/\/[^/]+/)![0];
  // GitLab's attachments live under the project.
  if (href.startsWith("/uploads/")) return `${project}${href}`;
  if (href.startsWith("/")) return `${origin}${href}`;
  const sep = project.startsWith("https://github.com/") ? "/blob/HEAD/" : "/-/blob/HEAD/";
  return `${project}${sep}${href.replace(/^\.\//, "")}`;
}

function Tokens({ lines }: { lines: Token[][] }) {
  return (
    <>
      {lines.map((line, i) => (
        <span key={i}>
          {line.map((t, k) => (
            <span key={k} className={t.cls ? t.cls.split(" ").map((c) => `hl-${c}`).join(" ") : undefined}>
              {t.text}
            </span>
          ))}
          {i < lines.length - 1 && "\n"}
        </span>
      ))}
    </>
  );
}

/** A fenced block, highlighted once its language has loaded. */
function CodeBlock({ code, lang }: { code: string; lang: string }) {
  const [lines, setLines] = useState<Token[][] | null>(null);
  useEffect(() => {
    let live = true;
    const language = languageFor(`f.${lang}`) ?? lang;
    void highlightLines(code.split("\n"), language).then((l) => live && setLines(l));
    return () => {
      live = false;
    };
  }, [code, lang]);
  return <code className="md-code">{lines ? <Tokens lines={lines} /> : code}</code>;
}

function components(project: string | null): Components {
  const open = (href: string | null) => (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (href) void openUrl(href);
  };
  return {
    a: ({ href, children }) => {
      const to = resolveLink(href, project);
      return to ? (
        <a href={to} title={to} onClick={open(to)}>
          {children}
        </a>
      ) : (
        <span className="md-dead-link">{children}</span>
      );
    },
    img: (props) => {
      const { src, alt } = props;
      // GitLab's pictures load lazily: the real address is data-src.
      const lazy = (props as Record<string, unknown>)["data-src"];
      const to = resolveLink(typeof lazy === "string" ? lazy : typeof src === "string" ? src : undefined, project);
      const label = alt || "image";
      return to ? (
        <a href={to} title={to} className="md-image" onClick={open(to)}>
          [{label}]
        </a>
      ) : (
        <span className="md-image">[{label}]</span>
      );
    },
    code: ({ className, children }) => {
      const lang = className?.match(/language-([\w+#-]+)/)?.[1];
      // Already highlighted (the service's HTML): as it is.
      return lang && typeof children === "string" ? (
        <CodeBlock code={children.replace(/\n$/, "")} lang={lang.toLowerCase()} />
      ) : (
        <code>{children}</code>
      );
    },
    input: ({ type, checked }) => (type === "checkbox" ? <input type="checkbox" checked={!!checked} disabled readOnly /> : null),
  };
}

/** GitLab's (Rouge) and GitHub's token classes, as the diff view's. */
const TOKENS: [RegExp, string][] = [
  [/^(k[cdnprtv]?|pl-k|pl-kos)$/, "keyword"],
  [/^(s[12bcdehirxs]?|pl-s|pl-pds|pl-sr|pl-s1)$/, "string"],
  [/^(c[1hmps]?|cpf|pl-c)$/, "comment"],
  [/^(m[bfhio]?|il|pl-c1)$/, "number"],
  [/^(nf|fm|pl-en)$/, "title"],
  [/^(nc|pl-ent)$/, "class_"],
  [/^(na|pl-e)$/, "attr"],
  [/^(nt)$/, "tag"],
  [/^(nb|bp)$/, "built_in"],
  [/^(n[vx]|v[cgi]|pl-smi|pl-v)$/, "variable"],
];

/** Only token classes survive, renamed to the app's: a class from the
 * page can't reach the app's own styles. A picture inside a link is just
 * its name (it becomes a link itself otherwise, and links don't nest). */
function tokenClasses() {
  return (tree: Root) => {
    const walk = (node: Root | Element, inLink: boolean) => {
      node.children.forEach((child, i) => {
        if (child.type !== "element") return;
        if (inLink && child.tagName === "img") {
          node.children[i] = { type: "text", value: `[${String(child.properties.alt || "image")}]` };
          return;
        }
        const given = child.properties.className;
        if (given !== undefined) {
          const names = (Array.isArray(given) ? given : [given]).map(String);
          const kinds =
            child.tagName === "span"
              ? names.flatMap((n) => TOKENS.filter(([re]) => re.test(n)).map(([, k]) => `hl-${k}`))
              : child.tagName === "code"
                ? names.filter((n) => /^language-[\w+#-]+$/.test(n))
                : [];
          child.properties.className = kinds.length ? kinds : undefined;
        }
        walk(child, inLink || child.tagName === "a");
      });
    };
    walk(tree, false);
  };
}

/** What a service's HTML may keep: GitHub's rules, token classes on
 * spans (renamed next), GitLab's lazy picture address. */
const SCHEMA: Schema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    span: [...(defaultSchema.attributes?.span ?? []), "className"],
    img: [...(defaultSchema.attributes?.img ?? []), "dataSrc"],
  },
};

const htmlParser = unified().use(rehypeParse, { fragment: true }).use(rehypeSanitize, SCHEMA).use(tokenClasses);

function ServiceHtml({ html, project }: { html: string; project: string | null }) {
  return useMemo(() => {
    const tree = htmlParser.runSync(htmlParser.parse(html)) as Root;
    return toJsxRuntime(tree, { Fragment, jsx, jsxs, components: components(project) as never, passKeys: true });
  }, [html, project]);
}

/** `text` as Markdown, or the service's `html` of it when there is one;
 * `url` is the request's or issue's page, for links relative to the
 * project. */
export function Markdown({ text, html, url, className }: { text: string; html?: string | null; url?: string; className?: string }): ReactNode {
  const project = url ? projectPage(url) : null;
  return (
    <div className={`markdown${className ? ` ${className}` : ""}`}>
      {html ? (
        <ServiceHtml html={html} project={project} />
      ) : (
        <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeRaw, [rehypeSanitize, SCHEMA], tokenClasses]} components={components(project)}>
          {text}
        </ReactMarkdown>
      )}
    </div>
  );
}
