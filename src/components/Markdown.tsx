// Markdown from GitHub and GitLab (descriptions, comments, issues), shown
// as the web pages show it. Raw HTML in it is never rendered; links open
// in the browser; pictures are links (the app loads no outside images).

import { openUrl } from "@tauri-apps/plugin-opener";
import { ReactNode, useEffect, useState } from "react";
import ReactMarkdown, { Components } from "react-markdown";
import remarkGfm from "remark-gfm";

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
    img: ({ src, alt }) => {
      const to = resolveLink(typeof src === "string" ? src : undefined, project);
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
      const text = String(children ?? "");
      return lang ? <CodeBlock code={text.replace(/\n$/, "")} lang={lang.toLowerCase()} /> : <code>{children}</code>;
    },
    input: ({ type, checked }) => (type === "checkbox" ? <input type="checkbox" checked={!!checked} disabled readOnly /> : null),
  };
}

/** `text` as Markdown; `url` is the request's or issue's page, for links
 * relative to the project. */
export function Markdown({ text, url, className }: { text: string; url?: string; className?: string }): ReactNode {
  const project = url ? projectPage(url) : null;
  return (
    <div className={`markdown${className ? ` ${className}` : ""}`}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components(project)} skipHtml>
        {text}
      </ReactMarkdown>
    </div>
  );
}
