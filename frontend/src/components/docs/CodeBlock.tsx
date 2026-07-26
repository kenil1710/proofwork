/**
 * Syntax highlighting for the handful of snippets these docs show.
 *
 * Deliberately hand-rolled rather than pulling in a highlighter: the payload of
 * a real one dwarfs the code being highlighted here, and the languages in play
 * are Python, JSON and plain text. It tokenises comments, strings and numbers —
 * enough to read as code, and it degrades to plain monospace on anything it
 * does not recognise rather than mangling it.
 */

type Token = { text: string; kind: "comment" | "string" | "number" | "plain" };

const COMMENT = /(#[^\n]*|\/\/[^\n]*)/;
const STRING = /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/;
const NUMBER = /\b(\d+(?:\.\d+)?)\b/;

const SPLITTER = new RegExp(
  `${COMMENT.source}|${STRING.source}|${NUMBER.source}`,
  "g",
);

function tokenise(line: string): Token[] {
  const tokens: Token[] = [];
  let lastIndex = 0;

  for (const match of line.matchAll(SPLITTER)) {
    const index = match.index ?? 0;
    if (index > lastIndex) {
      tokens.push({ text: line.slice(lastIndex, index), kind: "plain" });
    }
    const [whole, comment, string, number] = match;
    tokens.push({
      text: whole,
      kind: comment ? "comment" : string ? "string" : number ? "number" : "plain",
    });
    lastIndex = index + whole.length;
  }

  if (lastIndex < line.length) {
    tokens.push({ text: line.slice(lastIndex), kind: "plain" });
  }
  return tokens;
}

const TOKEN_CLASS = {
  comment: "text-surface-600 italic",
  string: "text-accent-300",
  number: "text-orchid-300",
  plain: "text-surface-200",
} as const;

export function CodeBlock({
  code,
  label,
  /** Renders without highlighting — for prose examples like requirements text. */
  plain = false,
}: {
  code: string;
  label?: string;
  plain?: boolean;
}) {
  const lines = code.replace(/\n$/, "").split("\n");

  return (
    <figure className="chrome-code mt-4 overflow-hidden rounded-[14px] border border-surface-800">
      {label ? (
        <figcaption className="border-b border-surface-800 px-4 py-2 text-xs tracking-[0.15em] text-surface-500 uppercase">
          {label}
        </figcaption>
      ) : null}
      <pre className="overflow-x-auto p-4 font-mono text-sm leading-relaxed">
        <code>
          {lines.map((line, index) => (
            <span key={index} className="block">
              {plain ? (
                <span className="text-surface-200">{line || " "}</span>
              ) : (
                tokenise(line).map((token, tokenIndex) => (
                  <span key={tokenIndex} className={TOKEN_CLASS[token.kind]}>
                    {token.text}
                  </span>
                ))
              )}
              {line ? null : " "}
            </span>
          ))}
        </code>
      </pre>
    </figure>
  );
}

/** Good-vs-bad comparison, used for requirements writing. */
export function GoodBad({
  good,
  bad,
}: {
  good: { label?: string; code: string };
  bad: { label?: string; code: string };
}) {
  return (
    <div className="mt-4 grid gap-4 md:grid-cols-2">
      <div>
        <p className="text-xs tracking-[0.15em] text-accent-400 uppercase">
          {good.label ?? "Scores well"}
        </p>
        <div className="mt-2 rounded-[12px] border border-accent-500/25 bg-accent-500/5 p-4">
          <p className="text-sm leading-relaxed whitespace-pre-wrap text-surface-200">
            {good.code}
          </p>
        </div>
      </div>
      <div>
        <p className="text-xs tracking-[0.15em] text-status-rejected uppercase">
          {bad.label ?? "Scores badly"}
        </p>
        <div className="mt-2 rounded-[12px] border border-status-rejected/25 bg-status-rejected/5 p-4">
          <p className="text-sm leading-relaxed whitespace-pre-wrap text-surface-200">
            {bad.code}
          </p>
        </div>
      </div>
    </div>
  );
}

/** Compact reference table with a monospace first column. */
export function DocTable({
  head,
  rows,
}: {
  head: string[];
  rows: (string | React.ReactNode)[][];
}) {
  return (
    <div className="mt-4 overflow-x-auto rounded-[14px] border border-surface-800">
      <table className="w-full border-collapse text-left text-sm">
        <thead>
          <tr className="border-b border-surface-800 bg-surface-900/60">
            {head.map((cell) => (
              <th
                key={cell}
                className="px-4 py-3 text-xs tracking-[0.12em] font-medium text-surface-400 uppercase"
              >
                {cell}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr
              key={index}
              className="border-b border-surface-800/60 last:border-0"
            >
              {row.map((cell, cellIndex) => (
                <td
                  key={cellIndex}
                  className={`px-4 py-3 align-top ${
                    cellIndex === 0
                      ? "font-medium text-surface-200"
                      : "text-surface-400"
                  }`}
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
