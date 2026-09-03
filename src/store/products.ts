import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { libPath } from "./paths.ts";

/**
 * Product profiles — plain markdown the user owns and can edit by hand.
 *
 * Adaptation needs to know what the caller is building and what they can actually produce,
 * and that shouldn't be retyped into every request or hardcoded into a tool call. One file
 * per product, read at the start of a run.
 *
 * The "What I can produce" section is the load-bearing one: it's how a caller states their
 * own constraints, so the tool never has to guess whether a format is feasible for them.
 */

export const PRODUCTS_DIR = libPath("products");

export const TEMPLATE = `# {NAME}

## What it is
One or two sentences. Plain language, the way you'd describe it to a friend.

## Who it's for
The person who has the problem, not a demographic bracket.

## The problem it solves
What is annoying or painful today, before your product exists.

## What I can produce
Say what you can and can't make. This is what stops the research recommending
formats you'd never be able to execute.

- design tools (layout, type, graphics): yes / no — which ones
- stock or AI-generated imagery: yes / no
- photography of specific real people or places: yes / no
- my own face or voice on camera: yes / no
- screen recordings of the product: yes / no

## Constraints
Anything off-limits — claims you can't make, audiences you won't target, tone to avoid.

## Voice
How it should sound. A line or two, or an example sentence.
`;

export type Product = { slug: string; name: string; content: string; path: string };

const slugify = (s: string) =>
  s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

export function listProducts(): { slug: string; name: string }[] {
  if (!existsSync(PRODUCTS_DIR)) return [];
  return readdirSync(PRODUCTS_DIR)
    .filter((f) => f.endsWith(".md"))
    .map((f) => {
      const slug = f.replace(/\.md$/, "");
      const first = readFileSync(join(PRODUCTS_DIR, f), "utf8").split("\n")[0] ?? "";
      return { slug, name: first.replace(/^#\s*/, "").trim() || slug };
    });
}

export function getProduct(slug: string): Product | null {
  const path = join(PRODUCTS_DIR, `${slugify(slug)}.md`);
  if (!existsSync(path)) return null;
  const content = readFileSync(path, "utf8");
  return {
    slug: slugify(slug),
    name: (content.split("\n")[0] ?? "").replace(/^#\s*/, "").trim() || slug,
    content,
    path,
  };
}

export function saveProduct(name: string, content?: string): Product {
  mkdirSync(PRODUCTS_DIR, { recursive: true });
  const slug = slugify(name);
  const path = join(PRODUCTS_DIR, `${slug}.md`);
  const body = content?.trim() ? content : TEMPLATE.replace("{NAME}", name);
  writeFileSync(path, body.endsWith("\n") ? body : `${body}\n`);
  return { slug, name, content: body, path };
}
