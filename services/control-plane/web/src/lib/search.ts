/**
 * URL search params as typed page state. TanStack Router parses the query
 * string as JSON values; each route then keeps only the fields that decode
 * with their schema, so a hand-edited or stale link degrades to defaults
 * instead of an error page.
 */
import { Option, Schema } from 'effect';

type Fields = Record<string, Schema.Top>;

type Decoded<F extends Fields> = { readonly [K in keyof F]?: F[K]['Type'] | undefined };

export function searchSchema<F extends Fields>(fields: F): (search: Record<string, unknown>) => Decoded<F> {
  const decoders = Object.entries(fields).map(
    ([key, schema]) => [key, Schema.decodeUnknownOption(schema as Schema.Codec<unknown>)] as const,
  );
  return (search) => {
    const out: Record<string, unknown> = {};
    for (const [key, decode] of decoders) {
      if (search[key] === undefined) continue;
      const value = decode(search[key]);
      if (Option.isSome(value)) out[key] = value.value;
    }
    return out;
  };
}
