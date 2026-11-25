/**
 * Expressions over explorer queries, e.g. `100 * a / b`: numbers, query ids,
 * `+ - * /`, unary minus and parentheses, evaluated per bucket. A small
 * recursive-descent parser: expressions come from URLs, so they're never
 * handed to `eval`.
 */

export type Expr =
  | { readonly kind: 'num'; readonly value: number }
  | { readonly kind: 'ref'; readonly id: string }
  | { readonly kind: 'neg'; readonly operand: Expr }
  | { readonly kind: 'bin'; readonly op: '+' | '-' | '*' | '/'; readonly left: Expr; readonly right: Expr };

export class ExprError extends Error {}

type Token = { kind: 'num'; value: number } | { kind: 'id'; value: string } | { kind: 'op'; value: string };

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const c = source[i]!;
    if (/\s/.test(c)) {
      i++;
    } else if (/[0-9.]/.test(c)) {
      const m = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(source.slice(i));
      if (!m) throw new ExprError(`unexpected "${c}"`);
      tokens.push({ kind: 'num', value: Number(m[0]) });
      i += m[0].length;
    } else if (/[a-z]/i.test(c)) {
      const m = /^[a-z][a-z0-9]*/i.exec(source.slice(i))!;
      tokens.push({ kind: 'id', value: m[0].toLowerCase() });
      i += m[0].length;
    } else if ('+-*/()'.includes(c)) {
      tokens.push({ kind: 'op', value: c });
      i++;
    } else {
      throw new ExprError(`unexpected "${c}"`);
    }
  }
  return tokens;
}

export function parseExpr(source: string): Expr {
  const tokens = tokenize(source);
  let pos = 0;
  const peek = () => tokens[pos];
  const isOp = (value: string) => {
    const t = peek();
    return t?.kind === 'op' && t.value === value;
  };

  const primary = (): Expr => {
    const t = tokens[pos++];
    if (!t) throw new ExprError('the expression ends early');
    if (t.kind === 'num') return { kind: 'num', value: t.value };
    if (t.kind === 'id') return { kind: 'ref', id: t.value };
    if (t.value === '(') {
      const inner = sum();
      if (!isOp(')')) throw new ExprError('a "(" is never closed');
      pos++;
      return inner;
    }
    if (t.value === '-') return { kind: 'neg', operand: primary() };
    throw new ExprError(`unexpected "${t.value}"`);
  };
  const product = (): Expr => {
    let left = primary();
    while (isOp('*') || isOp('/')) {
      const op = (tokens[pos++] as { value: '*' | '/' }).value;
      left = { kind: 'bin', op, left, right: primary() };
    }
    return left;
  };
  const sum = (): Expr => {
    let left = product();
    while (isOp('+') || isOp('-')) {
      const op = (tokens[pos++] as { value: '+' | '-' }).value;
      left = { kind: 'bin', op, left, right: product() };
    }
    return left;
  };

  if (tokens.length === 0) throw new ExprError('the expression is empty');
  const expr = sum();
  if (pos < tokens.length) throw new ExprError(`unexpected "${String(tokens[pos]!.value)}"`);
  return expr;
}

export function exprRefs(expr: Expr): Set<string> {
  const refs = new Set<string>();
  const walk = (e: Expr): void => {
    if (e.kind === 'ref') refs.add(e.id);
    else if (e.kind === 'neg') walk(e.operand);
    else if (e.kind === 'bin') {
      walk(e.left);
      walk(e.right);
    }
  };
  walk(expr);
  return refs;
}

/** The value for one bucket; null when an input is missing or a division has no denominator. */
export function evalExpr(expr: Expr, values: ReadonlyMap<string, number | null>): number | null {
  if (expr.kind === 'num') return expr.value;
  if (expr.kind === 'ref') return values.get(expr.id) ?? null;
  if (expr.kind === 'neg') {
    const v = evalExpr(expr.operand, values);
    return v === null ? null : -v;
  }
  const a = evalExpr(expr.left, values);
  const b = evalExpr(expr.right, values);
  if (a === null || b === null) return null;
  if (expr.op === '+') return a + b;
  if (expr.op === '-') return a - b;
  if (expr.op === '*') return a * b;
  return b === 0 ? null : a / b;
}
